// Анимированный аватар и баннер описания бота «Мониторинг».
// Сцена как в make-art.mjs (метеорит «Базис» врезается в планету «Эталон»), но живая:
// мерцают звёзды, пульсирует тревожное свечение удара, расходятся кольца, летят искры.
// Цикл бесшовный (кадр F совпадает с кадром 0). Кадры снимаем в Chromium → ffmpeg собирает видео/GIF.
//   art/avatar-anim.mp4   720×720 — анимированный аватар (BotFather → /setuserpic, прислать видео)
//   art/description.gif   640×360 — анимированный баннер описания (BotFather → /setdescriptionpic)
// Запуск: node art/make-avatar-anim.mjs
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require(execFileSync('npm', ['root', '-g']).toString().trim() + '/playwright')); }

const u = (p) => new URL(p, import.meta.url);
const font = (f) => fs.readFileSync(u('../app/fonts/' + f)).toString('base64');
const FONT_CSS = `
@font-face{font-family:M;font-weight:200 800;src:url(data:font/woff2;base64,${font('manrope-cyrillic-wght-normal.woff2')}) format('woff2');unicode-range:U+0400-045F}
@font-face{font-family:M;font-weight:200 800;src:url(data:font/woff2;base64,${font('manrope-latin-wght-normal.woff2')}) format('woff2');unicode-range:U+0000-00FF}`;

const BRAND = { blue: '#194B9B', navy: '#1E242E', orange: '#FF4D00', red: '#C10C1A' };
const TAU = Math.PI * 2;
const f1 = (n) => Number(n).toFixed(1);
const f2 = (n) => Number(n).toFixed(3);

// детерминированный ГПСЧ
function mk(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }

function rock(cx, cy, r, fill, n, rnd) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rnd() * 0.3;
    const rr = r * (0.72 + rnd() * 0.32);
    pts.push(`${f1(cx + rr * Math.cos(a))},${f1(cy + rr * Math.sin(a))}`);
  }
  return `<polygon points="${pts.join(' ')}" fill="${fill}"/>`;
}
function starburst(cx, cy, n, rOut, rIn, rot, fill, rnd, jitter = 0.22) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = rot + (i * Math.PI) / n;
    const r = (i % 2 ? rIn : rOut) * (1 - jitter / 2 + rnd() * jitter);
    pts.push(`${f1(cx + r * Math.cos(a))},${f1(cy + r * Math.sin(a))}`);
  }
  return `<polygon points="${pts.join(' ')}" fill="${fill}"/>`;
}

// геометрия (как SQUARE/WIDE в make-art.mjs)
const LAYOUT = {
  square: { W: 640, H: 640, planet: { cx: 330, cy: 760, r: 400 }, impact: [452, 379], tailFrom: [40, 20], textOffset: 39, textScale: 1 },
  wide: { W: 640, H: 360, planet: { cx: 300, cy: 900, r: 640 }, impact: [440, 275], tailFrom: [24, 8], textOffset: 44, textScale: 0.82 },
};

// звёзды считаем один раз: позиция фиксирована, мерцает только яркость
function makeStars(L, seed) {
  const rnd = mk(seed);
  const { W, H, planet } = L;
  const out = [];
  const n = Math.round((W * H) / 2600);
  for (let i = 0; i < n; i++) {
    const x = rnd() * W, y = rnd() * H;
    if (Math.hypot(x - planet.cx, y - planet.cy) < planet.r + 6) continue;
    out.push({ x, y, r: 0.5 + rnd() * 1.4, o: 0.25 + rnd() * 0.7, k: 1 + Math.floor(rnd() * 3), ph: rnd(), big: rnd() > 0.82 });
  }
  return out;
}

// искры-обломки: считаем базу один раз, в кадре двигаем по фазе
function makeSparks(L, seed) {
  const rnd = mk(seed);
  const [ix, iy] = L.impact;
  const base = Math.atan2(iy - L.planet.cy, ix - L.planet.cx);
  const out = [];
  for (let i = 0; i < 22; i++) {
    out.push({ a: base + (rnd() - 0.5) * 2.2, d0: 40 + rnd() * 40, dmax: 110 + rnd() * 120, cyc: 1 + Math.floor(rnd() * 2), ph: rnd(), rock: rnd() > 0.5, size: 2 + rnd() * 4, warm: rnd() > 0.5 });
  }
  return { out, ix, iy };
}

function defs(L) {
  const { cx: pcx, cy: pcy, r: pr } = L.planet;
  const [ix, iy] = L.impact;
  const [tx, ty] = L.tailFrom;
  const ang = Math.atan2(iy - ty, ix - tx);
  const hx = ix - Math.cos(ang) * 48, hy = iy - Math.sin(ang) * 48;
  return `<defs>
    <radialGradient id="space" cx="55%" cy="45%" r="75%"><stop offset="0" stop-color="#1b2b55"/><stop offset="0.55" stop-color="#0c1430"/><stop offset="1" stop-color="#04060e"/></radialGradient>
    <radialGradient id="neb1" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#3a5bd9" stop-opacity="0.45"/><stop offset="1" stop-color="#3a5bd9" stop-opacity="0"/></radialGradient>
    <radialGradient id="neb2" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#b0306a" stop-opacity="0.28"/><stop offset="1" stop-color="#b0306a" stop-opacity="0"/></radialGradient>
    <radialGradient id="planet" cx="${f2((ix - (pcx - pr)) / (2 * pr))}" cy="0.08" r="0.9">
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
  </defs>`;
}

// статичные слои (не зависят от фазы): фон, планета, метеорит, подписи
function staticLayers(L, stars) {
  const { W, H, planet, textScale, textOffset } = L;
  const { cx: pcx, cy: pcy, r: pr } = planet;
  const [ix, iy] = L.impact;
  const [tx, ty] = L.tailFrom;
  const ang = Math.atan2(iy - ty, ix - tx);
  const deg = (ang * 180) / Math.PI;
  const len = Math.hypot(ix - tx, iy - ty);
  const hx = ix - Math.cos(ang) * 48, hy = iy - Math.sin(ang) * 48;
  const nx = -Math.sin(ang), ny = Math.cos(ang);
  const tail = (w0, w1, back) => {
    const bx = hx - Math.cos(ang) * back, by = hy - Math.sin(ang) * back;
    return `M${f1(bx + nx * w0)} ${f1(by + ny * w0)} L${f1(hx + nx * w1)} ${f1(hy + ny * w1)} Q${f1(hx + Math.cos(ang) * w1 * 1.2)} ${f1(hy + Math.sin(ang) * w1 * 1.2)} ${f1(hx - nx * w1)} ${f1(hy - ny * w1)} L${f1(bx - nx * w0)} ${f1(by - ny * w0)} Z`;
  };
  const rnd = mk(99);
  let grid = '';
  for (let k = 1; k <= 5; k++) { grid += `<ellipse cx="${pcx}" cy="${pcy}" rx="${pr}" ry="${f1(pr * (k / 6))}" fill="none" stroke="#9cc3ff" stroke-opacity="0.13" stroke-width="1.2"/>`; }
  for (let k = 1; k <= 5; k++) { grid += `<ellipse cx="${pcx}" cy="${pcy}" rx="${f1(pr * (k / 6))}" ry="${pr}" fill="none" stroke="#9cc3ff" stroke-opacity="0.13" stroke-width="1.2"/>`; }
  let craters = '';
  for (let i = 0; i < 6; i++) { const a = rnd() * TAU, d = rnd() * 26; craters += `<circle cx="${f1(hx + Math.cos(a) * d)}" cy="${f1(hy + Math.sin(a) * d)}" r="${f1(3 + rnd() * 6)}" fill="#1c1411" opacity="0.55"/>`; }
  const tangent = (Math.atan2(iy - pcy, ix - pcx) * 180) / Math.PI + 90;
  const starsSvg = stars.map((s) => `<circle cx="${f1(s.x)}" cy="${f1(s.y)}" r="${f1(s.r)}" fill="#fff"/>`).join(''); // база (яркость в анимslое)
  void starsSvg;
  const labels = `
    <path id="arcE" d="M${f1(pcx - (pr - 62))} ${f1(pcy)} A${f1(pr - 62)} ${f1(pr - 62)} 0 0 1 ${f1(pcx + (pr - 62))} ${f1(pcy)}" fill="none"/>
    <text font-family="M" font-weight="800" font-size="${f1(46 * textScale)}" letter-spacing="${f1(7 * textScale)}" fill="#ffffff" fill-opacity="0.94"><textPath href="#arcE" startOffset="${textOffset}%" text-anchor="middle">ЭТАЛОН</textPath></text>
    <g transform="translate(${f1(hx - Math.cos(ang) * len * 0.42)} ${f1(hy - Math.sin(ang) * len * 0.42)}) rotate(${f1(deg)})">
      <text x="0" y="${f1(14 * textScale)}" text-anchor="middle" font-family="M" font-weight="800" font-size="${f1(40 * textScale)}" letter-spacing="${f1(4 * textScale)}" fill="#fff" stroke="#4a0b00" stroke-width="${f1(7 * textScale)}" stroke-linejoin="round" paint-order="stroke">БАЗИС</text>
    </g>`;
  return {
    bg: `<rect width="${W}" height="${H}" fill="url(#space)"/>
      <ellipse cx="${f1(W * 0.78)}" cy="${f1(H * 0.18)}" rx="${f1(W * 0.42)}" ry="${f1(H * 0.26)}" fill="url(#neb1)"/>
      <ellipse cx="${f1(W * 0.12)}" cy="${f1(H * 0.42)}" rx="${f1(W * 0.3)}" ry="${f1(H * 0.2)}" fill="url(#neb2)"/>`,
    planet: `<circle cx="${pcx}" cy="${pcy}" r="${pr + 22}" fill="url(#atmo)"/>
      <circle cx="${pcx}" cy="${pcy}" r="${pr}" fill="url(#planet)"/>
      <g clip-path="url(#clipPlanet)">${grid}
        <path d="M${f1(pcx - pr * 0.8)} ${f1(pcy - pr * 0.55)} q ${f1(pr * 0.25)} ${f1(-pr * 0.22)} ${f1(pr * 0.5)} ${f1(-pr * 0.05)} t ${f1(pr * 0.35)} ${f1(pr * 0.12)} q ${f1(-pr * 0.1)} ${f1(pr * 0.2)} ${f1(-pr * 0.4)} ${f1(pr * 0.16)} z" fill="#5d9bf5" opacity="0.22"/>
        <path d="M${f1(pcx + pr * 0.15)} ${f1(pcy - pr * 0.72)} q ${f1(pr * 0.2)} ${f1(-pr * 0.12)} ${f1(pr * 0.42)} ${f1(pr * 0.02)} q ${f1(pr * 0.05)} ${f1(pr * 0.15)} ${f1(-pr * 0.2)} ${f1(pr * 0.18)} q ${f1(-pr * 0.2)} ${f1(-pr * 0.02)} ${f1(-pr * 0.22)} ${f1(-pr * 0.2)} z" fill="#5d9bf5" opacity="0.2"/>
        <!--HEAT-->
        <ellipse cx="${f1(ix)}" cy="${f1(iy + 8)}" rx="70" ry="22" fill="#1a0a05" opacity="0.55" transform="rotate(${f1(tangent)} ${f1(ix)} ${f1(iy)})"/>
      </g>`,
    meteor: `<!--TRAIL-->
      <g>${rock(hx, hy, 40, 'url(#rockg)', 11, mk(7))}${craters}
        <path d="M${f1(hx + nx * 34)} ${f1(hy + ny * 34)} A40 40 0 0 1 ${f1(hx - nx * 34)} ${f1(hy - ny * 34)}" fill="none" stroke="#ffcf73" stroke-width="5" stroke-linecap="round" opacity="0.85"/></g>`,
    labels,
    geom: { ix, iy, hx, hy, ang, nx, ny, len, tangent, tail },
  };
}

// анимированные слои для фазы p∈[0,1)
function animLayers(L, p, stars, sparks, S) {
  const { ix, iy, hx, hy, ang, nx, ny, len, tangent, tail } = S.geom;
  // звёзды: мерцание
  let starsSvg = '';
  for (const s of stars) {
    const tw = 0.5 + 0.5 * Math.sin(TAU * (s.k * p + s.ph));
    const op = (s.o * (0.4 + 0.6 * tw)).toFixed(2);
    starsSvg += `<circle cx="${f1(s.x)}" cy="${f1(s.y)}" r="${f1(s.r)}" fill="#fff" opacity="${op}"/>`;
    if (s.big) { const c = s.r * 3; starsSvg += `<path d="M${f1(s.x - c)} ${f1(s.y)}H${f1(s.x + c)}M${f1(s.x)} ${f1(s.y - c)}V${f1(s.y + c)}" stroke="#fff" stroke-width="0.6" opacity="${(op * 0.6).toFixed(2)}"/>`; }
  }
  // след метеорита: лёгкое мерцание яркости
  const tf = 0.82 + 0.18 * Math.sin(TAU * 3 * p);
  const trail = `<path d="${tail(46, 70, len * 0.95)}" fill="url(#trail)" filter="url(#blur14)" opacity="${(0.9 * tf).toFixed(2)}"/>
    <path d="${tail(10, 44, len * 0.9)}" fill="url(#trail)" opacity="${f2(tf)}"/>
    <path d="${tail(2, 20, len * 0.75)}" fill="url(#trail2)" opacity="${f2(0.85 + 0.15 * Math.sin(TAU * 5 * p + 1))}"/>`;
  // тепло в кратере (внутри планеты) — пульс
  const heatPulse = 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(TAU * p));
  const heat = `<circle cx="${f1(ix)}" cy="${f1(iy)}" r="${f1(L.planet.r * 0.42 * (0.95 + 0.1 * Math.sin(TAU * p)))}" fill="url(#heat)" opacity="${f2(0.8 * heatPulse)}"/>`;
  // расходящиеся тревожные кольца (3 штуки со сдвигом фазы, эллипс по касательной)
  let rings = '';
  for (let j = 0; j < 3; j++) {
    const uu = (p + j / 3) % 1;
    const rx = 70 + uu * 150, ry = (70 + uu * 150) * 0.22;
    const op = (Math.sin(Math.PI * uu) * 0.55).toFixed(2);
    rings += `<g transform="rotate(${f1(tangent)} ${f1(ix)} ${f1(iy)})"><ellipse cx="${f1(ix)}" cy="${f1(iy)}" rx="${f1(rx)}" ry="${f1(ry)}" fill="none" stroke="#ffb35c" stroke-width="${f1(4 - uu * 2)}" opacity="${op}"/></g>`;
  }
  // главное свечение удара — пульс
  const g = 0.86 + 0.14 * Math.sin(TAU * p) + 0.05 * Math.sin(TAU * 4 * p);
  const glow = `<circle cx="${f1(ix)}" cy="${f1(iy)}" r="${f1(165 * (0.96 + 0.08 * Math.sin(TAU * p)))}" fill="url(#glow)" filter="url(#blur6)" opacity="${f2(Math.min(1, g))}"/>`;
  // лучи-вспышка: медленное вращение + пульс
  const rot = TAU * p;
  const puls = 1 + 0.07 * Math.sin(TAU * 2 * p);
  const burst = starburst(ix, iy, 13, 118 * puls, 44, rot * 0.3, BRAND.orange, mk(101))
    + starburst(ix, iy, 11, 82 * puls, 34, -rot * 0.5 + 0.5, '#ff9a2e', mk(102))
    + starburst(ix, iy, 9, 50 * puls, 22, rot * 0.7, '#ffe08a', mk(103));
  // ядро — мерцание
  const core = `<circle cx="${f1(ix)}" cy="${f1(iy)}" r="${f1(20 * (0.9 + 0.18 * Math.sin(TAU * 4 * p)))}" fill="#fffbe8"/>`;
  // искры летят наружу и затухают, бесшовно
  let debris = '';
  for (const sp of sparks.out) {
    const uu = (p * sp.cyc + sp.ph) % 1;
    const d = sp.d0 + uu * sp.dmax;
    const x = ix + Math.cos(sp.a) * d, y = iy + Math.sin(sp.a) * d;
    const op = (Math.sin(Math.PI * uu) * 0.9).toFixed(2);
    if (sp.rock) debris += rock(x, y, sp.size, '#5a3a2a', 6, mk(1 + Math.floor(sp.ph * 999)));
    else { const x0 = ix + Math.cos(sp.a) * (d - 16), y0 = iy + Math.sin(sp.a) * (d - 16); debris += `<line x1="${f1(x0)}" y1="${f1(y0)}" x2="${f1(x)}" y2="${f1(y)}" stroke="${sp.warm ? '#ffd36b' : '#ff9a3c'}" stroke-width="${f1(sp.size * 0.5)}" stroke-linecap="round" opacity="${op}"/>`; }
  }
  return { starsSvg, trail, heat, rings, glow, burst, core, debris };
}

function buildFrame(L, p, stars, sparks, S, D) {
  const a = animLayers(L, p, stars, sparks, S);
  const planet = S.planet.replace('<!--HEAT-->', a.heat);
  const meteor = S.meteor.replace('<!--TRAIL-->', a.trail);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${L.W}" height="${L.H}" viewBox="0 0 ${L.W} ${L.H}">
  <style>${FONT_CSS}</style>${D}
  ${S.bg}
  ${a.starsSvg}
  ${planet}
  ${meteor}
  ${a.rings}
  ${a.glow}
  ${a.burst}
  ${a.core}
  ${a.debris}
  ${S.labels}
</svg>`;
}

// ── рендер ──────────────────────────────────────────────────────────────────
const OUT = u('./frames');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function renderClip({ layout, frames, size, dir, tag }) {
  const L = LAYOUT[layout];
  const stars = makeStars(L, 20260925);
  const sparks = makeSparks(L, 424242);
  const S = staticLayers(L, stars);
  const D = defs(L);
  const scale = size / L.W;
  fs.mkdirSync(u('./' + dir), { recursive: true });
  await page.setViewportSize({ width: Math.round(L.W * scale), height: Math.round(L.H * scale) });
  for (let i = 0; i < frames; i++) {
    const svg = buildFrame(L, i / frames, stars, sparks, S, D).replace(`width="${L.W}" height="${L.H}"`, `width="${f1(L.W * scale)}" height="${f1(L.H * scale)}"`);
    await page.setContent(`<!doctype html><html><body style="margin:0;background:#000"><div id="c" style="width:${f1(L.W * scale)}px;height:${f1(L.H * scale)}px">${svg}</div></body></html>`);
    if (i === 0) await page.evaluate(() => document.fonts.ready);
    await page.locator('#c').screenshot({ path: u(`./${dir}/f${String(i).padStart(3, '0')}.png`).pathname });
  }
  console.log(`✓ ${tag}: ${frames} кадров ${Math.round(L.W * scale)}×${Math.round(L.H * scale)}`);
}

const SQ_FRAMES = 75, SQ_FPS = 25; // 3.0 c
const WIDE_FRAMES = 60, WIDE_FPS = 20; // 3.0 c

await renderClip({ layout: 'square', frames: SQ_FRAMES, size: 720, dir: 'frames', tag: 'аватар' });
// видео аватара: H.264, yuv420p, faststart, бесшовный цикл
execFileSync('ffmpeg', ['-y', '-framerate', String(SQ_FPS), '-i', u('./frames/f%03d.png').pathname,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart',
  '-vf', 'scale=720:720:flags=lanczos', u('./avatar-anim.mp4').pathname], { stdio: 'inherit' });
console.log('✓ art/avatar-anim.mp4', (fs.statSync(u('./avatar-anim.mp4')).size / 1024).toFixed(0), 'КБ');

await renderClip({ layout: 'wide', frames: WIDE_FRAMES, size: 640, dir: 'framesw', tag: 'баннер' });
// GIF баннера: палитра для аккуратного цикла
execFileSync('ffmpeg', ['-y', '-framerate', String(WIDE_FPS), '-i', u('./framesw/f%03d.png').pathname,
  '-vf', `fps=${WIDE_FPS},scale=640:360:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=160[p];[s1][p]paletteuse=dither=bayer`,
  '-loop', '0', u('./description.gif').pathname], { stdio: 'inherit' });
console.log('✓ art/description.gif', (fs.statSync(u('./description.gif')).size / 1024).toFixed(0), 'КБ');

await browser.close();
fs.rmSync(OUT, { recursive: true, force: true });
fs.rmSync(u('./framesw'), { recursive: true, force: true });
