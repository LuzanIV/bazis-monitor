// Смоук-тест в настоящем рантайме Cloudflare (workerd через Miniflare): модуль грузится, D1 настоящая,
// Cron-прогон, вебхук, тревога, дашборд. Запуск: node build.mjs && node test/workerd.mjs
import { Miniflare } from 'miniflare';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const TOKEN = '1:SMOKE';
const SECRET = createHash('sha256').update(TOKEN + ':hook').digest('hex').slice(0, 48);
const ADMIN = createHash('sha256').update(TOKEN + ':admin').digest('hex').slice(0, 32);
const tg = [];
let msgId = 500;
const prod = { api: 'up' };

const mf = new Miniflare({
  modules: true,
  scriptPath: 'dist/worker.js',
  compatibilityDate: '2025-09-01',
  d1Databases: ['DB'],
  bindings: { BOT_TOKEN: TOKEN, RETRY_DELAY_MS: '0' },
  outboundService: async (req) => {
    const url = new URL(req.url);
    if (url.hostname === 'etalon.iflat.io' && url.pathname === '/login') {
      return new Response('<!doctype html><title>Вход</title><div id="app"></div>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (url.hostname === 'etalon.iflat.io' && url.pathname.startsWith('/api/v1/')) {
      if (prod.api === 'up') return Response.json({ message: 'Unauthenticated.' }, { status: 401 });
      return new Response('<html><head><title>502 Bad Gateway</title></head></html>', { status: 502, headers: { 'content-type': 'text/html' } });
    }
    if (url.hostname === 'ya.ru') return new Response('ok');
    if (url.hostname !== 'api.telegram.org') return new Response('blocked', { status: 599 });
    const method = url.pathname.split('/').pop();
    if (method === 'sendPhoto') {
      const fd = await req.formData().catch(() => null);
      const photo = fd && fd.get('photo');
      tg.push({ method, body: {
        chat_id: fd ? Number(fd.get('chat_id')) : undefined,
        caption: fd ? fd.get('caption') : undefined,
        message_thread_id: fd && fd.get('message_thread_id') ? Number(fd.get('message_thread_id')) : undefined,
        photo_size: photo && photo.size ? photo.size : 0,
        reply_markup: fd ? fd.get('reply_markup') : undefined,
      } });
      return Response.json({ ok: true, result: { message_id: ++msgId } });
    }
    const body = await req.json().catch(() => ({}));
    tg.push({ method, body });
    const result = method === 'getMe' ? { id: 999, username: 'smoke_monitor_bot' }
      : method === 'getChatMember' ? { status: body.user_id === 999 ? 'administrator' : 'member', can_pin_messages: true, can_manage_topics: true }
      : { message_id: ++msgId };
    return Response.json({ ok: true, result });
  },
});

const base = 'https://bazis-monitor.smoke.workers.dev';
const hook = async (u) => {
  const r = await mf.dispatchFetch(base + '/tg', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': SECRET, 'content-type': 'application/json' }, body: JSON.stringify(u) });
  await r.text();
  await new Promise((res) => setTimeout(res, 400)); // waitUntil в фоне
};
const OWNER = { id: 42, first_name: 'Илья', username: 'LuzanIV' };
const GROUP = -100777;
let uid = 1;

try {
  // база «как на проде»: incidents версии 1.0.0 без thread_id — проверяем миграцию в настоящей D1
  const db = await mf.getD1Database('DB');
  await db.prepare('CREATE TABLE incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, started_at INTEGER NOT NULL, confirmed_at INTEGER, ended_at INTEGER, targets TEXT, cause TEXT, acked_uid INTEGER, acked_name TEXT, acked_at INTEGER, chat_id INTEGER, msg_id INTEGER, reminders INTEGER NOT NULL DEFAULT 0, last_remind INTEGER, last_edit INTEGER, note TEXT)').run();
  const setup = await mf.dispatchFetch(base + '/setup');
  const html = await setup.text();
  assert.equal(setup.status, 200, html);
  assert.match(html, /✅ <b>Сайт<\/b>/);
  assert.match(html, /✅ <b>API<\/b>.*401/);
  await hook({ update_id: uid++, message: { message_id: 1, from: OWNER, chat: { id: 42, type: 'private' }, date: 1, text: '/start' } });
  assert.match(tg.filter((c) => c.method === 'sendMessage').at(-1).body.text, /Ты владелец/);
  await hook({ update_id: uid++, my_chat_member: { chat: { id: GROUP, type: 'supergroup', title: 'Разработка' }, from: OWNER, date: 1, old_chat_member: { status: 'left', user: { id: 999 } }, new_chat_member: { status: 'administrator', user: { id: 999 } } } });
  assert.ok(tg.some((c) => c.method === 'pinChatMessage'), 'инструкция закреплена');
  // тема форума: /bind в теме «СЕРВИС НЕ ДОСТУПЕН»
  const FORUM = { id: GROUP, type: 'supergroup', title: 'Разработка', is_forum: true };
  await hook({ update_id: uid++, message: { message_id: 50, from: OWNER, chat: FORUM, date: 1, text: '/bind', is_topic_message: true, message_thread_id: 5,
    reply_to_message: { message_id: 5, date: 1, chat: FORUM, is_topic_message: true, message_thread_id: 5, forum_topic_created: { name: 'СЕРВИС НЕ ДОСТУПЕН', icon_color: 16478047 } } } });
  const bound = tg.filter((c) => c.method === 'sendMessage' && /эту тему «СЕРВИС НЕ ДОСТУПЕН»/.test(c.body.text)).at(-1).body;
  assert.equal(bound.message_thread_id, 5);
  assert.equal(tg.filter((c) => c.method === 'editForumTopic').at(-1).body.name, '🟢 Базис работает', 'статус в названии темы');

  const worker = await mf.getWorker();
  // Прогоны по минутам начиная с ровной пятиминутки в прошлом: прод проверяется раз в 5 минут,
  // минуты между проверками пишутся «как было», при сбое — проверка каждую минуту
  const nowMin = Math.floor(Date.now() / 60000) * 60000;
  const start = Math.floor((nowMin - 12 * 60000) / 300000) * 300000;
  let i = 0;
  const tick = async () => worker.scheduled({ scheduledTime: new Date(start + i++ * 60000), cron: '* * * * *' });
  for (let k = 0; k < 5; k++) await tick(); // :00 — проверка, :01–:04 — «как было»
  const carried = await db.prepare("SELECT COUNT(*) AS n, SUM(ms IS NULL) AS nul FROM checks WHERE target = 'api'").first();
  assert.equal(carried.n, 5, 'строка на каждую минуту');
  assert.equal(carried.nul, 4, 'между проверками — без времени ответа');

  prod.api = 'down';
  const before = tg.length;
  await tick();
  await tick();
  const alertMsgs = tg.slice(before).filter((c) => c.method === 'sendMessage' && c.body.chat_id === GROUP);
  assert.ok(alertMsgs.length >= 2 && alertMsgs.every((c) => c.body.message_thread_id === 5), 'сирена и карточка — в теме');
  const texts = tg.slice(before).filter((c) => c.method === 'sendMessage').map((c) => c.body.text);
  assert.equal(texts[0], '🚨', 'сирена');
  assert.match(texts[1], /🔴 <b>БАЗИС НЕДОСТУПЕН<\/b>/);
  assert.match(texts[1], /❌ <b>API<\/b> — 502 Bad Gateway/);
  assert.match(texts[1], /@Ai_basis/);
  assert.doesNotMatch(texts[1], /@LuzanIV/, 'владельца не упоминаем');

  prod.api = 'up';
  await tick();
  await tick();
  while (start + i * 60000 <= nowMin) await tick(); // догоняем до текущей минуты — /health должен быть свежим
  assert.ok(tg.some((c) => c.method === 'sendMessage' && /СНОВА РАБОТАЕТ/.test(c.body.text) && c.body.message_thread_id === 5), 'восстановление — в теме');
  const row = await db.prepare('SELECT thread_id, pm_msg FROM incidents ORDER BY id DESC LIMIT 1').first();
  assert.equal(row.thread_id, 5, 'колонка thread_id добавлена миграцией и заполнена');
  assert.ok(row.pm_msg, 'колонки разбора добавлены миграцией, «снова работает» ждёт разбор');
  assert.equal(tg.filter((c) => c.method === 'editForumTopic').at(-1).body.name, '🟢 Базис работает');

  // итоги недели картинкой: рендерим PNG в настоящем рантайме и шлём как sendPhoto с кнопкой
  const wBefore = tg.length;
  const t0 = performance.now();
  const wr = await mf.dispatchFetch(base + '/debug/weekly', { headers: { 'x-admin-key': ADMIN } });
  const wMs = performance.now() - t0;
  assert.equal(wr.status, 200, await wr.text());
  const photo = tg.slice(wBefore).find((c) => c.method === 'sendPhoto');
  assert.ok(photo, 'итоги недели пришли картинкой (sendPhoto)');
  assert.equal(photo.body.message_thread_id, 5, 'итоги недели — в теме тревог');
  assert.ok(photo.body.photo_size > 2000, 'картинка приложена, ' + photo.body.photo_size + ' Б');
  assert.ok(photo.body.reply_markup && /inline_keyboard/.test(photo.body.reply_markup), 'кнопка дашборда');
  assert.match(photo.body.caption || '', /итоги недели/);
  console.log(`  итоги недели: картинка ${(photo.body.photo_size / 1024) | 0} КБ, /debug/weekly ${wMs.toFixed(0)} мс (вместе с I/O)`);

  const health = await mf.dispatchFetch(base + '/health');
  assert.equal(health.status, 200, await health.text());
  const data = await (await mf.dispatchFetch(base + '/api/data?range=1h', { headers: { 'x-admin-key': ADMIN } })).json();
  assert.equal(data.ok, true);
  assert.equal(data.tiles.incidents, 1);
  assert.ok(data.series.api.every((r) => Number.isInteger(r[0]) && r[0] % 60 === 0), 'корзины по минуте — целые');
  const d24 = await (await mf.dispatchFetch(base + '/api/data?range=24h', { headers: { 'x-admin-key': ADMIN } })).json();
  assert.ok(d24.series.api.every((r) => r[0] % 300 === 0), 'корзины по 5 минут в настоящей D1');
  const page = await mf.dispatchFetch(base + '/app');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Базис · мониторинг прода/);
  const icon = await mf.dispatchFetch(base + '/app/icon.png');
  assert.equal(icon.headers.get('content-type'), 'image/png');
  await icon.arrayBuffer();
  const csv = await mf.dispatchFetch(base + '/api/incidents.csv', { headers: { 'x-admin-key': ADMIN } });
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /API — 502 Bad Gateway/);
  console.log('✅ workerd: модуль, миграция D1, Cron, вебхук, тема форума, тревога, восстановление, дашборд —', tg.length, 'вызовов Telegram');
} catch (e) {
  console.error('❌', e);
  console.error(tg.slice(-5).map((c) => c.method + ' ' + JSON.stringify(c.body).slice(0, 200)).join('\n'));
  process.exitCode = 1;
} finally {
  await mf.dispose();
}
