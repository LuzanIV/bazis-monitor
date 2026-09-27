// Сборка: src/*.js склеиваются по порядку, страница дашборда (app/*), шрифт и иконка вшиваются
// → dist/worker.js — один файл для вставки в Cloudflare (Edit code → вставить → Deploy).
import fs from 'node:fs';

const u = (p) => new URL(p, import.meta.url);
const read = (p) => fs.readFileSync(u(p), 'utf8');
const b64 = (p) => fs.readFileSync(u(p)).toString('base64');

const parts = fs.readdirSync(u('./src/')).filter((f) => /^\d\d-.*\.js$/.test(f)).sort();
let w = parts.map((f) => read('./src/' + f)).join('\n');

let page = read('./app/shell.html')
  .replace('/*APP_CSS*/', () => read('./app/app.css'))
  .replace('<!--APP_BODY-->', () => read('./app/body.html'));
page = page
  .replace('__FONT_LATIN__', () => b64('./app/fonts/manrope-latin-wght-normal.woff2'))
  .replace('__FONT_CYR__', () => b64('./app/fonts/manrope-cyrillic-wght-normal.woff2'));
if (page.includes('`') || page.includes('${')) throw new Error('в странице есть ` или ${ — String.raw не подойдёт');
fs.writeFileSync(u('./app/app.html'), page);

const htmlSlot = "const APP_HTML = '__APP_HTML__';";
const iconSlot = "const ICON_PNG_B64 = '__ICON_PNG_B64__';";
if (!w.includes(htmlSlot) || !w.includes(iconSlot)) throw new Error('нет мест для вставки страницы или иконки');
w = w.replace(htmlSlot, () => 'const APP_HTML = String.raw`' + page + '`;');
const icon = b64('./app/icon.png');
w = w.replace(iconSlot, () => "const ICON_PNG_B64 = '" + icon + "';");

fs.mkdirSync(u('./dist/'), { recursive: true });
fs.writeFileSync(u('./dist/worker.js'), w);
const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(0);
console.log(`dist/worker.js: ${kb(w)} KB (${parts.length} частей; страница ${kb(page)} KB, иконка ${(icon.length / 1024).toFixed(0)} KB base64)`);
