
// ─── Telegram API ───────────────────────────────────────────────────────────

async function tg(env, method, params) {
  let r;
  try {
    r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params || {}),
    });
  } catch (e) {
    console.warn('TG', method, e && e.message);
    return { ok: false, description: String(e && e.message) };
  }
  let j;
  try {
    j = await r.json();
  } catch {
    j = { ok: false, description: `HTTP ${r.status}` };
  }
  if (!j.ok && !/not modified/i.test(j.description || '')) console.warn('TG', method, j.description);
  return j;
}

function send(env, chatId, text, extra = {}) {
  return tg(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
}
function edit(env, chatId, msgId, text, kb) {
  return tg(env, 'editMessageText', {
    chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
    reply_markup: kb || { inline_keyboard: [] },
  });
}
const replyTo = (msgId) => (msgId ? { reply_parameters: { message_id: Number(msgId), allow_sending_without_reply: true } } : {});

async function botUsername(env, S) {
  if (S && S.bot_username) return S.bot_username;
  const me = await tg(env, 'getMe', {});
  if (me.ok) {
    await saveSettings(env, S, { bot_username: me.result.username, bot_id: me.result.id });
    return me.result.username;
  }
  return null;
}

async function baseUrl(env, S) {
  return ORIGIN || (S && S.base_url) || null;
}

// Куда слать тревоги: чат разработчиков, а пока он не привязан — владельцу в личку
async function alertChat(env, S) {
  if (S.chat_id) return Number(S.chat_id);
  const o = await owner(env);
  return o ? Number(o.user_id) : null;
}

async function notifyOwner(env, text, extra = {}) {
  const o = await owner(env);
  if (o) return send(env, o.user_id, text, extra);
  return null;
}

// ─── куда писать: чат и тема форума ─────────────────────────────────────────
// Место — { chat, thread }: thread — тема форума, null — общая лента (General) или обычный чат.
// Тему удалили или закрыли — пишем в General: тревога не должна потеряться.

const TOPIC_GONE = /thread not found|TOPIC_(?:DELETED|ID_INVALID)/i;
const TOPIC_CLOSED = /TOPIC_CLOSED/i;
const topicOf = (msg) => (msg && msg.is_topic_message && msg.message_thread_id ? Number(msg.message_thread_id) : null);
const samePlace = (a, b) => !!a && !!b && String(a.chat) === String(b.chat) && Number(a.thread || 0) === Number(b.thread || 0);

function alertThread(S, chat) {
  return S.thread_id && String(chat) === String(S.chat_id) ? Number(S.thread_id) : null;
}
async function alertPlace(env, S) {
  const chat = await alertChat(env, S);
  return chat ? { chat, thread: alertThread(S, chat) } : null;
}
// Место в чате разработчиков (без запасного варианта «владельцу в личку»)
const teamPlace = (S) => (S.chat_id ? { chat: Number(S.chat_id), thread: alertThread(S, S.chat_id) } : null);

// Вызов Telegram с темой. Тема недоступна — повторяем в General, ответ помечаем lostThread.
async function postTo(env, S, method, params, thread) {
  if (!thread) return tg(env, method, params);
  const r = await tg(env, method, { ...params, message_thread_id: Number(thread) });
  const d = r.ok ? '' : r.description || '';
  const gone = TOPIC_GONE.test(d);
  if (!gone && !TOPIC_CLOSED.test(d)) return r;
  await topicTrouble(env, S, params.chat_id, thread, gone);
  const { reply_parameters, ...rest } = params; // отвечать не на что: сообщение осталось в той теме
  const r2 = await tg(env, method, rest);
  r2.lostThread = true;
  return r2;
}

function sendTo(env, S, place, text, extra = {}) {
  return postTo(env, S, 'sendMessage', { chat_id: place.chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra }, place.thread);
}

// Тема для тревог пропала — отвязываем её и говорим владельцу; закрыта — говорим не чаще раза в 6 часов
async function topicTrouble(env, S, chat, thread, gone) {
  if (String(chat) !== String(S.chat_id) || Number(S.thread_id || 0) !== Number(thread)) return;
  const name = topicName(S) ? `«${esc(topicName(S))}»` : 'для тревог';
  const where = `в чате «${esc(S.chat_title || chat)}»`;
  if (gone) {
    await saveSettings(env, S, { thread_id: null, thread_title: null, topic_name_set: null, topic_orig: null });
    await notifyOwner(env, `⚠️ Тема ${name} ${where} пропала — похоже, её удалили. Тревоги теперь идут в общую ленту чата (General).\nНазначить тему заново: отправьте /bind в нужной теме.`);
    return;
  }
  const now = nowS();
  if (now - int(S.topic_warn_at, 0) < 6 * 3600) return;
  await saveSettings(env, S, { topic_warn_at: now });
  await notifyOwner(env, `⚠️ Тема ${name} ${where} закрыта, писать в неё я не могу — сообщения пока идут в общую ленту чата (General).\nОткройте тему или дайте мне право «Управление темами».`);
}

// «в теме «…»» или, с to = true, «в тему «…»» — для сообщений, куда ушло или переехало
function placeName(S, place, from, to = false) {
  if (place.thread) {
    const title = Number(S.thread_id || 0) === Number(place.thread) && topicName(S);
    if (title) return `${to ? 'в тему' : 'в теме'} «${esc(title)}»`;
    return to ? 'в отдельную тему' : 'в отдельной теме';
  }
  if (from && String(from.chat) === String(place.chat)) return to ? 'в общую ленту чата (General)' : 'в общей ленте чата (General)';
  if (Number(place.chat) > 0) return 'владельцу в личку';
  return `${to ? 'в чат' : 'в чате'} «${esc(S.chat_title || place.chat)}»`;
}

// Где отвечать по падению: там, где его карточка; карточки нет — в чат тревог
async function incPlace(env, S, inc) {
  if (inc.chat_id) return { chat: Number(inc.chat_id), thread: inc.thread_id ? Number(inc.thread_id) : null };
  return alertPlace(env, S);
}
async function sendInc(env, S, inc, place, text, extra = {}) {
  const r = await sendTo(env, S, place, text, extra);
  if (r.lostThread) {
    place.thread = null;
    if (inc.chat_id && inc.thread_id) await updateIncident(env, inc, { thread_id: null });
  }
  return r;
}

// Ссылка на дашборд из сообщения: в группе — командная (ключ привязан к чату), в личке — Mini App
async function dashUrlFor(env, S, chatId) {
  const base = await baseUrl(env, S);
  if (!base) return null;
  const token = Number(chatId) < 0 ? await makeToken(env, S, 'g', chatId, 365) : await makeToken(env, S, 'u', chatId, 180);
  return `${base}/app#k=${token}`;
}

// ─── кого будим ─────────────────────────────────────────────────────────────

function oncallList(S) {
  const saved = safeJson(S.oncall);
  return (Array.isArray(saved) ? saved : DEFAULT_ONCALL).map((u) => String(u).replace(/^@/, '').trim()).filter(Boolean);
}

async function mentionsText(env, S) {
  const seen = new Set();
  const out = [];
  for (const u of oncallList(S)) {
    const k = u.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push('@' + u);
  }
  const { results } = await env.DB.prepare('SELECT user_id, name, username FROM users WHERE mention = 1 ORDER BY added_at').all();
  for (const r of results || []) {
    const k = String(r.username || '').toLowerCase();
    if (k && seen.has(k)) continue;
    if (k) {
      seen.add(k);
      out.push('@' + r.username);
    } else out.push(`<a href="tg://user?id=${Number(r.user_id)}">${esc(r.name || 'дежурный')}</a>`);
  }
  return out.join(' ');
}

async function dmSubscribers(env, S, exceptChat, make) {
  const { results } = await env.DB.prepare('SELECT user_id FROM users WHERE dm = 1 ORDER BY added_at LIMIT 25').all();
  const ids = (results || []).map((r) => Number(r.user_id)).filter((id) => id !== Number(exceptChat));
  await pool(ids, 5, async (uid) => {
    const m = make(uid);
    const r = await send(env, uid, m.text, m.kb ? { reply_markup: m.kb } : {});
    if (!r.ok && /blocked|deactivated|chat not found|user not found/i.test(r.description || '')) await setUserFlag(env, uid, 'dm', 0);
  });
}

// Сирена перед тревогой: одиночный эмодзи 🚨 Telegram показывает крупно и анимированно.
// Владелец может заменить его своим стикером командой /siren.
async function sendSiren(env, S, place) {
  let lost = false;
  if (S.siren_sticker) {
    const r = await postTo(env, S, 'sendSticker', { chat_id: place.chat, sticker: S.siren_sticker }, place.thread);
    if (r.ok) return r;
    lost = !!r.lostThread;
  }
  const r = await postTo(env, S, 'sendMessage', { chat_id: place.chat, text: '🚨' }, lost ? null : place.thread);
  if (lost) r.lostThread = true;
  return r;
}

// ─── карточка тревоги ───────────────────────────────────────────────────────

function renderAlert(inc, o = {}) {
  const now = o.now || nowS();
  const drill = inc.kind === 'drill';
  const title = `${SERVICE.name.toUpperCase()} НЕДОСТУПЕН`;
  const L = [];
  if (drill) L.push('🧪 <b>УЧЕБНАЯ ТРЕВОГА</b> — проверяем бота, Базис в порядке', '');
  if (inc.ended_at) L.push(`✅ <b>${drill ? 'УЧЕНИЯ ОКОНЧЕНЫ' : 'РЕШЕНО'}</b> · <s>${title}</s>`);
  else L.push(`🔴 <b>${title}</b>`);
  L.push(`${esc(SERVICE.host)} · прод`, '');
  for (const t of Object.values(inc.t || {})) {
    if (t.ok === 1) L.push(`✅ ${esc(t.n)} — отвечает`);
    else if (t.ok === 0) L.push(`❌ <b>${esc(t.n)}</b> — ${esc(t.e || 'не отвечает')}`);
    else L.push(`❔ ${esc(t.n)} — ${esc(t.e || 'нет данных')}`);
  }
  const planned = Number((String(inc.note || '').match(/^after_planned:(\d+)/) || [])[1] || 0);
  if (inc.ended_at) L.push(`⏱ Не отвечал <b>${dur(inc.ended_at - inc.started_at)}</b> · ${hhmm(inc.started_at)} → ${hhmm(inc.ended_at)} МСК`);
  else if (planned) L.push(`⏱ Не отвечает с <b>${hhmm(planned)}</b> МСК, сначала шли плановые работы · всего <b>${dur(now - planned)}</b>`);
  else L.push(`⏱ Не отвечает с <b>${hhmm(inc.started_at)}</b> МСК · уже <b>${dur(now - inc.started_at)}</b>`);
  if (planned && !inc.ended_at) L.push('🔧 Плановые работы закончились, а Базис так и не поднялся');
  if (o.muteUntil && o.muteUntil > now && !inc.ended_at) L.push(`🔧 Отмечено как плановые работы до ${hhmm(o.muteUntil)} МСК — напоминания на паузе`);
  if (inc.acked_at) L.push(`🙋 В работе: <b>${esc(inc.acked_name)}</b> · с ${hhmm(inc.acked_at)}, реакция ${dur(inc.acked_at - (inc.confirmed_at || inc.started_at))}`);
  else if (!inc.ended_at) L.push('', `📣 ${o.mentions ? o.mentions + ' — ' : ''}кто разбирается, нажмите «🙋 Беру»`);
  if (!inc.ended_at && !inc.acked_at && o.dm) L.push('Тревога продублирована в чат разработчиков.');
  return L.join('\n');
}

function alertKb(inc, o = {}) {
  const rows = [];
  if (!inc.ended_at && !inc.acked_at) rows.push([{ text: '🙋 Беру', callback_data: `ack:${inc.id}` }]);
  if (!inc.ended_at && inc.kind !== 'drill' && !o.muted) rows.push([{ text: '🔧 Это плановые работы · пауза 1 ч', callback_data: 'mute:60' }]);
  const links = [];
  if (o.dashUrl) links.push(o.dm ? { text: '📈 Дашборд', web_app: { url: o.dashUrl } } : { text: '📈 Дашборд', url: o.dashUrl });
  links.push({ text: '🌐 Открыть Базис', url: SERVICE.openUrl });
  rows.push(links);
  return { inline_keyboard: rows };
}

async function cardOpts(env, S, inc, now, extra = {}) {
  const muteUntil = int(S.mute_until, 0);
  return {
    now,
    muteUntil,
    mentions: inc.acked_at || inc.ended_at ? '' : await mentionsText(env, S),
    ...extra,
  };
}

async function sendAlert(env, S, inc, c, o = {}) {
  const place = await alertPlace(env, S);
  if (!place) return;
  const now = c.now || nowS();
  const dashUrl = await dashUrlFor(env, S, place.chat);
  if ((await sendSiren(env, S, place)).lostThread) place.thread = null;
  const opts = await cardOpts(env, S, inc, now, o);
  const m = await sendTo(env, S, place, renderAlert(inc, opts), { reply_markup: alertKb(inc, { dashUrl, muted: opts.muteUntil > now }) });
  if (m.lostThread) place.thread = null;
  if (m.ok) {
    await updateIncident(env, inc, { chat_id: place.chat, thread_id: place.thread, msg_id: m.result.message_id, last_edit: now, last_remind: now });
    await tg(env, 'pinChatMessage', { chat_id: place.chat, message_id: m.result.message_id, disable_notification: false });
  }
  const base = await baseUrl(env, S);
  const dmText = '🚨 ' + renderAlert(inc, { ...opts, mentions: '', dm: Number(place.chat) < 0 });
  await dmSubscribers(env, S, place.chat, () => ({ text: dmText, kb: alertKb(inc, { dashUrl: base ? `${base}/app` : null, dm: true, muted: true }) }));
}

async function refreshCard(env, S, inc, now = nowS()) {
  if (!inc.chat_id || !inc.msg_id) return;
  const opts = await cardOpts(env, S, inc, now);
  const kb = alertKb(inc, { dashUrl: await dashUrlFor(env, S, inc.chat_id), muted: opts.muteUntil > now });
  await edit(env, inc.chat_id, inc.msg_id, renderAlert(inc, opts), kb);
  await updateIncident(env, inc, { last_edit: now });
}

async function sendReminder(env, S, inc, c) {
  const place = await incPlace(env, S, inc);
  if (!place) return;
  const age = dur(c.now - inc.started_at);
  const mentions = await mentionsText(env, S);
  const ackKb = { inline_keyboard: [[{ text: '🙋 Беру', callback_data: `ack:${inc.id}` }]] };
  const drill = inc.kind === 'drill';
  const text = `${drill ? '🧪 ' : ''}⏰ <b>${SERVICE.name} не отвечает уже ${age}</b> — тревогу пока никто не взял.\n${mentions ? mentions + ' — ' : ''}нажмите «🙋 Беру», кто разбирается.`;
  await sendInc(env, S, inc, place, text, { reply_markup: ackKb, ...replyTo(inc.msg_id) });
  await updateIncident(env, inc, { reminders: (inc.reminders || 0) + 1, last_remind: c.now });
  await refreshCard(env, S, inc, c.now);
  await dmSubscribers(env, S, place.chat, () => ({ text: `${drill ? '🧪 Учебная: ' : ''}⏰ <b>${SERVICE.name} не отвечает уже ${age}</b> — тревогу никто не взял.`, kb: ackKb }));
}

async function sendRecovery(env, S, inc, c) {
  const place = await incPlace(env, S, inc);
  if (!place) return;
  const chat = place.chat;
  const took = dur(inc.ended_at - inc.started_at);
  const span = `${hhmm(inc.started_at)} → ${hhmm(inc.ended_at)} МСК`;
  if (inc.kind === 'planned') {
    await sendInc(env, S, inc, place, `🔧✅ <b>${SERVICE.name} снова отвечает</b>\nПростой во время плановых работ: ${took} · ${span}. В доступность не входит.`, { disable_notification: true, ...replyTo(inc.msg_id) });
    return;
  }
  const drill = inc.kind === 'drill';
  // В чате просим разбор: ответом на это сообщение — одной строкой, что случилось и что сделали
  const ask = Number(chat) < 0 ? await pmAsk(env, inc) : null;
  const m = await sendInc(env, S, inc, place, recoveryText(S, inc) + (ask ? '\n\n' + ask.text : ''), {
    ...replyTo(inc.msg_id),
    ...(ask && ask.markup ? { reply_markup: ask.markup } : {}),
  });
  if (ask && m.ok) await updateIncident(env, inc, { pm_msg: m.result.message_id });
  if (inc.msg_id) {
    await refreshCard(env, S, inc, c.now);
    await tg(env, 'unpinChatMessage', { chat_id: chat, message_id: inc.msg_id });
  }
  await dmSubscribers(env, S, chat, () => ({ text: `${drill ? '🧪 Учебная: ' : ''}✅ <b>${SERVICE.name} снова работает</b> · не отвечал ${took}` }));
}

// Текст «снова работает» (без просьбы о разборе). Нужен и потом — дописать разбор, когда его пришлют.
function recoveryText(S, inc) {
  const took = dur(inc.ended_at - inc.started_at);
  const span = `${hhmm(inc.started_at)} → ${hhmm(inc.ended_at)} МСК`;
  const drill = inc.kind === 'drill';
  const who = inc.acked_at
    ? `🙋 Кто разбирался: <b>${esc(inc.acked_name)}</b>, реакция ${dur(inc.acked_at - (inc.confirmed_at || inc.started_at))}`
    : drill ? '🙋 Тревогу никто не взял — в настоящей тревоге напоминания шли бы дальше' : '🙋 Тревогу так никто и не взял';
  const L = drill
    ? [
      '🧪✅ <b>УЧЕНИЯ ОКОНЧЕНЫ</b> — так выглядит «снова работает»',
      `Учебный простой: ${took} · ${span}`,
      who,
      `Настоящая тревога выглядит так же, только без 🧪, а напоминания идут раз в ${cfg(S, 'remind_every')} мин, пока кто-нибудь не нажмёт «🙋 Беру».`,
    ]
    : [`✅ <b>${SERVICE.name.toUpperCase()} СНОВА РАБОТАЕТ</b>`, `Не отвечал <b>${took}</b> · ${span}`, inc.cause ? `Причина: ${esc(inc.cause)}` : null, who].filter(Boolean);
  if (inc.pm_text) L.push(`📝 <b>Разбор:</b> ${esc(inc.pm_text)}${inc.pm_by ? ` — ${esc(inc.pm_by)}` : ''}`);
  return L.join('\n');
}

// Кого просим о разборе: того, кто взял тревогу (Telegram сам откроет ему ответ), иначе — всех
async function pmAsk(env, inc) {
  const lead = inc.kind === 'drill' ? '📝 <b>Учебный разбор:</b>' : '📝 <b>Разбор:</b>';
  let who = null;
  if (inc.acked_uid) {
    const u = await getUser(env, inc.acked_uid);
    who = u && u.username ? '@' + u.username : `<a href="tg://user?id=${Number(inc.acked_uid)}">${esc(inc.acked_name || 'кто взял тревогу')}</a>`;
  }
  if (!who) return { text: `${lead} кто разбирался — ответьте на это сообщение одной строкой: что случилось и что сделали. Запишу в журнал.`, markup: null };
  return {
    text: `${lead} ${who}, ответьте на это сообщение одной строкой — что случилось и что сделали. Запишу в журнал.`,
    markup: { force_reply: true, selective: true, input_field_placeholder: 'Что случилось и что сделали' },
  };
}

// Ответ на «снова работает» — это разбор: пишем в журнал, дописываем в сообщение, ставим ✍
async function onPostmortemReply(env, S, msg, botId) {
  const rt = msg.reply_to_message;
  if (!rt || !rt.from || Number(rt.from.id) !== Number(botId)) return false;
  const text = String(msg.text || msg.caption || '').replace(/\s+/g, ' ').trim();
  if (!text || text.startsWith('/')) return false;
  const inc = parseInc(await env.DB.prepare('SELECT * FROM incidents WHERE pm_msg = ? AND chat_id = ?').bind(rt.message_id, msg.chat.id).first());
  if (!inc) return false;
  const again = !!inc.pm_text;
  await updateIncident(env, inc, { pm_text: trunc(text, 500), pm_by: userName(msg.from), pm_at: nowS() });
  const e = await tg(env, 'editMessageText', { chat_id: msg.chat.id, message_id: rt.message_id, text: recoveryText(S, inc), parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  await tg(env, 'setMessageReaction', { chat_id: msg.chat.id, message_id: msg.message_id, reaction: [{ type: 'emoji', emoji: '✍' }] });
  if (!e.ok || again) {
    await sendTo(env, S, { chat: msg.chat.id, thread: topicOf(msg) }, `📝 ${again ? 'Обновил' : 'Записал'} разбор в журнал.`, { disable_notification: true, ...replyTo(msg.message_id) });
  }
  return true;
}

// ─── статус в названии темы ─────────────────────────────────────────────────
// «🟢 Базис работает» / «🔴 Базис недоступен» / «🔧 Базис: плановые работы» — видно прямо в списке чатов.
// Нужно право «Управление темами». Исходное название запоминаем и возвращаем, если статус выключат.

const isStatusName = (n) => Object.values(TOPIC_NAMES).includes(String(n || ''));
const topicName = (S) => S.topic_name_set || S.thread_title || null;

async function topicState(env, S, now = nowS()) {
  const inc = await openIncident(env);
  if (inc && inc.kind === 'down') return 'down';
  if ((inc && inc.kind === 'planned') || int(S.mute_until, 0) > now) return 'planned';
  return 'up';
}

async function syncTopicName(env, S, force = false) {
  if (!S.chat_id || !S.thread_id || !cfg(S, 'topic_status')) return false;
  const name = TOPIC_NAMES[await topicState(env, S)];
  if (!force && S.topic_name_set === name) return false;
  const r = await tg(env, 'editForumTopic', { chat_id: Number(S.chat_id), message_thread_id: Number(S.thread_id), name });
  const d = r.ok ? '' : r.description || '';
  if (r.ok || /TOPIC_NOT_MODIFIED/i.test(d)) {
    const upd = { topic_name_set: name, topic_at: nowS() };
    if (!S.topic_orig && S.thread_title && !isStatusName(S.thread_title)) upd.topic_orig = S.thread_title;
    await saveSettings(env, S, upd);
    return true;
  }
  if (TOPIC_GONE.test(d)) return false; // тему удалили — это заметит отправка сообщений
  if (!S.topic_rights_warned) {
    await saveSettings(env, S, { topic_rights_warned: nowS() });
    await notifyOwner(env, `🏷 Не получилось поменять название темы (${esc(trunc(d || 'нет ответа', 80))}).\nЧтобы в названии был виден статус — «${TOPIC_NAMES.up}» или «${TOPIC_NAMES.down}», — дайте мне в чате право «Управление темами». Выключить эту функцию — /settings.`);
  }
  return false;
}

async function restoreTopicName(env, S) {
  if (!S.topic_name_set) return;
  const orig = S.topic_orig || (S.thread_title && !isStatusName(S.thread_title) ? S.thread_title : null);
  if (S.chat_id && S.thread_id && orig) await tg(env, 'editForumTopic', { chat_id: Number(S.chat_id), message_thread_id: Number(S.thread_id), name: orig });
  await saveSettings(env, S, { topic_name_set: null, topic_orig: null });
}

// В прогоне: после событий — сразу, а раз в 5 минут — сверка на всякий случай
async function topicTick(env, S, c, event) {
  if (!S.chat_id || !S.thread_id || !cfg(S, 'topic_status')) return;
  const ev = ['down', 'recovered', 'planned'].includes(event && event.type);
  if (!ev && c.now - int(S.topic_at, 0) < 290) return;
  if (!(await syncTopicName(env, S))) await saveSettings(env, S, { topic_at: c.now });
}

// Во время плановых работ — тихо, без упоминаний и закрепа
async function sendPlannedDown(env, S, inc, c) {
  const place = await alertPlace(env, S);
  if (!place) return;
  const until = int(S.mute_until, 0);
  const text = `🔧 <b>${SERVICE.name} не отвечает — идут плановые работы</b>\nТревоги на паузе до ${hhmm(until)} МСК. Если к концу работ не поднимется — будет обычная тревога.`;
  const m = await sendTo(env, S, place, text, { disable_notification: true });
  if (m.ok) await updateIncident(env, inc, { chat_id: place.chat, thread_id: m.lostThread ? null : place.thread, msg_id: m.result.message_id });
}

// ─── «Беру» ─────────────────────────────────────────────────────────────────

async function ackIncident(env, S, inc, from, now = nowS()) {
  const name = userName(from);
  const r = await env.DB.prepare('UPDATE incidents SET acked_uid = ?, acked_name = ?, acked_at = ? WHERE id = ? AND acked_at IS NULL AND ended_at IS NULL')
    .bind(from.id, name, now, inc.id).run();
  if (!r.meta || !r.meta.changes) return false;
  Object.assign(inc, { acked_uid: from.id, acked_name: name, acked_at: now });
  await refreshCard(env, S, inc, now);
  if (inc.chat_id) await sendInc(env, S, inc, await incPlace(env, S, inc), `🙋 <b>${esc(name)}</b> берёт тревогу${inc.kind === 'drill' ? ' (учебную)' : ''} — напоминаний больше не будет.`, { disable_notification: true, ...replyTo(inc.msg_id) });
  await dmSubscribers(env, S, from.id, () => ({ text: `🙋 ${esc(name)} берёт тревогу${inc.kind === 'drill' ? ' (учебную)' : ''} — ${SERVICE.name} ещё не отвечает, ждём.` }));
  return true;
}

// ─── табло: живой статус + инструкция (закреп в чате) ───────────────────────

function guideLines(S) {
  const fa = cfg(S, 'fail_after');
  const re = cfg(S, 'remind_every');
  return [
    '📖 <b>Как читать сообщения бота</b>',
    `🚨 🔴 <b>БАЗИС НЕДОСТУПЕН</b> — прод не отвечает ${fa} ${plural(fa, 'минуту', 'минуты', 'минут')} подряд. Тревога закрепляется, упоминает дежурных и повторяется каждые ${re} мин, пока кто-то не нажмёт «🙋 Беру».`,
    '✅ <b>БАЗИС СНОВА РАБОТАЕТ</b> — бот сам ответит на тревогу, когда прод поднимется, и посчитает простой.',
    '🔧 <b>Плановые работы</b> — тревоги на паузе, простой записывается отдельно и в доступность не входит.',
    '🧪 <b>Учебная тревога</b> — проверка бота, с продом всё в порядке.',
    '',
    '⚡ <b>Что делать при тревоге</b>',
    '1. Кто разбирается — жмёт «🙋 Беру». Повторы прекращаются, всем видно, кто в деле.',
    '2. Ход работ пишите ответом на тревогу — вся история в одной ветке.',
    '3. Починили — закрывать ничего не нужно: бот сам напишет «✅ снова работает».',
    '4. Ответьте на «снова работает» одной строкой: что случилось и что сделали — бот запишет разбор в журнал.',
    '5. Плановые работы — заранее /mute 1h или кнопка «🔧 Это плановые работы» в тревоге.',
    '',
    '/status — что сейчас · /stats — статистика падений · /incidents — журнал · /dash — графики',
  ];
}

async function boardHead(env, S, now) {
  const inc = await openIncident(env);
  const last = await env.DB.prepare("SELECT ts, st FROM checks WHERE target = '_' ORDER BY ts DESC LIMIT 1").first();
  const muteUntil = int(S.mute_until, 0);
  const svc = last ? Number(last.st) : null;
  let head;
  if (inc && inc.kind === 'down') head = `🔴 <b>${SERVICE.name} недоступен</b> · уже ${dur(now - inc.started_at)} · ${inc.acked_name ? 'в работе: ' + esc(inc.acked_name) : 'никто не взял'}`;
  else if (muteUntil > now) head = `🔧 <b>Плановые работы</b> до ${hhmm(muteUntil)} МСК · тревоги на паузе`;
  else if (svc === -1) head = `❔ <b>У монитора нет сети</b> — статус ${SERVICE.gen} неизвестен`;
  else if (svc === 0) head = `🟠 <b>${SERVICE.name} не отвечает</b> — перепроверяю`;
  else if (svc == null) head = `⏳ <b>Первая проверка ещё не прошла</b>`;
  else head = `🟢 <b>${SERVICE.name} работает</b>`;
  const today = await svcCounts(env, S, mskDayStart(now), now + 60);
  const m30 = await svcCounts(env, S, now - 30 * 86400, now + 60);
  const n30 = await countIncidents(env, now - 30 * 86400);
  const lines = [head];
  const checkedAt = int(S.last_check, 0) || (last ? Number(last.ts) : 0); // время настоящей проверки, а не минуты между ними
  lines.push(checkedAt ? `Проверено в ${hhmm(checkedAt)} МСК · проверка ${everyText(S)}` : `Проверка ${everyText(S)}`);
  lines.push(`Сегодня ${pctText(today)} · за 30 дней ${pctText(m30)}, ${n30 ? `${n30} ${plural(n30, 'падение', 'падения', 'падений')}` : 'падений не было'}`);
  return lines;
}

function boardKb(dashUrl) {
  const rows = [[{ text: '📣 Упоминать меня', callback_data: 'me:mention' }, { text: '🔔 Тревоги в личку', callback_data: 'me:dm' }]];
  if (dashUrl) rows.push([{ text: '📈 Дашборд', url: dashUrl }]);
  return { inline_keyboard: rows };
}

async function renderBoard(env, S, now) {
  return [...(await boardHead(env, S, now)), '', ...guideLines(S)].join('\n');
}

async function postBoard(env, S, place) {
  const now = nowS();
  const text = await renderBoard(env, S, now);
  const m = await sendTo(env, S, place, text, { reply_markup: boardKb(await dashUrlFor(env, S, place.chat)), disable_notification: true });
  if (!m.ok) return m;
  m.place = { chat: place.chat, thread: m.lostThread ? null : place.thread || null }; // куда легло на самом деле
  await saveSettings(env, S, { board_chat: m.place.chat, board_thread: m.place.thread, board_msg: m.result.message_id, board_at: now });
  m.pinned = (await tg(env, 'pinChatMessage', { chat_id: place.chat, message_id: m.result.message_id, disable_notification: true })).ok;
  return m;
}

// Табло одно. Новое выкладываем и закрепляем, старое открепляем: на том же месте — удаляем
// (не вышло — оставляем пометку), в другом месте — оставляем указатель, куда переехали.
async function replaceBoard(env, S, place) {
  const old = S.board_msg && S.board_chat ? { chat: Number(S.board_chat), thread: S.board_thread ? Number(S.board_thread) : null, msg: Number(S.board_msg) } : null;
  const m = await postBoard(env, S, place);
  if (!old || !m.ok) return m;
  await tg(env, 'unpinChatMessage', { chat_id: old.chat, message_id: old.msg });
  if (samePlace(old, m.place)) {
    const d = await tg(env, 'deleteMessage', { chat_id: old.chat, message_id: old.msg });
    if (!d.ok) await edit(env, old.chat, old.msg, '📌 Табло перевыложено — актуальное ниже, в закрепе.');
  } else {
    await edit(env, old.chat, old.msg, `📍 Тревоги ${SERVICE.gen} и живой статус переехали ${placeName(S, m.place, old, true)}.`);
  }
  return m;
}

const BOARD_EVENTS = ['down', 'recovered', 'planned', 'remind'];
async function boardTick(env, S, c, event) {
  if (!S.board_msg || !S.board_chat) return;
  const due = BOARD_EVENTS.includes(event && event.type) || c.now - int(S.board_at, 0) >= 290;
  if (!due) return;
  const text = await renderBoard(env, S, c.now);
  const r = await edit(env, Number(S.board_chat), Number(S.board_msg), text, boardKb(await dashUrlFor(env, S, S.board_chat)));
  if (!r.ok && /message to edit not found|message can't be edited|chat not found/i.test(r.description || '')) {
    // Табло пропало. Если вместе с темой — отвязываем тему и говорим владельцу сразу, а не при тревоге
    if (S.board_thread && Number(S.board_thread) === Number(S.thread_id || 0)) {
      const p = await tg(env, 'sendChatAction', { chat_id: Number(S.board_chat), message_thread_id: Number(S.board_thread), action: 'typing' });
      if (!p.ok && TOPIC_GONE.test(p.description || '')) await topicTrouble(env, S, S.board_chat, S.board_thread, true);
    }
    await saveSettings(env, S, { board_msg: null, board_chat: null, board_thread: null, board_at: null });
    return;
  }
  await saveSettings(env, S, { board_at: c.now });
}

// ─── учебная тревога ────────────────────────────────────────────────────────
// Весь цикл за ~4 минуты: тревога → напоминание раз в минуту → «Беру» → «снова работает».
// В статистику не идёт (kind = drill).

async function startDrill(env, S, place, by) {
  const cur = safeJson(S.drill);
  const now = nowS();
  if (cur && cur.id && now - cur.started < 600) return { ok: false, text: '🧪 Учения уже идут — дождись «учения окончены».' };
  const t = {};
  getTargets(S).forEach((x, i) => {
    t[x.id] = { n: x.name, ok: 0, e: i === 0 ? '502 Bad Gateway (понарошку)' : `нет ответа за ${Math.round(TIMEOUT_MS / 1000)} с (понарошку)`, c: null };
  });
  const r = await env.DB.prepare("INSERT INTO incidents (kind, started_at, confirmed_at, targets, cause, note) VALUES ('drill', ?, ?, ?, ?, ?)")
    .bind(now - 120, now, JSON.stringify(t), 'учебная тревога', `запустил ${by}`).run();
  const inc = await getIncident(env, r.meta.last_row_id);
  await saveSettings(env, S, { drill: JSON.stringify({ id: inc.id, chat: place.chat, started: now, last: now }) });
  const dashUrl = await dashUrlFor(env, S, place.chat);
  if ((await sendSiren(env, S, place)).lostThread) place.thread = null;
  const opts = await cardOpts(env, S, inc, now);
  const m = await sendTo(env, S, place, renderAlert(inc, opts), { reply_markup: alertKb(inc, { dashUrl }) });
  if (m.lostThread) place.thread = null;
  if (m.ok) {
    await updateIncident(env, inc, { chat_id: place.chat, thread_id: place.thread, msg_id: m.result.message_id, last_edit: now, last_remind: now });
    await tg(env, 'pinChatMessage', { chat_id: place.chat, message_id: m.result.message_id, disable_notification: false });
  }
  const base = await baseUrl(env, S);
  await dmSubscribers(env, S, place.chat, () => ({ text: renderAlert(inc, { ...opts, mentions: '' }), kb: alertKb(inc, { dashUrl: base ? `${base}/app` : null, dm: true }) }));
  return { ok: true, inc, place };
}

async function drillTick(env, S, now) {
  const d = safeJson(S.drill);
  if (!d || !d.id) return;
  const inc = await getIncident(env, d.id);
  if (!inc || inc.ended_at) {
    await saveSettings(env, S, { drill: null });
    return;
  }
  if (inc.acked_at) {
    if (now - inc.acked_at >= 50) await finishDrill(env, S, inc, now);
    return;
  }
  if (now - d.started >= 170) {
    await finishDrill(env, S, inc, now);
    return;
  }
  if (now - (d.last || d.started) >= 50) {
    await sendReminder(env, S, inc, { now });
    d.last = now;
    await saveSettings(env, S, { drill: JSON.stringify(d) });
  }
}

async function finishDrill(env, S, inc, now) {
  await updateIncident(env, inc, { ended_at: now });
  await saveSettings(env, S, { drill: null });
  await sendRecovery(env, S, inc, { now });
}

// ─── итоги недели ───────────────────────────────────────────────────────────

async function sendWeekly(env, S, now) {
  const chat = S.chat_id ? Number(S.chat_id) : null;
  if (!chat) return;
  const to = mskDayStart(now); // понедельник 00:00 МСК
  const from = to - 7 * 86400;
  const text = await periodSummary(env, S, from, to, `📊 <b>${SERVICE.name} за неделю</b> · ${dayMonth(from)} – ${dayMonth(to - 86400)}`);
  await sendTo(env, S, { chat, thread: alertThread(S, chat) }, text, { disable_notification: true });
}
