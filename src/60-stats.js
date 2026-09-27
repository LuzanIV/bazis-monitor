
// ─── статистика ─────────────────────────────────────────────────────────────
// Доступность = минуты «работает» / (минуты «работает» + «не отвечает»).
// Плановые работы и минуты без сети у монитора в доступность не входят.

async function svcCounts(env, S, from, to, target = '_') {
  const out = { up: 0, down: 0, planned: 0, unk: 0 };
  const add = (r) => {
    if (!r) return;
    out.up += Number(r.up || 0);
    out.down += Number(r.down || 0);
    out.planned += Number(r.planned || 0);
    out.unk += Number(r.unk || 0);
  };
  const raw = async (a, b) => {
    if (b <= a) return;
    add(await env.DB.prepare('SELECT SUM(st = 1) AS up, SUM(st = 0) AS down, SUM(st = 2) AS planned, SUM(st = -1) AS unk FROM checks WHERE target = ? AND ts >= ? AND ts < ?')
      .bind(target, a, b).first());
  };
  const rolled = S.rollup_hour != null ? int(S.rollup_hour, 0) + 3600 : 0; // часы раньше rolled уже свёрнуты в hourly
  const hFrom = Math.ceil(from / 3600) * 3600;
  const hTo = Math.min(rolled, Math.floor(to / 3600) * 3600);
  if (rolled && hTo > hFrom) {
    add(await env.DB.prepare('SELECT SUM(up) AS up, SUM(down) AS down, SUM(planned) AS planned, SUM(unk) AS unk FROM hourly WHERE target = ? AND hour >= ? AND hour < ?')
      .bind(target, hFrom, hTo).first());
    await raw(from, hFrom);
    await raw(hTo, to);
  } else {
    await raw(from, to);
  }
  return out;
}

function pctNum(c) {
  const n = c.up + c.down;
  return n ? (c.up / n) * 100 : null;
}
function pctText(c) {
  const n = c.up + c.down;
  if (!n) return '—';
  if (!c.down) return '100 %';
  return `${(Math.floor((c.up / n) * 10000) / 100).toFixed(2).replace('.', ',')} %`;
}

async function countIncidents(env, from) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM incidents WHERE kind = 'down' AND started_at >= ?").bind(from).first();
  return r ? Number(r.n) : 0;
}

async function incidentsBetween(env, from, to) {
  const { results } = await env.DB.prepare("SELECT * FROM incidents WHERE kind IN ('down', 'planned') AND started_at < ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at DESC LIMIT 200")
    .bind(to, from).all();
  return (results || []).map(parseInc);
}

// Время ответа по поминутным данным (последние 10 дней): среднее, медиана, p95 — считает сама база
async function latencyRaw(env, target, from, to) {
  const c = await env.DB.prepare('SELECT COUNT(*) AS n, AVG(ms) AS avg FROM checks WHERE target = ? AND st = 1 AND ms IS NOT NULL AND ts >= ? AND ts < ?').bind(target, from, to).first();
  const n = Number((c && c.n) || 0);
  if (!n) return null;
  const at = async (q) => {
    const off = Math.max(0, Math.ceil(q * n) - 1);
    const r = await env.DB.prepare('SELECT ms FROM checks WHERE target = ? AND st = 1 AND ms IS NOT NULL AND ts >= ? AND ts < ? ORDER BY ms LIMIT 1 OFFSET ?').bind(target, from, to, off).first();
    return r ? Number(r.ms) : null;
  };
  return { n, avg: Math.round(Number(c.avg)), p50: await at(0.5), p95: await at(0.95), approx: false };
}
// По почасовым сводкам (дальше 10 дней) — приблизительно: взвешенное среднее часовых значений
async function latencyHourly(env, target, from, to) {
  const r = await env.DB.prepare('SELECT SUM(up) AS n, SUM(avg_ms * up) * 1.0 / NULLIF(SUM(up), 0) AS avg, SUM(p50 * up) * 1.0 / NULLIF(SUM(up), 0) AS p50, SUM(p95 * up) * 1.0 / NULLIF(SUM(up), 0) AS p95 FROM hourly WHERE target = ? AND hour >= ? AND hour < ?')
    .bind(target, from, to).first();
  if (!r || !Number(r.n)) return null;
  return { n: Number(r.n), avg: Math.round(r.avg), p50: Math.round(r.p50), p95: Math.round(r.p95), approx: true };
}
async function latency(env, target, from, to) {
  if (from >= nowS() - (RETENTION_DAYS - 1) * 86400) return latencyRaw(env, target, from, to);
  return latencyHourly(env, target, from, to);
}

// Последняя настоящая проверка (минуты между проверками без времени ответа не показываем)
async function lastChecks(env, S) {
  const lc = int(S.last_check, 0);
  let r = lc ? await env.DB.prepare("SELECT ts, st FROM checks WHERE target = '_' AND ts = ?").bind(lc).first() : null;
  if (!r) r = await env.DB.prepare("SELECT ts, st FROM checks WHERE target = '_' ORDER BY ts DESC LIMIT 1").first();
  if (!r) return null;
  const ids = getTargets(S).map((t) => t.id);
  const { results } = await env.DB.prepare(`SELECT target, st, code, ms, err FROM checks WHERE target IN (${ids.map(() => '?').join(',')}) AND ts = ?`).bind(...ids, r.ts).all();
  const rows = {};
  for (const x of results || []) rows[x.target] = { st: Number(x.st), code: x.code, ms: x.ms, err: x.err };
  return { ts: Number(r.ts), svc: Number(r.st), rows };
}

function checkLine(t, r) {
  if (!r) return `▫️ ${esc(t.name)} — ещё не проверял`;
  const note = r.st === 1 && r.code === 401 ? ' (без входа так и должно быть)' : '';
  if (r.st === 1) return `✅ ${esc(t.name)} — ${r.code} · ${sec(r.ms)}${note}${r.err ? ' · со второй попытки' : ''}`;
  if (r.st === -1) return `❔ ${esc(t.name)} — ${esc(r.err || 'нет данных')}`;
  if (r.st === 2) return `🔧 ${esc(t.name)} — ${esc(r.err || 'не отвечает')} (плановые работы)`;
  return `❌ <b>${esc(t.name)}</b> — ${esc(r.err || 'не отвечает')}`;
}

async function statusText(env, S) {
  const now = nowS();
  const last = await lastChecks(env, S);
  const L = await boardHead(env, S, now);
  if (last) {
    L.splice(1, 0, ...getTargets(S).map((t) => checkLine(t, last.rows[t.id])));
  }
  const inc = await openIncident(env);
  if (inc && inc.kind === 'down') L.push(`🔴 Падение с ${hhmm(inc.started_at)} МСК: ${esc(inc.cause || '')}`);
  if (int(S.mute_until, 0) > now) L.push(`🔧 Плановые работы до ${hhmm(int(S.mute_until, 0))} МСК (кто поставил паузу: ${esc(S.mute_by || '—')})`);
  return L.join('\n');
}

// «Проверить сейчас» — живой запрос без записи в статистику
async function liveCheckText(env, S) {
  const targets = getTargets(S);
  const res = await Promise.all(targets.map((t) => probeTarget(t, TIMEOUT_MS)));
  const d = new Date((nowS() + MSK) * 1000).toISOString().slice(11, 19);
  return [
    `🔄 <b>Проверил только что</b> · ${d} МСК`,
    ...targets.map((t, i) => checkLine(t, res[i])),
    '',
    `Регулярная проверка — ${everyText(S)}; тревога — после ${cfg(S, 'fail_after')} неудачных проверок подряд.`,
  ].join('\n');
}

async function statsText(env, S) {
  const now = nowS();
  const L = [`📊 <b>Доступность ${SERVICE.gen}</b> · ${esc(SERVICE.host)}`];
  for (const [label, s] of [['Сутки', 86400], ['7 дней', 7 * 86400], ['30 дней', 30 * 86400], ['90 дней', 90 * 86400]]) {
    const c = await svcCounts(env, S, now - s, now + 60);
    if (!c.up && !c.down) {
      L.push(`${label} — нет данных`);
      continue;
    }
    const n = await countIncidents(env, now - s);
    L.push(`${label} — <b>${pctText(c)}</b> · ${n ? `${n} ${plural(n, 'падение', 'падения', 'падений')}, простой ${dur(c.down * 60)}` : 'падений нет'}`);
  }
  const lat = [];
  for (const t of getTargets(S)) {
    const l = await latencyRaw(env, t.id, now - 86400, now + 60);
    if (l) lat.push(`${esc(t.name)} ${sec(l.avg)} (p95 ${sec(l.p95)})`);
  }
  if (lat.length) L.push('', `⏱ Время ответа за сутки: ${lat.join(' · ')}`);
  const r = await env.DB.prepare("SELECT COUNT(*) AS n, AVG(ended_at - started_at) AS mttr, AVG(CASE WHEN acked_at IS NOT NULL THEN acked_at - confirmed_at END) AS mtta FROM incidents WHERE kind = 'down' AND ended_at IS NOT NULL AND started_at >= ?")
    .bind(now - 90 * 86400).first();
  if (r && Number(r.n)) L.push(`🧯 За 90 дней: восстановление в среднем ${dur(r.mttr)}${r.mtta != null ? `, реакция на тревогу ${dur(r.mtta)}` : ''}`);
  const p = await svcCounts(env, S, now - 30 * 86400, now + 60);
  if (p.planned) L.push(`🔧 Плановые работы за 30 дней: ${dur(p.planned * 60)} — в доступность не входят`);
  const lastInc = await env.DB.prepare("SELECT * FROM incidents WHERE kind = 'down' ORDER BY started_at DESC LIMIT 1").first();
  if (lastInc) L.push(`Последнее падение: ${ddmm(lastInc.started_at)} в ${hhmm(lastInc.started_at)}${lastInc.ended_at ? ` — ${dur(lastInc.ended_at - lastInc.started_at)}` : ' — идёт сейчас'}${lastInc.cause ? `, ${esc(lastInc.cause)}` : ''}`);
  L.push('', '📈 Графики — /dash');
  return L.join('\n');
}

function incidentLine(i, now) {
  const icon = i.kind === 'planned' ? '🔧' : '🔴';
  const len = i.ended_at ? dur(i.ended_at - i.started_at) : `${dur(now - i.started_at)}, идёт сейчас`;
  const who = i.kind === 'planned' ? 'плановые работы' : i.acked_at ? `${esc(i.acked_name)}, реакция ${dur(i.acked_at - (i.confirmed_at || i.started_at))}` : 'никто не взял';
  const pm = i.pm_text ? `\n    📝 ${esc(trunc(i.pm_text, 120))}` : '';
  return `${icon} ${ddmm(i.started_at)} ${hhmm(i.started_at)} — <b>${len}</b> · ${esc(trunc(i.cause || '—', 60))} · ${who}${pm}`;
}

async function incidentsText(env, S) {
  const now = nowS();
  const { results } = await env.DB.prepare("SELECT * FROM incidents WHERE kind IN ('down', 'planned') ORDER BY started_at DESC LIMIT 12").all();
  if (!results || !results.length) return '🧯 <b>Журнал падений</b>\nПадений пока не было 👌';
  const c = await svcCounts(env, S, now - 90 * 86400, now + 60);
  const n = await countIncidents(env, now - 90 * 86400);
  return [
    `🧯 <b>Журнал падений</b> · последние ${results.length}`,
    ...results.map((i) => incidentLine(i, now)),
    '',
    `За 90 дней: ${n} ${plural(n, 'падение', 'падения', 'падений')}, простой ${dur(c.down * 60)}, доступность ${pctText(c)}. Весь журнал в CSV — в дашборде (/dash).`,
  ].join('\n');
}

// Итоги за период (неделя) — для сообщения в чат
// (periodSummary убрана в 1.4.0 — итоги недели теперь картинкой + подпись, см. sendWeekly в 40-alerts.js)

// ─── данные для дашборда ────────────────────────────────────────────────────

const RANGES = {
  '1h': { sec: 3600, bucket: 60 },
  '24h': { sec: 86400, bucket: 300 },
  '7d': { sec: 7 * 86400, bucket: 3600 },
  '30d': { sec: 30 * 86400, bucket: 10800 },
  '90d': { sec: 90 * 86400, bucket: 21600 },
};

async function onApiData(env, request, url) {
  if (!env.BOT_TOKEN) return json({ ok: false, error: 'not configured' }, 503);
  await ensureSchema(env);
  const S = await loadSettings(env);
  const who = await dashAuth(env, S, request);
  if (!who) return json({ ok: false, error: 'unauthorized' }, 401, { 'cache-control': 'no-store' });
  const key = RANGES[url.searchParams.get('range')] ? url.searchParams.get('range') : '24h';
  return json(await dashData(env, S, key, who), 200, { 'cache-control': 'no-store' });
}

function mergeBucket(map, target, r) {
  const k = `${target}|${r.b}`;
  const cur = map.get(k);
  const row = [Number(r.b), Number(r.up || 0), Number(r.down || 0), Number(r.planned || 0), Number(r.unk || 0), r.avg == null ? null : Math.round(Number(r.avg)), r.mx == null ? null : Number(r.mx)];
  if (!cur) {
    map.set(k, { target, row });
    return;
  }
  const a = cur.row;
  const upA = a[1];
  const upB = row[1];
  a[5] = a[5] == null ? row[5] : row[5] == null ? a[5] : Math.round((a[5] * upA + row[5] * upB) / Math.max(1, upA + upB));
  a[6] = a[6] == null ? row[6] : row[6] == null ? a[6] : Math.max(a[6], row[6]);
  for (let i = 1; i <= 4; i++) a[i] += row[i];
}

async function dashData(env, S, key, who) {
  const R = RANGES[key];
  const now = nowS();
  const to = Math.floor(now / 60) * 60 + 60;
  const from = alignMsk(to - R.sec, R.bucket);
  const targets = getTargets(S).map((t) => ({ id: t.id, name: t.name, url: t.url }));
  const ids = [...targets.map((t) => t.id), '_'];
  const inList = ids.map(() => '?').join(',');
  const rolled = S.rollup_hour != null ? int(S.rollup_hour, 0) + 3600 : 0;
  const useHourly = R.bucket >= 3600 && rolled > from;
  const B = R.bucket; // вставляем числом прямо в SQL: привязанные числа база может считать дробными, и деление перестанет округлять

  // ряды для графиков
  const buckets = new Map();
  const rawFrom = useHourly ? Math.max(from, rolled) : from;
  const raw = await env.DB.prepare(
    `SELECT target, ((ts + ${MSK}) / ${B}) * ${B} - ${MSK} AS b, SUM(st = 1) AS up, SUM(st = 0) AS down, SUM(st = 2) AS planned, SUM(st = -1) AS unk,
            AVG(CASE WHEN st = 1 THEN ms END) AS avg, MAX(CASE WHEN st = 1 THEN ms END) AS mx
       FROM checks WHERE target IN (${inList}) AND ts >= ? AND ts < ? GROUP BY target, b`
  ).bind(...ids, rawFrom, to).all();
  for (const r of raw.results || []) mergeBucket(buckets, r.target, r);
  if (useHourly) {
    const hr = await env.DB.prepare(
      `SELECT target, ((hour + ${MSK}) / ${B}) * ${B} - ${MSK} AS b, SUM(up) AS up, SUM(down) AS down, SUM(planned) AS planned, SUM(unk) AS unk,
              SUM(avg_ms * up) * 1.0 / NULLIF(SUM(up), 0) AS avg, MAX(p95) AS mx
         FROM hourly WHERE target IN (${inList}) AND hour >= ? AND hour < ? GROUP BY target, b`
    ).bind(...ids, from, rolled).all();
    for (const r of hr.results || []) mergeBucket(buckets, r.target, r);
  }
  const series = {};
  for (const id of ids) series[id] = [];
  for (const { target, row } of buckets.values()) if (series[target]) series[target].push(row);
  for (const id of ids) series[id].sort((a, b) => a[0] - b[0]);

  // плитки
  const c = await svcCounts(env, S, from, to);
  const incs = await incidentsBetween(env, from, to);
  const real = incs.filter((i) => i.kind === 'down');
  const closed = real.filter((i) => i.ended_at);
  const acked = real.filter((i) => i.acked_at);
  const lat = {};
  for (const t of targets) lat[t.id] = await latency(env, t.id, from, to);
  let blips = 0;
  if (useHourly) {
    const b = await env.DB.prepare(`SELECT SUM(blips) AS n FROM hourly WHERE target IN (${inList}) AND hour >= ? AND hour < ?`).bind(...ids, from, rolled).first();
    blips += Number((b && b.n) || 0);
  }
  const rb = await env.DB.prepare(`SELECT COUNT(*) AS n FROM checks WHERE target IN (${inList}) AND st = 1 AND err IS NOT NULL AND ts >= ? AND ts < ?`).bind(...ids, rawFrom, to).first();
  blips += Number((rb && rb.n) || 0);
  const tiles = {
    up: c.up, down: c.down, planned: c.planned, unk: c.unk,
    uptime: pctNum(c),
    incidents: real.length,
    downtime_s: c.down * 60,
    mttr_s: closed.length ? Math.round(closed.reduce((s, i) => s + (i.ended_at - i.started_at), 0) / closed.length) : null,
    mtta_s: acked.length ? Math.round(acked.reduce((s, i) => s + (i.acked_at - (i.confirmed_at || i.started_at)), 0) / acked.length) : null,
    latency: lat,
    blips,
  };

  // 90 дней полосками и «когда падает»
  const dayFrom = mskDayStart(now) - 89 * 86400;
  const dayMap = new Map();
  const addDay = (r) => {
    const d = Number(r.d);
    const cur = dayMap.get(d) || [d, 0, 0, 0, 0, 0];
    cur[1] += Number(r.up || 0);
    cur[2] += Number(r.down || 0);
    cur[3] += Number(r.planned || 0);
    cur[4] += Number(r.unk || 0);
    dayMap.set(d, cur);
  };
  if (rolled > dayFrom) {
    const hd = await env.DB.prepare(`SELECT (hour + ${MSK}) / 86400 AS d, SUM(up) AS up, SUM(down) AS down, SUM(planned) AS planned, SUM(unk) AS unk FROM hourly WHERE target = '_' AND hour >= ? AND hour < ? GROUP BY d`)
      .bind(dayFrom, rolled).all();
    for (const r of hd.results || []) addDay(r);
  }
  const rd = await env.DB.prepare(`SELECT (ts + ${MSK}) / 86400 AS d, SUM(st = 1) AS up, SUM(st = 0) AS down, SUM(st = 2) AS planned, SUM(st = -1) AS unk FROM checks WHERE target = '_' AND ts >= ? GROUP BY d`)
    .bind(Math.max(dayFrom, rolled)).all();
  for (const r of rd.results || []) addDay(r);
  const di = await env.DB.prepare(`SELECT (started_at + ${MSK}) / 86400 AS d, COUNT(*) AS n FROM incidents WHERE kind = 'down' AND started_at >= ? GROUP BY d`).bind(dayFrom).all();
  for (const r of di.results || []) {
    const d = Number(r.d);
    const cur = dayMap.get(d) || [d, 0, 0, 0, 0, 0];
    cur[5] = Number(r.n);
    dayMap.set(d, cur);
  }
  const days = [...dayMap.values()].sort((a, b) => a[0] - b[0]);
  const heat = (await env.DB.prepare(`SELECT ((hour + ${MSK}) / 86400 + 3) % 7 AS wd, ((hour + ${MSK}) % 86400) / 3600 AS h, SUM(down) AS down, SUM(up + down) AS n FROM hourly WHERE target = '_' AND hour >= ? GROUP BY wd, h`)
    .bind(dayFrom).all()).results.map((r) => [Number(r.wd), Number(r.h), Number(r.down || 0), Number(r.n || 0)]);

  // журнал — 90 дней, включая учения
  const jl = (await env.DB.prepare('SELECT * FROM incidents WHERE started_at >= ? OR ended_at IS NULL ORDER BY started_at DESC LIMIT 300').bind(dayFrom).all()).results || [];
  const incidents = jl.map((r) => {
    const i = parseInc(r);
    return {
      id: i.id, kind: i.kind, start: i.started_at, end: i.ended_at, confirmed: i.confirmed_at,
      dur: (i.ended_at || now) - i.started_at, cause: i.cause, acked: i.acked_name || null,
      ack_s: i.acked_at ? i.acked_at - (i.confirmed_at || i.started_at) : null, reminders: i.reminders || 0,
      pm: i.pm_text || null, pm_by: i.pm_by || null,
      targets: Object.values(i.t || {}).filter((t) => t.ok === 0).map((t) => t.n),
    };
  });

  // сейчас
  const last = await lastChecks(env, S);
  const open = await openIncident(env);
  const mute = int(S.mute_until, 0);
  const status = {
    svc: last ? last.svc : null,
    checked_at: last ? last.ts : null,
    age_s: last ? now - last.ts : null,
    targets: targets.map((t) => ({ id: t.id, name: t.name, ...(last && last.rows[t.id] ? last.rows[t.id] : { st: null }) })),
    incident: open ? { id: open.id, kind: open.kind, start: open.started_at, cause: open.cause, acked: open.acked_name || null, ack_at: open.acked_at } : null,
    mute_until: mute > now ? mute : null,
    mute_by: mute > now ? S.mute_by || null : null,
    drill: !!safeJson(S.drill),
  };

  return {
    ok: true,
    version: VERSION,
    now,
    generated_at: nowIso(),
    viewer: who ? who.via : null,
    service: { name: SERVICE.name, host: SERVICE.host, url: SERVICE.openUrl },
    bot: S.bot_username || null,
    chat: S.chat_title || null,
    topic: S.chat_id && S.thread_id ? S.thread_title || 'отдельная тема' : null,
    range: key,
    from,
    to,
    bucket: B,
    upper: useHourly ? 'p95' : 'max',
    slow_ms: SLOW_MS,
    settings: { fail_after: cfg(S, 'fail_after'), remind_every: cfg(S, 'remind_every'), check_every: Math.max(1, cfg(S, 'check_every')) },
    status,
    targets,
    series,
    tiles,
    days,
    heat,
    incidents,
  };
}

// Весь журнал падений для Excel: UTF-8 с BOM, разделитель «;»
async function onIncidentsCsv(env, request, url) {
  await ensureSchema(env);
  const S = await loadSettings(env);
  if (!(await dashAuth(env, S, request))) return new Response('unauthorized', { status: 401 });
  const { results } = await env.DB.prepare("SELECT * FROM incidents WHERE kind IN ('down', 'planned') ORDER BY started_at DESC").all();
  const head = ['№', 'Начало (МСК)', 'Конец (МСК)', 'Длительность, мин', 'Вид', 'Что не отвечало', 'Причина', 'Взял', 'Реакция, мин', 'Напоминаний', 'Разбор: что случилось и что сделали', 'Кто написал разбор'];
  const lines = [head.join(';')];
  for (const r of results || []) {
    const i = parseInc(r);
    const down = Object.values(i.t || {}).filter((t) => t.ok === 0).map((t) => t.n).join(', ');
    lines.push([
      i.id, fmtDateTime(i.started_at), i.ended_at ? fmtDateTime(i.ended_at) : 'идёт',
      i.ended_at ? String(Math.round((i.ended_at - i.started_at) / 6) / 10).replace('.', ',') : '',
      i.kind === 'planned' ? 'плановые работы' : 'падение', down, i.cause || '', i.acked_name || '',
      i.acked_at ? String(Math.round((i.acked_at - (i.confirmed_at || i.started_at)) / 6) / 10).replace('.', ',') : '', i.reminders || 0,
      i.pm_text || '', i.pm_by || '',
    ].map(csvCell).join(';'));
  }
  return new Response('﻿' + lines.join('\r\n'), {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="bazis-incidents-${mskDay(nowS())}.csv"`, 'cache-control': 'no-store' },
  });
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
