// Картинки бота: метеорит «Базис» врезается в планету «Эталон».
// Рисуется кодом (SVG) и снимается в PNG через Chromium (Playwright).
//   art/avatar.png      640×640 — аватар бота (BotFather → /setuserpic), всё важное внутри круга
//   art/description.png 640×360 — картинка в описании бота (BotFather → /setdescriptionpic)
//   app/icon.png        512×512 — иконка дашборда и «На экран „Домой“» (без подписей — читается мелко)
// Запуск: node art/make-art.mjs   (нужен playwright: npm i -g playwright или npx)
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
@font-face{font-family:M;font-weight:200 800;src:url(data:font/woff2;base64,${font('manrope-cyrillic-wght-normal.woff2')}) format('woff2');unicode-range:U+0400-045F}
@font-face{font-family:M;font-weight:200 800;src:url(data:font/woff2;base64,${font('manrope-latin-wght-normal.woff2')}) format('woff2');unicode-range:U+0000-00FF}`;

// детерминированный «случай» — картинка одинаковая при каждой сборке
let seed = 20260925;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const f1 = (n) => Number(n).toFixed(1);

const BRAND = { blue: '#194B9B', navy: '#1E242E', orange: '#FF4D00', red: '#C10C1A' };

function stars(W, H, n, avoid) {
  let out = '';
  for (let i = 0; i < n; i++) {
    const x = rnd() * W;
    const y = rnd() * H;
    if (avoid && avoid(x, y)) continue;
    const r = 0.5 + rnd() * 1.4;
    const o = 0.25 + rnd() * 0.7;
    out += `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r)}" fill="#fff" opacity="${o.toFixed(2)}"/>`;
    if (r > 1.6 && rnd() > 0.4) out += `<path d="M${f1(x - r * 3)} ${f1(y)}H${f1(x + r * 3)}M${f1(x)} ${f1(y - r * 3)}V${f1(y + r * 3)}" stroke="#fff" stroke-width="0.6" opacity="${(o * 0.6).toFixed(2)}"/>`;
  }
  return out;
}

function starburst(cx, cy, n, rOut, rIn, rot, fill, jitter = 0.25) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = rot + (i * Math.PI) / n;
    const r = (i % 2 ? rIn : rOut) * (1 - jitter / 2 + rnd() * jitter);
    pts.push(`${f1(cx + r * Math.cos(a))},${f1(cy + r * Math.sin(a))}`);
  }
  return `<polygon points="${pts.join(' ')}" fill="${fill}"/>`;
}

function rock(cx, cy, r, fill, n = 9) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rnd() * 0.3;
    const rr = r * (0.72 + rnd() * 0.32);
    pts.push(`${f1(cx + rr * Math.cos(a))},${f1(cy + rr * Math.sin(a))}`);
  }
  return `<polygon points="${pts.join(' ')}" fill="${fill}"/>`;
}

// Сцена в координатах 640×640; для широкой картинки двигаем и масштабируем элементы
function scene({ W, H, planet, impact, tailFrom, labels, textScale = 1, textOffset = 50 }) {
  const { cx: pcx, cy: pcy, r: pr } = planet;
  const [ix, iy] = impact;
  const [tx, ty] = tailFrom;
  const ang = Math.atan2(iy - ty, ix - tx);
  const deg = (ang * 180) / Math.PI;
  const len = Math.hypot(ix - tx, iy - ty);
  // голова метеорита — чуть до точки удара
  const hx = ix - Math.cos(ang) * 48;
  const hy = iy - Math.sin(ang) * 48;
  const nx = -Math.sin(ang);
  const ny = Math.cos(ang);
  const tail = (w0, w1, back) => {
    const bx = hx - Math.cos(ang) * back;
    const by = hy - Math.sin(ang) * back;
    return `M${f1(bx + nx * w0)} ${f1(by + ny * w0)} L${f1(hx + nx * w1)} ${f1(hy + ny * w1)} Q${f1(hx + Math.cos(ang) * w1 * 1.2)} ${f1(hy + Math.sin(ang) * w1 * 1.2)} ${f1(hx - nx * w1)} ${f1(hy - ny * w1)} L${f1(bx - nx * w0)} ${f1(by - ny * w0)} Z`;
  };
  // сетка широт/долгот на планете
  let grid = '';
  for (let k = 1; k <= 5; k++) {
    const ry = pr * (k / 6);
    grid += `<ellipse cx="${pcx}" cy="${pcy}" rx="${pr}" ry="${f1(ry)}" fill="none" stroke="#9cc3ff" stroke-opacity="0.13" stroke-width="1.2"/>`;
  }
  for (let k = 1; k <= 5; k++) {
    const rx = pr * (k / 6);
    grid += `<ellipse cx="${pcx}" cy="${pcy}" rx="${f1(rx)}" ry="${pr}" fill="none" stroke="#9cc3ff" stroke-opacity="0.13" stroke-width="1.2"/>`;
  }
  // обломки и искры
  let debris = '';
  for (let i = 0; i < 26; i++) {
    const a = -Math.PI + rnd() * Math.PI * 1.05 + (Math.atan2(iy - pcy, ix - pcx) + Math.PI / 2) * 0;
    const base = Math.atan2(iy - pcy, ix - pcx); // наружу от центра планеты
    const aa = base + (rnd() - 0.5) * 2.2;
    const d = 60 + rnd() * 150;
    const x = ix + Math.cos(aa) * d;
    const y = iy + Math.sin(aa) * d;
    if (rnd() > 0.45) debris += rock(x, y, 2.5 + rnd() * 6, rnd() > 0.5 ? '#3a2c28' : '#5a3a2a', 6);
    else debris += `<line x1="${f1(ix + Math.cos(aa) * (d - 18))}" y1="${f1(iy + Math.sin(aa) * (d - 18))}" x2="${f1(x)}" y2="${f1(y)}" stroke="${rnd() > 0.5 ? '#ffd36b' : '#ff9a3c'}" stroke-width="${f1(1.4 + rnd() * 1.6)}" stroke-linecap="round" opacity="${(0.6 + rnd() * 0.4).toFixed(2)}"/>`;
    void a;
  }
  // кратеры на камне
  let craters = '';
  for (let i = 0; i < 6; i++) {
    const a = rnd() * Math.PI * 2;
    const d = rnd() * 26;
    craters += `<circle cx="${f1(hx + Math.cos(a) * d)}" cy="${f1(hy + Math.sin(a) * d)}" r="${f1(3 + rnd() * 6)}" fill="#1c1411" opacity="0.55"/>`;
  }
  const tangent = (Math.atan2(iy - pcy, ix - pcx) * 180) / Math.PI + 90;
  const lbl = labels
    ? `
    <path id="arcE" d="M${f1(pcx - (pr - 62))} ${f1(pcy)} A${f1(pr - 62)} ${f1(pr - 62)} 0 0 1 ${f1(pcx + (pr - 62))} ${f1(pcy)}" fill="none"/>
    <text font-family="M" font-weight="800" font-size="${f1(46 * textScale)}" letter-spacing="${f1(7 * textScale)}" fill="#ffffff" fill-opacity="0.94"><textPath href="#arcE" startOffset="${textOffset}%" text-anchor="middle">ЭТАЛОН</textPath></text>
    <g transform="translate(${f1(hx - Math.cos(ang) * len * 0.42)} ${f1(hy - Math.sin(ang) * len * 0.42)}) rotate(${f1(deg)})">
      <text x="0" y="${f1(14 * textScale)}" text-anchor="middle" font-family="M" font-weight="800" font-size="${f1(40 * textScale)}" letter-spacing="${f1(4 * textScale)}" fill="#fff" stroke="#4a0b00" stroke-width="${f1(7 * textScale)}" stroke-linejoin="round" paint-order="stroke">БАЗИС</text>
    </g>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <style>${FONT_CSS}</style>
  <defs>
    <radialGradient id="space" cx="55%" cy="45%" r="75%"><stop offset="0" stop-color="#1b2b55"/><stop offset="0.55" stop-color="#0c1430"/><stop offset="1" stop-color="#04060e"/></radialGradient>
    <radialGradient id="neb1" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#3a5bd9" stop-opacity="0.45"/><stop offset="1" stop-color="#3a5bd9" stop-opacity="0"/></radialGradient>
    <radialGradient id="neb2" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#b0306a" stop-opacity="0.28"/><stop offset="1" stop-color="#b0306a" stop-opacity="0"/></radialGradient>
    <radialGradient id="planet" cx="${f1((ix - (pcx - pr)) / (2 * pr))}" cy="0.08" r="0.9">
      <stop offset="0" stop-color="#4f8ef0"/><stop offset="0.35" stop-color="#2a66c4"/><stop offset="0.7" stop-color="${BRAND.blue}"/><stop offset="1" stop-color="#081a3d"/>
    </radialGradient>
    <radialGradient id="atmo" cx="0.5" cy="0.5" r="0.5"><stop offset="0.9" stop-color="#6fb1ff" stop-opacity="0"/><stop offset="0.965" stop-color="#6fb1ff" stop-opacity="0.55"/><stop offset="1" stop-color="#6fb1ff" stop-opacity="0"/></radialGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fffbe8"/><stop offset="0.16" stop-color="#ffe08a"/><stop offset="0.38" stop-color="#ff8a1f" stop-opacity="0.9"/><stop offset="0.65" stop-color="${BRAND.orange}" stop-opacity="0.45"/><stop offset="1" stop-color="${BRAND.red}" stop-opacity="0"/></radialGradient>
    <radialGradient id="heat" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ffb04a" stop-opacity="0.95"/><stop offset="1" stop-color="#ff4d00" stop-opacity="0"/></radialGradient>
    <linearGradient id="trail" gradientUnits="userSpaceOnUse" x1="${f1(tx)}" y1="${f1(ty)}" x2="${f1(hx)}" y2="${f1(hy)}">
      <stop offset="0" stop-color="${BRAND.red}" stop-opacity="0"/><stop offset="0.45" stop-color="${BRAND.orange}" stop-opacity="0.55"/><stop offset="0.85" stop-color="#ff9a2e" stop-opacity="0.95"/><stop offset="1" stop-color="#ffe7a3"/>
    </linearGradient>
    <linearGradient id="trail2" gradientUnits="userSpaceOnUse" x1="${f1(tx)}" y1="${f1(ty)}" x2="${f1(hx)}" y2="${f1(hy)}">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.7" stop-color="#fff3c4" stop-opacity="0.55"/><stop offset="1" stop-color="#ffffff" stop-opacity="0.95"/>
    </linearGradient>
    <radialGradient id="rockg" cx="0.35" cy="0.3" r="0.8"><stop offset="0" stop-color="#8a6a58"/><stop offset="0.55" stop-color="#4a342b"/><stop offset="1" stop-color="#1f1512"/></radialGradient>
    <filter id="blur6" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>
    <filter id="blur14" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="14"/></filter>
    <clipPath id="clipPlanet"><circle cx="${pcx}" cy="${pcy}" r="${pr}"/></clipPath>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#space)"/>
  <ellipse cx="${f1(W * 0.78)}" cy="${f1(H * 0.18)}" rx="${f1(W * 0.42)}" ry="${f1(H * 0.26)}" fill="url(#neb1)"/>
  <ellipse cx="${f1(W * 0.12)}" cy="${f1(H * 0.42)}" rx="${f1(W * 0.3)}" ry="${f1(H * 0.2)}" fill="url(#neb2)"/>
  ${stars(W, H, Math.round((W * H) / 2600), (x, y) => Math.hypot(x - pcx, y - pcy) < pr + 6)}
  <circle cx="${pcx}" cy="${pcy}" r="${pr + 22}" fill="url(#atmo)"/>
  <circle cx="${pcx}" cy="${pcy}" r="${pr}" fill="url(#planet)"/>
  <g clip-path="url(#clipPlanet)">
    ${grid}
    <path d="M${f1(pcx - pr * 0.8)} ${f1(pcy - pr * 0.55)} q ${f1(pr * 0.25)} ${f1(-pr * 0.22)} ${f1(pr * 0.5)} ${f1(-pr * 0.05)} t ${f1(pr * 0.35)} ${f1(pr * 0.12)} q ${f1(-pr * 0.1)} ${f1(pr * 0.2)} ${f1(-pr * 0.4)} ${f1(pr * 0.16)} z" fill="#5d9bf5" opacity="0.22"/>
    <path d="M${f1(pcx + pr * 0.15)} ${f1(pcy - pr * 0.72)} q ${f1(pr * 0.2)} ${f1(-pr * 0.12)} ${f1(pr * 0.42)} ${f1(pr * 0.02)} q ${f1(pr * 0.05)} ${f1(pr * 0.15)} ${f1(-pr * 0.2)} ${f1(pr * 0.18)} q ${f1(-pr * 0.2)} ${f1(-pr * 0.02)} ${f1(-pr * 0.22)} ${f1(-pr * 0.2)} z" fill="#5d9bf5" opacity="0.2"/>
    <circle cx="${f1(ix)}" cy="${f1(iy)}" r="${f1(pr * 0.42)}" fill="url(#heat)" opacity="0.8"/>
    <ellipse cx="${f1(ix)}" cy="${f1(iy + 8)}" rx="70" ry="22" fill="#1a0a05" opacity="0.55" transform="rotate(${f1(tangent)} ${f1(ix)} ${f1(iy)})"/>
  </g>
  <path d="${tail(46, 70, len * 0.95)}" fill="url(#trail)" filter="url(#blur14)" opacity="0.9"/>
  <path d="${tail(10, 44, len * 0.9)}" fill="url(#trail)"/>
  <path d="${tail(2, 20, len * 0.75)}" fill="url(#trail2)"/>
  <g>
    ${rock(hx, hy, 40, 'url(#rockg)', 11)}
    ${craters}
    <path d="M${f1(hx + nx * 34)} ${f1(hy + ny * 34)} A40 40 0 0 1 ${f1(hx - nx * 34)} ${f1(hy - ny * 34)}" fill="none" stroke="#ffcf73" stroke-width="5" stroke-linecap="round" opacity="0.85" transform="rotate(0)"/>
  </g>
  <g transform="rotate(${f1(tangent)} ${f1(ix)} ${f1(iy)})">
    <ellipse cx="${f1(ix)}" cy="${f1(iy)}" rx="190" ry="40" fill="none" stroke="#ffb35c" stroke-width="3" opacity="0.35"/>
    <ellipse cx="${f1(ix)}" cy="${f1(iy)}" rx="132" ry="28" fill="none" stroke="#ffd08a" stroke-width="4" opacity="0.7"/>
  </g>
  <circle cx="${f1(ix)}" cy="${f1(iy)}" r="165" fill="url(#glow)" filter="url(#blur6)"/>
  ${starburst(ix, iy, 13, 118, 44, 0.2, BRAND.orange)}
  ${starburst(ix, iy, 11, 82, 34, 0.5, '#ff9a2e')}
  ${starburst(ix, iy, 9, 50, 22, 0.1, '#ffe08a')}
  <circle cx="${f1(ix)}" cy="${f1(iy)}" r="20" fill="#fffbe8"/>
  ${debris}
  ${lbl}
</svg>`;
}

const SQUARE = { W: 640, H: 640, planet: { cx: 330, cy: 760, r: 400 }, impact: [452, 379], tailFrom: [40, 20], textOffset: 39 };
const WIDE = { W: 640, H: 360, planet: { cx: 300, cy: 900, r: 640 }, impact: [440, 275], tailFrom: [24, 8], textScale: 0.82, textOffset: 44 };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function shoot(svg, W, H, out, scale = 1) {
  await page.setViewportSize({ width: Math.round(W * scale), height: Math.round(H * scale) });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#000"><div id="c" style="width:${W * scale}px;height:${H * scale}px">${svg.replace(`width="${W}" height="${H}"`, `width="${W * scale}" height="${H * scale}"`)}</div></body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  await page.locator('#c').screenshot({ path: out });
  console.log('✓', out);
}
seed = 20260925;
const sq = scene({ ...SQUARE, labels: true });
fs.writeFileSync(u('./avatar.svg'), sq);
await shoot(sq, 640, 640, new URL('./avatar.png', import.meta.url).pathname);
seed = 20260925;
const icon = scene({ ...SQUARE, labels: false });
await shoot(icon, 640, 640, new URL('./icon-512.png', import.meta.url).pathname, 0.8);
// иконка для дашборда вшивается в Worker — делаем её лёгкой: 192×192, палитра
{
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    sharp = require(require('node:child_process').execSync('npm root -g').toString().trim() + '/sharp');
  }
  await sharp(new URL('./icon-512.png', import.meta.url).pathname).resize(192, 192).png({ palette: true, quality: 90, colors: 160, compressionLevel: 9 }).toFile(new URL('../app/icon.png', import.meta.url).pathname);
  console.log('✓ app/icon.png', fs.statSync(new URL('../app/icon.png', import.meta.url)).size, 'байт');
}
seed = 777;
const wide = scene({ ...WIDE, labels: true });
fs.writeFileSync(u('./description.svg'), wide);
await shoot(wide, 640, 360, new URL('./description.png', import.meta.url).pathname);
// превью: как аватар выглядит в кружке Telegram
await page.setViewportSize({ width: 420, height: 180 });
const av = fs.readFileSync(u('./avatar.png')).toString('base64');
await page.setContent(`<body style="margin:0;background:#17212b;display:flex;gap:24px;align-items:center;padding:18px;font:14px system-ui;color:#fff">
  <img src="data:image/png;base64,${av}" style="width:144px;height:144px;border-radius:50%">
  <img src="data:image/png;base64,${av}" style="width:54px;height:54px;border-radius:50%">
  <img src="data:image/png;base64,${av}" style="width:34px;height:34px;border-radius:50%"></body>`);
await page.screenshot({ path: new URL('./avatar-circle-preview.png', import.meta.url).pathname });
await browser.close();
