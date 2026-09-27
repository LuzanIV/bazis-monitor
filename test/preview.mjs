// Скриншоты дашборда в Chromium на правдоподобных данных за 90 дней (D1 → node:sqlite).
// Запуск: node build.mjs && node test/preview.mjs  → test/shots/*.png
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require(require('node:child_process').execSync('npm root -g').toString().trim() + '/playwright'));
}

class Stmt {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...p) { return new Stmt(this.db, this.sql, p); }
  async first() { const r = this.db.prepare(this.sql).get(...this.params); return r ? { ...r } : null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params).map((r) => ({ ...r })) }; }
  async run() { const i = this.db.prepare(this.sql).run(...this.params); return { meta: { changes: Number(i.changes), last_row_id: Number(i.lastInsertRowid) } }; }
}
class FakeD1 {
  constructor() { this.db = new DatabaseSync(':memory:'); }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) { this.db.exec('BEGIN'); for (const s of stmts) await s.run(); this.db.exec('COMMIT'); }
}

const NOW = Date.parse('2026-09-25T09:30:00Z'); // пятница, 12:30 МСК
Date.now = () => NOW;
const now = NOW / 1000;
const MSK = 3 * 3600;
const at = (iso) => Date.parse(iso + '+03:00') / 1000; // время по Москве → epoch

globalThis.fetch = async () => new Response('{"ok":true,"result":{"message_id":1,"username":"bazis_monitor_bot","id":1}}', { headers: { 'content-type': 'application/json' } });
const worker = await import('../dist/worker.js');
const W = worker.default;
const env = { DB: new FakeD1(), BOT_TOKEN: '1:PREVIEW' };
const ADMIN = createHash('sha256').update('1:PREVIEW:admin').digest('hex').slice(0, 32);
await W.fetch(new Request('https://mon.test/health'), env, {}); // создаёт таблицы
const db = env.DB.db;

// ─── модель данных ──────────────────────────────────────────────────────────
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const OUT = [
  // [начало МСК, минут, какие проверки, причина, кто взял, реакция мин, вид]
  ['2026-07-24T11:20:00', 52, ['web', 'api'], 'Сайт — 502 Bad Gateway', 'Виталий Федоров', 6, 'down'],
  ['2026-08-17T03:41:00', 4, ['web'], 'Сайт — нет ответа за 12 с', null, null, 'down'],
  ['2026-09-13T14:03:00', 17, ['api'], 'API — 502 Bad Gateway', 'Александр Кисс', 2, 'down'],
  ['2026-09-20T22:00:00', 35, ['web', 'api'], 'Сайт — HTTP 200, но страница не та: «Технические работы»', null, null, 'planned'],
  ['2026-09-24T16:40:00', 7, ['api'], 'API — 503 Service Unavailable', 'Артём', 1, 'down'],
  ['2026-09-25T11:00:00', 4, ['web', 'api'], 'учебная тревога', 'Мария', 1, 'drill'],
].map(([s, mins, t, cause, who, react, kind]) => ({ from: at(s), to: at(s) + mins * 60, t, cause, who, react, kind }));
const stateAt = (target, ts) => {
  for (const o of OUT) {
    if (o.kind === 'drill') continue;
    if (ts >= o.from && ts < o.to && (target === '_' || o.t.includes(target))) return o.kind === 'planned' ? 2 : 0;
  }
  return 1;
};
const base = (target, ts) => {
  const h = Math.floor(((ts + MSK) % 86400) / 3600);
  const wd = (Math.floor((ts + MSK) / 86400) + 3) % 7;
  const work = h >= 9 && h < 19 && wd < 5 ? 1 : 0;
  return (target === 'web' ? 232 : 214) + work * 48;
};
const sample = (target, ts) => {
  let ms = base(target, ts) * (0.85 + rnd() * 0.3);
  if (rnd() < 0.02) ms *= 2 + rnd() * 3; // редкие медленные ответы
  if (ts > at('2026-09-18T10:00:00') && ts < at('2026-09-18T11:30:00')) ms *= 4.5; // «тормозил» утром 18.09
  return Math.round(ms);
};

// поминутные данные за последние 8 суток
const rawFrom = Math.floor((now - 8 * 86400) / 3600) * 3600;
const lastMin = Math.floor(now / 60) * 60 - 60;
const ins = db.prepare('INSERT OR REPLACE INTO checks (target, ts, st, code, ms, err) VALUES (?, ?, ?, ?, ?, ?)');
db.exec('BEGIN');
for (let ts = rawFrom; ts <= lastMin; ts += 60) {
  let svc = 1;
  const oks = [];
  for (const t of ['web', 'api']) {
    const st = stateAt(t, ts);
    const blip = st === 1 && rnd() < 0.0015;
    const ms = st === 1 ? sample(t, ts) : st === 2 ? null : 12000;
    ins.run(t, ts, st, st === 1 ? (t === 'web' ? 200 : 401) : t === 'api' ? 503 : 502, ms, blip ? 'сбой с первой попытки: соединение оборвалось' : st === 1 ? null : 'не отвечает');
    if (st === 0) svc = 0;
    else if (st === 2 && svc !== 0) svc = 2;
    if (st === 1) oks.push(ms);
  }
  ins.run('_', ts, svc, null, oks.length ? Math.max(...oks) : null, null);
}
db.exec('COMMIT');

// почасовые сводки за 90 дней (последние 8 суток — из поминутных, как делает сам бот)
const hourNow = Math.floor(now / 3600) * 3600;
const rolled = hourNow - 3600;
const hins = db.prepare('INSERT OR REPLACE INTO hourly (target, hour, up, down, planned, unk, blips, avg_ms, p50, p95, max_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
const q = (a, p) => a[Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1))];
db.exec('BEGIN');
for (let h = hourNow - 90 * 86400; h <= rolled; h += 3600) {
  for (const t of ['web', 'api', '_']) {
    let up = 0, down = 0, planned = 0, blips = 0;
    const ms = [];
    if (h >= rawFrom) {
      for (const r of db.prepare('SELECT st, ms, err FROM checks WHERE target = ? AND ts >= ? AND ts < ?').all(t, h, h + 3600)) {
        if (r.st === 1) { up++; if (r.ms != null) ms.push(r.ms); if (r.err) blips++; } else if (r.st === 0) down++; else if (r.st === 2) planned++;
      }
    } else {
      for (let m = 0; m < 60; m++) {
        const ts = h + m * 60;
        const st = stateAt(t, ts);
        if (st === 1) { up++; ms.push(t === '_' ? Math.max(sample('web', ts), sample('api', ts)) : sample(t, ts)); if (rnd() < 0.0015) blips++; } else if (st === 0) down++; else planned++;
      }
    }
    ms.sort((a, b) => a - b);
    const avg = ms.length ? Math.round(ms.reduce((s, x) => s + x, 0) / ms.length) : null;
    hins.run(t, h, up, down, planned, 0, blips, avg, ms.length ? q(ms, 0.5) : null, ms.length ? q(ms, 0.95) : null, ms.length ? ms[ms.length - 1] : null);
  }
}
db.exec('COMMIT');

const incIns = db.prepare('INSERT INTO incidents (kind, started_at, confirmed_at, ended_at, targets, cause, acked_uid, acked_name, acked_at, reminders) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
for (const o of OUT) {
  const t = {};
  for (const [id, n] of [['web', 'Сайт'], ['api', 'API']]) t[id] = { n, ok: o.t.includes(id) ? 0 : 1, e: o.t.includes(id) ? o.cause.split(' — ')[1] : null, c: null };
  const confirmed = o.from + 120;
  incIns.run(o.kind, o.from, confirmed, o.to, JSON.stringify(t), o.cause, o.who ? 1 : null, o.who, o.who ? confirmed + o.react * 60 : null, o.who ? Math.floor(o.react / 5) : o.kind === 'down' ? 1 : 0);
}
const set = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
set.run('rollup_hour', String(rolled));
set.run('chat_id', '-100123');
set.run('chat_title', 'Базис · разработка');
set.run('bot_username', 'bazis_monitor_bot');

async function data(range) {
  const r = await W.fetch(new Request('https://mon.test/api/data?range=' + range, { headers: { 'x-admin-key': ADMIN } }), env, {});
  if (r.status !== 200) throw new Error('api ' + r.status + ' ' + (await r.text()));
  return r.json();
}
const DATA = {};
for (const r of ['1h', '24h', '7d', '30d', '90d']) DATA[r] = await data(r);
if (process.env.DUMP_DIR) for (const r of Object.keys(DATA)) fs.writeFileSync(process.env.DUMP_DIR + '/d' + r + '.json', JSON.stringify(DATA[r]));

// вариант «лежит прямо сейчас»
const down = JSON.parse(JSON.stringify(DATA['1h']));
down.status.svc = 0;
down.status.targets[1] = { ...down.status.targets[1], st: 0, code: 502, ms: 180, err: '502 Bad Gateway' };
down.status.incident = { id: 99, kind: 'down', start: now - 6 * 60, cause: 'API — 502 Bad Gateway', acked: 'Александр Кисс', ack_at: now - 3 * 60 };
const lastB = down.series._.slice(-6);
for (const r of lastB) { r[1] = 0; r[2] = 1; }
for (const r of down.series.api.slice(-6)) { r[1] = 0; r[2] = 1; r[5] = null; r[6] = null; }

// ─── браузер ────────────────────────────────────────────────────────────────
const html = fs.readFileSync(new URL('../app/app.html', import.meta.url), 'utf8');
const icon = fs.readFileSync(new URL('../app/icon.png', import.meta.url));
const shots = new URL('./shots/', import.meta.url);
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const problems = [];

async function shot(name, { width, height, range = '24h', theme = 'dark', override = null, full = true, before = null }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: width < 500 ? 2 : 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`${name}: console ${m.text()}`); });
  await page.addInitScript(([t, r]) => { localStorage.setItem('mon:theme', t); localStorage.setItem('mon:range', r); }, [theme, range]);
  await page.route('https://mon.test/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/app') return route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' });
    if (u.pathname === '/app/icon.png') return route.fulfill({ body: icon, contentType: 'image/png' });
    if (u.pathname === '/api/data') return route.fulfill({ body: JSON.stringify(override || DATA[u.searchParams.get('range')] || DATA['24h']), contentType: 'application/json' });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('https://mon.test/app#k=preview');
  await page.waitForSelector('#kpis .tile');
  await page.evaluate(() => document.fonts.ready);
  if (before) await before(page);
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 0) problems.push(`${name}: горизонтальная прокрутка ${overflow}px`);
  await page.screenshot({ path: new URL(name + '.png', shots).pathname, fullPage: full });
  console.log('✓', name);
  await ctx.close();
}

await shot('desktop-dark-24h', { width: 1440, height: 900 });
await shot('desktop-dark-24h-hover', {
  width: 1440, height: 900, full: false,
  before: async (page) => {
    const box = await page.locator('#lat svg').boundingBox();
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  },
});
await shot('desktop-light-7d', { width: 1440, height: 900, range: '7d', theme: 'light' });
await shot('desktop-dark-90d', { width: 1440, height: 900, range: '90d' });
await shot('desktop-dark-down-now', { width: 1280, height: 800, range: '1h', override: down, full: false });
await shot('mobile-dark-24h', { width: 390, height: 844 });
await shot('mobile-light-30d', { width: 390, height: 844, range: '30d', theme: 'light' });
await browser.close();

if (problems.length) {
  console.error('\n❌ ' + problems.join('\n❌ '));
  process.exitCode = 1;
} else console.log('\n✅ без ошибок в консоли и без горизонтальной прокрутки');
