// Атлас шрифта для картинки «итоги недели».
// Рисует глифы Manrope в Chromium (Playwright) и складывает их альфа-маски в app/card-font.json.
// Worker потом не растрирует шрифт — только накладывает готовые глифы (быстро, влезает в лимит free-плана Cloudflare).
// Запуск: node art/make-card-font.mjs   (нужен playwright)
// Пересобирать только если поменяли шрифт или размеры. Дальше: node build.mjs (вошьёт JSON в worker.js).
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require(require('node:child_process').execSync('npm root -g').toString().trim() + '/playwright'));
}

const u = (p) => new URL(p, import.meta.url);
const font = (f) => fs.readFileSync(u('../app/fonts/' + f)).toString('base64');
const FONT_CSS = `
@font-face{font-family:M;font-weight:200 800;src:url(data:font/woff2;base64,${font('manrope-cyrillic-wght-normal.woff2')}) format('woff2');unicode-range:U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116}
@font-face{font-family:M;font-weight:200 800;src:url(data:font/woff2;base64,${font('manrope-latin-wght-normal.woff2')}) format('woff2');unicode-range:U+0000-00FF,U+2010-2015,U+2018-201F,U+2022,U+00B7,U+2116,U+2212}`;

// Наборы глифов. hero — крупные цифры для доступности; med/bold — обычный текст.
const DIGITS = '0123456789';
const PUNCT = ' .,:%()/+·–—-№°';
const CYR = 'абвгдежзийклмнопрстуфхцчшщъыьэюяё'.split('').join('') + 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯЁ';
const LAT = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const FULL = DIGITS + PUNCT + CYR + LAT;

const SETS = [
  { key: 'hero', size: 66, weight: 800, chars: DIGITS + ' .,%—' },
  { key: 'bold', size: 26, weight: 800, chars: FULL },
  { key: 'med', size: 21, weight: 600, chars: FULL },
  { key: 'small', size: 16, weight: 600, chars: FULL },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 400, height: 200 }, deviceScaleFactor: 1 });
await page.setContent(`<!doctype html><meta charset=utf-8><style>${FONT_CSS}</style><body><canvas id=c></canvas>`);
await page.evaluate(async () => { await document.fonts.load('800 66px M'); await document.fonts.load('600 21px M'); await document.fonts.ready; });

const out = { font: 'Manrope', sizes: {} };
for (const set of SETS) {
  const data = await page.evaluate(({ size, weight, chars }) => {
    const pad = Math.ceil(size * 0.6);
    const W = Math.ceil(size * 2) + pad * 2;
    const H = Math.ceil(size * 2) + pad * 2;
    const cv = document.getElementById('c');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.font = `${weight} ${size}px M`;
    ctx.textBaseline = 'alphabetic';
    const baseline = pad + Math.ceil(size * 1.2);
    const m0 = ctx.measureText('Hg');
    const ascent = Math.round(m0.actualBoundingBoxAscent);
    const lineH = Math.round(size * 1.34);
    const glyphs = {};
    let spaceAdv = Math.round(ctx.measureText(' ').width);
    for (const ch of chars) {
      const adv = Math.round(ctx.measureText(ch).width * 10) / 10;
      if (ch === ' ') { spaceAdv = adv; continue; }
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#fff';
      ctx.fillText(ch, pad, baseline);
      const img = ctx.getImageData(0, 0, W, H).data;
      let minX = W, minY = H, maxX = -1, maxY = -1;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (img[(y * W + x) * 4 + 3]) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) { glyphs[ch] = { w: 0, h: 0, dx: 0, dy: 0, adv, a: '' }; continue; }
      const gw = maxX - minX + 1, gh = maxY - minY + 1;
      const bytes = new Uint8Array(gw * gh);
      for (let y = 0; y < gh; y++)
        for (let x = 0; x < gw; x++)
          bytes[y * gw + x] = img[((minY + y) * W + (minX + x)) * 4 + 3];
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      glyphs[ch] = { w: gw, h: gh, dx: minX - pad, dy: minY - baseline, adv, a: btoa(bin) };
    }
    return { ascent, lineH, spaceAdv, glyphs };
  }, set);
  out.sizes[set.key] = data;
  const n = Object.keys(data.glyphs).length;
  const bytes = Object.values(data.glyphs).reduce((s, g) => s + g.w * g.h, 0);
  console.log(`${set.key}: ${n} глифов, ${(bytes / 1024).toFixed(0)} КБ альфы`);
}
await browser.close();

const json = JSON.stringify(out);
fs.writeFileSync(u('../app/card-font.json'), json);
console.log(`app/card-font.json: ${(json.length / 1024).toFixed(0)} КБ`);
