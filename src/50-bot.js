
// ─── бот: вебхук и апдейты ──────────────────────────────────────────────────

async function onWebhook(request, env, ctx) {
  const k = await keys(env);
  if (!k || request.headers.get('x-telegram-bot-api-secret-token') !== k.hook) return new Response('forbidden', { status: 403 });
  let update;
  try {
    update = await request.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }
  await ensureSchema(env);
  if (update.update_id != null) {
    const r = await env.DB.prepare('INSERT OR IGNORE INTO updates (update_id, at) VALUES (?, ?)').bind(update.update_id, nowS()).run();
    if (!r.meta || !r.meta.changes) return new Response('duplicate');
  }
  // Отвечаем Telegram сразу, работаем в фоне
  ctx.waitUntil(handleUpdate(env, update).catch((e) => console.error('update failed', e && e.stack ? e.stack : e)));
  return new Response('ok');
}

async function handleUpdate(env, u) {
  const S = await loadSettings(env);
  if (u.callback_query) return onCallback(env, S, u.callback_query);
  if (u.my_chat_member) return onMyChatMember(env, S, u.my_chat_member);
  const msg = u.message;
  if (!msg || !msg.chat) return;
  // Группа стала супергруппой — у чата новый id, тем в нём ещё нет
  if (msg.migrate_to_chat_id && String(msg.chat.id) === String(S.chat_id)) {
    await saveSettings(env, S, { chat_id: msg.migrate_to_chat_id, board_chat: S.board_chat ? msg.migrate_to_chat_id : null, thread_id: null, thread_title: null, board_thread: null });
    return;
  }
  // Служебные строки о наших же действиях — «Мониторинг закрепил…», «…переименовал тему…» — убираем сразу:
  // они занимают место в теме и видны в превью чата. Чужие закрепы и переименования не трогаем.
  if ((msg.pinned_message || msg.forum_topic_edited) && msg.chat.type !== 'private' && msg.from && msg.from.is_bot && Number(msg.from.id) === Number(await botId(env, S))) {
    await dropServiceMessage(env, S, msg);
    return;
  }
  // Тему для тревог переименовали. Наши «🟢/🔴/🔧» пропускаем; человек переименовал — запоминаем название
  // и перестаём менять его сами, чтобы не спорить с людьми
  if (msg.forum_topic_edited && msg.forum_topic_edited.name && String(msg.chat.id) === String(S.chat_id) && topicOf(msg) && topicOf(msg) === Number(S.thread_id || 0)) {
    const name = msg.forum_topic_edited.name;
    if (isStatusName(name) || (msg.from && Number(msg.from.id) === Number(S.bot_id))) return;
    const upd = { thread_title: name };
    const wasOn = !!S.topic_name_set && cfg(S, 'topic_status');
    if (wasOn) Object.assign(upd, { topic_status: 0, topic_name_set: null, topic_orig: null });
    await saveSettings(env, S, upd);
    if (wasOn) await notifyOwner(env, `🏷 Тему для тревог переименовали вручную — «${esc(name)}». Статус в названии больше не меняю. Включить снова — /settings.`);
    return;
  }
  if (!msg.from || msg.from.is_bot) return;
  if (msg.chat.type === 'private') return onPrivate(env, S, msg);
  if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') return onGroup(env, S, msg);
}

async function dropServiceMessage(env, S, msg) {
  const r = await tg(env, 'deleteMessage', { chat_id: msg.chat.id, message_id: msg.message_id });
  if (r.ok || S.svc_delete_warned) return;
  await saveSettings(env, S, { svc_delete_warned: nowS() });
  await notifyOwner(env, `🧹 Не получается убирать служебные строки «Мониторинг закрепил…» и «…переименовал тему» (${esc(trunc(r.description || 'нет ответа', 80))}).\nДайте мне в чате право «Удаление сообщений» — тогда они будут исчезать сразу.`);
}

function parseCommand(text, me) {
  const m = String(text || '').trim().match(/^\/([a-zA-Z_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  if (m[2] && me && m[2].toLowerCase() !== String(me).toLowerCase()) return null; // команда другому боту
  return { cmd: m[1].toLowerCase(), arg: (m[3] || '').trim() };
}

async function onPrivate(env, S, msg) {
  const chatId = msg.chat.id;
  const from = msg.from;
  const text = (msg.text || '').trim();
  const pc = parseCommand(text, null);
  let user = await getUser(env, from.id);
  if (!user) {
    const arg = pc && pc.cmd === 'start' ? pc.arg : '';
    user = await tryJoin(env, S, from, arg);
    if (!user) {
      return send(env, chatId, `🔒 Это бот мониторинга ${SERVICE.gen} для команды разработки.\nПользоваться им могут участники чата разработчиков или те, кого пригласил владелец.\n\nТвой ID: <code>${from.id}</code>`);
    }
    if (arg === 'sub') {
      await setUserFlag(env, from.id, 'dm', 1);
      user.dm = 1;
    }
    return send(env, chatId, welcomeText(user, S), { reply_markup: menuKb() });
  }
  if ((user.username || null) !== (from.username || null) || user.name !== userName(from)) user = await upsertUser(env, from, user.role);

  const ctx = { env, S, chatId, user, from, msg, private: true, isOwner: user.role === 'owner' };
  if (msg.sticker) return onSticker(ctx);
  if (pc) {
    if (pc.cmd === 'start' && pc.arg === 'sub') return setDm(ctx, true);
    return onCommand(ctx, pc.cmd, pc.arg);
  }
  switch (text) {
    case BTN.status: return onCommand(ctx, 'status', '');
    case BTN.dash: return onCommand(ctx, 'dash', '');
    case BTN.help: return onCommand(ctx, 'help', '');
    case BTN.dm: return setDm(ctx, !Number(user.dm));
  }
  return send(env, chatId, 'Я понимаю команды: /status — что сейчас, /stats — статистика, /dash — графики, /help — всё остальное 🙂', { reply_markup: menuKb() });
}

// Кто может пользоваться ботом: владелец (первый после /setup), участники чата разработчиков, приглашённые
async function tryJoin(env, S, from, arg) {
  if (arg && arg.startsWith('inv_')) {
    const key = 'invite:' + arg.slice(4);
    if (S[key]) {
      await saveSettings(env, S, { [key]: null });
      return upsertUser(env, from, 'member');
    }
  }
  if ((await countUsers(env)) === 0) {
    const at = int(S.setup_at, 0);
    if (at && nowS() - at <= 3600) return upsertUser(env, from, 'owner', { dm: true });
  }
  if (S.chat_id && (await isChatMember(env, S.chat_id, from.id))) return upsertUser(env, from, 'member');
  return null;
}

async function isChatMember(env, chatId, userId) {
  const r = await tg(env, 'getChatMember', { chat_id: chatId, user_id: userId });
  if (!r.ok) return false;
  const s = r.result.status;
  return s === 'creator' || s === 'administrator' || s === 'member' || (s === 'restricted' && r.result.is_member);
}
async function isChatAdmin(env, chatId, userId) {
  const r = await tg(env, 'getChatMember', { chat_id: chatId, user_id: userId });
  return !!(r.ok && (r.result.status === 'creator' || r.result.status === 'administrator'));
}
async function canManage(ctx) {
  if (ctx.isOwner) return true;
  if (!ctx.private && (await isChatAdmin(ctx.env, ctx.chatId, ctx.from.id))) return true;
  return false;
}

async function onGroup(env, S, msg) {
  const me = await botUsername(env, S);
  const pc = parseCommand(msg.text, me);
  if (!pc) {
    if (msg.reply_to_message) await onPostmortemReply(env, S, msg, await botId(env, S));
    return;
  }
  const chatId = msg.chat.id;
  let user = await getUser(env, msg.from.id);
  const isOwner = !!(user && user.role === 'owner');
  const ctx = { env, S, chatId, thread: topicOf(msg), user, from: msg.from, msg, private: false, isOwner };
  if (pc.cmd === 'bind') return onBind(ctx);
  const bound = String(chatId) === String(S.chat_id);
  if (!bound) {
    if (['start', 'help', 'status'].includes(pc.cmd)) {
      return say(ctx, `👋 Я бот мониторинга ${SERVICE.gen}. Тревоги идут в чат, который назначил владелец. Владелец — отправьте здесь /bind, чтобы тревоги шли сюда.`);
    }
    return;
  }
  if (!user) ctx.user = await upsertUser(env, msg.from, 'member');
  return onCommand(ctx, pc.cmd, pc.arg);
}

// Ответ на команду — туда же, где спросили: в личку, в чат или в ту же тему форума
function say(ctx, text, extra = {}) {
  return sendTo(ctx.env, ctx.S, { chat: ctx.chatId, thread: ctx.thread || null }, text, extra);
}
// Где сейчас разговор — чтобы сравнить с местом для тревог
const ctxPlace = (ctx) => ({ chat: ctx.chatId, thread: ctx.thread || null });

async function onCommand(ctx, cmd, arg) {
  const { env, S, chatId } = ctx;
  switch (cmd) {
    case 'start':
    case 'menu':
      return ctx.private ? say(ctx, welcomeText(ctx.user, S), { reply_markup: menuKb() }) : say(ctx, helpText(ctx));
    case 'help':
      return say(ctx, helpText(ctx), ctx.private ? { reply_markup: menuKb() } : {});
    case 'status':
      return say(ctx, await statusText(env, S), { reply_markup: await statusKb(env, S, chatId, ctx.private) });
    case 'stats':
      return say(ctx, await statsText(env, S));
    case 'incidents':
      return say(ctx, await incidentsText(env, S));
    case 'dash':
    case 'dashboard':
      return sendDash(ctx);
    case 'check':
      return say(ctx, await liveCheckText(env, S), { reply_markup: await statusKb(env, S, chatId, ctx.private) });
    case 'subscribe':
      if (ctx.private) return setDm(ctx, true);
      return say(ctx, 'Личные тревоги включаются в личке с ботом 👇', { reply_markup: { inline_keyboard: [[{ text: '🔔 Включить в личке', url: `https://t.me/${await botUsername(env, S)}?start=sub` }]] } });
    case 'unsubscribe':
      return setDm(ctx, false);
    case 'mute':
      return onMute(ctx, arg);
    case 'unmute':
      return onUnmute(ctx);
    case 'guide':
    case 'board':
      return onGuide(ctx);
    case 'drill':
      return onDrill(ctx);
    case 'weekly':
      return onWeekly(ctx);
    case 'oncall':
      return onOncall(ctx, arg);
    case 'settings':
      return onSettings(ctx);
    case 'targets':
      return onTargets(ctx, arg);
    case 'target_add':
      return onTargetAdd(ctx, arg);
    case 'target_del':
      return onTargetDel(ctx, arg);
    case 'siren':
      return onSiren(ctx, arg);
    case 'invite':
      return onInvite(ctx);
    case 'unbind':
      return onUnbind(ctx);
    case 'newlinks':
      return onNewLinks(ctx);
    default:
      return ctx.private ? say(ctx, 'Не знаю такую команду. /help — подсказка.') : null;
  }
}

// /weekly — прислать итоги недели сейчас (владелец): удобно проверить отчёт и картинку, не дожидаясь понедельника
async function onWeekly(ctx) {
  if (!ctx.isOwner) return say(ctx, '🔒 Только владелец.');
  if (!ctx.S.chat_id) return say(ctx, 'Чат для тревог ещё не назначен — добавьте меня в чат разработчиков и напишите /bind в теме.');
  await sendWeekly(ctx.env, ctx.S, nowS());
  return say(ctx, '📊 Итоги недели отправлены в чат тревог.');
}

function menuKb() {
  return { keyboard: [[{ text: BTN.status }, { text: BTN.dash }], [{ text: BTN.dm }, { text: BTN.help }]], resize_keyboard: true, is_persistent: true };
}

function welcomeText(user, S) {
  const first = String(user.name || '').split(' ')[0] || 'привет';
  const L = [
    `👋 Привет, ${esc(first)}!`,
    `Я бот мониторинга ${SERVICE.gen}: проверяю ${esc(SERVICE.host)} (страницу входа и API) ${everyText(S)} и бью тревогу в чате разработчиков, если прод не отвечает.`,
    '',
    `🔔 Личные тревоги: <b>${Number(user.dm) ? 'включены' : 'выключены'}</b> — /subscribe, /unsubscribe`,
    '📊 /status — что сейчас · /stats — статистика падений · /incidents — журнал · /dash — графики',
  ];
  if (user.role === 'owner') {
    L.push(
      '',
      '👑 <b>Ты владелец.</b> Дальше:',
      `1. Добавь меня в чат разработчиков и отправь там /bind — тревоги пойдут туда (в чате с темами — в ту тему, где отправишь).${S.chat_id ? ` Сейчас назначен: ${boundText(S)}.` : ' Пока чат не назначен, тревоги приходят тебе сюда.'}`,
      '2. Сделай меня админом с правом «Закреплять сообщения».',
      '3. Покажи команде учебную тревогу — /drill.',
      '',
      'Настройки — /settings · проверки — /targets · дежурные — /oncall · свой стикер вместо 🚨 — /siren · пригласить — /invite'
    );
  }
  return L.join('\n');
}

function helpText(ctx) {
  const L = [
    `🤖 <b>Бот мониторинга ${SERVICE.gen}</b> · ${esc(SERVICE.host)} · v${VERSION}`,
    '',
    '/status — что с Базисом сейчас (кнопка «Проверить сейчас»)',
    '/stats — доступность за сутки, 7, 30 и 90 дней',
    '/incidents — журнал падений',
    '/dash — дашборд с графиками',
    '/mute 1h — плановые работы: пауза тревог (/mute 30, /mute 23:00, /unmute)',
    '/subscribe · /unsubscribe — тревоги в личку',
    '/guide — инструкция и живой статус (закрепить в чате)',
    '/drill — учебная тревога: так выглядит настоящая',
  ];
  if (ctx.isOwner) {
    L.push(
      '',
      '👑 <b>Владельцу</b>',
      '/bind — назначить чат или тему для тревог (отправить там, куда слать) · /unbind',
      '/oncall @a @b — кого упоминать · /oncall reset — список по умолчанию',
      '/settings — через сколько минут тревога, как часто повторять',
      '/targets — что проверяем · /target_add Имя https://… [200] · /target_del id',
      '/siren — свой стикер вместо 🚨 · /invite — пригласить · /newlinks — отозвать ссылки на дашборд'
    );
  }
  return L.join('\n');
}

// ─── статус и ссылки ────────────────────────────────────────────────────────

async function statusKb(env, S, chatId, isPrivate) {
  const base = await baseUrl(env, S);
  const row = [{ text: '🔄 Проверить сейчас', callback_data: 'check' }];
  if (base) row.push(isPrivate ? { text: '📈 Дашборд', web_app: { url: `${base}/app` } } : { text: '📈 Дашборд', url: await dashUrlFor(env, S, chatId) });
  return { inline_keyboard: [row] };
}

async function sendDash(ctx) {
  const { env, S, chatId } = ctx;
  const base = await baseUrl(env, S);
  if (!base) return say(ctx, 'Дашборд ещё не настроен: открой /setup у Worker’а.');
  const url = await dashUrlFor(env, S, chatId);
  if (ctx.private) {
    return say(ctx, [
      '📈 <b>Дашборд мониторинга</b> — доступность, время ответа, журнал падений и когда Базис падает чаще всего.',
      '',
      'В Telegram — кнопка ниже или «Дашборд» слева от поля ввода.',
      '',
      `Личная ссылка для браузера (180 дней, не пересылай её):\n${url}`,
      '',
      '📱 На айфоне: открой ссылку в Safari → «Поделиться» → «На экран „Домой“» — дашборд будет открываться как приложение.',
    ].join('\n'), { reply_markup: { inline_keyboard: [[{ text: '📈 Открыть дашборд', web_app: { url: `${base}/app` } }]] } });
  }
  return say(ctx, `📈 <b>Дашборд мониторинга</b> — ссылка для команды, работает, пока бот привязан к этому чату:\n${url}`, {
    reply_markup: { inline_keyboard: [[{ text: '📈 Открыть дашборд', url }]] },
  });
}

async function setDm(ctx, on) {
  const { env, chatId, from } = ctx;
  await setUserFlag(env, from.id, 'dm', on);
  const text = on
    ? '🔔 Готово: тревоги будут приходить и сюда, в личку — даже если чат разработчиков выключен.\nВыключить — /unsubscribe.'
    : '🔕 Личные тревоги выключены. Включить — /subscribe.';
  if (ctx.private) return say(ctx, text, { reply_markup: menuKb() });
  const r = await send(env, from.id, text);
  if (!r.ok) return say(ctx, `${esc(userName(from))}, сначала открой меня в личке и нажми Start.`);
  return null;
}

// ─── плановые работы ────────────────────────────────────────────────────────

function parseMute(arg, now) {
  const a = String(arg || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!a) return 3600;
  if (/^(off|выкл|стоп|stop|нет|0)$/.test(a)) return 0;
  let m = a.match(/^(?:до\s+)?(\d{1,2})[:.](\d{2})$/);
  if (m) {
    let t = mskDayStart(now) + Number(m[1]) * 3600 + Number(m[2]) * 60;
    if (t <= now) t += 86400;
    return t - now;
  }
  m = a.match(/^(\d+(?:[.,]\d+)?)\s*(h|ч|час|часа|часов|m|м|мин|минут|минуты|минуту|d|д|день|дня|дней)?$/);
  if (m) {
    const n = parseFloat(m[1].replace(',', '.'));
    const u = m[2] || 'm';
    return Math.round(/^(h|ч)/.test(u) ? n * 3600 : /^(d|д)/.test(u) ? n * 86400 : n * 60);
  }
  return null;
}

async function setMute(env, S, sec, from, where) {
  const now = nowS();
  sec = Math.min(Math.max(60, sec), 86400);
  const until = now + sec;
  await saveSettings(env, S, { mute_until: until, mute_by: userName(from) });
  const text = `🔧 <b>Плановые работы до ${hhmm(until)} МСК</b> — тревоги на паузе.\nКто поставил паузу: ${esc(userName(from))}. Если ${SERVICE.name} в это время не отвечает, простой запишется как плановый. Снять паузу — /unmute.`;
  const team = teamPlace(S);
  if (team) await sendTo(env, S, team, text, { disable_notification: true });
  if (where && !samePlace(where, team)) await sendTo(env, S, where, text); // спросили в личке или в другой теме
  const inc = await openIncident(env);
  if (inc && inc.kind === 'down') await refreshCard(env, S, inc, now);
  await refreshBoard(env, S);
  await syncTopicName(env, S);
  return until;
}

async function onMute(ctx, arg) {
  const { env, S, from } = ctx;
  const sec = parseMute(arg, nowS());
  if (sec === 0) return onUnmute(ctx);
  if (sec == null) return say(ctx, 'Не понял, на сколько. Примеры: /mute 30 · /mute 2h · /mute 23:00 · /unmute');
  await setMute(env, S, sec, from, ctxPlace(ctx));
  return null;
}

async function onUnmute(ctx) {
  const { env, S, from } = ctx;
  if (!(int(S.mute_until, 0) > nowS())) return say(ctx, '🔔 Тревоги и так включены.');
  await saveSettings(env, S, { mute_until: null, mute_by: null });
  const text = `🔔 <b>Тревоги снова включены</b> — кто снял паузу: ${esc(userName(from))}.`;
  const team = teamPlace(S);
  if (team) await sendTo(env, S, team, text, { disable_notification: true });
  if (!samePlace(ctxPlace(ctx), team)) await say(ctx, text);
  const inc = await openIncident(env);
  if (inc && inc.kind === 'down') await refreshCard(env, S, inc);
  await refreshBoard(env, S);
  await syncTopicName(env, S);
  return null;
}

// Пауза закончилась сама — скажем в чат (вызывается из прогона)
async function muteExpiry(env, S, now) {
  const until = int(S.mute_until, 0);
  if (!until || until > now) return;
  await saveSettings(env, S, { mute_until: null, mute_by: null });
  const team = teamPlace(S);
  if (team) await sendTo(env, S, team, `🔔 Плановые работы по расписанию закончились (${hhmm(until)} МСК) — тревоги снова включены.`, { disable_notification: true });
  await syncTopicName(env, S);
}

async function refreshBoard(env, S) {
  if (!S.board_msg || !S.board_chat) return;
  const now = nowS();
  const r = await edit(env, Number(S.board_chat), Number(S.board_msg), await renderBoard(env, S, now), boardKb(await dashUrlFor(env, S, S.board_chat)));
  if (r.ok || /not modified/i.test(r.description || '')) await saveSettings(env, S, { board_at: now });
}

// ─── чат для тревог ─────────────────────────────────────────────────────────

async function botId(env, S) {
  if (S.bot_id) return Number(S.bot_id);
  const me = await tg(env, 'getMe', {});
  if (!me.ok) return null;
  await saveSettings(env, S, { bot_username: me.result.username, bot_id: me.result.id });
  return me.result.id;
}

async function botRights(env, S, chatId) {
  const id = await botId(env, S);
  if (!id) return { pin: false };
  const r = await tg(env, 'getChatMember', { chat_id: chatId, user_id: id });
  if (!r.ok) return { pin: false };
  const m = r.result;
  return { admin: m.status === 'administrator', pin: m.status === 'administrator' && m.can_pin_messages !== false, topics: m.status === 'administrator' && !!m.can_manage_topics };
}

// /bind — тревоги пойдут туда, где отправили команду: в чат, а в форуме — в эту тему
async function onBind(ctx) {
  const { env, S, chatId, msg } = ctx;
  if (!ctx.isOwner) return say(ctx, '🔒 Назначить чат для тревог может только владелец бота.');
  const thread = ctx.thread || null;
  // Сообщение в теме приходит «ответом» на служебное «тема создана» — оттуда берём название
  const created = msg.reply_to_message && msg.reply_to_message.forum_topic_created;
  const title = thread ? (created && created.name) || (Number(S.thread_id || 0) === thread && S.thread_title) || null : null;
  const same = String(S.chat_id) === String(chatId) && Number(S.thread_id || 0) === Number(thread || 0);
  if (!same) await restoreTopicName(env, S); // прежней теме — её название
  await saveSettings(env, S, { chat_id: chatId, chat_title: msg.chat.title || '', thread_id: thread, thread_title: isStatusName(title) ? S.topic_orig || title : title, topic_warn_at: null, topic_rights_warned: null });
  const here = thread ? `эту тему${title ? ` «${esc(title)}»` : ''}` : msg.chat.is_forum ? 'общую ленту чата (General)' : 'этот чат';
  await say(ctx, `✅ Готово: тревоги по ${SERVICE.dat} (${esc(SERVICE.host)}) теперь приходят в ${here}.\nНиже — инструкция с живым статусом, закреплю её.`);
  await replaceBoard(env, S, ctxPlace(ctx));
  const rights = await botRights(env, S, chatId);
  if (!rights.pin) await say(ctx, `📌 Чтобы закреплять тревоги, сделайте меня администратором с правом «Закреплять сообщения»${thread ? ', а чтобы в названии темы был статус — ещё и «Управление темами»' : ''}.`);
  else if (thread && !rights.topics && cfg(S, 'topic_status')) await say(ctx, `🏷 Чтобы в названии темы был виден статус — «${TOPIC_NAMES.up}» или «${TOPIC_NAMES.down}», — дайте мне право «Управление темами».`);
  if (thread && rights.topics) await syncTopicName(env, S, true);
  return null;
}

async function onUnbind(ctx) {
  const { env, S } = ctx;
  if (!ctx.isOwner) return say(ctx, '🔒 Только владелец.');
  const old = S.chat_title || S.chat_id;
  await restoreTopicName(env, S);
  await saveSettings(env, S, { chat_id: null, chat_title: null, thread_id: null, thread_title: null, board_chat: null, board_thread: null, board_msg: null });
  return say(ctx, `Чат «${esc(old || '—')}» отвязан. Пока новый не назначен (/bind в чате), тревоги приходят владельцу в личку.`);
}

// Куда сейчас идут тревоги — для приветствия, настроек и /setup
function boundText(S) {
  if (!S.chat_id) return '';
  const chat = `<b>${esc(S.chat_title || S.chat_id)}</b>`;
  if (!S.thread_id) return chat;
  return `${chat} · тема ${topicName(S) ? `«${esc(topicName(S))}»` : 'для тревог'}`;
}

async function onMyChatMember(env, S, upd) {
  const chat = upd.chat;
  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return;
  const was = upd.old_chat_member && upd.old_chat_member.status;
  const now = upd.new_chat_member && upd.new_chat_member.status;
  const added = ['member', 'administrator'].includes(now) && ['left', 'kicked', undefined].includes(was);
  const removed = ['left', 'kicked'].includes(now);
  const bound = String(chat.id) === String(S.chat_id);
  if (added) {
    const by = upd.from ? await getUser(env, upd.from.id) : null;
    if (by && by.role === 'owner' && !S.chat_id) {
      await saveSettings(env, S, { chat_id: chat.id, chat_title: chat.title || '', thread_id: null, thread_title: null });
      const place = { chat: chat.id, thread: null };
      const topics = chat.is_forum ? '\nНужна отдельная тема — владелец бота отправляет в ней /bind, и тревоги с закрепом переедут туда.' : '';
      await sendTo(env, S, place, `👋 Привет! Я слежу за доступностью ${SERVICE.gen} (${esc(SERVICE.host)}): проверяю сайт и API ${everyText(S)} и бью тревогу сюда, если прод не отвечает.${topics}\nНиже — как читать мои сообщения.`);
      await replaceBoard(env, S, place);
      if (now !== 'administrator') await sendTo(env, S, place, '📌 Сделайте меня администратором с правом «Закреплять сообщения» — тогда тревоги будут закрепляться.');
      return;
    }
    return send(env, chat.id, `👋 Привет! Я бот мониторинга ${SERVICE.gen}. Владелец бота — отправьте здесь /bind, чтобы тревоги шли в этот чат.`);
  }
  // Дали право удалять сообщения — снова пробуем убирать служебные строки и снова предупредим, если не выйдет
  if (bound && now === 'administrator' && upd.new_chat_member.can_delete_messages && S.svc_delete_warned) await saveSettings(env, S, { svc_delete_warned: null });
  // Дали право «Управление темами» — сразу ставим статус в название темы
  const oldTopics = was === 'administrator' && !!upd.old_chat_member.can_manage_topics;
  const newTopics = now === 'administrator' && !!upd.new_chat_member.can_manage_topics;
  if (bound && newTopics && !oldTopics && S.thread_id) {
    await saveSettings(env, S, { topic_rights_warned: null });
    await syncTopicName(env, S, true);
  }
  // Дали права админа (или право закреплять) — сразу закрепляем табло и открытую тревогу
  const oldPin = was === 'administrator' && upd.old_chat_member.can_pin_messages !== false;
  const newPin = now === 'administrator' && upd.new_chat_member.can_pin_messages !== false;
  if (bound && now === 'administrator' && !oldPin && (newPin || was !== 'administrator')) {
    let pinned = false;
    if (newPin && S.board_msg && String(S.board_chat) === String(chat.id)) {
      pinned = (await tg(env, 'pinChatMessage', { chat_id: chat.id, message_id: Number(S.board_msg), disable_notification: true })).ok;
    }
    const open = newPin ? await openIncident(env) : null;
    if (open && open.kind === 'down' && open.msg_id && String(open.chat_id) === String(chat.id)) {
      await tg(env, 'pinChatMessage', { chat_id: chat.id, message_id: Number(open.msg_id), disable_notification: true });
    }
    const text = newPin
      ? `📌 Спасибо, теперь смогу закреплять тревоги.${pinned ? ' Табло со статусом закрепил.' : ''}`
      : '📌 Спасибо! Чтобы закреплять тревоги, включите мне ещё право «Закреплять сообщения».';
    return sendTo(env, S, teamPlace(S), text, { disable_notification: true });
  }
  if (bound && removed) {
    await saveSettings(env, S, { chat_id: null, chat_title: null, thread_id: null, thread_title: null, board_chat: null, board_thread: null, board_msg: null, topic_name_set: null, topic_orig: null });
    await notifyOwner(env, `⚠️ Меня удалили из чата «${esc(chat.title || chat.id)}». Пока новый чат не назначен, тревоги приходят тебе в личку.`);
  }
}

// Табло живёт там же, где тревоги. /guide из другой темы перевыкладывает его туда и говорит куда.
async function onGuide(ctx) {
  const { env, S, chatId } = ctx;
  if (!ctx.private && !(await canManage(ctx))) return say(ctx, '📌 Выложить и закрепить инструкцию могут владелец бота и админы чата.');
  if (ctx.private) return say(ctx, await renderBoard(env, S, nowS()), { reply_markup: boardKb(await dashUrlFor(env, S, chatId)) });
  const m = await replaceBoard(env, S, teamPlace(S));
  if (m.ok && !samePlace(m.place, ctxPlace(ctx))) await say(ctx, `📌 Табло со статусом перевыложил и закрепил ${placeName(S, m.place, ctxPlace(ctx))}.`);
  return null;
}

async function onDrill(ctx) {
  const { env, S } = ctx;
  if (!(await canManage(ctx))) return say(ctx, '🧪 Учебную тревогу запускают владелец бота и админы чата.');
  const r = await startDrill(env, S, teamPlace(S) || ctxPlace(ctx), userName(ctx.from));
  if (!r.ok) return say(ctx, r.text);
  if (!samePlace(r.place, ctxPlace(ctx))) await say(ctx, `🧪 Учебная тревога запущена ${placeName(S, r.place, ctxPlace(ctx))}. Через ~4 минуты учения закончатся сами.`);
  return null;
}

// ─── дежурные ───────────────────────────────────────────────────────────────

async function onOncall(ctx, arg) {
  const { env, S, chatId } = ctx;
  const a = String(arg || '').trim();
  if (!a) {
    const { results } = await env.DB.prepare('SELECT name, username FROM users WHERE mention = 1').all();
    const btn = (results || []).map((r) => (r.username ? '@' + r.username : esc(r.name)));
    return say(ctx, [
      '📣 <b>Кого упоминаю в тревогах</b>',
      oncallList(S).map((u) => '@' + esc(u)).join(' ') || '— список пуст',
      btn.length ? `Сами попросили: ${btn.join(', ')}` : 'Кнопкой «📣 Упоминать меня» пока никто не добавился.',
      '',
      'Поменять список: /oncall @user1 @user2 · вернуть как было: /oncall reset · убрать всех: /oncall off',
    ].join('\n'));
  }
  if (!(await canManage(ctx))) return say(ctx, '🔒 Список дежурных меняют владелец и админы чата. Себя можно добавить кнопкой «📣 Упоминать меня» в закреплённой инструкции.');
  if (/^(reset|сброс)$/i.test(a)) await saveSettings(env, S, { oncall: null });
  else if (/^(off|нет|никого)$/i.test(a)) await saveSettings(env, S, { oncall: '[]' });
  else {
    const list = [...new Set((a.match(/@?[A-Za-z][A-Za-z0-9_]{3,31}/g) || []).map((x) => x.replace(/^@/, '')))];
    if (!list.length) return say(ctx, 'Пришли юзернеймы через пробел: /oncall @user1 @user2');
    await saveSettings(env, S, { oncall: JSON.stringify(list) });
  }
  return say(ctx, `📣 Теперь в тревогах упоминаю: ${oncallList(S).map((u) => '@' + esc(u)).join(' ') || 'никого из списка'} (+ тех, кто нажал «📣 Упоминать меня»).`);
}

// ─── настройки ──────────────────────────────────────────────────────────────

function settingsView(S) {
  const ev = Math.max(1, cfg(S, 'check_every'));
  const fa = cfg(S, 'fail_after');
  const re = cfg(S, 'remind_every');
  const wk = cfg(S, 'weekly');
  const text = [
    '⚙️ <b>Настройки тревог</b>',
    `• Проверка прода: <b>${ev > 1 ? `раз в ${ev} мин` : 'каждую минуту'}</b>${ev > 1 ? ', а пока что-то не так (сбой, падение, пауза) — каждую минуту' : ''}`,
    `• Тревога после <b>${fa}</b> ${plural(fa, 'неудачной минуты', 'неудачных минут подряд', 'неудачных минут подряд')}`,
    `• Повтор, пока никто не взял: каждые <b>${re} мин</b> (после 30 мин — раз в 15, после 2 ч — раз в час)`,
    `• Итоги недели по понедельникам в 9:00: <b>${wk ? 'включены' : 'выключены'}</b>`,
    `• Дежурные: ${oncallList(S).map((u) => '@' + esc(u)).join(' ') || '—'} (+ кто нажал «📣 Упоминать меня») — /oncall`,
    `• Чат тревог: ${S.chat_id ? boundText(S) : 'не назначен — тревоги идут владельцу в личку'}`,
    `• Сирена: ${S.siren_sticker ? 'свой стикер (/siren reset — вернуть 🚨)' : '🚨 (свой стикер — /siren)'}`,
    `• Статус в названии темы: <b>${cfg(S, 'topic_status') ? 'включён' : 'выключен'}</b>${S.thread_id ? '' : ' (работает, когда тревоги идут в тему форума)'}`,
  ].join('\n');
  const kb = {
    inline_keyboard: [
      CHECK_EVERY.map((n) => ({ text: `${n === ev ? '● ' : ''}${n === 1 ? 'проверка каждую мин' : `раз в ${n} мин`}`, callback_data: `cfg:every:${n}` })),
      [1, 2, 3, 5].map((n) => ({ text: `${n === fa ? '● ' : ''}тревога через ${n}`, callback_data: `cfg:fail:${n}` })),
      [2, 5, 10, 15].map((n) => ({ text: `${n === re ? '● ' : ''}повтор ${n}`, callback_data: `cfg:rem:${n}` })),
      [{ text: wk ? '📊 Итоги недели: вкл → выключить' : '📊 Итоги недели: выкл → включить', callback_data: `cfg:week:${wk ? 0 : 1}` }],
      [{ text: cfg(S, 'topic_status') ? '🏷 Статус в названии темы: вкл → выключить' : '🏷 Статус в названии темы: выкл → включить', callback_data: `cfg:tname:${cfg(S, 'topic_status') ? 0 : 1}` }],
    ],
  };
  return { text, kb };
}

async function onSettings(ctx) {
  const { env, S, chatId } = ctx;
  if (!ctx.isOwner) return say(ctx, '🔒 Настройки меняет владелец бота.');
  const v = settingsView(S);
  return say(ctx, v.text, { reply_markup: v.kb });
}

// ─── проверки: список и правка ──────────────────────────────────────────────

function targetLine(t, last) {
  const exp = Array.isArray(t.expect) && t.expect.length ? `ждём ${t.expect.join('/')}` : 'ждём любой ответ, кроме 5xx';
  const kind = t.kind === 'html' ? ' + разметку страницы' : t.kind === 'json' ? ' + JSON' : '';
  let now = '';
  if (last) now = last.st === 1 ? ` · сейчас ✅ ${sec(last.ms)}` : last.st === -1 ? ' · сейчас ❔' : ` · сейчас ❌ ${esc(last.err || '')}`;
  return `• <code>${esc(t.id)}</code> — <b>${esc(t.name)}</b>\n  ${esc(t.url)}\n  ${exp}${kind}${now}`;
}

async function onTargets(ctx, arg) {
  const { env, S, chatId } = ctx;
  if (/^(reset|сброс)$/i.test(arg || '')) {
    if (!ctx.isOwner) return say(ctx, '🔒 Только владелец.');
    await saveSettings(env, S, { targets: null });
  }
  const targets = getTargets(S);
  const lastTs = int(S.last_check, 0) ? { ts: int(S.last_check, 0) } : await env.DB.prepare("SELECT MAX(ts) AS ts FROM checks WHERE target = '_'").first();
  const last = {};
  if (lastTs && lastTs.ts) {
    const ids = targets.map((t) => t.id);
    const { results } = await env.DB.prepare(`SELECT target, st, ms, err FROM checks WHERE target IN (${ids.map(() => '?').join(',')}) AND ts = ?`).bind(...ids, lastTs.ts).all();
    for (const r of results || []) last[r.target] = { st: Number(r.st), ms: r.ms, err: r.err };
  }
  return say(ctx, [
    `🎯 <b>Что проверяю</b>${S.targets ? '' : ' (по умолчанию)'} · ${everyText(S)}`,
    ...targets.map((t) => targetLine(t, last[t.id])),
    '',
    'Тревога — если не отвечает хотя бы одна проверка.',
    ctx.isOwner ? 'Добавить: /target_add Название https://адрес [коды, например 200]\nУбрать: /target_del id · как было: /targets reset' : '',
  ].filter((x) => x !== '').join('\n'));
}

async function onTargetAdd(ctx, arg) {
  const { env, S, chatId } = ctx;
  if (!ctx.isOwner) return say(ctx, '🔒 Только владелец.');
  const m = String(arg || '').match(/^(.*?)\s*(https?:\/\/\S+)\s*([\d\s,/]*)$/i);
  if (!m) return say(ctx, 'Формат: /target_add Название https://адрес [коды]\nНапример: /target_add Тест https://iflat.io/login 200');
  const targets = getTargets(S).map((t) => ({ ...t }));
  if (targets.length >= MAX_TARGETS) return say(ctx, `Больше ${MAX_TARGETS} проверок не держу — бесплатный тариф Cloudflare.`);
  const url = m[2];
  const name = trunc(m[1].trim() || hostOf(url), 40);
  const expect = (m[3].match(/\d{3}/g) || []).map(Number);
  let n = targets.length + 1;
  while (targets.some((t) => t.id === 't' + n)) n++;
  const t = { id: 't' + n, name, url, expect, kind: null };
  const probe = await probeTarget(t, 10000);
  targets.push(t);
  await saveSettings(env, S, { targets: JSON.stringify(targets) });
  return say(ctx, `➕ Добавил проверку <code>${t.id}</code> «${esc(name)}».\nПробный запрос: ${probe.st === 1 ? `✅ ${probe.code} · ${sec(probe.ms)}` : `❌ ${esc(probe.err)} — тревога придёт, если так и останется`}`);
}

async function onTargetDel(ctx, arg) {
  const { env, S, chatId } = ctx;
  if (!ctx.isOwner) return say(ctx, '🔒 Только владелец.');
  const id = String(arg || '').trim();
  const targets = getTargets(S);
  if (!targets.some((t) => t.id === id)) return say(ctx, `Нет проверки «${esc(id)}». Список — /targets`);
  const rest = targets.filter((t) => t.id !== id);
  if (!rest.length) return say(ctx, 'Последнюю проверку не убираю — иначе следить не за чем.');
  await saveSettings(env, S, { targets: JSON.stringify(rest) });
  return say(ctx, `🗑 Убрал проверку <code>${esc(id)}</code>. Осталось: ${rest.map((t) => esc(t.name)).join(', ')}.`);
}

// ─── сирена, приглашения, ссылки ────────────────────────────────────────────

async function onSiren(ctx, arg) {
  const { env, S, chatId } = ctx;
  if (!ctx.isOwner) return say(ctx, '🔒 Только владелец.');
  if (/^(reset|сброс)$/i.test(arg || '')) {
    await saveSettings(env, S, { siren_sticker: null, await_siren: null });
    return say(ctx, '🚨 Вернул стандартную сирену — эмодзи 🚨.');
  }
  if (!ctx.private) return say(ctx, 'Стикер для сирены присылай мне в личку: /siren');
  await saveSettings(env, S, { await_siren: `${ctx.from.id}:${nowS()}` });
  return say(ctx, '🚨 Пришли стикер — он будет открывать каждую тревогу вместо эмодзи 🚨. Лучше анимированный: мигалка, сирена, огонь.\n/siren reset — вернуть 🚨');
}

async function onSticker(ctx) {
  const { env, S, chatId, from, msg } = ctx;
  const [uid, at] = String(S.await_siren || '').split(':');
  if (ctx.isOwner && Number(uid) === from.id && nowS() - Number(at) < 900) {
    await saveSettings(env, S, { siren_sticker: msg.sticker.file_id, await_siren: null });
    return say(ctx, '✅ Готово: теперь каждая тревога начинается с этого стикера. Проверить — /drill.');
  }
  return say(ctx, 'Хороший стикер 🙂 Чтобы он открывал тревоги, отправь /siren, а потом его.');
}

async function onInvite(ctx) {
  const { env, S, chatId } = ctx;
  if (!ctx.isOwner) return say(ctx, '🔒 Приглашать может только владелец.');
  const code = randomCode(12);
  await saveSettings(env, S, { ['invite:' + code]: nowS() });
  const me = await botUsername(env, S);
  return say(ctx, `🔗 Одноразовая ссылка-приглашение:\nhttps://t.me/${me}?start=inv_${code}\n\nУчастникам чата разработчиков приглашение не нужно — они могут просто открыть бота.`);
}

async function onNewLinks(ctx) {
  const { env, S, chatId } = ctx;
  if (!ctx.isOwner) return say(ctx, '🔒 Только владелец.');
  await saveSettings(env, S, { link_ver: int(S.link_ver, 1) + 1 });
  return say(ctx, '🔐 Все старые ссылки на дашборд отозваны. Новые — /dash (в личке и в чате). Внутри Telegram дашборд открывается как раньше.');
}

// ─── кнопки ─────────────────────────────────────────────────────────────────

async function onCallback(env, S, cq) {
  const data = String(cq.data || '');
  const from = cq.from;
  const msg = cq.message;
  const chatId = msg && msg.chat ? msg.chat.id : null;
  const answer = (text = '', alert = false, extra = {}) => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: alert, ...extra });

  let user = await getUser(env, from.id);
  const inBound = chatId != null && String(chatId) === String(S.chat_id);
  if (!user && inBound) user = await upsertUser(env, from, 'member');
  if (!user) return answer('Эти кнопки — для команды разработки Базиса 🙂', true);
  const isOwner = user.role === 'owner';
  const [kind, a] = data.split(':');

  switch (kind) {
    case 'ack': {
      const inc = await getIncident(env, Number(a));
      if (!inc) return answer('Тревога не найдена');
      if (inc.ended_at) return answer('Уже решено ✅');
      if (inc.acked_at) return answer(`Тревога уже в работе: ${inc.acked_name}`);
      const ok = await ackIncident(env, S, inc, from);
      return answer(ok ? '🙋 Тревога твоя — напоминаний больше не будет' : 'Уже взяли');
    }
    case 'mute': {
      const mins = Math.min(1440, Math.max(5, Number(a) || 60));
      await answer(`🔧 Пауза тревог на ${mins} мин`);
      await setMute(env, S, mins * 60, from, inBound ? null : { chat: chatId, thread: null });
      return null;
    }
    case 'me': {
      if (a === 'mention') {
        const on = !Number(user.mention);
        await setUserFlag(env, from.id, 'mention', on);
        if (on && !from.username) return answer('📣 Буду упоминать тебя в тревогах. У тебя нет юзернейма — упомяну по имени.', true);
        return answer(on ? '📣 Буду упоминать тебя в тревогах' : 'Больше не упоминаю тебя в тревогах');
      }
      if (a === 'dm') {
        if (Number(user.dm)) {
          await setUserFlag(env, from.id, 'dm', 0);
          return answer('🔕 Личные тревоги выключены');
        }
        const r = await send(env, from.id, '🔔 Тревоги по Базису будут приходить и сюда, в личку. Выключить — /unsubscribe.');
        if (!r.ok) return answer('', false, { url: `https://t.me/${await botUsername(env, S)}?start=sub` });
        await setUserFlag(env, from.id, 'dm', 1);
        return answer('🔔 Готово: тревоги будут приходить и в личку');
      }
      return answer();
    }
    case 'check': {
      await answer('Проверяю…');
      const text = await liveCheckText(env, S);
      await edit(env, chatId, msg.message_id, text, await statusKb(env, S, chatId, msg.chat.type === 'private'));
      return null;
    }
    case 'cfg': {
      if (!isOwner) return answer('Настройки меняет владелец бота', true);
      const [, key, val] = data.split(':');
      const n = Number(val);
      if (key === 'every' && CHECK_EVERY.includes(n)) await saveSettings(env, S, { check_every: n });
      else if (key === 'fail' && [1, 2, 3, 5].includes(n)) await saveSettings(env, S, { fail_after: n });
      else if (key === 'rem' && [2, 5, 10, 15].includes(n)) await saveSettings(env, S, { remind_every: n });
      else if (key === 'week') await saveSettings(env, S, { weekly: n ? 1 : 0 });
      else if (key === 'tname') {
        if (n) {
          await saveSettings(env, S, { topic_status: 1, topic_rights_warned: null });
          await syncTopicName(env, S, true);
        } else {
          await restoreTopicName(env, S);
          await saveSettings(env, S, { topic_status: 0 });
        }
      }
      else return answer();
      const v = settingsView(S);
      await edit(env, chatId, msg.message_id, v.text, v.kb);
      await refreshBoard(env, S);
      return answer('Сохранил');
    }
    default:
      return answer();
  }
}
