
// ─── точка входа ────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    ORIGIN = url.origin;
    const p = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
      if (p === '/app') return appPage();
      if (p === '/app/icon.png' || p === '/apple-touch-icon.png' || p === '/favicon.ico') return iconImage();
      if (p === '/app/manifest.webmanifest') return manifest();
      if (p === '/api/data') return await onApiData(env, request, url);
      if (p === '/api/incidents.csv') return await onIncidentsCsv(env, request, url);
      if (p === '/tg' && request.method === 'POST') return await onWebhook(request, env, ctx);
      if (p === '/setup') return await onSetup(env, url);
      if (p === '/health') return await onHealth(env);
      if (p === '/debug/tick') return await onDebugTick(env, url, request);
      if (p === '/debug/weekly') return await onDebugWeekly(env, url, request);
      if (p === '/') return Response.redirect(`${url.origin}/app`, 302);
      return new Response(`Базис · мониторинг v${VERSION}`, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    } catch (e) {
      console.error('fatal', e && e.stack ? e.stack : e);
      return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
    }
  },

  // Cron Trigger «* * * * *»: раз в минуту проверяем прод
  async scheduled(controller, env, ctx) {
    try {
      await tick(env, controller && controller.scheduledTime ? controller.scheduledTime : Date.now());
    } catch (e) {
      console.error('tick failed', e && e.stack ? e.stack : e);
    }
  },
};

async function onHealth(env) {
  if (!env.DB) return json({ ok: false, error: 'нет привязки DB' }, 503);
  await ensureSchema(env);
  const r = await env.DB.prepare("SELECT MAX(ts) AS ts FROM checks WHERE target = '_'").first();
  const age = r && r.ts ? nowS() - Number(r.ts) : null;
  // Cron пишет строку каждую минуту — и при проверке, и между проверками; настоящая проверка — раз в check_every минут
  const S = await loadSettings(env);
  const every = Math.max(1, cfg(S, 'check_every'));
  const real = int(S.last_check, 0);
  const realAge = real ? nowS() - real : null;
  const fresh = age != null && age < 180 && (realAge == null || realAge < every * 60 + 180);
  return json({ ok: fresh, version: VERSION, last_check_age_s: age, last_real_check_age_s: realAge, check_every_min: every }, fresh ? 200 : 503, { 'cache-control': 'no-store' });
}

async function onDebugTick(env, url, request) {
  if (!(await isAdmin(env, url, request))) return new Response('forbidden', { status: 403 });
  await ensureSchema(env);
  if (url.searchParams.get('dry')) {
    const S = await loadSettings(env);
    const res = await runChecks(env, getTargets(S));
    const control = await probeTarget({ id: 'control', url: CONTROL_URL, expect: null, kind: null }, 8000);
    return json({ ok: true, dry: true, results: res, control });
  }
  const out = await tick(env, Date.now(), { manual: true });
  return json({ ok: true, ...out });
}

// Прислать итоги недели сейчас (админ-ключ) — для проверки отчёта и картинки, не дожидаясь понедельника
async function onDebugWeekly(env, url, request) {
  if (!(await isAdmin(env, url, request))) return new Response('forbidden', { status: 403 });
  await ensureSchema(env);
  const S = await loadSettings(env);
  if (!S.chat_id) return json({ ok: false, error: 'чат для тревог не назначен' }, 400);
  await sendWeekly(env, S, nowS());
  return json({ ok: true });
}
