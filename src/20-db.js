
// ─── база ───────────────────────────────────────────────────────────────────
// checks   — поминутные результаты: st 1 работает · 0 не отвечает · 2 не отвечает во время плановых работ ·
//            −1 не знаем (не было сети у самого монитора). target '_' — итог по сервису за минуту.
// hourly   — почасовые сводки по каждой проверке (для графиков за 30–90 дней и статистики)
// incidents— падения: kind down (настоящее) · planned (во время плановых работ) · drill (учебная тревога)

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS users (user_id INTEGER PRIMARY KEY, name TEXT, username TEXT, role TEXT NOT NULL DEFAULT 'member', dm INTEGER NOT NULL DEFAULT 0, mention INTEGER NOT NULL DEFAULT 0, added_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS updates (update_id INTEGER PRIMARY KEY, at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS checks (target TEXT NOT NULL, ts INTEGER NOT NULL, st INTEGER NOT NULL, code INTEGER, ms INTEGER, err TEXT, PRIMARY KEY (target, ts)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS hourly (target TEXT NOT NULL, hour INTEGER NOT NULL, up INTEGER NOT NULL DEFAULT 0, down INTEGER NOT NULL DEFAULT 0, planned INTEGER NOT NULL DEFAULT 0, unk INTEGER NOT NULL DEFAULT 0, blips INTEGER NOT NULL DEFAULT 0, avg_ms INTEGER, p50 INTEGER, p95 INTEGER, max_ms INTEGER, PRIMARY KEY (target, hour)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, started_at INTEGER NOT NULL, confirmed_at INTEGER, ended_at INTEGER, targets TEXT, cause TEXT, acked_uid INTEGER, acked_name TEXT, acked_at INTEGER, chat_id INTEGER, msg_id INTEGER, reminders INTEGER NOT NULL DEFAULT 0, last_remind INTEGER, last_edit INTEGER, note TEXT, thread_id INTEGER, pm_msg INTEGER, pm_text TEXT, pm_by TEXT, pm_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_incidents_open ON incidents (ended_at, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_incidents_start ON incidents (started_at)`,
];

// Колонки, которых не было в первых версиях: CREATE TABLE IF NOT EXISTS их в старую таблицу не добавит.
// Смотрим, чего не хватает (один запрос), и добавляем.
const ADD_COLUMNS = {
  incidents: [
    ['thread_id', 'INTEGER'], // 1.1.0: тема форума, где висит карточка тревоги
    ['pm_msg', 'INTEGER'], // 1.3.0: сообщение «снова работает», на которое отвечают разбором
    ['pm_text', 'TEXT'], // 1.3.0: разбор — что случилось и что сделали
    ['pm_by', 'TEXT'],
    ['pm_at', 'INTEGER'],
  ],
};

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  if (!env.DB) throw new Error('Нет привязки DB (D1)');
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  for (const [table, cols] of Object.entries(ADD_COLUMNS)) {
    const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    const have = new Set((results || []).map((r) => r.name));
    for (const [col, type] of cols) {
      if (have.has(col)) continue;
      try {
        await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`).run();
      } catch (e) {
        const text = e ? `${e.message || e} ${(e.cause && e.cause.message) || ''}` : '';
        if (!/duplicate column/i.test(text)) throw e; // параллельный запрос успел раньше
      }
    }
  }
  schemaReady = true;
}

// Настройки читаем одним запросом на весь прогон
async function loadSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const S = {};
  for (const r of results || []) S[r.key] = r.value;
  return S;
}
function setStmt(env, key, value) {
  if (value == null) return env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(key);
  return env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, String(value));
}
// set(env, S, {k: v}) — пишет в базу и сразу в объект настроек текущего прогона
async function saveSettings(env, S, obj) {
  const stmts = Object.entries(obj).map(([k, v]) => setStmt(env, k, v));
  if (stmts.length) await env.DB.batch(stmts);
  if (S) for (const [k, v] of Object.entries(obj)) {
    if (v == null) delete S[k];
    else S[k] = String(v);
  }
}

const int = (v, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};
const cfg = (S, key) => int(S[key], DEFAULTS[key]);

// ─── пользователи ───────────────────────────────────────────────────────────
// role: owner (владелец, первый после /setup) · member (участник чата разработчиков или по приглашению)

async function getUser(env, userId) {
  if (userId == null) return null;
  return env.DB.prepare('SELECT * FROM users WHERE user_id = ?').bind(userId).first();
}
async function countUsers(env) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  return r ? Number(r.n) : 0;
}
async function upsertUser(env, from, role = 'member', extra = {}) {
  const now = nowS();
  await env.DB.prepare(
    `INSERT INTO users (user_id, name, username, role, dm, mention, added_at) VALUES (?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, username = excluded.username`
  ).bind(from.id, userName(from), from.username || null, role, extra.dm ? 1 : 0, now).run();
  return getUser(env, from.id);
}
async function setUserFlag(env, userId, flag, value) {
  if (!['dm', 'mention'].includes(flag)) throw new Error('bad flag');
  await env.DB.prepare(`UPDATE users SET ${flag} = ? WHERE user_id = ?`).bind(value ? 1 : 0, userId).run();
}
async function owner(env) {
  return env.DB.prepare("SELECT * FROM users WHERE role = 'owner' ORDER BY added_at LIMIT 1").first();
}

// ─── инциденты ──────────────────────────────────────────────────────────────

function parseInc(r) {
  if (!r) return null;
  r.t = safeJson(r.targets) || {};
  return r;
}
async function getIncident(env, id) {
  return parseInc(await env.DB.prepare('SELECT * FROM incidents WHERE id = ?').bind(id).first());
}
async function openIncident(env) {
  return parseInc(await env.DB.prepare("SELECT * FROM incidents WHERE ended_at IS NULL AND kind IN ('down', 'planned') ORDER BY id DESC LIMIT 1").first());
}
// Открываем падение, только если открытого ещё нет (защита от двух прогонов подряд)
async function createIncident(env, kind, startedAt, confirmedAt, t, cause) {
  const r = await env.DB.prepare(
    `INSERT INTO incidents (kind, started_at, confirmed_at, targets, cause)
     SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM incidents WHERE ended_at IS NULL AND kind IN ('down', 'planned'))`
  ).bind(kind, startedAt, confirmedAt, JSON.stringify(t), cause || null).run();
  if (!r.meta || !r.meta.changes) return null;
  return getIncident(env, r.meta.last_row_id);
}
async function updateIncident(env, inc, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return inc;
  const vals = keys.map((k) => (k === 'targets' ? JSON.stringify(fields[k] || {}) : fields[k] === undefined ? null : fields[k]));
  await env.DB.prepare(`UPDATE incidents SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...vals, inc.id).run();
  keys.forEach((k, i) => {
    inc[k] = vals[i];
    if (k === 'targets') inc.t = fields[k] || {};
  });
  return inc;
}
