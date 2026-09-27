
// ─── проверки ───────────────────────────────────────────────────────────────

function getTargets(S) {
  const custom = safeJson(S && S.targets);
  if (Array.isArray(custom) && custom.length) return custom;
  return DEFAULT_TARGETS;
}

const HTTP_TEXT = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 408: 'Request Timeout',
  429: 'Too Many Requests', 500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable',
  504: 'Gateway Timeout', 520: 'Unknown Error', 521: 'Web Server Is Down', 522: 'Connection Timed Out', 523: 'Origin Is Unreachable',
  524: 'A Timeout Occurred', 525: 'SSL Handshake Failed', 526: 'Invalid SSL Certificate',
};

// Один запрос к адресу → { st: 1 работает | 0 не отвечает, code, ms, err }
async function probeTarget(t, timeoutMs = TIMEOUT_MS) {
  const started = Date.now();
  let r;
  try {
    r = await fetch(t.url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: t.kind === 'json' ? 'application/json' : 'text/html,application/xhtml+xml,*/*;q=0.8' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { st: 0, code: null, ms: Date.now() - started, err: netError(e, timeoutMs) };
  }
  const code = r.status;
  let body = '';
  try {
    body = await readText(r, 65536);
  } catch (e) {
    return { st: 0, code, ms: Date.now() - started, err: `ответ оборвался (HTTP ${code})` };
  }
  const ms = Date.now() - started;
  const expect = Array.isArray(t.expect) && t.expect.length ? t.expect.map(Number) : null;
  const codeOk = expect ? expect.includes(code) : code < 500;
  if (!codeOk) return { st: 0, code, ms, err: httpErr(code, r.statusText, body) };
  if (t.kind === 'html' && t.marker && !body.includes(t.marker)) return { st: 0, code, ms, err: `HTTP ${code}, но страница не та: «${pageHint(body)}»` };
  if (t.kind === 'json') {
    try {
      JSON.parse(body);
    } catch {
      return { st: 0, code, ms, err: `HTTP ${code}, но вместо JSON — «${pageHint(body)}»` };
    }
  }
  return { st: 1, code, ms, err: null };
}

function netError(e, timeoutMs) {
  const m = String((e && (e.message || e.name)) || e || '');
  if ((e && (e.name === 'TimeoutError' || e.name === 'AbortError')) || /timed? ?out|abort/i.test(m)) return `нет ответа за ${Math.round(timeoutMs / 1000)} с`;
  if (/dns|resolve|name not/i.test(m)) return 'адрес не находится (DNS)';
  if (/certificate|ssl|tls|handshake/i.test(m)) return 'ошибка SSL-сертификата';
  if (/refused/i.test(m)) return 'соединение отклонено';
  if (/reset|lost|closed|disconnect/i.test(m)) return 'соединение оборвалось';
  return 'не удалось подключиться: ' + trunc(m.replace(/\s+/g, ' '), 70);
}

function httpErr(code, statusText, body) {
  const txt = (statusText && statusText.trim()) || HTTP_TEXT[code] || '';
  const title = (String(body || '').match(/<title[^>]*>([^<]{1,80})<\/title>/i) || [])[1];
  const extra = title && !title.includes(String(code)) && !/^\s*$/.test(title) ? ` — «${trunc(decodeEntities(title).trim(), 50)}»` : '';
  return `${code}${txt ? ' ' + txt : ''}${extra}`;
}

function pageHint(body) {
  const s = String(body || '');
  const title = (s.match(/<title[^>]*>([^<]{1,120})<\/title>/i) || [])[1];
  const t = title ? decodeEntities(title) : s.replace(/<[^>]+>/g, ' ');
  return trunc(t.replace(/\s+/g, ' ').trim() || 'пусто', 50);
}

async function readText(r, max) {
  if (!r.body) return '';
  const reader = r.body.getReader();
  const chunks = [];
  let n = 0;
  while (n < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.byteLength;
  }
  if (n >= max) reader.cancel().catch(() => {});
  const buf = new Uint8Array(Math.min(n, max));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, buf.length - off);
    buf.set(c.subarray(0, take), off);
    off += take;
    if (off >= buf.length) break;
  }
  return new TextDecoder().decode(buf);
}

// Все проверки параллельно; неудачную повторяем один раз через несколько секунд (отсекаем случайные сбои)
async function runChecks(env, targets) {
  const delay = Number(env.RETRY_DELAY_MS != null ? env.RETRY_DELAY_MS : RETRY_DELAY_MS);
  const timeout = Number(env.TIMEOUT_MS != null ? env.TIMEOUT_MS : TIMEOUT_MS);
  return Promise.all(targets.map(async (t) => {
    let r = await probeTarget(t, timeout);
    if (r.st === 0) {
      await sleep(delay);
      const r2 = await probeTarget(t, timeout);
      r = r2.st === 1 ? { ...r2, err: 'сбой с первой попытки: ' + r.err } : r2;
    }
    return { id: t.id, name: t.name, ...r };
  }));
}

// ─── прогон раз в минуту ────────────────────────────────────────────────────
// Cron будит Worker каждую минуту, а прод проверяем раз в check_every минут (по умолчанию 5).
// Пока что-то не так — прошлая проверка не прошла, открыто падение, пауза, нет сети у монитора —
// проверяем каждую минуту: тревога приходит так же быстро, а в обычное время нагрузки в 5 раз меньше.
// Минуты между проверками пишутся «как на прошлой проверке» (всё работало), но без времени ответа:
// доступность и простои считаются по минутам, а время ответа — только по настоящим замерам.

function checkDue(S, ts, targets, incOpen, manual) {
  const every = Math.max(1, cfg(S, 'check_every'));
  if (manual || every <= 1 || incOpen) return true;
  const last = int(S.last_check, 0);
  if (!last || int(S.last_svc, 1) !== 1) return true;
  if (ts - last >= every * 60 || (ts / 60) % every === 0) return true; // ровная сетка :00, :05… или пропущенная минута
  const carry = safeJson(S.last_res);
  return !carry || targets.some((t) => !carry[t.id]); // список проверок поменялся — проверяем сразу
}

// Как часто проверяем — для сообщений: «раз в 5 мин, при сбое — каждую минуту»
function everyText(S) {
  const n = Math.max(1, cfg(S, 'check_every'));
  return n > 1 ? `раз в ${n} мин, при сбое — каждую минуту` : 'каждую минуту';
}

async function tick(env, scheduled, opts = {}) {
  await ensureSchema(env);
  const S = await loadSettings(env);
  const now = nowS();
  const ts = Math.floor(Number(scheduled) / 60000) * 60;
  await safely('mute', () => muteExpiry(env, S, now));
  const targets = getTargets(S);
  const muted = int(S.mute_until, 0) > now;
  const real = checkDue(S, ts, targets, !!(await openIncident(env)), !!opts.manual);
  let res;
  let svc;
  let control = null;

  if (real) {
    res = await runChecks(env, targets);
    // Не отвечает — проверяем, есть ли сеть у самого монитора
    if (res.some((r) => r.st === 0)) {
      control = await probeTarget({ id: 'control', url: CONTROL_URL, expect: null, kind: null }, 8000);
      if (control.st !== 1) {
        for (const r of res) if (r.st === 0) { r.st = -1; r.err = 'нет сети у монитора: ' + r.err; }
      }
    }
    if (muted) for (const r of res) if (r.st === 0) r.st = 2;
    svc = res.some((r) => r.st === 0) ? 0 : res.some((r) => r.st === 2) ? 2 : res.some((r) => r.st === -1) ? -1 : 1;
    const okMs = res.filter((r) => r.st === 1).map((r) => r.ms || 0);
    const last = {};
    for (const r of res) last[r.id] = { c: r.code == null ? null : r.code };
    const mark = { last_check: ts, last_svc: svc, last_res: JSON.stringify(last) };
    await env.DB.batch([
      ...res.map((r) => insCheck(env, r.id, ts, r.st, r.code, r.ms, r.err)),
      insCheck(env, '_', ts, svc, null, okMs.length ? Math.max(...okMs) : null, null),
      ...Object.entries(mark).map(([k, v]) => setStmt(env, k, v)),
    ]);
    for (const [k, v] of Object.entries(mark)) S[k] = String(v);
  } else {
    // Минута между проверками: прошлая проверка прошла — считаем, что работает, время ответа не пишем
    const carry = safeJson(S.last_res) || {};
    res = targets.map((t) => ({ id: t.id, name: t.name, st: 1, code: carry[t.id] ? carry[t.id].c : null, ms: null, err: null, carried: true }));
    svc = 1;
    await env.DB.batch([
      ...res.map((r) => insCheck(env, r.id, ts, 1, r.code, null, null)),
      insCheck(env, '_', ts, 1, null, null, null),
    ]);
  }

  const hist = await recentSvc(env, ts);
  const c = { ts, now, res, svc, hist, targets, muted, real, manual: !!opts.manual };
  let event = { type: 'none' };
  try {
    event = await evaluate(env, S, c);
  } catch (e) {
    console.error('evaluate', e && e.stack ? e.stack : e);
  }
  await safely('board', () => boardTick(env, S, c, event));
  await safely('topic', () => topicTick(env, S, c, event));
  await safely('drill', () => drillTick(env, S, now));
  await safely('rollup', () => rollupIfDue(env, S, ts));
  await safely('daily', () => dailyIfDue(env, S, now));
  await safely('net', () => netWatch(env, S, c));
  return { ts, svc, real, results: res, control, event: event && event.type };
}

async function safely(name, fn) {
  try {
    await fn();
  } catch (e) {
    console.error(name, e && e.stack ? e.stack : e);
  }
}

function insCheck(env, target, ts, st, code, ms, err) {
  return env.DB.prepare('INSERT OR REPLACE INTO checks (target, ts, st, code, ms, err) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(target, ts, st, code == null ? null : code, ms == null ? null : Math.round(ms), err == null ? null : trunc(err, 200));
}

async function recentSvc(env, ts) {
  const { results } = await env.DB.prepare("SELECT ts, st FROM checks WHERE target = '_' AND ts <= ? AND ts > ? ORDER BY ts DESC LIMIT 60")
    .bind(ts, ts - 3600).all();
  return (results || []).map((r) => ({ ts: Number(r.ts), st: Number(r.st) }));
}

// Серии одинаковых результатов с конца; минуты «нет сети у монитора» пропускаем
function streaks(hist) {
  const known = hist.filter((h) => h.st !== -1);
  const run = (want) => {
    let n = 0;
    for (const h of known) {
      if (h.st === want) n++;
      else break;
    }
    return n;
  };
  const down = run(0);
  const up = run(1);
  const planned = run(2);
  return {
    down, up, planned,
    downFrom: down ? known[down - 1].ts : null,
    upFrom: up ? known[up - 1].ts : null,
    plannedFrom: planned ? known[planned - 1].ts : null,
  };
}

function snapshot(res) {
  const o = {};
  for (const r of res) o[r.id] = { n: r.name, ok: r.st === 1 ? 1 : r.st === -1 ? null : 0, e: r.st === 1 ? null : r.err || null, c: r.code == null ? null : r.code };
  return o;
}

function causeOf(res) {
  const f = res.find((r) => r.st === 0 || r.st === 2);
  return f ? `${f.name} — ${f.err}` : null;
}

// Переходы: работает → упал → тревога → напоминания → «Беру» → снова работает
async function evaluate(env, S, c) {
  const k = streaks(c.hist);
  const failAfter = Math.max(1, cfg(S, 'fail_after'));
  const recAfter = Math.max(1, cfg(S, 'recover_after'));
  const snap = snapshot(c.res);
  let inc = await openIncident(env);

  if (!inc) {
    if (k.down >= failAfter) {
      inc = await createIncident(env, 'down', k.downFrom, c.now, snap, causeOf(c.res));
      if (inc) {
        await sendAlert(env, S, inc, c);
        return { type: 'down', inc };
      }
    } else if (k.planned >= failAfter) {
      inc = await createIncident(env, 'planned', k.plannedFrom, c.now, snap, causeOf(c.res));
      if (inc) {
        await sendPlannedDown(env, S, inc, c);
        return { type: 'planned', inc };
      }
    }
    return { type: c.svc === -1 ? 'unknown' : c.svc === 1 ? 'up' : 'pending' };
  }

  if (k.up >= recAfter) {
    await updateIncident(env, inc, { ended_at: k.upFrom });
    await sendRecovery(env, S, inc, c);
    return { type: 'recovered', inc };
  }

  if (inc.kind === 'planned') {
    if (!c.muted && c.svc === 0) {
      // Плановые работы закончились, а Базис не поднялся: плановый простой закрываем,
      // открываем настоящее падение с первой минуты после паузы и сразу тревожим
      const from = k.downFrom || c.ts;
      await updateIncident(env, inc, { ended_at: from });
      const down = await createIncident(env, 'down', from, c.now, snap, causeOf(c.res));
      if (down) {
        await updateIncident(env, down, { note: `after_planned:${inc.started_at}` });
        await sendAlert(env, S, down, c, { afterPlanned: true });
        return { type: 'down', inc: down };
      }
      return { type: 'none' };
    }
    return { type: 'planned_still', inc };
  }

  // Падение продолжается
  const fresh = c.svc === 0 || c.svc === 2;
  if (fresh && JSON.stringify(snap) !== JSON.stringify(inc.t)) {
    await updateIncident(env, inc, { targets: snap });
    await refreshCard(env, S, inc);
  }
  if (!inc.acked_at && !c.muted && c.svc === 0 && remindDue(S, inc, c.now)) {
    await sendReminder(env, S, inc, c);
    return { type: 'remind', inc };
  }
  if (c.now - (inc.last_edit || inc.confirmed_at || c.now) >= 290) await refreshCard(env, S, inc);
  return { type: 'still_down', inc };
}

function remindEvery(S, age) {
  if (age >= 7200) return 3600;
  if (age >= 1800) return 900;
  return Math.max(1, cfg(S, 'remind_every')) * 60;
}
function remindDue(S, inc, now) {
  const age = now - (inc.confirmed_at || inc.started_at);
  const last = inc.last_remind || inc.confirmed_at || inc.started_at;
  return now - last >= remindEvery(S, age) - 20;
}

// ─── почасовые сводки ───────────────────────────────────────────────────────

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

function aggregateRows(rows) {
  const by = {};
  for (const r of rows) {
    const a = by[r.target] || (by[r.target] = { up: 0, down: 0, planned: 0, unk: 0, blips: 0, ms: [] });
    const st = Number(r.st);
    if (st === 1) {
      a.up++;
      if (r.ms != null) a.ms.push(Number(r.ms));
      if (r.err) a.blips++;
    } else if (st === 0) a.down++;
    else if (st === 2) a.planned++;
    else a.unk++;
  }
  for (const a of Object.values(by)) {
    a.ms.sort((x, y) => x - y);
    a.avg = a.ms.length ? Math.round(a.ms.reduce((s, x) => s + x, 0) / a.ms.length) : null;
    a.p50 = quantile(a.ms, 0.5);
    a.p95 = quantile(a.ms, 0.95);
    a.max = a.ms.length ? a.ms[a.ms.length - 1] : null;
  }
  return by;
}

async function rollupIfDue(env, S, ts) {
  const cur = Math.floor(ts / 3600) * 3600;
  let last = int(S.rollup_hour, NaN);
  if (!Number.isFinite(last)) {
    const r = await env.DB.prepare('SELECT MIN(ts) AS ts FROM checks').first();
    if (!r || r.ts == null) return;
    last = Math.floor(Number(r.ts) / 3600) * 3600 - 3600;
  }
  const stmts = [];
  let done = 0;
  while (last + 7200 <= cur && done < 3) {
    const h = last + 3600;
    const { results } = await env.DB.prepare('SELECT target, st, ms, err FROM checks WHERE ts >= ? AND ts < ?').bind(h, h + 3600).all();
    for (const [target, a] of Object.entries(aggregateRows(results || []))) {
      stmts.push(env.DB.prepare('INSERT OR REPLACE INTO hourly (target, hour, up, down, planned, unk, blips, avg_ms, p50, p95, max_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(target, h, a.up, a.down, a.planned, a.unk, a.blips, a.avg, a.p50, a.p95, a.max));
    }
    last = h;
    done++;
  }
  if (done || S.rollup_hour == null) {
    stmts.push(setStmt(env, 'rollup_hour', last));
    await env.DB.batch(stmts);
    S.rollup_hour = String(last);
  }
}

// ─── раз в сутки и раз в неделю ─────────────────────────────────────────────

async function dailyIfDue(env, S, now) {
  const day = mskDay(now);
  const h = mskHour(now);
  if (h >= 3 && S.cleanup_day !== day) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM checks WHERE ts < ?').bind(now - RETENTION_DAYS * 86400),
      env.DB.prepare('DELETE FROM hourly WHERE hour < ?').bind(now - 400 * 86400),
      env.DB.prepare('DELETE FROM updates WHERE at < ?').bind(now - 7 * 86400),
      setStmt(env, 'cleanup_day', day),
    ]);
    S.cleanup_day = day;
  }
  // Итоги недели — в понедельник с 9:00 МСК
  const wd = mskWeekday(now); // 0 — понедельник
  const week = mskDay(now - wd * 86400);
  if (wd === 0 && h >= 9 && cfg(S, 'weekly') && S.weekly_sent !== week && S.chat_id) {
    await saveSettings(env, S, { weekly_sent: week });
    await sendWeekly(env, S, now);
  }
}

// Монитор сам остался без сети — скажем владельцу (эти минуты в статистику не идут)
async function netWatch(env, S, c) {
  let n = 0;
  for (const h of c.hist) {
    if (h.st === -1) n++;
    else break;
  }
  if (n >= 10 && !S.net_alert) {
    await saveSettings(env, S, { net_alert: c.now });
    await notifyOwner(env, `⚠️ <b>Монитор ${n} мин без сети</b>\nНе отвечает ни ${esc(SERVICE.host)}, ни контрольный ${esc(hostOf(CONTROL_URL))}. Похоже, проблема на стороне Cloudflare, а не Базиса. Эти минуты не считаются падением. Как сеть вернётся — напишу.`);
  } else if (n === 0 && S.net_alert) {
    const since = int(S.net_alert, c.now);
    await saveSettings(env, S, { net_alert: null });
    await notifyOwner(env, `✅ Сеть у монитора снова есть (не было примерно ${dur(c.now - since + 600)}). Проверки идут как обычно.`);
  }
}
