// Visual signatures: drawing one, turning a photo of one into transparent
// ink, and rendering either at any size. A signature is plain data, so it can
// be stored and redrawn sharp at export size:
//   { kind: 'draw', strokes: [[x, y, x, y, ...], ...], width, aspect, color }
//     points are 0..1 across and down the signature's box; width is the line
//     width as a fraction of the box height; aspect is width / height.
//   { kind: 'image', url, aspect }   a transparent PNG data URL
//   { kind: 'type', text, font, color, aspect, m: { l, r, a, d } }
//     typed in one of FONTS; m is the text's measured extent in ems
//   { kind: 'text', text, color, aspect, lines, w, font? }
//     plain text filled in on the page, one or more lines, in one of
//     TEXT_FONTS (no font: TEXT_FONT); w is the widest line in ems
//   { kind: 'mark', mark: 'check' | 'cross', color, aspect: 1 }

export const INKS = { black: '#1b1b1f', blue: '#1d3f9e' };

const PAD_LINE = 2.6; // CSS px on the pad

/* ---------- drawing pad ---------- */

export function createPad(canvas, { onChange = () => {} } = {}) {
  let strokes = [];       // in CSS px
  let current = null;
  let color = INKS.black;

  function size() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  function redraw() {
    const ctx = size();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of strokes) strokePath(ctx, s, 1, 1, PAD_LINE, color);
  }

  const point = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    current = { id: e.pointerId, pts: point(e) };
    strokes.push(current.pts);
    redraw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!current || e.pointerId !== current.id) return;
    // Coalesced events keep fast strokes smooth.
    for (const ev of e.getCoalescedEvents?.() ?? [e]) current.pts.push(...point(ev));
    redraw();
  });
  const end = (e) => {
    if (!current || e.pointerId !== current.id) return;
    current = null;
    onChange();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  return {
    clear() { strokes = []; redraw(); onChange(); },
    isEmpty: () => strokes.length === 0,
    setColor(c) { color = c; redraw(); },
    redraw,
    // Normalise to the strokes' own bounding box, with room for the line.
    toSignature() {
      if (!strokes.length) return null;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const s of strokes) {
        for (let i = 0; i < s.length; i += 2) {
          x0 = Math.min(x0, s[i]); x1 = Math.max(x1, s[i]);
          y0 = Math.min(y0, s[i + 1]); y1 = Math.max(y1, s[i + 1]);
        }
      }
      const m = PAD_LINE;
      x0 -= m; y0 -= m; x1 += m; y1 += m;
      const w = Math.max(x1 - x0, 1), h = Math.max(y1 - y0, 1);
      return {
        kind: 'draw',
        strokes: strokes.map((s) => s.map((v, i) => (i % 2 ? (v - y0) / h : (v - x0) / w))),
        width: PAD_LINE / h,
        aspect: w / h,
        color,
      };
    },
  };
}

// A smooth line through the points: quadratic curves between midpoints.
function strokePath(ctx, s, sx, sy, lineWidth, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const n = s.length / 2;
  if (n === 1) {
    ctx.beginPath();
    ctx.arc(s[0] * sx, s[1] * sy, lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(s[0] * sx, s[1] * sy);
  for (let i = 1; i < n - 1; i++) {
    const mx = ((s[2 * i] + s[2 * i + 2]) / 2) * sx, my = ((s[2 * i + 1] + s[2 * i + 3]) / 2) * sy;
    ctx.quadraticCurveTo(s[2 * i] * sx, s[2 * i + 1] * sy, mx, my);
  }
  ctx.lineTo(s[2 * n - 2] * sx, s[2 * n - 1] * sy);
  ctx.stroke();
}

/* ---------- photo or scan of a signature ---------- */

const MAX_IMAGE_SIDE = 1600;

// Paper becomes transparent and the ink takes the chosen colour: alpha comes
// from how dark each pixel is, measured against the paper's own brightness.
export async function imageToSignature(blob, color = INKS.black) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const img = ctx.getImageData(0, 0, w, h);
  const alpha = inkAlpha(img.data, w, h);
  const box = alphaBox(alpha, w, h);
  if (!box) return null;
  const [r, g, b] = hex(color);
  const out = ctx.createImageData(box.w, box.h);
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const o = (y * box.w + x) * 4;
      out.data[o] = r; out.data[o + 1] = g; out.data[o + 2] = b;
      out.data[o + 3] = alpha[(y + box.y) * w + x + box.x];
    }
  }
  c.width = box.w; c.height = box.h;
  ctx.putImageData(out, 0, 0);
  return { kind: 'image', url: c.toDataURL('image/png'), aspect: box.w / box.h };
}

// Per-pixel ink opacity, 0..255. The paper level is a bright percentile of
// the image, so grey phone photos of white paper still come out clean.
export function inkAlpha(rgba, w, h) {
  const n = w * h, lum = new Uint8Array(n), hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const v = (rgba[4 * i] * 299 + rgba[4 * i + 1] * 587 + rgba[4 * i + 2] * 114) / 1000;
    // Transparent pixels count as paper.
    const a = rgba[4 * i + 3] / 255;
    const l = Math.round(v * a + 255 * (1 - a));
    lum[i] = l;
    hist[l]++;
  }
  let paper = 255;
  for (let acc = 0, v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.4) { paper = v; break; } }
  const lo = paper * 0.45, hi = paper * 0.82; // darker than lo: full ink; lighter than hi: paper
  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const t = (hi - lum[i]) / (hi - lo);
    alpha[i] = t <= 0 ? 0 : t >= 1 ? 255 : Math.round(t * 255);
  }
  return alpha;
}

function alphaBox(alpha, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  if (x1 < 0) return null;
  const m = 4;
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m);
  x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

/* ---------- typed signatures ---------- */

const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT = 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';
const HEBREW = 'U+0307-0308,U+0590-05FF,U+200C-2010,U+20AA,U+25CC,U+FB1D-FB4F';
const ARABIC = 'U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0897-08E1,U+08E3-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC';

// Each family only downloads the files for the letters actually typed.
const FACES = {
  'Pared Dancing': [['dancing-script', 'latin', LATIN], ['dancing-script', 'latin-ext', LATIN_EXT]],
  'Pared Caveat': [['caveat', 'latin', LATIN], ['caveat', 'latin-ext', LATIN_EXT]],
  'Pared Gveret': [['gveret-levin', 'latin', LATIN], ['gveret-levin', 'hebrew', HEBREW]],
  'Pared Ruqaa': [['aref-ruqaa', 'latin', LATIN], ['aref-ruqaa', 'arabic', ARABIC]],
  'Pared Playpen': [['playpen-sans-hebrew', 'latin', LATIN], ['playpen-sans-hebrew', 'hebrew', HEBREW]],
  'Pared Amatic': [['amatic-sc', 'latin', LATIN], ['amatic-sc', 'hebrew', HEBREW]],
  'Pared Solitreo': [['solitreo', 'latin', LATIN], ['solitreo', 'hebrew', HEBREW]],
  // Formal, printed letters: for typed signatures and text on the page.
  'Pared Heebo': [['heebo', 'latin', LATIN], ['heebo', 'hebrew', HEBREW]],
  'Pared Frank Ruhl': [['frank-ruhl-libre', 'latin', LATIN], ['frank-ruhl-libre', 'hebrew', HEBREW]],
  'Pared David': [['david-libre', 'latin', LATIN], ['david-libre', 'hebrew', HEBREW]],
  'Pared Arabic Sans': [['noto-sans-arabic', 'arabic', ARABIC]],
  'Pared Naskh': [['noto-naskh-arabic', 'arabic', ARABIC]],
};

// Styles to choose from. Each handwritten one falls back to the Hebrew and
// Arabic handwriting, so a name in any of the interface's scripts comes out
// handwritten; each formal one (`formal`) to a printed Arabic font of the
// same kind. Formal styles also set text typed on the page.
// `scripts`: what a style can write. `offer`: the scripts it's offered for,
// so a Latin name keeps its four styles and a Hebrew name gets its own four.
export const FONTS = [
  { id: 'dancing', name: 'Dancing Script', scripts: ['latin'], offer: ['latin'], stack: ['Pared Dancing', 'Pared Gveret', 'Pared Ruqaa'] },
  { id: 'caveat', name: 'Caveat', scripts: ['latin'], offer: ['latin'], stack: ['Pared Caveat', 'Pared Gveret', 'Pared Ruqaa'] },
  { id: 'gveret', name: 'Gveret Levin', scripts: ['latin', 'hebrew'], offer: ['latin', 'hebrew'], stack: ['Pared Gveret', 'Pared Ruqaa'] },
  { id: 'ruqaa', name: 'Aref Ruqaa', scripts: ['latin', 'arabic'], offer: ['latin', 'arabic'], stack: ['Pared Ruqaa', 'Pared Gveret'] },
  { id: 'playpen', name: 'Playpen Sans Hebrew', scripts: ['latin', 'hebrew'], offer: ['hebrew'], stack: ['Pared Playpen', 'Pared Ruqaa'] },
  { id: 'amatic', name: 'Amatic SC', scripts: ['latin', 'hebrew'], offer: ['hebrew'], stack: ['Pared Amatic', 'Pared Ruqaa'] },
  { id: 'solitreo', name: 'Solitreo', scripts: ['latin', 'hebrew'], offer: ['hebrew'], stack: ['Pared Solitreo', 'Pared Ruqaa'] },
  { id: 'sans', name: 'Heebo', formal: true, generic: 'sans-serif', scripts: ['latin', 'hebrew', 'arabic'], offer: ['latin', 'hebrew', 'arabic'], stack: ['Pared Heebo', 'Pared Arabic Sans'] },
  { id: 'serif', name: 'Frank Ruhl Libre', formal: true, generic: 'serif', scripts: ['latin', 'hebrew', 'arabic'], offer: ['latin', 'hebrew', 'arabic'], stack: ['Pared Frank Ruhl', 'Pared Naskh'] },
  { id: 'david', name: 'David Libre', formal: true, generic: 'serif', scripts: ['latin', 'hebrew'], offer: ['latin', 'hebrew'], stack: ['Pared David', 'Pared Naskh'] },
];

// The fonts for text typed on the page: the device's own plain font
// (TEXT_FONT, the font of text placed before there was a choice), then the
// formal styles.
export const TEXT_FONTS = [{ id: 'plain', name: 'Arial' }, ...FONTS.filter((f) => f.formal)];

// The styles offered for this text: those that can write all its letters
// themselves (others would only show their fallback). All if none can.
export function fontsFor(text) {
  const need = [/[\u0590-\u05FF\uFB1D-\uFB4F]/.test(text) && 'hebrew', /[\u0600-\u08FF\uFB50-\uFDFF\uFE70-\uFEFC]/.test(text) && 'arabic'].filter(Boolean);
  const main = need.length ? need : ['latin'];
  const fit = FONTS.filter((f) => need.every((sc) => f.scripts.includes(sc)) && main.some((sc) => f.offer.includes(sc)));
  return fit.length ? fit : FONTS.filter((f) => f.offer.includes('latin'));
}

let facesAdded = false;
function addFaces() {
  if (facesAdded || typeof FontFace !== 'function') return;
  facesAdded = true;
  for (const [family, faces] of Object.entries(FACES)) {
    for (const [dir, sub, unicodeRange] of faces) {
      const url = new URL(`./vendor/fonts/${dir}/${dir}-${sub}-400-normal.woff2`, import.meta.url);
      document.fonts.add(new FontFace(family, `url(${url}) format('woff2')`, { unicodeRange, display: 'block' }));
    }
  }
}

const fontFamily = (id) => { const f = FONTS.find((x) => x.id === id); return `${f.stack.map((n) => `"${n}"`).join(', ')}, ${f.generic ?? 'cursive'}`; };
export const fontCss = (id, px) => `${px}px ${fontFamily(id)}`;

const RTL_CHARS = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/;
const MARGIN = 0.12; // ems of room around the ink

function setupText(ctx, sig, px) {
  ctx.font = fontCss(sig.font, px);
  ctx.direction = RTL_CHARS.test(sig.text) ? 'rtl' : 'ltr';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

// Wait until the faces for these letters are loaded, so measuring and
// drawing use the chosen font, not a fallback.
export async function loadFont(id, text) {
  addFaces();
  await document.fonts.load(fontCss(id, 40), text || 'a');
}

// A font for text on the page, in every script it has, so text can be
// measured as it's typed (measuring can't wait for a download).
export async function loadTextFont(id) {
  if (!id || id === 'plain') return;
  await loadFont(id, 'Aa\u05d0\u0628');
}

export async function typedSignature(text, font, color = INKS.black) {
  text = text.trim();
  if (!text) return null;
  await loadFont(font, text);
  const ctx = document.createElement('canvas').getContext('2d');
  const sig = { kind: 'type', text, font, color };
  setupText(ctx, sig, 100);
  const tm = ctx.measureText(text);
  // Extent of the ink around the drawing point, in ems.
  const m = {
    l: (tm.actualBoundingBoxLeft ?? 0) / 100,
    r: (tm.actualBoundingBoxRight ?? tm.width) / 100,
    a: (tm.actualBoundingBoxAscent ?? 80) / 100,
    d: (tm.actualBoundingBoxDescent ?? 20) / 100,
  };
  sig.m = m;
  sig.aspect = (m.l + m.r + 2 * MARGIN) / (m.a + m.d + 2 * MARGIN);
  return sig;
}

function drawTyped(ctx, sig, w, h) {
  const { l, a, d } = sig.m;
  const px = h / (a + d + 2 * MARGIN);
  setupText(ctx, sig, px);
  ctx.fillStyle = sig.color;
  ctx.fillText(sig.text, (MARGIN + l) * px, (MARGIN + a) * px);
}

/* ---------- text and marks filled in on the page ---------- */

export const TEXT_FONT = 'Arial, "Helvetica Neue", Helvetica, "Noto Sans", "Noto Sans Hebrew", "Noto Sans Arabic", sans-serif';
// The CSS font family of a text item: its own font, or the plain one.
export const textFamily = (sig) => (sig?.font && sig.font !== 'plain' && FONTS.some((f) => f.id === sig.font) ? fontFamily(sig.font) : TEXT_FONT);
export const TEXT_LINE = 1.25; // line height, in ems
export const TEXT_PAD = 0.1;   // ems of room around the text

// Measured once, at a fixed size; drawn at any size. `font`: one of
// TEXT_FONTS (load it first, with loadTextFont).
export function textItem(text, color = INKS.black, font = 'plain') {
  text = String(text).replace(/\r/g, '');
  const lines = text.split('\n');
  const sig = { kind: 'text', text, color, lines: lines.length };
  if (font && font !== 'plain') sig.font = font;
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = `100px ${textFamily(sig)}`;
  // An empty box still has some width, so it can be seen and grabbed.
  sig.w = Math.max(0.6, ...lines.map((l) => ctx.measureText(l).width / 100));
  sig.aspect = (sig.w + 2 * TEXT_PAD) / (lines.length * TEXT_LINE + 2 * TEXT_PAD);
  return sig;
}

// Which way the text runs, by its first letter, as a field with dir="auto"
// decides: all its lines then start from that side.
export function isRtlText(s) {
  const first = String(s).match(/[A-Za-z\u00C0-\u02AF\u0370-\u052F]|[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFC]/);
  return !!first && RTL_CHARS.test(first[0]);
}

// Drawn as it was typed: every line starts from the side the text runs from.
function drawText(ctx, sig, w, h) {
  const px = h / (sig.lines * TEXT_LINE + 2 * TEXT_PAD);
  const rtl = isRtlText(sig.text);
  ctx.font = `${px}px ${textFamily(sig)}`;
  ctx.fillStyle = sig.color;
  ctx.textBaseline = 'middle';
  ctx.direction = rtl ? 'rtl' : 'ltr';
  ctx.textAlign = rtl ? 'right' : 'left';
  sig.text.split('\n').forEach((line, i) => {
    ctx.fillText(line, rtl ? w - TEXT_PAD * px : TEXT_PAD * px, (TEXT_PAD + (i + 0.5) * TEXT_LINE) * px);
  });
}

export const markItem = (mark, color = INKS.black) => ({ kind: 'mark', mark, color, aspect: 1 });

function drawMark(ctx, sig, w, h) {
  const s = Math.min(w, h);
  ctx.strokeStyle = sig.color;
  ctx.lineWidth = s * 0.13;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const pt = (x, y) => [(w - s) / 2 + x * s, (h - s) / 2 + y * s];
  if (sig.mark === 'cross') {
    ctx.moveTo(...pt(0.2, 0.2)); ctx.lineTo(...pt(0.8, 0.8));
    ctx.moveTo(...pt(0.8, 0.2)); ctx.lineTo(...pt(0.2, 0.8));
  } else {
    ctx.moveTo(...pt(0.14, 0.54)); ctx.lineTo(...pt(0.4, 0.8)); ctx.lineTo(...pt(0.88, 0.2));
  }
  ctx.stroke();
}

/* ---------- the PDF's own form fields ---------- */

// What a form field shows, drawn here because the browser has fonts for
// every script. w×h are pixels at k pixels per point; size is the field's
// font size in points (0: fit the field), align its /Q (0 start, 1 centre,
// 2 end; right-to-left text starts on the right).
export function fieldCanvas(text, w, h, { k = 1, size = 0, align = 0, multiline = false, color = '#000' } = {}) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext('2d');
  const pad = 2 * k, room = c.width - 2 * pad, LH = 1.15;
  const rtl = isRtlText(text);
  let px = (size || (multiline ? 11 : Math.min(12, (c.height / k) * 0.66))) * k;
  const fontAt = (v) => { ctx.font = `${v}px ${TEXT_FONT}`; };
  fontAt(px);
  let lines;
  if (multiline) {
    for (;;) {
      lines = wrapLines(ctx, text, room);
      if (size || lines.length * px * LH <= c.height - 2 * pad || px <= 4 * k) break;
      fontAt((px *= 0.9));
    }
  } else {
    lines = [text.replace(/\n/g, ' ')];
    const wide = ctx.measureText(lines[0]).width;
    if (!size && wide > room) fontAt((px *= room / wide));
  }
  ctx.fillStyle = color;
  ctx.direction = rtl ? 'rtl' : 'ltr';
  ctx.textBaseline = 'middle';
  const side = align === 1 ? 'center' : (align === 2) !== rtl ? 'right' : 'left';
  ctx.textAlign = side;
  const x = side === 'center' ? c.width / 2 : side === 'right' ? c.width - pad : pad;
  lines.forEach((line, i) => {
    ctx.fillText(line, x, multiline ? pad + (i + 0.5) * px * LH : c.height / 2);
  });
  return c;
}

// Words to lines no wider than `room`, keeping the typed line breaks.
function wrapLines(ctx, text, room) {
  const out = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/(?<=\s)/)) {
      if (line && ctx.measureText(line + word).width > room) { out.push(line.trimEnd()); line = word.trimStart(); } else line += word;
    }
    out.push(line.trimEnd());
  }
  return out;
}

export async function fieldPng(text, w, h, opts) {
  const blob = await new Promise((resolve) => fieldCanvas(text, w, h, opts).toBlob(resolve, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/* ---------- rendering ---------- */

const images = new Map(); // data URL -> decoded image

async function decoded(url) {
  if (!images.has(url)) {
    const img = new Image();
    img.src = url;
    images.set(url, img.decode().then(() => img));
  }
  return images.get(url);
}

// Draw the signature into a new transparent canvas of w×h pixels.
export async function renderSignature(sig, w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext('2d');
  if (sig.kind === 'draw') {
    for (const s of sig.strokes) strokePath(ctx, s, c.width, c.height, Math.max(1, sig.width * c.height), sig.color);
  } else if (sig.kind === 'type') {
    await loadFont(sig.font, sig.text);
    drawTyped(ctx, sig, c.width, c.height);
  } else if (sig.kind === 'text') {
    await loadTextFont(sig.font);
    drawText(ctx, sig, c.width, c.height);
  } else if (sig.kind === 'mark') {
    drawMark(ctx, sig, c.width, c.height);
  } else if (sig.kind === 'image') {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(await decoded(sig.url), 0, 0, c.width, c.height);
  }
  return c;
}

export async function signaturePng(sig, w, h) {
  const c = await renderSignature(sig, w, h);
  const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

// A small image URL for showing the signature on screen.
export async function signaturePreview(sig) {
  if (sig.kind === 'image') return sig.url;
  const h = 160;
  return (await renderSignature(sig, h * sig.aspect, h)).toDataURL('image/png');
}
