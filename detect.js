// Pure detection helpers: no DOM, no pdf.js. Boxes are normalised to the
// rendered sheet: {x0, y0, x1, y1} in 0..1, origin top-left.

const PORTRAIT = [
  { id: '9:16', label: '9:16', r: 9 / 16 },
  { id: '2:3', label: '2:3', r: 2 / 3 },
  { id: 'iso', label: 'A4', r: 1 / Math.SQRT2 },
  { id: '3:4', label: '3:4', r: 3 / 4 },
  { id: 'letter', label: 'Letter', r: 8.5 / 11 },
  { id: '4:5', label: '4:5', r: 4 / 5 },
];
const SQUARE = { id: '1:1', label: '1:1', r: 1 };
const LANDSCAPE = PORTRAIT.map((p) => ({
  id: p.id + '-l',
  label: p.label.includes(':') ? p.label.split(':').reverse().join(':') : p.label,
  r: 1 / p.r,
}));

export const RATIOS = [...PORTRAIT, SQUARE, ...LANDSCAPE];
export const FULL = { x0: 0, y0: 0, x1: 1, y1: 1 };

export function ratiosFor(orientation) {
  return orientation === 'landscape' ? [...LANDSCAPE, SQUARE] : [...PORTRAIT, SQUARE];
}

// The same shape in the other orientation ('3:4' <-> '3:4-l'); 1:1 maps to itself.
export function flipRatioId(id) {
  if (id === SQUARE.id) return id;
  return id.endsWith('-l') ? id.slice(0, -2) : id + '-l';
}

// Bounding box of everything that differs from the background colour.
// `data` is RGBA ImageData.data. Returns null for a blank page.
export function findContentBox(data, width, height, threshold = 24) {
  const bg = backgroundColour(data, width, height);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    let row = y * width * 4;
    for (let x = 0; x < width; x++, row += 4) {
      const d = Math.abs(data[row] - bg[0]) + Math.abs(data[row + 1] - bg[1]) + Math.abs(data[row + 2] - bg[2]);
      if (d > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x0: minX / width, y0: minY / height, x1: (maxX + 1) / width, y1: (maxY + 1) / height };
}

// The colour at least two corners agree on; white if they all differ
// (e.g. a full-bleed photo).
function backgroundColour(data, w, h) {
  const at = (x, y) => { const i = (y * w + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
  const cs = [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)];
  const close = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 12;
  for (let i = 0; i < 4; i++) {
    if (cs.filter((c) => close(c, cs[i])).length >= 2) return cs[i];
  }
  return [255, 255, 255];
}

export function unionBoxes(a, b) {
  if (!a) return b;
  if (!b) return a;
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

// A box of ratio r (width / height) centred on a W×H sheet, as large as fits.
export function boxForRatio(r, W, H) {
  if (r <= W / H) {
    const f = (H * r) / W;
    return { x0: (1 - f) / 2, y0: 0, x1: (1 + f) / 2, y1: 1 };
  }
  const f = W / r / H;
  return { x0: 0, y0: (1 - f) / 2, x1: 1, y1: (1 + f) / 2 };
}

export function padBox(b, pad = 0.01) {
  return { x0: Math.max(0, b.x0 - pad), y0: Math.max(0, b.y0 - pad), x1: Math.min(1, b.x1 + pad), y1: Math.min(1, b.y1 + pad) };
}

// Guess the real page from the union of content across pages. Assumes the
// exporter centred the real page on the sheet (what Keynote, PowerPoint and
// "fit to page" printing do), then snaps the empty-band axis to the
// smallest common aspect ratio that still contains all content.
export function detectPageBox(content, W, H) {
  if (!content) return { box: FULL, ratio: null, confidence: 'low', reason: 'blank' };

  const halfW = Math.max(W / 2 - content.x0 * W, content.x1 * W - W / 2);
  const halfH = Math.max(H / 2 - content.y0 * H, content.y1 * H - H / 2);
  const bandX = (W / 2 - halfW) / W; // empty share on each side, assuming centring
  const bandY = (H / 2 - halfH) / H;
  const MIN_BAND = 0.04;

  if (Math.max(bandX, bandY) < MIN_BAND) {
    return { box: FULL, ratio: null, confidence: 'high', reason: 'fills-sheet' };
  }

  const horizontal = bandX >= bandY; // empty bands left/right → real page uses full height
  const full = horizontal ? H : W;
  const avail = horizontal ? W : H;
  const need = horizontal ? 2 * halfW : 2 * halfH;
  const tol = Math.max(1, 0.004 * full); // anti-aliasing slack, in points

  let best = null;
  for (const rt of RATIOS) {
    const span = horizontal ? full * rt.r : full / rt.r;
    if (span > avail - tol || span < need - tol) continue;
    if (!best || span < best.span) best = { rt, span };
  }

  const span = best ? best.span : need;
  const f = span / avail;
  const box = horizontal
    ? { x0: (1 - f) / 2, y0: 0, x1: (1 + f) / 2, y1: 1 }
    : { x0: 0, y0: (1 - f) / 2, x1: 1, y1: (1 + f) / 2 };

  const otherBand = horizontal ? bandY : bandX;
  const offCentre = horizontal
    ? Math.abs((content.x0 + content.x1) / 2 - 0.5)
    : Math.abs((content.y0 + content.y1) / 2 - 0.5);
  const confidence = best && otherBand < MIN_BAND && offCentre < 0.03 ? 'high' : 'low';
  return { box, ratio: best ? best.rt : null, confidence, reason: horizontal ? 'side-bands' : 'top-bands' };
}

// Name the ratio of a box (in points) if it is close to a known one.
export function nameRatio(w, h) {
  const r = w / h;
  const hit = RATIOS.find((rt) => Math.abs(rt.r - r) / rt.r < 0.006);
  return hit ? hit.label : null;
}

/* ---------- exact detection from the PDF's own clip ---------- */

// Exporters such as Keynote draw each slide inside a rectangular clip the
// size of the real page. pageClipRects reads the rectangular clips from a
// pdf.js operator list and returns them in PDF user space as
// [x0, y0, x1, y1], outermost first. OPS is pdfjsLib.OPS.
export function pageClipRects(fnArray, argsArray, OPS) {
  const rects = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let pending = null; // a lone rectangle path that a clip may use
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], args = argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mulMatrix(args, ctm);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (args?.[0]) ctm = mulMatrix(Array.from(args[0]), ctm); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.constructPath) {
      const [ops, coords] = args;
      pending = ops.length === 1 && ops[0] === OPS.rectangle ? Array.from(coords).slice(0, 4) : null;
      continue;
    } else if ((fn === OPS.clip || fn === OPS.eoClip) && pending) {
      const r = transformRect(pending, ctm);
      if (r) rects.push(r);
    }
    if (fn !== OPS.clip && fn !== OPS.eoClip && fn !== OPS.endPath) pending = null;
  }
  return rects;
}

function mulMatrix(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

// [x, y, w, h] through matrix m; null unless the result is axis-aligned.
function transformRect([x, y, w, h], m) {
  if (Math.abs(m[1]) > 1e-6 || Math.abs(m[2]) > 1e-6) {
    if (Math.abs(m[0]) > 1e-6 || Math.abs(m[3]) > 1e-6) return null;
  }
  const pts = [[x, y], [x + w, y + h]].map(([px, py]) => [m[0] * px + m[2] * py + m[4], m[1] * px + m[3] * py + m[5]]);
  return [Math.min(pts[0][0], pts[1][0]), Math.min(pts[0][1], pts[1][1]), Math.max(pts[0][0], pts[1][0]), Math.max(pts[0][1], pts[1][1])];
}

// A normalised clip that could be a page: on the sheet, at least a fifth of
// it, and not the whole sheet.
export function isPageLikeClip(b) {
  if (!b) return false;
  const fw = b.x1 - b.x0, fh = b.y1 - b.y0;
  const inside = b.x0 > -0.002 && b.y0 > -0.002 && b.x1 < 1.002 && b.y1 < 1.002;
  return inside && fw * fh >= 0.2 && (fw < 0.98 || fh < 0.98);
}

// Decide whether the clips agree on a real page. `clips` holds, per sampled
// page, that page's outermost page-like clip as a normalised box (or null).
// Returns a detection like detectPageBox's, with confidence 'exact', or null.
export function clipPageBox(clips, content, W, H) {
  const good = clips.filter(isPageLikeClip);
  if (!clips.length || good.length < Math.ceil(clips.length * 0.8)) return null;
  const tol = 1 / Math.max(W, H); // about one point
  const ref = good[0];
  const same = (b) => ['x0', 'y0', 'x1', 'y1'].every((k) => Math.abs(b[k] - ref[k]) <= tol);
  if (!good.every(same)) return null;
  const box = {
    x0: Math.max(0, ref.x0), y0: Math.max(0, ref.y0), x1: Math.min(1, ref.x1), y1: Math.min(1, ref.y1),
  };
  // Everything visible has to be inside the clip, or it isn't the page.
  if (content && (content.x0 < box.x0 - 2 * tol || content.y0 < box.y0 - 2 * tol
      || content.x1 > box.x1 + 2 * tol || content.y1 > box.y1 + 2 * tol)) return null;
  const w = (box.x1 - box.x0) * W, h = (box.y1 - box.y0) * H;
  const ratio = RATIOS.find((rt) => Math.abs(rt.r - w / h) / rt.r < 0.006) || null;
  const centred = Math.abs((box.x0 + box.x1) / 2 - 0.5) < 0.01 && Math.abs((box.y0 + box.y1) / 2 - 0.5) < 0.01;
  return { box, ratio, confidence: 'exact', reason: 'clip', centred };
}
