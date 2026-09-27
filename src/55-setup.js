
// ─── /setup — настройка в один заход (открывать можно сколько угодно раз) ────

async function onSetup(env, url) {
  const title = `${SERVICE.name} · мониторинг — настройка`;
  if (!env.DB) {
    return html(title, '<p>⏳ Код загружен. Осталось привязать базу: Worker → Settings → Bindings → Add → <b>D1 database</b>, имя переменной <code>DB</code>. Потом обнови эту страницу.</p>');
  }
  if (!env.BOT_TOKEN) {
    return html(title, '<p>⏳ База привязана. Осталось добавить секрет <b>BOT_TOKEN</b> (токен от @BotFather): Worker → Settings → Variables and Secrets → Add → тип <i>Secret</i>. После этого обнови эту страницу.</p>');
  }
  await ensureSchema(env);
  const S = await loadSettings(env);
  const k = await keys(env);
  const me = await tg(env, 'getMe', {});
  if (!me.ok) return html('Ошибка', `<p>❌ Токен бота не подошёл: ${esc(me.description)}</p>`, 500);
  await saveSettings(env, S, { bot_username: me.result.username, bot_id: me.result.id, base_url: url.origin });

  const hookUrl = `${url.origin}/tg`;
  const wh = await tg(env, 'setWebhook', { url: hookUrl, secret_token: k.hook, allowed_updates: ['message', 'callback_query', 'my_chat_member'], max_connections: 10 });
  const c1 = await tg(env, 'setMyCommands', { commands: COMMANDS_PRIVATE, scope: { type: 'all_private_chats' } });
  const c2 = await tg(env, 'setMyCommands', { commands: COMMANDS_GROUP, scope: { type: 'all_group_chats' } });
  const menu = await tg(env, 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'Дашборд', web_app: { url: `${url.origin}/app` } } });
  await tg(env, 'setMyDescription', { description: `Следит за доступностью ${SERVICE.gen} (${SERVICE.host}): проверяет сайт и API ${everyText(S)} и бьёт тревогу в чате разработчиков, если прод не отвечает. Статистика падений и графики — в дашборде.` });
  await tg(env, 'setMyShortDescription', { short_description: `Мониторинг прода ${SERVICE.gen}: тревоги в чат разработчиков, статистика падений, графики.` });
  // Короткое имя — в списке чатов остаётся место для самого сообщения. Меняем, только если отличается
  const nm = await tg(env, 'getMyName', {});
  const nameRes = nm.ok && nm.result && nm.result.name === BOT_NAME ? { ok: true } : await tg(env, 'setMyName', { name: BOT_NAME });

  const users = await countUsers(env);
  if (users === 0) await saveSettings(env, S, { setup_at: nowS() });

  // Пробная проверка прямо отсюда — сразу видно, достаёт ли Cloudflare до прода
  const targets = getTargets(S);
  const probe = await Promise.all(targets.map((t) => probeTarget(t, 10000)));
  const control = await probeTarget({ id: 'control', url: CONTROL_URL, expect: null, kind: null }, 8000);
  const last = await env.DB.prepare("SELECT MAX(ts) AS ts FROM checks WHERE target = '_'").first();
  const age = last && last.ts ? nowS() - Number(last.ts) : null;
  const cron = age == null
    ? '❌ ещё не было ни одного прогона. Добавь Cron Trigger: Worker → Settings → Trigger Events → Add → <b>Cron Triggers</b> → <code>* * * * *</code> (каждую минуту). Первый прогон — в течение минуты.'
    : age < 180 ? `✅ последний прогон ${age} с назад` : `⚠️ последний прогон ${dur(age)} назад — проверь Cron Trigger <code>* * * * *</code>`;
  const link = `https://t.me/${me.result.username}`;
  const ok = (r) => (r.ok ? '✅' : '❌ ' + esc(r.description));
  const body = [
    `<p>Бот: <b>@${esc(me.result.username)}</b> · версия ${VERSION}</p>`,
    `<p>Вебхук: ${ok(wh)} <code>${esc(hookUrl)}</code></p>`,
    `<p>Имя бота: ${nameRes.ok ? `✅ «${esc(BOT_NAME)}»` : `❌ ${esc(nameRes.description || '')} — поменяйте в @BotFather → /setname`}</p>`,
    `<p>Команды: ${ok(c1)} ${ok(c2)} · кнопка «Дашборд»: ${ok(menu)}</p>`,
    `<p>Cron: ${cron}</p>`,
    '<h2>Пробная проверка отсюда (из Cloudflare)</h2>',
    '<ul>',
    ...targets.map((t, i) => `<li>${probe[i].st === 1 ? '✅' : '❌'} <b>${esc(t.name)}</b> — <code>${esc(t.url)}</code>: ${probe[i].st === 1 ? `${probe[i].code} · ${probe[i].ms} мс` : esc(probe[i].err)}</li>`),
    `<li>${control.st === 1 ? '✅' : '❌'} контрольный адрес <code>${esc(CONTROL_URL)}</code>: ${control.st === 1 ? `${control.code} · ${control.ms} мс` : esc(control.err)}</li>`,
    '</ul>',
    probe.some((p) => p.st !== 1) && control.st === 1 ? '<p>⚠️ Контрольный адрес отвечает, а Базис — нет. Если Базис при этом открывается из браузера, возможно, он не пускает запросы из-за рубежа — напиши, разберёмся.</p>' : '',
    `<p>Дашборд: <a href="${url.origin}/app">${esc(url.origin)}/app</a> (открывается из бота)</p>`,
    `<p>Чат для тревог: ${S.chat_id ? boundText(S) : 'не назначен — добавь бота в чат разработчиков (он привяжется сам) или отправь там /bind'}</p>`,
    `<p>Пользователей: ${users}</p>`,
    users === 0
      ? `<p class="big"><a id="owner-link" href="${link}">Открыть бота →</a></p><p>Нажми <b>Start</b> в течение часа — первый, кто это сделает, станет владельцем бота.</p>`
      : `<p>Владелец уже назначен. <a href="${link}">Открыть бота</a></p>`,
  ].join('\n');
  return html(title, body);
}
