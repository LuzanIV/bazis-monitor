
// ─── доступ ─────────────────────────────────────────────────────────────────
// Дашборд открывается: внутри Telegram (подпись initData, пользователь есть в users),
// по личной ссылке (u.<id>.<срок>.<подпись>), по командной ссылке чата (g.<chat>.<срок>.<подпись>,
// действует, пока бот привязан к этому чату) или с админ-ключом.

let keyCache = null;
async function keys(env) {
  if (!env.BOT_TOKEN) return null;
  if (!keyCache || keyCache.token !== env.BOT_TOKEN) {
    keyCache = {
      token: env.BOT_TOKEN,
      hook: (await sha256hex(`${env.BOT_TOKEN}:hook`)).slice(0, 48),
      admin: (await sha256hex(`${env.BOT_TOKEN}:admin`)).slice(0, 32),
    };
  }
  return keyCache;
}

async function isAdmin(env, url, request) {
  const k = await keys(env);
  if (!k) return false;
  const given = request.headers.get('x-admin-key') || url.searchParams.get('key');
  return !!given && given === k.admin;
}

async function hmacRaw(key, data) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? new TextEncoder().encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data)));
}
const hexOf = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');

// Подпись данных Telegram Mini App (core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
async function verifyInitData(botToken, initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  const secret = await hmacRaw('WebAppData', botToken);
  const build = (skip) => [...params.entries()].filter(([key]) => !skip.includes(key)).map(([key, v]) => `${key}=${v}`).sort().join('\n');
  let ok = false;
  for (const skip of [['hash'], ['hash', 'signature']]) {
    if (hexOf(await hmacRaw(secret, build(skip))) === hash) {
      ok = true;
      break;
    }
  }
  if (!ok) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > 7 * 86400) return null;
  const user = safeJson(params.get('user'));
  return user && user.id ? Number(user.id) : null;
}

async function linkKey(env, S) {
  const k = await keys(env);
  return `${k.admin}:dash:${int(S && S.link_ver, 1)}`;
}

async function makeToken(env, S, type, id, days) {
  const exp = nowS() + days * 86400;
  const payload = `${type}.${id}.${exp}`;
  return `${payload}.${hexOf(await hmacRaw(await linkKey(env, S), payload)).slice(0, 32)}`;
}

async function verifyToken(env, S, token) {
  const m = String(token || '').match(/^([ug])\.(-?\d+)\.(\d+)\.([a-f0-9]{32})$/);
  if (!m || Number(m[3]) < nowS()) return null;
  const sig = hexOf(await hmacRaw(await linkKey(env, S), `${m[1]}.${m[2]}.${m[3]}`)).slice(0, 32);
  if (sig !== m[4]) return null;
  return { type: m[1], id: Number(m[2]) };
}

async function dashAuth(env, S, request) {
  const k = await keys(env);
  if (!k) return null;
  const init = request.headers.get('x-tg-init-data');
  if (init) {
    const uid = await verifyInitData(env.BOT_TOKEN, init);
    if (uid && (await getUser(env, uid))) return { via: 'telegram', uid };
  }
  const key = request.headers.get('x-dash-key');
  if (key) {
    const t = await verifyToken(env, S, key);
    if (t && t.type === 'u' && (await getUser(env, t.id))) return { via: 'link', uid: t.id };
    if (t && t.type === 'g' && S.chat_id && String(t.id) === String(S.chat_id)) return { via: 'team', chat: t.id };
  }
  const admin = request.headers.get('x-admin-key');
  if (admin && admin === k.admin) return { via: 'admin' };
  return null;
}
