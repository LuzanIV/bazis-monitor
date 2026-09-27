/**
 * «Базис · мониторинг» — алертный Telegram-бот и дашборд доступности прода Базиса (etalon.iflat.io).
 * Cloudflare Worker + D1 + Cron Trigger раз в минуту (прод проверяется раз в 5 минут, при сбое — каждую минуту).
 * Один файл, без зависимостей.
 *
 * Привязки и секреты:
 *   DB         — база D1
 *   BOT_TOKEN  — секрет, токен от @BotFather (единственный секрет, вносится вручную)
 *   Cron Trigger «* * * * *» — Worker → Settings → Trigger Events → Cron Triggers
 *
 * Секрет вебхука и админ-ключ выводятся из BOT_TOKEN (sha-256), отдельно их задавать не нужно.
 *
 * Адреса:
 *   POST /tg                — вебхук Telegram
 *   GET  /setup             — таблицы, вебхук, команды, кнопка «Дашборд», пробная проверка (идемпотентно)
 *   GET  /app               — дашборд (Telegram Mini App, личная или командная ссылка)
 *   GET  /api/data          — данные дашборда (?range=1h|24h|7d|30d|90d)
 *   GET  /api/incidents.csv — журнал падений для Excel
 *   GET  /health            — жив ли сам монитор: 200, если проверка была за последние 3 минуты, иначе 503
 *   GET  /debug/tick        — ручной прогон проверки (админ-ключ; &dry=1 — только посмотреть ответы, без записи)
 *
 * Разделы исходника (src/*.js склеиваются сборкой в dist/worker.js):
 *   00 настройки · 10 вход · 20 база · 30 проверки и инциденты · 40 сообщения и тревоги
 *   50 бот · 60 статистика и дашборд · 70 доступ · 80 мелочи
 */

const VERSION = '1.4.0';

// Страница дашборда, иконка и шрифт вшиваются сборкой (build.mjs → dist/worker.js)
const APP_HTML = '__APP_HTML__';
const ICON_PNG_B64 = '__ICON_PNG_B64__';
let ORIGIN = null; // https://<worker>.workers.dev — для кнопок, открывающих дашборд

// ─── что проверяем ──────────────────────────────────────────────────────────

const SERVICE = {
  name: 'Базис', // кто? — «Базис не отвечает»
  gen: 'Базиса', // кого? чего? — «мониторинг Базиса»
  dat: 'Базису', // кому? по чему? — «тревоги по Базису»
  host: 'etalon.iflat.io',
  openUrl: 'https://etalon.iflat.io/panel',
};

// Проверки по умолчанию. Владелец меняет список командами /targets, /target_add, /target_del.
// Сверено на проде 25.09.2026: /login без входа отдаёт 200 и разметку приложения за ~0,23 с,
// API без входа отдаёт 401 {"message":"Unauthenticated."} за ~0,23 с — это и есть «живой».
const DEFAULT_TARGETS = [
  { id: 'web', name: 'Сайт', url: 'https://etalon.iflat.io/login', expect: [200], kind: 'html', marker: 'id="app"' },
  { id: 'api', name: 'API', url: 'https://etalon.iflat.io/api/v1/houses?perPage=1', expect: [200, 401], kind: 'json' },
];

// Если не отвечает и Базис, и контрольный адрес — проблема в сети самого монитора (Cloudflare),
// а не в Базисе. Такие минуты не считаются ни падением, ни работой.
const CONTROL_URL = 'https://ya.ru/';

const TIMEOUT_MS = 12000; // сколько ждём ответа
const RETRY_DELAY_MS = 4000; // пауза перед повтором, если первая попытка не прошла
const SLOW_MS = 3000; // выше — «медленно» (жёлтая зона на дашборде)
const MAX_TARGETS = 6; // бесплатный тариф: не больше 50 запросов к базе и 50 подзапросов за вызов
const RETENTION_DAYS = 10; // поминутные проверки; почасовые сводки хранятся 400 дней

// Кого упоминать в тревогах. Меняется командой /oncall; плюс все, кто нажал «📣 Упоминать меня».
// Разработка Базиса. Владелец бота (со стороны заказчика) получает тревоги в личку — упоминать его не нужно.
const DEFAULT_ONCALL = ['Kiss_Alexandr', 'VitalyFeodorov', 'reffery101', 'Ai_basis', 'A_K_Titov', 'Osipov_A_L', 'Chadny_Denis', 'eugene_lipenin'];

const DEFAULTS = {
  check_every: 5, // проверка прода раз в столько минут; пока что-то не так (сбой, падение, пауза) — каждую минуту
  fail_after: 2, // тревога после стольких неудачных минут подряд
  recover_after: 2, // «снова работает» после стольких удачных минут подряд
  remind_every: 5, // повтор тревоги, пока никто не нажал «Беру», мин (после 30 мин — раз в 15, после 2 ч — раз в час)
  weekly: 1, // итоги недели по понедельникам в 9:00 МСК
  topic_status: 1, // статус в названии темы форума: «🟢 Базис работает» / «🔴 Базис недоступен» / «🔧 Базис: плановые работы»
};

// Имя бота в Telegram (ставится в /setup): короткое, чтобы в списке чатов было видно само сообщение
const BOT_NAME = 'Мониторинг';

// Названия темы тревог по состоянию прода (нужно право «Управление темами»)
const TOPIC_NAMES = {
  up: `🟢 ${SERVICE.name} работает`,
  down: `🔴 ${SERVICE.name} недоступен`,
  planned: `🔧 ${SERVICE.name}: плановые работы`,
};

const MSK = 3 * 3600; // Москва, UTC+3 без перехода на летнее время
const UA = `Mozilla/5.0 (compatible; BazisMonitor/${VERSION}; uptime check)`;
const CHECK_EVERY = [1, 2, 5, 10]; // как часто проверять — варианты в /settings, мин

const BTN = {
  status: '📊 Статус',
  dash: '📈 Дашборд',
  dm: '🔔 Личные тревоги',
  help: '❓ Помощь',
};

const COMMANDS_PRIVATE = [
  { command: 'status', description: 'Что с Базисом сейчас' },
  { command: 'stats', description: 'Статистика падений' },
  { command: 'incidents', description: 'Журнал падений' },
  { command: 'dash', description: 'Дашборд с графиками' },
  { command: 'subscribe', description: 'Присылать тревоги в личку' },
  { command: 'unsubscribe', description: 'Не присылать тревоги в личку' },
  { command: 'help', description: 'Как пользоваться' },
];

const COMMANDS_GROUP = [
  { command: 'status', description: 'Что с Базисом сейчас' },
  { command: 'stats', description: 'Статистика падений' },
  { command: 'incidents', description: 'Журнал падений' },
  { command: 'dash', description: 'Дашборд с графиками' },
  { command: 'mute', description: 'Плановые работы: пауза тревог, например /mute 1h' },
  { command: 'unmute', description: 'Снова включить тревоги' },
  { command: 'guide', description: 'Инструкция и живой статус — закрепить' },
  { command: 'drill', description: 'Учебная тревога' },
  { command: 'help', description: 'Команды бота' },
];
