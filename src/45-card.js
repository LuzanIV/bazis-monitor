
// ─── картинка «итоги недели» ────────────────────────────────────────────────
// Рисуем PNG прямо в Worker: свой маленький холст + PNG-энкодер (RGB, без сжатия).
// Текст — готовые глифы Manrope из атласа (art/make-card-font.mjs → app/card-font.json, вшивается сборкой).
// Шрифт при отправке не растрируется, поэтому картинка укладывается в лимит free-плана Cloudflare (10 мс CPU).

const CARD_FONT_JSON = '__CARD_FONT__'; // сборка заменит на JSON атласа

let FONT = null;
function loadFont() {
  if (FONT !== null) return FONT;
  if (!CARD_FONT_JSON || CARD_FONT_JSON === '__CARD' + '_FONT__') return (FONT = false);
  try {
    const raw = JSON.parse(CARD_FONT_JSON);
    for (const size of Object.values(raw.sizes)) {
      for (const g of Object.values(size.glyphs)) {
        if (g.a) {
          const bin = atob(g.a);
          const u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          g.bytes = u8;
        } else g.bytes = new Uint8Array(0);
      }
    }
    FONT = raw;
  } catch (e) {
    console.warn('card font', e && e.message);
    FONT = false;
  }
  return FONT;
}

// холст RGB
function Canvas(w, h, bg) {
  const px = new Uint8Array(w * h * 3);
  if (bg) for (let i = 0; i < px.length; i += 3) { px[i] = bg[0]; px[i + 1] = bg[1]; px[i + 2] = bg[2]; }
  return { w, h, px };
}
function blend(c, x, y, col, a) {
  x |= 0; y |= 0;
  if (a <= 0 || x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const i = (y * c.w + x) * 3;
  if (a >= 255) { c.px[i] = col[0]; c.px[i + 1] = col[1]; c.px[i + 2] = col[2]; return; }
  const px = c.px, ia = 255 - a;
  px[i] = (px[i] * ia + col[0] * a + 127) / 255;
  px[i + 1] = (px[i + 1] * ia + col[1] * a + 127) / 255;
  px[i + 2] = (px[i + 2] * ia + col[2] * a + 127) / 255;
}
function fillRect(c, x, y, w, h, col) {
  const x1 = Math.max(0, x | 0), y1 = Math.max(0, y | 0), x2 = Math.min(c.w, (x + w) | 0), y2 = Math.min(c.h, (y + h) | 0);
  for (let yy = y1; yy < y2; yy++) {
    let i = (yy * c.w + x1) * 3;
    for (let xx = x1; xx < x2; xx++) { c.px[i] = col[0]; c.px[i + 1] = col[1]; c.px[i + 2] = col[2]; i += 3; }
  }
}
// прямоугольник со скруглёнными углами, сглажены только уголки
function roundRect(c, x, y, w, h, r, col) {
  r = Math.min(r, w / 2, h / 2);
  fillRect(c, x + r, y, w - 2 * r, h, col);
  fillRect(c, x, y + r, r, h - 2 * r, col);
  fillRect(c, x + w - r, y + r, r, h - 2 * r, col);
  const corners = [[x + r, y + r, -1, -1], [x + w - r, y + r, 1, -1], [x + r, y + h - r, -1, 1], [x + w - r, y + h - r, 1, 1]];
  for (const [cx, cy, sx, sy] of corners) {
    for (let dy = 0; dy < r; dy++) {
      for (let dx = 0; dx < r; dx++) {
        const px = cx + sx * dx, py = cy + sy * dy;
        const dist = Math.sqrt((dx + 0.5) * (dx + 0.5) + (dy + 0.5) * (dy + 0.5));
        const cov = Math.max(0, Math.min(1, r - dist + 0.5));
        if (cov > 0) blend(c, sx < 0 ? px - 1 : px, sy < 0 ? py - 1 : py, col, Math.round(cov * 255));
      }
    }
  }
}
function disc(c, cx, cy, r, col) {
  for (let dy = -r - 1; dy <= r + 1; dy++)
    for (let dx = -r - 1; dx <= r + 1; dx++) {
      const dist = Math.sqrt(dx * dx + dy * dy);
      const cov = Math.max(0, Math.min(1, r - dist + 0.5));
      if (cov > 0) blend(c, cx + dx, cy + dy, col, Math.round(cov * 255));
    }
}

// ширина строки в глифах атласа
function textWidth(size, str) {
  let w = 0;
  for (const ch of str) {
    const g = size.glyphs[ch];
    w += g ? g.adv : size.spaceAdv;
  }
  return w;
}
// текст по базовой линии baseline; align: 0 слева, 1 по центру, 2 справа
function drawText(c, sizeKey, x, baseline, str, col, align = 0) {
  const F = loadFont();
  const size = F && F.sizes[sizeKey];
  if (!size) return 0;
  const total = textWidth(size, str);
  let penX = align === 1 ? x - total / 2 : align === 2 ? x - total : x;
  for (const ch of str) {
    const g = size.glyphs[ch];
    if (!g) { penX += size.spaceAdv; continue; }
    if (g.bytes && g.bytes.length) {
      const gx0 = Math.round(penX + g.dx), gy0 = Math.round(baseline + g.dy);
      for (let gy = 0; gy < g.h; gy++) {
        const row = gy * g.w;
        for (let gx = 0; gx < g.w; gx++) {
          const a = g.bytes[row + gx];
          if (a) blend(c, gx0 + gx, gy0 + gy, col, a);
        }
      }
    }
    penX += g.adv;
  }
  return total;
}

// ─── PNG (тип 2 RGB, фильтр 0, DEFLATE без сжатия) ───────────────────────────
// Всё на типизированных массивах: без push/spread больших массивов, иначе отправка не влезет в 10 мс CPU free-плана.
let CRC_T = null;
function crc32(buf, start, end) {
  if (!CRC_T) {
    CRC_T = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_T[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function adler32(buf) {
  let a = 1, b = 0, i = 0, len = buf.length;
  while (len > 0) {
    let n = Math.min(5552, len); // NMAX: считаем по частям, деление реже
    len -= n;
    while (n--) { a += buf[i++]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}
function writeChunk(out, o, type, data) {
  const dv = new DataView(out.buffer);
  dv.setUint32(o, data.length); o += 4;
  const ts = o;
  out[o++] = type.charCodeAt(0); out[o++] = type.charCodeAt(1); out[o++] = type.charCodeAt(2); out[o++] = type.charCodeAt(3);
  out.set(data, o); o += data.length;
  dv.setUint32(o, crc32(out, ts, o)); o += 4;
  return o;
}
function encodePng(c) {
  const { w, h, px } = c;
  const rowLen = 1 + w * 3;
  const raw = new Uint8Array(h * rowLen); // байт фильтра (0) уже в начале каждой строки
  for (let y = 0; y < h; y++) raw.set(px.subarray(y * w * 3, (y + 1) * w * 3), y * rowLen + 1);

  // zlib: заголовок 0x78 0x01 + блоки store (по ≤65535) + adler32
  const nblocks = Math.max(1, Math.ceil(raw.length / 65535));
  const idat = new Uint8Array(2 + nblocks * 5 + raw.length + 4);
  let p = 0;
  idat[p++] = 0x78; idat[p++] = 0x01;
  for (let off = 0; off < raw.length; off += 65535) {
    const len = Math.min(65535, raw.length - off);
    idat[p++] = off + len >= raw.length ? 1 : 0;
    idat[p++] = len & 255; idat[p++] = (len >> 8) & 255; idat[p++] = ~len & 255; idat[p++] = (~len >> 8) & 255;
    idat.set(raw.subarray(off, off + len), p); p += len;
  }
  const ad = adler32(raw);
  idat[p++] = (ad >>> 24) & 255; idat[p++] = (ad >>> 16) & 255; idat[p++] = (ad >>> 8) & 255; idat[p++] = ad & 255;

  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, w);
  new DataView(ihdr.buffer).setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 2; // 8 бит, RGB

  const out = new Uint8Array(8 + 25 + 12 + idat.length + 12);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let o = 8;
  o = writeChunk(out, o, 'IHDR', ihdr);
  o = writeChunk(out, o, 'IDAT', idat);
  o = writeChunk(out, o, 'IEND', new Uint8Array(0));
  return out;
}

// ─── карточка ────────────────────────────────────────────────────────────────
const CARD = {
  bg: [0x0e, 0x13, 0x1b], panel: [0x18, 0x20, 0x2c], panel2: [0x22, 0x2c, 0x3b],
  ink: [0xf2, 0xf4, 0xf7], ink2: [0xb3, 0xbc, 0xc9], ink3: [0x7f, 0x8a, 0x9a],
  accent: [0x5b, 0x8d, 0xef], good: [0x3b, 0xcf, 0x3b], warn: [0xfa, 0xb2, 0x19],
  crit: [0xff, 0x7b, 0x7b], planned: [0x8b, 0x9a, 0xb3], nodata: [0x2a, 0x35, 0x47],
};
const STATE_COL = { good: CARD.good, warn: CARD.warn, crit: CARD.crit, planned: CARD.planned, nodata: CARD.nodata };

// d: { title, range, availText, availState, stats:[{dot,text}], days:[{label,date,state,h}] }
function weeklyCard(d) {
  if (!loadFont()) return null;
  const W = 600, H = 314, M = 28;
  const c = Canvas(W, H, CARD.bg);

  // шапка
  drawText(c, 'small', M, 40, (d.brand || 'БАЗИС · МОНИТОРИНГ ДОСТУПНОСТИ'), CARD.ink3, 0);
  drawText(c, 'bold', M, 78, d.title || 'Итоги недели', CARD.ink, 0);
  if (d.range) drawText(c, 'med', W - M, 76, d.range, CARD.ink2, 2);
  fillRect(c, M, 92, W - 2 * M, 2, CARD.panel2);

  // левая панель — доступность
  const hx = M, hy = 108, hw = 250, hh = 104;
  roundRect(c, hx, hy, hw, hh, 16, CARD.panel);
  drawText(c, 'small', hx + 20, hy + 30, 'ДОСТУПНОСТЬ ЗА НЕДЕЛЮ', CARD.ink3, 0);
  const availCol = STATE_COL[d.availState] || CARD.ink;
  drawText(c, 'hero', hx + 18, hy + 88, d.availText || '—', availCol, 0);

  // правая панель — цифры
  const sx = hx + hw + 16, sy = 108, sw = W - M - sx, sh = 104;
  roundRect(c, sx, sy, sw, sh, 16, CARD.panel);
  const stats = (d.stats || []).slice(0, 3);
  let ry = sy + 30;
  for (const st of stats) {
    let tx = sx + 22;
    if (st.dot) { disc(c, tx + 5, ry - 6, 6, STATE_COL[st.dot] || CARD.ink2); tx += 20; }
    drawText(c, 'med', tx, ry, st.text, st.strong ? CARD.ink : CARD.ink2, 0);
    ry += 30;
  }

  // столбцы по дням
  const days = d.days || [];
  const gx = M, gyTop = 228, gyBase = 266, colW = (W - 2 * M) / Math.max(1, days.length), barW = Math.min(46, colW - 18);
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const cx = gx + colW * i + colW / 2;
    const maxH = gyBase - gyTop;
    const bh = Math.max(6, Math.round(maxH * Math.max(0.1, Math.min(1, day.h == null ? 1 : day.h))));
    const col = STATE_COL[day.state] || CARD.nodata;
    // подложка столбца
    roundRect(c, cx - barW / 2, gyTop, barW, maxH, 7, CARD.nodata);
    roundRect(c, cx - barW / 2, gyBase - bh, barW, bh, 7, col);
    drawText(c, 'small', cx, gyBase + 22, day.label, CARD.ink2, 1);
    if (day.date) drawText(c, 'small', cx, gyBase + 40, day.date, CARD.ink3, 1);
  }

  return encodePng(c);
}
