
// ─── страница, иконка, ответы ───────────────────────────────────────────────

function appPage() {
  return new Response(APP_HTML, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' },
  });
}

let iconBytes = null;
function iconImage() {
  if (!iconBytes) iconBytes = b64bytes(ICON_PNG_B64);
  return new Response(iconBytes, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });
}

function manifest() {
  return json({
    name: `${SERVICE.name} · мониторинг`,
    short_name: 'Мониторинг',
    start_url: '/app',
    display: 'standalone',
    background_color: '#0E131B',
    theme_color: '#0E131B',
    icons: [{ src: '/app/icon.png', sizes: '512x512', type: 'image/png' }],
  }, 200, { 'content-type': 'application/manifest+json; charset=utf-8' });
}

function b64bytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function cors() {
  return { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, x-admin-key, x-dash-key, x-tg-init-data' };
}

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

function html(title, body, status = 200) {
  return new Response(
    `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#1d1d1b}h1{font-size:24px}h2{font-size:18px;margin-top:28px}code{background:#f2f2f2;padding:2px 4px;border-radius:4px;word-break:break-all}li{margin:4px 0}.big a{display:inline-block;background:#194B9B;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:600}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
  );
}

// ─── мелочи ─────────────────────────────────────────────────────────────────

const nowS = () => Math.floor(Date.now() / 1000);
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

async function pool(items, n, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) {
      const it = queue.shift();
      try {
        await fn(it);
      } catch (e) {
        console.warn('pool', e && e.message);
      }
    }
  });
  await Promise.all(workers);
}

function userName(from) {
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || (from.username ? '@' + from.username : String(from.id));
}

async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomCode(n) {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map((x) => abc[x % abc.length]).join('');
}

function safeJson(s) {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
}

function hostOf(u) {
  try {
    return new URL(u).hostname;
  } catch {
    return String(u);
  }
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const trunc = (s, n) => {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const pad2 = (n) => String(n).padStart(2, '0');

function plural(n, one, few, many) {
  n = Math.abs(Math.round(Number(n) || 0));
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// Длительность по-человечески: 45 с · 3 мин · 1 ч 12 мин · 2 д 3 ч
function dur(s) {
  s = Math.max(0, Math.round(Number(s) || 0));
  if (s < 60) return `${s} с`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return mm ? `${h} ч ${mm} мин` : `${h} ч`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d} д ${hh} ч` : `${d} д`;
}

// Миллисекунды → «0,23 с»
function sec(ms) {
  if (ms == null || Number.isNaN(Number(ms))) return '—';
  const s = Number(ms) / 1000;
  return `${s < 10 ? s.toFixed(2) : s.toFixed(1)}`.replace('.', ',') + ' с';
}

// ─── московское время ───────────────────────────────────────────────────────

const mskIso = (ts) => new Date((Number(ts) + MSK) * 1000).toISOString();
const hhmm = (ts) => mskIso(ts).slice(11, 16);
const ddmm = (ts) => {
  const s = mskIso(ts);
  return `${s.slice(8, 10)}.${s.slice(5, 7)}`;
};
const mskDay = (ts) => mskIso(ts).slice(0, 10);
const mskHour = (ts) => Number(mskIso(ts).slice(11, 13));
const mskWeekday = (ts) => (Math.floor((Number(ts) + MSK) / 86400) + 3) % 7; // 0 — понедельник
const mskDayStart = (ts) => Math.floor((Number(ts) + MSK) / 86400) * 86400 - MSK;
const alignMsk = (ts, step) => Math.floor((Number(ts) + MSK) / step) * step - MSK;
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const dayMonth = (ts) => {
  const s = mskIso(ts);
  return `${Number(s.slice(8, 10))} ${MONTHS_GEN[Number(s.slice(5, 7)) - 1]}`;
};
const fmtDateTime = (ts) => {
  const s = mskIso(ts);
  return `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)} ${s.slice(11, 16)}`;
};

// для локальных тестов
export const __test = {
  streaks, snapshot, parseMute, dur, sec, pctText, plural, hhmm, mskDayStart, mskWeekday, alignMsk, quantile, aggregateRows,
  renderAlert, alertKb, guideLines, httpErr, netError, pageHint, parseCommand, verifyInitData, makeToken, verifyToken, keys,
  remindEvery, getTargets, settingsView, movedUrl, movedText, spanText, incHost,
  resetSchemaFlag: () => {
    schemaReady = false;
  },
};
