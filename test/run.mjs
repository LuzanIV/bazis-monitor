// Сценарии бота мониторинга: D1 → node:sqlite, Telegram, прод и часы — моки.
// Запуск: node build.mjs && node test/run.mjs
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac } from 'node:crypto';

// ─── фейковый D1 ────────────────────────────────────────────────────────────
class Stmt {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...p) {
    for (const v of p) if (v === undefined) throw new Error('D1_TYPE_ERROR: undefined in bind for: ' + this.sql);
    return new Stmt(this.db, this.sql, p);
  }
  async first(col) { const r = this.db.prepare(this.sql).get(...this.params); if (!r) return null; const o = { ...r }; return col ? o[col] : o; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params).map((r) => ({ ...r })), success: true, meta: {} }; }
  async run() { const i = this.db.prepare(this.sql).run(...this.params); return { success: true, meta: { changes: Number(i.changes), last_row_id: Number(i.lastInsertRowid) } }; }
}
class FakeD1 {
  constructor() { this.db = new DatabaseSync(':memory:'); this.queries = 0; }
  prepare(sql) { this.queries++; return new Stmt(this.db, sql); }
  async batch(stmts) {
    this.db.exec('BEGIN');
    try { const out = []; for (const s of stmts) out.push(await s.run()); this.db.exec('COMMIT'); return out; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}

// ─── часы ───────────────────────────────────────────────────────────────────
let NOW = Date.parse('2026-09-29T07:00:00Z'); // вторник, 10:00 МСК
Date.now = () => NOW;
const minuteStart = (ms) => Math.floor(ms / 60000) * 60000;

// ─── прод и сеть ────────────────────────────────────────────────────────────
const prod = { web: 'up', api: 'up', control: 'up', latency: 230, extra: 'up' };
const seen = [];
const timeoutErr = () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; return e; };
function prodMock(url) {
  seen.push(url);
  NOW += prod.latency;
  const html = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=UTF-8' } });
  if (url.startsWith('https://etalon.iflat.io/login')) {
    if (prod.web === 'up') return html('<!doctype html><html><head><title>\n\t\tВход в личный кабинет |\n\tetalon.iflat.io</title></head><body><div id="app"></div></body></html>');
    if (prod.web === '502') return html('<html><head><title>502 Bad Gateway</title></head><body><center>nginx</center></body></html>', 502);
    if (prod.web === 'maint') return html('<html><head><title>Технические работы</title></head><body>Скоро вернёмся</body></html>');
    if (prod.web === 'timeout') throw timeoutErr();
    throw new TypeError('Network connection lost.');
  }
  if (url.startsWith('https://etalon.iflat.io/api/v1/houses')) {
    if (prod.api === 'up') return new Response('{"message":"Unauthenticated."}', { status: 401, headers: { 'content-type': 'application/json' } });
    if (prod.api === '502') return html('<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>', 502);
    if (prod.api === 'html') return html('<html><head><title>Ошибка</title></head><body>oops</body></html>', 200);
    if (prod.api === 'timeout') throw timeoutErr();
    throw new TypeError('connection refused');
  }
  if (url.startsWith('https://ya.ru')) {
    if (prod.control === 'up') return html('<html>ya</html>');
    throw new TypeError('Network connection lost.');
  }
  if (url.startsWith('https://iflat.io/login')) {
    return prod.extra === 'up' ? html('<html>ok</html>') : html('oops', 503);
  }
  throw new Error('unexpected fetch ' + url);
}

// ─── Telegram ───────────────────────────────────────────────────────────────
const TOKEN = '123:TEST';
const h = (x) => createHash('sha256').update(x).digest('hex');
const SECRET = h(TOKEN + ':hook').slice(0, 48);
const ADMIN = h(TOKEN + ':admin').slice(0, 32);
let calls = [];
let msgSeq = 1000;
const BOT_ID = 999;
const GROUP = -1001234567890;
const members = new Map(); // `${chat}:${user}` → status
const blocked = new Set([555]);
const deadTopics = new Set(); // удалённые темы форума
const closedTopics = new Set(); // закрытые темы
const msgThread = new Map(); // message_id → тема, куда ушло сообщение
const undeletable = new Set(); // сообщения, которые Telegram не даст удалить

async function tgMock(url, init) {
  const m = url.match(/^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/);
  assert.ok(m, 'bad tg url ' + url);
  assert.equal(m[1], TOKEN);
  const method = m[2];
  const params = JSON.parse(init.body || '{}');
  calls.push({ method, params });
  const ok = (result = true) => new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } });
  const fail = (d) => new Response(JSON.stringify({ ok: false, description: d }), { status: 400, headers: { 'content-type': 'application/json' } });
  const th = params.message_thread_id != null ? Number(params.message_thread_id) : null;
  if (th != null && deadTopics.has(th)) return fail('Bad Request: message thread not found');
  if (th != null && closedTopics.has(th) && method !== 'sendChatAction') return fail('Bad Request: TOPIC_CLOSED');
  switch (method) {
    case 'sendMessage':
    case 'sendSticker':
      if (blocked.has(Number(params.chat_id))) return fail('Forbidden: bot was blocked by the user');
      msgThread.set(msgSeq + 1, th);
      return ok({ message_id: ++msgSeq, chat: { id: params.chat_id }, message_thread_id: th ?? undefined, text: params.text });
    case 'deleteMessage':
      if (undeletable.has(params.message_id)) return fail("Bad Request: message can't be deleted");
      return ok(true);
    case 'editMessageText':
      if (params.message_id === 404 || deadTopics.has(msgThread.get(params.message_id))) return fail('Bad Request: message to edit not found');
      return ok({ message_id: params.message_id });
    case 'getMe':
      return ok({ id: BOT_ID, is_bot: true, username: 'bazis_monitor_test_bot' });
    case 'getChatMember': {
      if (params.user_id === BOT_ID) return ok({ status: 'administrator', can_pin_messages: true, can_manage_topics: true, user: { id: BOT_ID } });
      const st = members.get(`${params.chat_id}:${params.user_id}`) || 'left';
      return ok({ status: st, user: { id: params.user_id } });
    }
    default:
      return ok(true);
  }
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://api.telegram.org/')) return tgMock(url, init);
  return prodMock(url);
};

// ─── окружение ──────────────────────────────────────────────────────────────
const worker = await import('../dist/worker.js');
const W = worker.default;
const T = worker.__test;
const env = { DB: new FakeD1(), BOT_TOKEN: TOKEN, RETRY_DELAY_MS: 0 };
// база «как на проде»: incidents из версии 1.0.0, без thread_id — новая версия должна добавить колонку сама
env.DB.db.exec('CREATE TABLE incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, started_at INTEGER NOT NULL, confirmed_at INTEGER, ended_at INTEGER, targets TEXT, cause TEXT, acked_uid INTEGER, acked_name TEXT, acked_at INTEGER, chat_id INTEGER, msg_id INTEGER, reminders INTEGER NOT NULL DEFAULT 0, last_remind INTEGER, last_edit INTEGER, note TEXT)');
// Большинство сценариев считают по минутам — проверяем каждую минуту. Режим «раз в 5 минут» — отдельный сценарий.
env.DB.db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); INSERT INTO settings (key, value) VALUES ('check_every', '1')");
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const settle = async () => { while (pending.length) await pending.shift(); };
const BASE = 'https://bazis-monitor.test.workers.dev';

async function hook(update) {
  const r = await W.fetch(new Request(BASE + '/tg', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': SECRET, 'content-type': 'application/json' }, body: JSON.stringify(update) }), env, ctx);
  await settle();
  return r;
}
async function get(path, headers = {}) {
  return W.fetch(new Request(BASE + path, { headers }), env, ctx);
}
async function tick() {
  NOW = minuteStart(NOW) + 60000;
  await W.scheduled({ scheduledTime: NOW, cron: '* * * * *' }, env, ctx);
  await settle();
}
async function ticks(n) { for (let i = 0; i < n; i++) await tick(); }
const q = (sql, ...p) => env.DB.db.prepare(sql).all(...p);
const q1 = (sql, ...p) => env.DB.db.prepare(sql).get(...p);

let uid = 1;
const OWNER = { id: 42, first_name: 'Илья', last_name: 'Лузан', username: 'ilya_luzan' };
const DEV = { id: 77, first_name: 'Александр', username: 'Kiss_Alexandr' };
const DEV2 = { id: 78, first_name: 'Мария' };
const STRANGER = { id: 13, first_name: 'Чужой' };
const pm = (from, text, extra = {}) => ({ update_id: uid++, message: { message_id: uid + 500, from, chat: { id: from.id, type: 'private' }, date: 1, text, ...extra } });
const gm = (from, text, extra = {}) => ({ update_id: uid++, message: { message_id: uid + 500, from, chat: { id: GROUP, type: 'supergroup', title: 'Базис · разработка' }, date: 1, text, ...extra } });
const cb = (from, data, chatId = GROUP, msgId = 1) => ({ update_id: uid++, callback_query: { id: 'cb' + uid, from, data, message: { message_id: msgId, chat: { id: chatId, type: chatId < 0 ? 'supergroup' : 'private' } } } });
const sent = (method = 'sendMessage') => calls.filter((c) => c.method === method);
const lastText = (chatId) => { const s = sent().filter((c) => chatId == null || String(c.params.chat_id) === String(chatId)); return s.length ? s.at(-1).params.text : ''; };
const since = (i) => calls.slice(i);

const results = [];
async function scenario(name, fn) {
  try {
    await fn();
    results.push(['✅', name]);
  } catch (e) {
    results.push(['❌', name]);
    console.error(`\n❌ ${name}\n`, e);
    console.error('последние вызовы:', calls.slice(-6).map((c) => c.method + ' ' + JSON.stringify(c.params).slice(0, 260)).join('\n'));
    process.exitCode = 1;
  }
}

// ═══ сценарии ═══════════════════════════════════════════════════════════════

await scenario('чистые функции: длительности, проценты, пауза, серии', async () => {
  assert.equal(T.dur(45), '45 с');
  assert.equal(T.dur(180), '3 мин');
  assert.equal(T.dur(4320), '1 ч 12 мин');
  assert.equal(T.dur(7200), '2 ч');
  assert.equal(T.dur(2 * 86400 + 3 * 3600), '2 д 3 ч');
  assert.equal(T.sec(231), '0,23 с');
  assert.equal(T.sec(12000), '12,0 с');
  assert.equal(T.pctText({ up: 100, down: 0 }), '100\u00a0%');
  assert.equal(T.pctText({ up: 99999, down: 1 }), '99,99\u00a0%');
  assert.equal(T.pctText({ up: 0, down: 0 }), '—');
  assert.equal(T.plural(1, 'падение', 'падения', 'падений'), 'падение');
  assert.equal(T.plural(3, 'падение', 'падения', 'падений'), 'падения');
  assert.equal(T.plural(11, 'падение', 'падения', 'падений'), 'падений');
  const now = Date.parse('2026-09-29T07:00:00Z') / 1000; // 10:00 МСК
  assert.equal(T.parseMute('', now), 3600);
  assert.equal(T.parseMute('30', now), 1800);
  assert.equal(T.parseMute('2h', now), 7200);
  assert.equal(T.parseMute('1,5 ч', now), 5400);
  assert.equal(T.parseMute('23:00', now), 13 * 3600);
  assert.equal(T.parseMute('09:30', now), 23.5 * 3600);
  assert.equal(T.parseMute('off', now), 0);
  assert.equal(T.parseMute('когда-нибудь', now), null);
  assert.equal(T.hhmm(now), '10:00');
  assert.equal(T.mskWeekday(now), 1); // вторник
  assert.equal(T.hhmm(T.mskDayStart(now)), '00:00');
  const s = T.streaks([{ ts: 300, st: 0 }, { ts: 240, st: -1 }, { ts: 180, st: 0 }, { ts: 120, st: 1 }]);
  assert.deepEqual([s.down, s.downFrom, s.up], [2, 180, 0]);
  const s2 = T.streaks([{ ts: 300, st: 1 }, { ts: 240, st: 1 }, { ts: 180, st: 0 }]);
  assert.deepEqual([s2.up, s2.upFrom, s2.down], [2, 240, 0]);
  assert.equal(T.quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.equal(T.quantile([1, 2, 3, 4], 0.5), 2);
  assert.equal(T.httpErr(502, '', '<title>502 Bad Gateway</title>'), '502 Bad Gateway');
  assert.equal(T.httpErr(503, '', '<title>Технические работы</title>'), '503 Service Unavailable — «Технические работы»');
  assert.match(T.netError(timeoutErr(), 12000), /нет ответа за 12 с/);
  assert.deepEqual(T.parseCommand('/status@bazis_monitor_test_bot', 'bazis_monitor_test_bot'), { cmd: 'status', arg: '' });
  assert.equal(T.parseCommand('/status@other_bot', 'bazis_monitor_test_bot'), null);
  assert.deepEqual(T.parseCommand('/mute 2h', 'x'), { cmd: 'mute', arg: '2h' });
});

await scenario('/setup: вебхук, команды, пробная проверка, кнопка стать владельцем', async () => {
  const r = await get('/setup');
  const html = await r.text();
  assert.equal(r.status, 200, html);
  assert.match(html, /@bazis_monitor_test_bot/);
  assert.match(html, /✅ <b>Сайт<\/b>.*200 · \d+ мс/);
  assert.match(html, /✅ <b>API<\/b>.*401 · \d+ мс/);
  assert.match(html, /Cron: ❌ ещё не было ни одного прогона/);
  assert.match(html, /id="owner-link"/);
  const wh = calls.find((c) => c.method === 'setWebhook').params;
  assert.equal(wh.url, BASE + '/tg');
  assert.equal(wh.secret_token, SECRET);
  assert.deepEqual(wh.allowed_updates, ['message', 'callback_query', 'my_chat_member']);
  const cmds = calls.filter((c) => c.method === 'setMyCommands');
  assert.deepEqual(cmds.map((c) => c.params.scope.type), ['all_private_chats', 'all_group_chats']);
  assert.ok(cmds[1].params.commands.some((c) => c.command === 'drill'));
  assert.equal(calls.find((c) => c.method === 'setChatMenuButton').params.menu_button.web_app.url, BASE + '/app');
});

await scenario('владелец: первый /start после /setup, чужой не проходит', async () => {
  await hook(pm(OWNER, '/start'));
  assert.match(lastText(OWNER.id), /Привет, Илья/);
  assert.match(lastText(OWNER.id), /Ты владелец/);
  assert.equal(q1('SELECT role, dm FROM users WHERE user_id = 42').role, 'owner');
  assert.equal(q1('SELECT dm FROM users WHERE user_id = 42').dm, 1);
  await hook(pm(STRANGER, '/start'));
  assert.match(lastText(STRANGER.id), /🔒 Это бот мониторинга/);
  assert.equal(q1('SELECT COUNT(*) AS n FROM users').n, 1);
});

await scenario('пока чат не привязан, работает; проверки раз в минуту пишутся в базу', async () => {
  const before = calls.length;
  await ticks(3);
  assert.equal(q1("SELECT COUNT(*) AS n FROM checks WHERE target = '_'").n, 3);
  assert.equal(q1("SELECT COUNT(*) AS n FROM checks WHERE target = 'api' AND st = 1 AND code = 401").n, 3);
  assert.equal(q1("SELECT MIN(ms) AS ms FROM checks WHERE target = 'api'").ms, 230); // часы общие на оба запроса: второй меряется точно
  assert.equal(since(before).filter((c) => c.method === 'sendMessage').length, 0, 'без падений не пишем');
  const hr = await get('/health');
  assert.equal(hr.status, 200);
  assert.equal((await hr.json()).ok, true);
});

await scenario('владелец добавил бота в чат → привязка, закреплённая инструкция с живым статусом', async () => {
  members.set(`${GROUP}:${DEV.id}`, 'member');
  members.set(`${GROUP}:${DEV2.id}`, 'member');
  members.set(`${GROUP}:${OWNER.id}`, 'creator');
  const before = calls.length;
  await hook({ update_id: uid++, my_chat_member: { chat: { id: GROUP, type: 'supergroup', title: 'Базис · разработка' }, from: OWNER, date: 1, old_chat_member: { status: 'left', user: { id: BOT_ID } }, new_chat_member: { status: 'member', user: { id: BOT_ID } } } });
  const S = Object.fromEntries(q('SELECT key, value FROM settings').map((r) => [r.key, r.value]));
  assert.equal(S.chat_id, String(GROUP));
  const msgs = since(before).filter((c) => c.method === 'sendMessage').map((c) => c.params.text);
  assert.match(msgs[0], /Привет! Я слежу за доступностью Базиса/);
  assert.match(msgs[1], /🟢 <b>Базис работает<\/b>/);
  assert.match(msgs[1], /Как читать сообщения бота/);
  assert.match(msgs[1], /повторяется каждые 5 мин/);
  assert.match(msgs[2], /администратором с правом «Закреплять сообщения»/);
  const pin = since(before).find((c) => c.method === 'pinChatMessage');
  assert.equal(String(pin.params.message_id), S.board_msg);
  const kb = since(before).filter((c) => c.method === 'sendMessage')[1].params.reply_markup.inline_keyboard;
  assert.equal(kb[0][0].callback_data, 'me:mention');
  assert.match(kb[1][0].url, /\/app#k=g\.-1001234567890\./);
});

await scenario('участник чата открывает бота в личке без приглашения; подписка на личные тревоги', async () => {
  await hook(pm(DEV, '/start'));
  assert.match(lastText(DEV.id), /Привет, Александр/);
  assert.doesNotMatch(lastText(DEV.id), /владелец/);
  await hook(pm(DEV, '/subscribe'));
  assert.equal(q1('SELECT dm FROM users WHERE user_id = 77').dm, 1);
  // кнопка «Упоминать меня» из закрепа
  await hook(cb(DEV2, 'me:mention'));
  assert.equal(q1('SELECT mention FROM users WHERE user_id = 78').mention, 1);
  const ans = calls.filter((c) => c.method === 'answerCallbackQuery').at(-1).params.text;
  assert.match(ans, /нет юзернейма/);
});

let incId;
let cardMsg;
await scenario('падение: одна минута — ждём, вторая — сирена 🚨, карточка, упоминания, закреп, личка', async () => {
  prod.api = '502';
  let before = calls.length;
  await tick();
  assert.equal(since(before).filter((c) => c.method === 'sendMessage').length, 0, 'после первой неудачной минуты ещё не тревожим');
  assert.equal(q1("SELECT st FROM checks WHERE target = '_' ORDER BY ts DESC LIMIT 1").st, 0);
  before = calls.length;
  await tick();
  const out = since(before).filter((c) => c.method === 'sendMessage');
  assert.equal(out[0].params.text, '🚨');
  assert.equal(String(out[0].params.chat_id), String(GROUP));
  const card = out[1].params;
  assert.match(card.text, /🔴 <b>БАЗИС НЕДОСТУПЕН<\/b>/);
  assert.match(card.text, /❌ <b>API<\/b> — 502 Bad Gateway/);
  assert.match(card.text, /✅ Сайт — отвечает/);
  assert.match(card.text, /@Kiss_Alexandr @VitalyFeodorov @reffery101 @Ai_basis\b/);
  assert.doesNotMatch(card.text, /LuzanIV/, 'владельца со стороны заказчика не упоминаем');
  assert.match(card.text, /<a href="tg:\/\/user\?id=78">Мария<\/a>/);
  assert.match(card.text, /Не отвечает с <b>10:0\d<\/b> МСК · уже <b>/);
  assert.equal(card.reply_markup.inline_keyboard[0][0].text, '🙋 Беру');
  assert.match(card.reply_markup.inline_keyboard[1][0].callback_data, /^mute:60$/);
  assert.equal(card.reply_markup.inline_keyboard[2][1].url, 'https://etalon.iflat.io/panel');
  cardMsg = msgSeq - (out.length - 2); // id карточки
  const pin = since(before).find((c) => c.method === 'pinChatMessage');
  assert.equal(pin.params.disable_notification, false);
  const dms = out.filter((c) => c.params.chat_id === OWNER.id || c.params.chat_id === DEV.id);
  assert.equal(dms.length, 2, 'владелец и подписчик получили в личку');
  assert.match(dms[0].params.text, /^🚨 🔴 <b>БАЗИС НЕДОСТУПЕН/);
  assert.ok(dms[0].params.reply_markup.inline_keyboard[1][0].web_app, 'в личке дашборд открывается как Mini App');
  const inc = q1('SELECT * FROM incidents');
  incId = inc.id;
  assert.equal(inc.kind, 'down');
  assert.equal(inc.msg_id, pin.params.message_id);
  assert.match(inc.cause, /API — 502 Bad Gateway/);
  assert.equal(inc.started_at, q1("SELECT MIN(ts) AS ts FROM checks WHERE target = '_' AND st = 0").ts);
});

await scenario('пока никто не взял — напоминание каждые 5 минут ответом на тревогу', async () => {
  const before = calls.length;
  await ticks(4);
  assert.equal(since(before).filter((c) => c.method === 'sendMessage' && /⏰/.test(c.params.text)).length, 0, 'раньше 5 минут не напоминаем');
  await tick();
  const rem = since(before).filter((c) => c.method === 'sendMessage' && /⏰/.test(c.params.text));
  const inChat = rem.find((c) => String(c.params.chat_id) === String(GROUP));
  assert.ok(inChat, 'напоминание в чат');
  assert.match(inChat.params.text, /Базис не отвечает уже \d+ мин<\/b> — тревогу пока никто не взял/);
  assert.match(inChat.params.text, /@Kiss_Alexandr/);
  assert.equal(inChat.params.reply_parameters.message_id, q1('SELECT msg_id FROM incidents WHERE id = ?', incId).msg_id);
  assert.equal(rem.length, 3, 'чат + двое в личке');
  assert.equal(q1('SELECT reminders FROM incidents WHERE id = ?', incId).reminders, 1);
  assert.ok(since(before).some((c) => c.method === 'editMessageText' && /уже <b>\d+ мин/.test(c.params.text)), 'карточка обновляется');
});

await scenario('«Беру»: карточка показывает, кто взял; напоминания прекращаются', async () => {
  let before = calls.length;
  await hook(cb(DEV, `ack:${incId}`));
  const ans = since(before).find((c) => c.method === 'answerCallbackQuery').params.text;
  assert.match(ans, /Тревога твоя/);
  const ed = since(before).find((c) => c.method === 'editMessageText').params;
  assert.match(ed.text, /🙋 В работе: <b>Александр<\/b> · с \d\d:\d\d, реакция \d+ мин/);
  assert.notEqual(ed.reply_markup.inline_keyboard[0][0].text, '🙋 Беру');
  assert.ok(since(before).some((c) => c.method === 'sendMessage' && /<b>Александр<\/b> берёт тревогу — напоминаний больше не будет/.test(c.params.text)));
  await hook(cb(DEV2, `ack:${incId}`));
  assert.match(calls.filter((c) => c.method === 'answerCallbackQuery').at(-1).params.text, /Тревога уже в работе: Александр/);
  before = calls.length;
  await ticks(12);
  assert.equal(since(before).filter((c) => c.method === 'sendMessage' && /⏰/.test(c.params.text)).length, 0, 'после «Беру» не напоминаем');
});

await scenario('поднялся: две удачные минуты → «снова работает» ответом на тревогу, открепление, личка', async () => {
  prod.api = 'up';
  let before = calls.length;
  await tick();
  assert.equal(since(before).filter((c) => /СНОВА РАБОТАЕТ/.test(c.params.text || '')).length, 0, 'одной удачной минуты мало');
  before = calls.length;
  await tick();
  const rec = since(before).find((c) => c.method === 'sendMessage' && String(c.params.chat_id) === String(GROUP) && /СНОВА РАБОТАЕТ/.test(c.params.text));
  assert.ok(rec);
  assert.match(rec.params.text, /Не отвечал <b>\d+ мин<\/b> · \d\d:\d\d → \d\d:\d\d МСК/);
  assert.match(rec.params.text, /Причина: API — 502 Bad Gateway/);
  assert.match(rec.params.text, /Кто разбирался: <b>Александр<\/b>, реакция \d+ мин/);
  assert.ok(since(before).some((c) => c.method === 'unpinChatMessage'));
  assert.ok(since(before).some((c) => c.method === 'editMessageText' && /✅ <b>РЕШЕНО<\/b> · <s>БАЗИС НЕДОСТУПЕН<\/s>/.test(c.params.text)));
  assert.ok(since(before).some((c) => c.method === 'sendMessage' && c.params.chat_id === OWNER.id && /снова работает/.test(c.params.text)));
  const inc = q1('SELECT * FROM incidents WHERE id = ?', incId);
  assert.ok(inc.ended_at > inc.started_at);
  assert.equal(inc.ended_at, q1("SELECT MAX(ts) AS ts FROM checks WHERE target = '_' AND st = 1") .ts - 60);
});

await scenario('разбор: ответ на «снова работает» пишется в журнал; чужие ответы боту — не разбор', async () => {
  const inc = q1('SELECT * FROM incidents WHERE id = ?', incId);
  assert.ok(inc.pm_msg, 'бот запомнил сообщение, на которое ждёт разбор');
  const rec = calls.find((c) => c.method === 'sendMessage' && String(c.params.chat_id) === String(GROUP) && /^✅ <b>БАЗИС СНОВА РАБОТАЕТ/.test(c.params.text));
  assert.match(rec.params.text, /📝 <b>Разбор:<\/b> @Kiss_Alexandr, ответьте на это сообщение одной строкой — что случилось и что сделали/);
  assert.equal(rec.params.reply_markup.force_reply, true, 'Telegram сам откроет ответ тому, кто взял тревогу');
  assert.equal(rec.params.reply_markup.selective, true);
  const botMsg = (id) => ({ message_id: id, from: { id: BOT_ID, is_bot: true, first_name: 'Мониторинг' }, chat: { id: GROUP, type: 'supergroup' }, date: 1 });
  await hook(gm(DEV2, 'ответ на карточку', { reply_to_message: botMsg(inc.msg_id) }));
  assert.equal(q1('SELECT pm_text FROM incidents WHERE id = ?', incId).pm_text, null, 'ответ на карточку — не разбор');
  let before = calls.length;
  await hook(gm(DEV, 'Упал php-fpm: кончилась память. Перезапустили,   подняли лимит', { reply_to_message: botMsg(inc.pm_msg) }));
  const row = q1('SELECT pm_text, pm_by FROM incidents WHERE id = ?', incId);
  assert.equal(row.pm_text, 'Упал php-fpm: кончилась память. Перезапустили, подняли лимит');
  assert.equal(row.pm_by, 'Александр');
  const ed = since(before).find((c) => c.method === 'editMessageText' && c.params.message_id === inc.pm_msg);
  assert.match(ed.params.text, /✅ <b>БАЗИС СНОВА РАБОТАЕТ<\/b>/);
  assert.match(ed.params.text, /📝 <b>Разбор:<\/b> Упал php-fpm: кончилась память\. Перезапустили, подняли лимит — Александр/);
  assert.doesNotMatch(ed.params.text, /ответьте на это сообщение/);
  assert.equal(ed.params.reply_markup, undefined, 'правим только текст');
  assert.ok(since(before).some((c) => c.method === 'setMessageReaction' && c.params.reaction[0].emoji === '✍'));
  assert.ok(!since(before).some((c) => c.method === 'sendMessage'), 'лишних сообщений нет');
  // уточнили — разбор обновился, бот отвечает коротко
  before = calls.length;
  await hook(gm(DEV2, 'Упал php-fpm из-за утечки памяти в отчётах; перезапустили, подняли лимит, завели задачу', { reply_to_message: botMsg(inc.pm_msg) }));
  assert.match(q1('SELECT pm_text FROM incidents WHERE id = ?', incId).pm_text, /утечки памяти/);
  assert.match(since(before).find((c) => c.method === 'sendMessage').params.text, /Обновил разбор/);
  await hook(gm(DEV2, '/incidents'));
  assert.match(lastText(GROUP), /📝 Упал php-fpm из-за утечки памяти/);
});

await scenario('случайный сбой с первой попытки не поднимает тревогу', async () => {
  let n = 0;
  const orig = prod.api;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v1/houses') && n++ === 0) throw new TypeError('Network connection lost.');
    return realFetch(input, init);
  };
  const before = calls.length;
  await tick();
  globalThis.fetch = realFetch;
  prod.api = orig;
  const r = q1("SELECT st, err FROM checks WHERE target = 'api' ORDER BY ts DESC LIMIT 1");
  assert.equal(r.st, 1);
  assert.match(r.err, /сбой с первой попытки: соединение оборвалось/);
  assert.equal(since(before).filter((c) => c.method === 'sendMessage').length, 0);
});

await scenario('нет сети у самого монитора: не тревожим, через 10 минут пишем владельцу', async () => {
  prod.web = 'down';
  prod.api = 'down';
  prod.control = 'down';
  let before = calls.length;
  await ticks(9);
  assert.equal(since(before).filter((c) => c.method === 'sendMessage').length, 0);
  assert.equal(q1("SELECT st FROM checks WHERE target = '_' ORDER BY ts DESC LIMIT 1").st, -1);
  await tick();
  const warn = since(before).filter((c) => c.method === 'sendMessage');
  assert.equal(warn.length, 1);
  assert.equal(warn[0].params.chat_id, OWNER.id);
  assert.match(warn[0].params.text, /Монитор 10 мин без сети/);
  prod.web = 'up';
  prod.api = 'up';
  prod.control = 'up';
  before = calls.length;
  await tick();
  assert.match(since(before).find((c) => c.method === 'sendMessage').params.text, /Сеть у монитора снова есть/);
  assert.equal(q1("SELECT COUNT(*) AS n FROM incidents WHERE ended_at IS NULL").n, 0);
});

await scenario('плановые работы: /mute в чате, тихая запись, после паузы — обычная тревога', async () => {
  let before = calls.length;
  await hook(gm(DEV, '/mute 5'));
  const m = since(before).find((c) => c.method === 'sendMessage').params;
  assert.match(m.text, /🔧 <b>Плановые работы до \d\d:\d\d МСК<\/b> — тревоги на паузе/);
  assert.match(m.text, /Кто поставил паузу: Александр/);
  assert.equal(m.disable_notification, true);
  prod.web = 'maint';
  before = calls.length;
  await ticks(2);
  const planned = since(before).filter((c) => c.method === 'sendMessage');
  assert.equal(planned.length, 1);
  assert.match(planned[0].params.text, /Базис не отвечает — идут плановые работы/);
  assert.equal(planned[0].params.disable_notification, true);
  assert.ok(!since(before).some((c) => c.method === 'pinChatMessage'), 'не закрепляем');
  assert.equal(q1("SELECT kind FROM incidents WHERE ended_at IS NULL").kind, 'planned');
  assert.equal(q1("SELECT st FROM checks WHERE target = 'web' ORDER BY ts DESC LIMIT 1").st, 2);
  before = calls.length;
  await ticks(4); // пауза 5 минут кончилась, а сайт всё ещё отдаёт заглушку
  const after = since(before).filter((c) => c.method === 'sendMessage').map((c) => c.params.text);
  assert.ok(after.some((t) => /Плановые работы по расписанию закончились/.test(t)));
  const card = after.find((t) => /БАЗИС НЕДОСТУПЕН/.test(t) && /Плановые работы закончились, а Базис так и не поднялся/.test(t));
  assert.ok(card, 'после паузы — настоящая тревога');
  assert.match(card, /❌ <b>Сайт<\/b> — HTTP 200, но страница не та: «Технические работы»/);
  assert.match(card, /Не отвечает с <b>\d\d:\d\d<\/b> МСК, сначала шли плановые работы · всего <b>\d+ мин<\/b>/);
  assert.equal(q1("SELECT COUNT(*) AS n FROM incidents WHERE kind = 'planned' AND ended_at IS NOT NULL").n, 1, 'плановый простой закрыт отдельно');
  assert.equal(q1("SELECT kind FROM incidents WHERE ended_at IS NULL").kind, 'down');
  prod.web = 'up';
  await ticks(2);
  assert.equal(q1("SELECT COUNT(*) AS n FROM incidents WHERE ended_at IS NULL").n, 0);
});

await scenario('кнопка «🔧 Это плановые работы» в тревоге ставит паузу и глушит напоминания', async () => {
  prod.api = 'timeout';
  await ticks(2);
  const inc = q1("SELECT * FROM incidents WHERE ended_at IS NULL");
  assert.equal(inc.kind, 'down');
  assert.match(inc.cause, /API — нет ответа за 12 с/);
  let before = calls.length;
  await hook(cb(DEV2, 'mute:60'));
  assert.ok(since(before).some((c) => c.method === 'sendMessage' && /Плановые работы до/.test(c.params.text) && /Мария/.test(c.params.text)));
  assert.ok(since(before).some((c) => c.method === 'editMessageText' && /напоминания на паузе/.test(c.params.text)));
  before = calls.length;
  await ticks(10);
  assert.equal(since(before).filter((c) => /⏰/.test(c.params.text || '')).length, 0);
  await hook(gm(OWNER, '/unmute'));
  assert.match(lastText(GROUP), /Тревоги снова включены/);
  prod.api = 'up';
  await ticks(2);
  assert.equal(q1("SELECT COUNT(*) AS n FROM incidents WHERE ended_at IS NULL").n, 0);
});

await scenario('учебная тревога: 🧪 полный цикл, в статистику не идёт', async () => {
  const downBefore = q1("SELECT COUNT(*) AS n FROM incidents WHERE kind = 'down'").n;
  let before = calls.length;
  await hook(gm(DEV, '/drill'));
  assert.match(lastText(GROUP), /Учебную тревогу запускают владелец бота и админы чата/);
  before = calls.length;
  await hook(gm(OWNER, '/drill'));
  const out = since(before).filter((c) => c.method === 'sendMessage');
  assert.equal(out[0].params.text, '🚨');
  assert.match(out[1].params.text, /^🧪 <b>УЧЕБНАЯ ТРЕВОГА<\/b>/);
  assert.match(out[1].params.text, /502 Bad Gateway \(понарошку\)/);
  assert.ok(out.some((c) => c.params.chat_id === DEV.id && /УЧЕБНАЯ ТРЕВОГА/.test(c.params.text)));
  const drill = q1("SELECT * FROM incidents WHERE kind = 'drill'");
  before = calls.length;
  await tick();
  assert.ok(since(before).some((c) => c.method === 'sendMessage' && /^🧪 ⏰/.test(c.params.text)), 'учебное напоминание через минуту');
  await hook(cb(DEV2, `ack:${drill.id}`));
  assert.ok(calls.some((c) => c.method === 'sendMessage' && /<b>Мария<\/b> берёт тревогу \(учебную\)/.test(c.params.text)));
  before = calls.length;
  await tick();
  const fin = since(before).find((c) => c.method === 'sendMessage' && /УЧЕНИЯ ОКОНЧЕНЫ/.test(c.params.text));
  assert.ok(fin, 'учения закончились через минуту после «Беру»');
  assert.match(fin.params.text, /Кто разбирался: <b>Мария<\/b>/);
  assert.match(fin.params.text, /напоминания идут раз в 5 мин/);
  assert.ok(since(before).some((c) => c.method === 'unpinChatMessage'));
  assert.equal(q1("SELECT COUNT(*) AS n FROM incidents WHERE kind = 'down'").n, downBefore);
  assert.ok(q1("SELECT ended_at FROM incidents WHERE kind = 'drill'").ended_at);
  const S = Object.fromEntries(q('SELECT key, value FROM settings').map((r) => [r.key, r.value]));
  assert.equal(S.drill, undefined);
});

await scenario('/status, /stats, /incidents и «Проверить сейчас»', async () => {
  await hook(gm(DEV2, '/status'));
  const st = sent().at(-1).params;
  assert.match(st.text, /🟢 <b>Базис работает<\/b>/);
  assert.match(st.text, /✅ API — 401 · 0,23 с \(без входа так и должно быть\)/);
  assert.equal(st.reply_markup.inline_keyboard[0][0].callback_data, 'check');
  await hook(gm(DEV2, '/stats'));
  const stats = lastText(GROUP);
  assert.match(stats, /Сутки — <b>\d\d,\d\d\u00a0%<\/b> · 3 падения, простой \d+ мин/);
  assert.match(stats, /Время ответа за сутки: Сайт 0,\d\d с \(p95 0,\d\d с\) · API 0,23 с \(p95 0,23 с\)/);
  assert.match(stats, /восстановление в среднем \d+ мин/);
  await hook(gm(DEV2, '/incidents'));
  const inc = lastText(GROUP);
  assert.match(inc, /🧯 <b>Журнал падений<\/b>/);
  assert.match(inc, /Александр, реакция \d+ мин/);
  assert.doesNotMatch(inc, /учебная/);
  const before = calls.length;
  await hook(cb(DEV2, 'check', GROUP, 4242));
  const ed = since(before).find((c) => c.method === 'editMessageText');
  assert.equal(ed.params.message_id, 4242);
  assert.match(ed.params.text, /🔄 <b>Проверил только что<\/b>/);
});

await scenario('почасовые сводки и статистика совпадают с поминутными данными', async () => {
  // догоняем до следующего полного часа и ещё на час
  const target = Math.floor(NOW / 3600000) * 3600000 + 2 * 3600000 + 120000;
  while (NOW < target) await tick();
  const S = Object.fromEntries(q('SELECT key, value FROM settings').map((r) => [r.key, r.value]));
  const rolled = Number(S.rollup_hour);
  assert.ok(rolled >= Math.floor(NOW / 1000 / 3600) * 3600 - 7200, 'сводки догнали');
  const raw = q1("SELECT SUM(st = 1) AS up, SUM(st = 0) AS down FROM checks WHERE target = '_' AND ts < ?", rolled + 3600);
  const hr = q1("SELECT SUM(up) AS up, SUM(down) AS down FROM hourly WHERE target = '_' AND hour <= ?", rolled);
  assert.deepEqual([hr.up, hr.down], [raw.up, raw.down]);
  const row = q1("SELECT * FROM hourly WHERE target = 'api' AND hour = ?", rolled);
  assert.equal(row.p50, 230);
  assert.equal(row.up, 60);
});

let teamKey;
await scenario('дашборд: командная и личная ссылки, Mini App, чужим — 401', async () => {
  const page = await get('/app');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  await page.text();
  assert.equal((await get('/api/data')).status, 401);
  await hook(gm(DEV2, '/dash'));
  const team = sent().at(-1).params;
  teamKey = team.reply_markup.inline_keyboard[0][0].url.split('#k=')[1];
  const d = await (await get('/api/data?range=24h', { 'x-dash-key': teamKey })).json();
  assert.equal(d.ok, true);
  assert.equal(d.viewer, 'team');
  assert.equal(d.range, '24h');
  assert.equal(d.bucket, 300);
  assert.deepEqual(d.targets.map((t) => t.id), ['web', 'api']);
  assert.ok(d.series.web.length > 20 && d.series._.length > 20);
  assert.ok(d.series.web.length <= 289, 'корзины по 5 минут, а не по минуте: ' + d.series.web.length);
  assert.ok(d.series.web.every((r) => r[0] % 300 === 0), 'корзины выровнены по 5 минутам');
  assert.equal(d.series.web[0].length, 7);
  assert.equal(d.tiles.incidents, 3);
  assert.ok(d.tiles.uptime > 0 && d.tiles.uptime < 100);
  assert.equal(d.tiles.latency.api.p50, 230);
  assert.ok(d.tiles.mttr_s > 0 && d.tiles.mtta_s > 0);
  assert.ok(d.tiles.blips >= 1);
  assert.equal(d.status.svc, 1);
  assert.equal(d.status.targets[1].code, 401);
  assert.ok(d.days.length >= 1 && d.days.at(-1)[2] > 0);
  assert.ok(d.heat.length >= 1);
  assert.ok(d.incidents.some((i) => i.kind === 'drill'));
  assert.ok(d.incidents.some((i) => i.kind === 'planned'));
  const i0 = d.incidents.find((i) => i.kind === 'down' && i.acked);
  assert.equal(i0.acked, 'Александр');
  assert.ok(d.incidents.some((i) => i.pm && /утечки памяти/.test(i.pm) && i.pm_by === 'Мария'), 'разбор виден в журнале дашборда');
  for (const r of ['1h', '7d', '30d', '90d']) {
    const x = await (await get('/api/data?range=' + r, { 'x-dash-key': teamKey })).json();
    assert.equal(x.ok, true, r);
    assert.ok(x.series._.length >= 1, r);
  }
  const d30 = await (await get('/api/data?range=30d', { 'x-dash-key': teamKey })).json();
  assert.equal(d30.upper, 'p95');
  assert.equal(d30.tiles.incidents, 3);
  // личная ссылка
  await hook(pm(DEV, '/dash'));
  const personal = lastText(DEV.id).match(/\/app#k=(\S+)/)[1];
  assert.match(personal, /^u\.77\./);
  assert.equal((await get('/api/data', { 'x-dash-key': personal })).status, 200);
  // Mini App: подпись initData
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const params = new URLSearchParams({ auth_date: String(Math.floor(NOW / 1000)), user: JSON.stringify({ id: 77, first_name: 'Александр' }), query_id: 'q1' });
  const dataCheck = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  params.set('hash', createHmac('sha256', secret).update(dataCheck).digest('hex'));
  assert.equal((await get('/api/data', { 'x-tg-init-data': params.toString() })).status, 200);
  params.set('hash', 'f'.repeat(64));
  assert.equal((await get('/api/data', { 'x-tg-init-data': params.toString() })).status, 401);
  assert.equal((await get('/api/data', { 'x-dash-key': teamKey.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')) })).status, 401);
  // CSV
  const csv = await get('/api/incidents.csv', { 'x-dash-key': teamKey });
  assert.equal(csv.status, 200);
  const bytes = new Uint8Array(await csv.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'BOM для Excel');
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.startsWith('№;Начало (МСК)'));
  assert.match(text, /падение;API;API — 502 Bad Gateway;Александр/);
  assert.match(text.split('\r\n')[0], /;Разбор: что случилось и что сделали;Кто написал разбор$/);
  assert.match(text, /;"Упал php-fpm из-за утечки памяти в отчётах; перезапустили, подняли лимит, завели задачу";Мария/, 'разбор — в выгрузке');
  assert.match(text, /плановые работы/);
  assert.doesNotMatch(text, /учебная/);
});

await scenario('/newlinks отзывает ссылки; отвязка чата гасит командную ссылку', async () => {
  await hook(pm(OWNER, '/newlinks'));
  assert.equal((await get('/api/data', { 'x-dash-key': teamKey })).status, 401);
  await hook(gm(DEV2, '/dash'));
  const fresh = sent().at(-1).params.reply_markup.inline_keyboard[0][0].url.split('#k=')[1];
  assert.equal((await get('/api/data', { 'x-dash-key': fresh })).status, 200);
  teamKey = fresh;
});

await scenario('настройки владельца: тревога через 3 минуты, повтор 10; чужим нельзя', async () => {
  await hook(pm(OWNER, '/settings'));
  const v = sent().at(-1).params;
  assert.match(v.text, /Тревога после <b>2<\/b>/);
  await hook(cb(DEV, 'cfg:fail:3', DEV.id, 900));
  assert.match(calls.filter((c) => c.method === 'answerCallbackQuery').at(-1).params.text, /владелец/);
  await hook(cb(OWNER, 'cfg:fail:3', OWNER.id, 900));
  await hook(cb(OWNER, 'cfg:rem:10', OWNER.id, 900));
  const S = Object.fromEntries(q('SELECT key, value FROM settings').map((r) => [r.key, r.value]));
  assert.equal(S.fail_after, '3');
  assert.equal(S.remind_every, '10');
  assert.ok(calls.some((c) => c.method === 'editMessageText' && c.params.message_id === Number(S.board_msg) && /3 минуты подряд/.test(c.params.text) && /каждые 10 мин/.test(c.params.text)), 'закреп с инструкцией обновился');
  prod.web = '502';
  const before = calls.length;
  await ticks(2);
  assert.equal(since(before).filter((c) => /БАЗИС НЕДОСТУПЕН/.test(c.params.text || '')).length, 0, 'две минуты — ещё рано');
  await tick();
  assert.ok(since(before).some((c) => /БАЗИС НЕДОСТУПЕН/.test(c.params.text || '')), 'на третьей — тревога');
  prod.web = 'up';
  await ticks(2);
  await hook(cb(OWNER, 'cfg:fail:2', OWNER.id, 900));
  await hook(cb(OWNER, 'cfg:rem:5', OWNER.id, 900));
});

await scenario('дежурные: /oncall меняет список; участник не может', async () => {
  await hook(gm(DEV2, '/oncall @someone'));
  assert.match(lastText(GROUP), /меняют владелец и админы/);
  await hook(gm(OWNER, '/oncall @Kiss_Alexandr @ops_duty'));
  assert.match(lastText(GROUP), /@Kiss_Alexandr @ops_duty/);
  await hook(gm(OWNER, '/oncall'));
  assert.match(lastText(GROUP), /Сами попросили: Мария/);
  await hook(gm(OWNER, '/oncall reset'));
  assert.match(lastText(GROUP), /@Kiss_Alexandr @VitalyFeodorov @reffery101 @Ai_basis\b/);
  assert.doesNotMatch(lastText(GROUP), /LuzanIV/);
});

await scenario('проверки: добавить и убрать адрес', async () => {
  await hook(pm(OWNER, '/target_add Тест https://iflat.io/login 200'));
  assert.match(lastText(OWNER.id), /Добавил проверку <code>t3<\/code> «Тест».*\n.*✅ 200/);
  await tick();
  assert.equal(q1("SELECT st FROM checks WHERE target = 't3' ORDER BY ts DESC LIMIT 1").st, 1);
  await hook(pm(OWNER, '/targets'));
  assert.match(lastText(OWNER.id), /<code>t3<\/code> — <b>Тест<\/b>/);
  await hook(pm(DEV, '/target_del t3'));
  assert.match(lastText(DEV.id), /Только владелец/);
  await hook(pm(OWNER, '/target_del t3'));
  assert.match(lastText(OWNER.id), /Убрал проверку/);
  await hook(pm(OWNER, '/targets reset'));
  assert.match(lastText(OWNER.id), /\(по умолчанию\)/);
});

await scenario('заблокировавшему бота подписчику личка отключается', async () => {
  env.DB.db.prepare("INSERT INTO users (user_id, name, username, role, dm, mention, added_at) VALUES (555, 'Заблокировал', NULL, 'member', 1, 0, 0)").run();
  prod.api = '502';
  await ticks(2);
  assert.equal(q1('SELECT dm FROM users WHERE user_id = 555').dm, 0);
  prod.api = 'up';
  await ticks(2);
});

await scenario('итоги недели в понедельник в 10:00', async () => {
  // перематываем на ближайший понедельник 09:58 МСК
  let t = NOW;
  while (new Date(t + 3 * 3600e3).getUTCDay() !== 1) t += 86400e3;
  const d = new Date(t + 3 * 3600e3);
  NOW = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 9, 58) - 3 * 3600e3;
  const before = calls.length;
  await ticks(3);
  const weekly = since(before).filter((c) => c.method === 'sendMessage' && /Базис за неделю/.test(c.params.text));
  assert.equal(weekly.length, 1);
  assert.match(weekly[0].params.text, /Доступность <b>/);
  assert.equal(weekly[0].params.disable_notification, true);
  await ticks(2);
  assert.equal(calls.filter((c) => c.method === 'sendMessage' && /Базис за неделю/.test(c.params.text)).length, 1, 'один раз в неделю');
});

await scenario('вебхук: чужой секрет — 403, повтор апдейта — duplicate', async () => {
  const bad = await W.fetch(new Request(BASE + '/tg', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'nope' }, body: '{}' }), env, ctx);
  assert.equal(bad.status, 403);
  const u = pm(DEV, '/help');
  await hook(u);
  const r = await hook(u);
  assert.equal(await r.text(), 'duplicate');
});

// ─── темы форума ────────────────────────────────────────────────────────────
const TOPIC = 3;
const TOPIC2 = 7;
const FORUM = { id: GROUP, type: 'supergroup', title: 'Базис · разработка', is_forum: true };
const settings = () => Object.fromEntries(q('SELECT key, value FROM settings').map((r) => [r.key, r.value]));
// сообщение в теме: Telegram присылает его «ответом» на служебное «тема создана»
const tm = (from, text, thread = TOPIC) => gm(from, text, {
  chat: FORUM, is_topic_message: true, message_thread_id: thread,
  reply_to_message: { message_id: thread, date: 1, chat: FORUM, is_topic_message: true, message_thread_id: thread, forum_topic_created: { name: thread === TOPIC ? 'СЕРВИС НЕ ДОСТУПЕН' : 'Флуд', icon_color: 16478047 } },
});

await scenario('тема форума: /bind в теме — тревоги, закреп, «Беру», учения и ответы идут туда', async () => {
  assert.ok(q('PRAGMA table_info(incidents)').some((c) => c.name === 'thread_id'), 'миграция добавила колонку thread_id');
  const oldBoard = Number(settings().board_msg);
  await hook(tm(DEV, '/bind'));
  assert.match(lastText(GROUP), /только владелец/);
  assert.equal(sent().at(-1).params.message_thread_id, TOPIC, 'ответ в той же теме');
  let before = calls.length;
  await hook(tm(OWNER, '/bind'));
  let S = settings();
  assert.equal(S.thread_id, String(TOPIC));
  assert.equal(S.thread_title, 'СЕРВИС НЕ ДОСТУПЕН');
  const out = since(before).filter((c) => c.method === 'sendMessage');
  assert.match(out[0].params.text, /теперь приходят в эту тему «СЕРВИС НЕ ДОСТУПЕН»/);
  assert.ok(out.every((c) => c.params.message_thread_id === TOPIC), 'всё — в теме');
  assert.ok(out.some((c) => /Как читать сообщения бота/.test(c.params.text)), 'табло в теме');
  assert.equal(S.board_thread, String(TOPIC));
  assert.ok(since(before).some((c) => c.method === 'pinChatMessage' && String(c.params.message_id) === S.board_msg), 'табло закреплено');
  assert.ok(since(before).some((c) => c.method === 'unpinChatMessage' && c.params.message_id === oldBoard), 'старое табло откреплено');
  assert.ok(since(before).some((c) => c.method === 'editMessageText' && c.params.message_id === oldBoard && /переехали в тему «СЕРВИС НЕ ДОСТУПЕН»/.test(c.params.text)), 'в General остался указатель');
  const rn = () => calls.filter((c) => c.method === 'editForumTopic').map((c) => c.params.name);
  assert.equal(rn().at(-1), '🟢 Базис работает', 'в названии темы — статус');
  assert.equal(settings().topic_orig, 'СЕРВИС НЕ ДОСТУПЕН', 'исходное название запомнили');
  // бота сделали админом — табло закрепляется само
  before = calls.length;
  await hook({ update_id: uid++, my_chat_member: { chat: FORUM, from: OWNER, date: 1, old_chat_member: { status: 'member', user: { id: BOT_ID } }, new_chat_member: { status: 'administrator', can_pin_messages: true, user: { id: BOT_ID } } } });
  assert.ok(since(before).some((c) => c.method === 'pinChatMessage' && String(c.params.message_id) === S.board_msg));
  const thanks = since(before).find((c) => c.method === 'sendMessage');
  assert.match(thanks.params.text, /Табло со статусом закрепил/);
  assert.equal(thanks.params.message_thread_id, TOPIC);
  // падение: сирена, карточка, «Беру», «снова работает» — в теме
  prod.api = '502';
  before = calls.length;
  await ticks(2);
  const alert = since(before).filter((c) => c.method === 'sendMessage' && String(c.params.chat_id) === String(GROUP));
  assert.equal(alert[0].params.text, '🚨');
  assert.match(alert[1].params.text, /БАЗИС НЕДОСТУПЕН/);
  assert.ok(alert.every((c) => c.params.message_thread_id === TOPIC), 'сирена и карточка в теме');
  assert.equal(rn().at(-1), '🔴 Базис недоступен', 'падение — видно в названии темы');
  const inc = q1('SELECT * FROM incidents WHERE ended_at IS NULL');
  assert.equal(inc.thread_id, TOPIC);
  before = calls.length;
  await hook(cb(DEV, `ack:${inc.id}`));
  const ack = since(before).find((c) => c.method === 'sendMessage' && /берёт тревогу/.test(c.params.text));
  assert.equal(ack.params.message_thread_id, TOPIC);
  assert.equal(ack.params.reply_parameters.message_id, inc.msg_id);
  prod.api = 'up';
  before = calls.length;
  await ticks(2);
  const rec = since(before).find((c) => c.method === 'sendMessage' && /СНОВА РАБОТАЕТ/.test(c.params.text));
  assert.equal(rec.params.message_thread_id, TOPIC);
  assert.equal(rec.params.reply_parameters.message_id, inc.msg_id);
  assert.equal(rn().at(-1), '🟢 Базис работает', 'поднялся — снова зелёное название');
  // команда из другой темы — ответ там же
  await hook(tm(DEV2, '/status', TOPIC2));
  assert.equal(sent().at(-1).params.message_thread_id, TOPIC2);
  // /guide из другой темы: табло перевыкладывается в теме тревог, старое удаляется
  const b1 = Number(settings().board_msg);
  before = calls.length;
  await hook(tm(OWNER, '/guide', TOPIC2));
  S = settings();
  assert.notEqual(Number(S.board_msg), b1);
  assert.equal(S.board_thread, String(TOPIC));
  assert.ok(since(before).some((c) => c.method === 'deleteMessage' && c.params.message_id === b1), 'старое табло удалено');
  const ptr = since(before).find((c) => c.method === 'sendMessage' && /перевыложил и закрепил в теме «🟢 Базис работает»/.test(c.params.text));
  assert.equal(ptr.params.message_thread_id, TOPIC2);
  // /drill из General — учения в теме тревог, подсказка — в General
  before = calls.length;
  await hook(gm(OWNER, '/drill'));
  const d = since(before).filter((c) => c.method === 'sendMessage' && String(c.params.chat_id) === String(GROUP));
  assert.ok(d.some((c) => c.params.message_thread_id === TOPIC && /УЧЕБНАЯ ТРЕВОГА/.test(c.params.text)), 'учения в теме');
  const note = d.find((c) => /Учебная тревога запущена в теме «🟢 Базис работает»/.test(c.params.text));
  const renames = rn().length;
  assert.ok(note, 'подсказка, где учения');
  assert.equal(note.params.message_thread_id, undefined, 'подсказка — там, где спросили');
  const drill = q1("SELECT * FROM incidents WHERE kind = 'drill' AND ended_at IS NULL");
  assert.equal(drill.thread_id, TOPIC);
  await hook(cb(DEV2, `ack:${drill.id}`));
  before = calls.length;
  await tick();
  assert.equal(since(before).find((c) => /УЧЕНИЯ ОКОНЧЕНЫ/.test(c.params.text || '')).params.message_thread_id, TOPIC);
  assert.equal(rn().length, renames, 'учения название темы не трогают');
  // /mute из General: пауза объявляется в теме тревог и в General
  before = calls.length;
  await hook(gm(DEV, '/mute 10'));
  const mm = since(before).filter((c) => c.method === 'sendMessage' && /Плановые работы до/.test(c.params.text));
  assert.equal(mm.length, 2);
  assert.ok(mm.some((c) => c.params.message_thread_id === TOPIC) && mm.some((c) => c.params.message_thread_id === undefined));
  assert.equal(rn().at(-1), '🔧 Базис: плановые работы');
  await hook(tm(DEV, '/unmute'));
  assert.equal(rn().at(-1), '🟢 Базис работает');
  assert.equal(since(before).filter((c) => /Тревоги снова включены/.test(c.params.text || '')).length, 1, 'из темы тревог — без дубля');
  // тему переименовали — бот запомнил название
  await hook({ update_id: uid++, message: { message_id: 9001, from: OWNER, chat: FORUM, date: 1, is_topic_message: true, message_thread_id: TOPIC, forum_topic_edited: { name: '🚨 СЕРВИС НЕ ДОСТУПЕН' } } });
  assert.equal(settings().thread_title, '🚨 СЕРВИС НЕ ДОСТУПЕН');
  assert.equal(settings().topic_status, '0', 'переименовали вручную — статус в названии выключен');
  assert.match(lastText(OWNER.id), /переименовали вручную/);
  // своё переименование бот не принимает за ручное
  await hook({ update_id: uid++, message: { message_id: 9002, from: { id: BOT_ID, is_bot: true, first_name: 'Мониторинг' }, chat: FORUM, date: 1, is_topic_message: true, message_thread_id: TOPIC, forum_topic_edited: { name: '🟢 Базис работает' } } });
  assert.equal(settings().thread_title, '🚨 СЕРВИС НЕ ДОСТУПЕН');
  assert.ok(calls.some((c) => c.method === 'deleteMessage' && c.params.message_id === 9002), 'строку «переименовал тему» бот сразу убрал');
  // «Мониторинг закрепил…» — тоже убираем; чужой закреп и чужое переименование не трогаем
  let b2 = calls.length;
  await hook({ update_id: uid++, message: { message_id: 9003, from: { id: BOT_ID, is_bot: true, first_name: 'Мониторинг' }, chat: FORUM, date: 1, is_topic_message: true, message_thread_id: TOPIC, pinned_message: { message_id: 1234, date: 1, chat: FORUM } } });
  assert.ok(since(b2).some((c) => c.method === 'deleteMessage' && c.params.message_id === 9003), 'строку «закрепил» бот сразу убрал');
  b2 = calls.length;
  await hook({ update_id: uid++, message: { message_id: 9004, from: OWNER, chat: FORUM, date: 1, is_topic_message: true, message_thread_id: TOPIC2, pinned_message: { message_id: 1235, date: 1, chat: FORUM } } });
  assert.ok(!since(b2).some((c) => c.method === 'deleteMessage'), 'чужой закреп не трогаем');
  // удалить не дали — владельцу один раз подсказка про право «Удаление сообщений»
  undeletable.add(9005).add(9006);
  b2 = calls.length;
  for (const id of [9005, 9006]) await hook({ update_id: uid++, message: { message_id: id, from: { id: BOT_ID, is_bot: true, first_name: 'Мониторинг' }, chat: FORUM, date: 1, is_topic_message: true, message_thread_id: TOPIC, pinned_message: { message_id: 1236, date: 1, chat: FORUM } } });
  assert.equal(since(b2).filter((c) => c.method === 'sendMessage' && c.params.chat_id === OWNER.id && /Удаление сообщений/.test(c.params.text)).length, 1, 'подсказка — один раз');
  await hook(pm(OWNER, '/settings'));
  assert.match(lastText(OWNER.id), /Чат тревог: <b>Базис · разработка<\/b> · тема «🚨 СЕРВИС НЕ ДОСТУПЕН»/);
});

await scenario('тему закрыли или удалили — тревога не теряется: General и сообщение владельцу', async () => {
  // закрыта: пишем в General, привязку держим, владельцу — предупреждение
  closedTopics.add(TOPIC);
  prod.api = '502';
  let before = calls.length;
  await ticks(2);
  let card = since(before).find((c) => c.method === 'sendMessage' && String(c.params.chat_id) === String(GROUP) && /БАЗИС НЕДОСТУПЕН/.test(c.params.text));
  assert.ok(card, 'карточка дошла');
  assert.equal(card.params.message_thread_id, undefined, 'карточка — в General');
  assert.ok(since(before).some((c) => c.method === 'sendMessage' && c.params.chat_id === OWNER.id && /закрыта/.test(c.params.text)), 'владелец знает про закрытую тему');
  assert.equal(settings().thread_id, String(TOPIC), 'привязка к закрытой теме остаётся');
  assert.equal(q1('SELECT thread_id FROM incidents WHERE ended_at IS NULL').thread_id, null);
  prod.api = 'up';
  before = calls.length;
  await ticks(2);
  assert.equal(since(before).find((c) => /СНОВА РАБОТАЕТ/.test(c.params.text || '')).params.message_thread_id, undefined, 'ответ туда же, где карточка');
  closedTopics.delete(TOPIC);
  // удалена: General, привязка снимается, владельцу — сообщение
  deadTopics.add(TOPIC);
  prod.api = '502';
  before = calls.length;
  await ticks(2);
  card = since(before).find((c) => c.method === 'sendMessage' && String(c.params.chat_id) === String(GROUP) && /БАЗИС НЕДОСТУПЕН/.test(c.params.text));
  assert.ok(card, 'карточка дошла');
  assert.equal(card.params.message_thread_id, undefined);
  assert.ok(calls.some((c) => c.method === 'sendMessage' && c.params.chat_id === OWNER.id && /пропала/.test(c.params.text)), 'владелец знает про удалённую тему');
  assert.equal(settings().thread_id, undefined, 'привязка к теме снята');
  prod.api = 'up';
  await ticks(2);
  assert.equal(q1('SELECT COUNT(*) AS n FROM incidents WHERE ended_at IS NULL').n, 0);
  // /bind в General — табло возвращается в общую ленту
  before = calls.length;
  await hook(gm(OWNER, '/bind', { chat: FORUM }));
  assert.match(since(before).find((c) => c.method === 'sendMessage').params.text, /в общую ленту чата \(General\)/);
  assert.equal(settings().board_thread, undefined);
  deadTopics.delete(TOPIC);
});

await scenario('проверка раз в 5 минут: между проверками прод не трогаем, при сбое — каждую минуту', async () => {
  await hook(cb(OWNER, 'cfg:every:5', OWNER.id, 900));
  assert.equal(settings().check_every, '5');
  assert.match(calls.filter((c) => c.method === 'editMessageText' && c.params.message_id === 900).at(-1).params.text, /Проверка прода: <b>раз в 5 мин<\/b>, а пока что-то не так/);
  const hits = () => seen.filter((u) => u.startsWith('https://etalon.iflat.io/')).length;
  while ((minuteStart(NOW) / 60000 + 1) % 5 !== 0) await tick(); // следующий прогон — ровно на пятиминутке
  let h0 = hits();
  await ticks(5);
  assert.equal(hits() - h0, 2, 'за 5 минут — одна проверка: сайт и API');
  const rows = q("SELECT ts, st, ms, err FROM checks WHERE target = 'api' ORDER BY ts DESC LIMIT 5");
  assert.equal(rows.length, 5, 'строка на каждую минуту — доступность считается по минутам');
  assert.equal(rows.filter((r) => r.ms != null).length, 1, 'время ответа — только у настоящей проверки');
  assert.ok(rows.every((r) => r.st === 1 && r.err == null));
  const realTs = rows.find((r) => r.ms != null).ts;
  assert.equal(settings().last_check, String(realTs));
  await hook(gm(DEV2, '/status'));
  const st = lastText(GROUP);
  assert.match(st, /✅ API — 401 · 0,23 с/, 'статус — по настоящей проверке');
  assert.match(st, new RegExp(`Проверено в ${T.hhmm(realTs)} МСК · проверка раз в 5 мин, при сбое — каждую минуту`));
  // сбой: проверка на пятиминутке ловит, дальше — каждую минуту; тревога через минуту
  prod.api = '502';
  let before = calls.length;
  h0 = hits();
  await tick();
  assert.equal(hits() - h0, 3, 'на пятиминутке: сайт, API и повтор API');
  assert.equal(q1("SELECT st FROM checks WHERE target = '_' ORDER BY ts DESC LIMIT 1").st, 0);
  assert.ok(!since(before).some((c) => c.method === 'sendMessage' && /^🔴 <b>БАЗИС НЕДОСТУПЕН/.test(c.params.text || '')), 'одна неудачная проверка — ещё не тревога');
  h0 = hits();
  await tick();
  assert.ok(hits() - h0 >= 2, 'после сбоя проверяем в следующую же минуту');
  assert.ok(since(before).some((c) => c.method === 'sendMessage' && /^🔴 <b>БАЗИС НЕДОСТУПЕН/.test(c.params.text || '')), 'тревога через минуту после первой неудачной проверки');
  prod.api = 'up';
  h0 = hits();
  await ticks(2);
  assert.equal(hits() - h0, 4, 'пока падение открыто — каждую минуту');
  assert.ok(since(before).some((c) => /СНОВА РАБОТАЕТ/.test(c.params.text || '')));
  assert.equal(q1('SELECT COUNT(*) AS n FROM incidents WHERE ended_at IS NULL').n, 0);
  // поднялся — снова раз в 5 минут
  h0 = hits();
  await ticks(10);
  assert.equal(hits() - h0, 4, 'за 10 минут — две проверки');
  // дашборд: минуты между проверками — «работает», время ответа — только настоящие замеры
  const d = await (await get('/api/data?range=1h', { 'x-dash-key': teamKey })).json();
  assert.equal(d.settings.check_every, 5);
  const last10 = d.series.api.slice(-10); // 10 минут после восстановления
  assert.ok(last10.every((r) => r[1] === 1 && r[2] === 0), 'каждая минута на месте и «работает»');
  assert.equal(last10.filter((r) => r[5] != null).length, 2, 'время ответа — только у двух настоящих проверок');
  const hl = await (await get('/health')).json();
  assert.equal(hl.check_every_min, 5);
  assert.ok(hl.last_real_check_age_s <= 300);
  await hook(cb(OWNER, 'cfg:every:1', OWNER.id, 900));
});

await scenario('группа стала супергруппой; бота удалили из чата — владелец узнаёт', async () => {
  const NEW = -1009999;
  await hook({ update_id: uid++, message: { message_id: 1, from: OWNER, chat: { id: GROUP, type: 'group', title: 'Базис · разработка' }, date: 1, migrate_to_chat_id: NEW } });
  let S = Object.fromEntries(q('SELECT key, value FROM settings').map((r) => [r.key, r.value]));
  assert.equal(S.chat_id, String(NEW));
  await hook({ update_id: uid++, my_chat_member: { chat: { id: NEW, type: 'supergroup', title: 'Базис · разработка' }, from: OWNER, date: 1, old_chat_member: { status: 'administrator', user: { id: BOT_ID } }, new_chat_member: { status: 'left', user: { id: BOT_ID } } } });
  S = Object.fromEntries(q('SELECT key, value FROM settings').map((r) => [r.key, r.value]));
  assert.equal(S.chat_id, undefined);
  assert.match(lastText(OWNER.id), /Меня удалили из чата/);
  // без чата тревога идёт владельцу в личку
  prod.api = '502';
  const before = calls.length;
  await ticks(2);
  const card = since(before).find((c) => /БАЗИС НЕДОСТУПЕН/.test(c.params.text || ''));
  assert.equal(card.params.chat_id, OWNER.id);
  prod.api = 'up';
  await ticks(2);
});

await scenario('/health показывает, что монитор жив; debug/tick только с админ-ключом', async () => {
  assert.equal((await get('/health')).status, 200);
  assert.equal((await get('/debug/tick?dry=1')).status, 403);
  const r = await (await get('/debug/tick?dry=1', { 'x-admin-key': ADMIN })).json();
  assert.equal(r.dry, true);
  assert.equal(r.results.length, 2);
  assert.equal(r.control.st, 1);
  NOW += 10 * 60e3; // монитор 10 минут не запускался
  const stale = await get('/health');
  assert.equal(stale.status, 503);
});

console.log('\n' + results.map((r) => r.join(' ')).join('\n'));
console.log(`\n${results.filter((r) => r[0] === '✅').length}/${results.length} сценариев · ${calls.length} вызовов Telegram · ${env.DB.queries} запросов к базе`);

// DUMP=путь — сохранить стенограмму сообщений бота для вычитки
if (process.env.DUMP) {
  const fs = await import('node:fs');
  const kb = (m) => (m ? JSON.stringify((m.inline_keyboard || m.keyboard || []).map((r) => r.map((b) => b.text))) : '');
  fs.writeFileSync(process.env.DUMP, calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method))
    .map((c) => `── ${c.method} → ${c.params.chat_id}${c.params.disable_notification ? ' (тихо)' : ''}\n${c.params.text}\n${kb(c.params.reply_markup)}`).join('\n\n'));
}
