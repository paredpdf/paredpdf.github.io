// Places to write on a form that has no fields: a flat form, printed to PDF
// with its boxes, lines and checkboxes only drawn. Found from what the page
// draws, so they are guesses:
//  - checkboxes: box glyphs from symbol fonts (❏ ❑ ☐ …),
//  - cells: areas closed in by lines, without their label,
//  - blank lines to write on that aren't part of a table.
// Everything here is in PDF user space (points, y up) and pure, so it can be
// tested without a browser.

const overlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const area = (r) => (r[2] - r[0]) * (r[3] - r[1]);

/* ---------- what the page draws ---------- */

// The straight lines the page draws, as horizontal and vertical segments:
// { h: [{ y, x0, x1, dashed }], v: [{ x, y0, y1, dashed }] }. Strokes, and
// the edges of filled rectangles (a thin filled rectangle is a line too).
export function pageLines(fnArray, argsArray, OPS) {
  const h = [], v = [];
  let ctm = [1, 0, 0, 1, 0, 0], dashed = false;
  const stack = [];
  let path = null; // { segs, rects } of the path being built
  const STROKES = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const FILLS = new Set([OPS.fill, OPS.eoFill]);
  const add = (ax, ay, bx, by, dash) => {
    const [x0, y0] = apply(ctm, ax, ay), [x1, y1] = apply(ctm, bx, by);
    if (Math.abs(y1 - y0) < 0.5 && Math.abs(x1 - x0) >= 0.5) h.push({ y: (y0 + y1) / 2, x0: Math.min(x0, x1), x1: Math.max(x0, x1), dashed: dash });
    else if (Math.abs(x1 - x0) < 0.5 && Math.abs(y1 - y0) >= 0.5) v.push({ x: (x0 + x1) / 2, y0: Math.min(y0, y1), y1: Math.max(y0, y1), dashed: dash });
  };
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], args = argsArray[i];
    if (fn === OPS.save) stack.push([ctm, dashed]);
    else if (fn === OPS.restore) [ctm, dashed] = stack.pop() ?? [[1, 0, 0, 1, 0, 0], false];
    else if (fn === OPS.transform) ctm = mul(args, ctm);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push([ctm, dashed]); if (args?.[0]) ctm = mul(Array.from(args[0]), ctm); }
    else if (fn === OPS.paintFormXObjectEnd) [ctm, dashed] = stack.pop() ?? [ctm, dashed];
    else if (fn === OPS.setDash) dashed = !!args?.[0]?.length;
    else if (fn === OPS.constructPath) path = readPath(args[0], args[1], OPS, path);
    else if (path && (STROKES.has(fn) || FILLS.has(fn) || fn === OPS.endPath)) {
      if (STROKES.has(fn)) for (const s of path.segs) add(...s, dashed);
      if (STROKES.has(fn) || FILLS.has(fn)) {
        for (const [x, y, w, hh] of path.rects) {
          if (FILLS.has(fn) && Math.min(Math.abs(w), Math.abs(hh)) <= 2) {
            // A bar: the line along its middle.
            if (Math.abs(w) >= Math.abs(hh)) add(x, y + hh / 2, x + w, y + hh / 2, false);
            else add(x + w / 2, y, x + w / 2, y + hh, false);
          } else {
            add(x, y, x + w, y, dashed && !FILLS.has(fn)); add(x + w, y, x + w, y + hh, dashed && !FILLS.has(fn));
            add(x + w, y + hh, x, y + hh, dashed && !FILLS.has(fn)); add(x, y + hh, x, y, dashed && !FILLS.has(fn));
          }
        }
      }
      path = null;
    }
  }
  return { h: mergeLines(h, 'y', 'x0', 'x1'), v: mergeLines(v, 'x', 'y0', 'y1') };
}

// The straight pieces and rectangles of one path. pdf.js may send a path in
// several parts, so a path that hasn't been painted yet carries on.
function readPath(ops, coords, OPS, prev) {
  const out = prev ?? { segs: [], rects: [] };
  let k = 0, cx = 0, cy = 0, sx = 0, sy = 0;
  if (prev?.end) [cx, cy, sx, sy] = prev.end;
  for (const op of ops) {
    if (op === OPS.moveTo) { cx = sx = coords[k++]; cy = sy = coords[k++]; }
    else if (op === OPS.lineTo) { const x = coords[k++], y = coords[k++]; out.segs.push([cx, cy, x, y]); cx = x; cy = y; }
    else if (op === OPS.curveTo) { k += 4; cx = coords[k++]; cy = coords[k++]; }
    else if (op === OPS.curveTo2 || op === OPS.curveTo3) { k += 2; cx = coords[k++]; cy = coords[k++]; }
    else if (op === OPS.closePath) { out.segs.push([cx, cy, sx, sy]); cx = sx; cy = sy; }
    else if (op === OPS.rectangle) { const r = [coords[k++], coords[k++], coords[k++], coords[k++]]; out.rects.push(r); cx = sx = r[0]; cy = sy = r[1]; }
  }
  out.end = [cx, cy, sx, sy];
  return out;
}

const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const mul = (m, n) => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];

// Join pieces of the same line that touch or overlap.
function mergeLines(list, at, lo, hi) {
  list.sort((a, b) => a[at] - b[at]);
  const out = [];
  for (let i = 0; i < list.length;) {
    // Lines within about a point of each other are one line.
    let j = i;
    while (j < list.length && list[j][at] - list[i][at] < 1.2) j++;
    const group = list.slice(i, j).sort((a, b) => a[lo] - b[lo]);
    const pos = group.reduce((s, x) => s + x[at], 0) / group.length;
    const runs = [];
    for (const s of group) {
      const last = runs.findLast((r) => r.dashed === s.dashed);
      if (last && s[lo] <= last[hi] + 1) last[hi] = Math.max(last[hi], s[hi]);
      else runs.push({ ...s, [at]: pos });
    }
    out.push(...runs);
    i = j;
  }
  return out;
}

// The page's text from pdf.js getTextContent, as boxes in user space:
// { str, x0, y0, x1, y1, size, rtl, font } (font: the font's real name).
export function textBoxes(items, fontName = () => '') {
  const out = [];
  for (const t of items) {
    if (!t.str || !t.str.trim()) continue;
    const [a, b, c, d, e, f] = t.transform;
    const size = Math.hypot(c, d) || t.height || 0;
    if (!size) continue;
    const ux = a / (Math.hypot(a, b) || 1), uy = b / (Math.hypot(a, b) || 1); // along the text
    const vx = c / (Math.hypot(c, d) || 1), vy = d / (Math.hypot(c, d) || 1); // up the letters
    const w = t.width, up = size * 0.8, down = size * 0.2;
    const xs = [e - vx * down, e + ux * w - vx * down, e + vx * up, e + ux * w + vx * up];
    const ys = [f - vy * down, f + uy * w - vy * down, f + vy * up, f + uy * w + vy * up];
    out.push({ str: t.str, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys),
      size, rtl: t.dir === 'rtl', font: fontName(t.fontName) || '', x: e, y: f, upright: Math.abs(b) < 1e-3 && Math.abs(c) < 1e-3 && a > 0,
      // The way it reads, to the nearest quarter turn: 0 along x, 90 up the page...
      angle: (((Math.round(Math.atan2(b, a) / (Math.PI / 2)) * 90) % 360) + 360) % 360 });
  }
  return out;
}

/* ---------- checkboxes ---------- */

const BOX_CHARS = /^[☐□❏❐❑❒▢◻⬜]$/u;
const SYMBOL_FONT = /dingbat|wingding|symbol/i;
const SYMBOL_BOXES = { dingbat: 'nopqr', wingding: 'opq¨' };

// Checkboxes drawn as a letter: [x0, y0, x1, y1] of each box.
export function findCheckboxes(texts) {
  const out = [];
  for (const t of texts) {
    if (!t.upright) continue;
    const s = t.str.trim();
    const kind = /dingbat/i.test(t.font) ? 'dingbat' : /wingding/i.test(t.font) ? 'wingding' : null;
    const boxes = kind ? [...s].every((ch) => SYMBOL_BOXES[kind].includes(ch) || ch === ' ') : false;
    if (!(BOX_CHARS.test(s) || (boxes && s.length && SYMBOL_FONT.test(t.font)))) continue;
    // One item may hold a few boxes in a row; each takes an equal part.
    const chars = [...t.str];
    const each = (t.x1 - t.x0) / chars.length;
    chars.forEach((ch, i) => {
      if (ch === ' ') return;
      const side = Math.min(each, t.size) * 0.85;
      const x0 = t.x + i * each + (each - side) / 2;
      out.push([x0, t.y - t.size * 0.02, x0 + side, t.y - t.size * 0.02 + side]);
    });
  }
  return out;
}

/* ---------- cells ---------- */

const MIN_LINE = 6;      // shorter lines are ticks, not edges
const GRID = 4;          // points between the probes for cells
const MIN_W = 18, MIN_H = 7; // smallest place to write in, in points

const hasLetters = (s) => /\p{L}/u.test(s);

// Areas closed in by lines, as [x0, y0, x1, y1]. Each probe point looks for
// the nearest line in all four directions; the lines must close the area on
// all sides. Dashed upright lines are left out (they mark digits inside a
// box), dashed level ones kept (rows to write on).
export function findCells(lines, view) {
  const [vx0, vy0, vx1, vy1] = view;
  const hs = lines.h.filter((s) => s.x1 - s.x0 >= MIN_LINE);
  const vs = lines.v.filter((s) => !s.dashed && s.y1 - s.y0 >= MIN_LINE);
  const seen = new Map();
  for (let y = vy0 + GRID / 2; y < vy1; y += GRID) {
    for (let x = vx0 + GRID / 2; x < vx1; x += GRID) {
      let top = null, bottom = null, left = null, right = null;
      for (const s of hs) {
        if (x < s.x0 - 0.5 || x > s.x1 + 0.5) continue;
        if (s.y > y && (!top || s.y < top.y)) top = s;
        if (s.y < y && (!bottom || s.y > bottom.y)) bottom = s;
      }
      if (!top || !bottom) continue;
      for (const s of vs) {
        if (y < s.y0 - 0.5 || y > s.y1 + 0.5) continue;
        if (s.x > x && (!right || s.x < right.x)) right = s;
        if (s.x < x && (!left || s.x > left.x)) left = s;
      }
      if (!left || !right) continue;
      const key = `${left.x.toFixed(1)},${bottom.y.toFixed(1)},${right.x.toFixed(1)},${top.y.toFixed(1)}`;
      if (seen.has(key)) continue;
      const r = [left.x, bottom.y, right.x, top.y];
      // Dotted rows often stop short of the box's sides.
      const covers = (s, a, b, lo, hi) => { const slack = s.dashed ? 8 : 2; return s[lo] <= a + slack && s[hi] >= b - slack; };
      const closed = covers(top, r[0], r[2], 'x0', 'x1') && covers(bottom, r[0], r[2], 'x0', 'x1')
        && covers(left, r[1], r[3], 'y0', 'y1') && covers(right, r[1], r[3], 'y0', 'y1');
      seen.set(key, closed ? r : null);
    }
  }
  // A frame around other cells (a table, or a box's drop shadow) isn't one.
  const cells = [...seen.values()].filter((r) => r && area(r) < area(view) * 0.25).sort((a, b) => area(a) - area(b));
  const kept = [];
  for (const c of cells) {
    if (kept.reduce((s, k) => s + overlap(k, c), 0) < area(c) * 0.3) kept.push(c);
  }
  return kept;
}

// The part of a cell to write in: the largest space without words, below or
// above its label, or beside it. Null when there isn't room.
export function freeSpace(cell, texts) {
  const [cx0, cy0, cx1, cy1] = cell;
  const pad = 1.5;
  const inside = texts.filter((t) => hasLetters(t.str) && (t.x0 + t.x1) / 2 > cx0 && (t.x0 + t.x1) / 2 < cx1 && (t.y0 + t.y1) / 2 > cy0 && (t.y0 + t.y1) / 2 < cy1);
  // Up and down: the tallest gap between the words.
  const spans = inside.map((t) => [Math.max(cy0, t.y0), Math.min(cy1, t.y1)]).sort((a, b) => b[1] - a[1]);
  let best = null, at = cy1 - pad;
  for (const [lo, hi] of [...spans, [cy0 + pad, cy0 + pad]]) {
    if (at - hi >= MIN_H && (!best || at - hi > best[3] - best[1])) best = [cx0 + pad, hi, cx1 - pad, at];
    at = Math.min(at, lo);
  }
  if (best && best[2] - best[0] >= MIN_W) return best;
  // Beside: a label at one side of a cell one line high leaves the rest
  // free. Words in the middle (a heading) leave nothing.
  if (cy1 - cy0 < MIN_H || !inside.length) return null;
  const lo = Math.min(...inside.map((t) => t.x0)), hi = Math.max(...inside.map((t) => t.x1));
  const left = lo - cx0, right = cx1 - hi, w = cx1 - cx0;
  const wide = Math.max(MIN_W * 2, 30), snug = Math.min(15, w * 0.15);
  if (left >= wide && right <= snug) return [cx0 + pad, cy0 + pad, lo - pad, cy1 - pad];
  if (right >= wide && left <= snug) return [hi + pad, cy0 + pad, cx1 - pad, cy1 - pad];
  return null;
}

// The characters of a line of text between x0 and x1, roughly: a line of
// text is measured as a whole, so its letters are taken as equally wide.
function textBetween(t, x0, x1) {
  const n = t.str.length, w = t.x1 - t.x0;
  if (!w) return t.str;
  let a = Math.floor(((Math.max(x0, t.x0) - t.x0) / w) * n), b = Math.ceil(((Math.min(x1, t.x1) - t.x0) / w) * n);
  if (t.rtl) [a, b] = [n - b, n - a]; // stored in reading order
  return t.str.slice(Math.max(0, a), Math.min(n, b));
}

/* ---------- blank lines ---------- */

// Level lines to write on that stand alone, not the edges of a box: no other
// line just above them, no upright lines at their ends. The space above each,
// as tall as the words beside it.
export function findBlanks(lines, texts) {
  const out = [];
  for (const s of lines.h) {
    const len = s.x1 - s.x0;
    if (len < 15 || len > 300 || s.dashed) continue; // dotted lines mark rows of a table
    const above = lines.h.filter((o) => o !== s && o.y > s.y + 0.5 && o.y < s.y + 22 && o.x0 < s.x1 - 2 && o.x1 > s.x0 + 2);
    const roof = Math.min(s.y + 22, ...above.map((o) => o.y));
    const boxed = roof < s.y + 10
      // a border at an end, or a column's border across it: a table's row
      || lines.v.some((o) => !o.dashed && o.x > s.x0 - 2 && o.x < s.x1 + 2 && o.y0 <= s.y + 8 && o.y1 >= s.y - 2);
    if (boxed) continue;
    // Words on the same line give its height; else about a line of text.
    const near = texts.filter((t) => t.y0 < s.y + 14 && t.y1 > s.y && (t.x1 > s.x0 - 40 && t.x0 < s.x1 + 40));
    let hgt = Math.min(16, roof - s.y - 1, Math.max(9, ...near.map((t) => t.size * 1.15)));
    // Keep clear of words over the line itself; a sentence with a blank in
    // it has only spaces there. Words of the line above only make the space
    // lower.
    const over = texts.filter((t) => t.x0 < s.x1 && t.x1 > s.x0 && t.y0 < s.y + hgt && t.y1 > s.y + 1
      && hasLetters(textBetween(t, s.x0 + 2, s.x1 - 2)));
    if (over.some((t) => t.y0 < s.y + 4)) continue;
    hgt = Math.min(hgt, ...over.map((t) => t.y0 - s.y - 0.5));
    if (hgt < MIN_H) continue;
    out.push([s.x0, s.y + 0.5, s.x1, s.y + hgt]);
  }
  // Underscores typed as text: ____
  for (const t of texts) {
    if (!t.upright) continue;
    const m = [...t.str.matchAll(/_{3,}/g)];
    for (const run of m) {
      const n = t.str.length, w = t.x1 - t.x0;
      // Text that reads right to left is stored in reading order.
      const a = t.rtl ? n - run.index - run[0].length : run.index;
      const x0 = t.x0 + (w * a) / n, x1 = x0 + (w * run[0].length) / n;
      if (x1 - x0 >= 12) out.push([x0, t.y, x1, t.y + t.size * 1.1]);
    }
  }
  return out;
}

/* ---------- all together ---------- */

// Every place to write on a page whose view box is `view` ([x0, y0, x1, y1]):
// [{ kind: 'check' | 'text', rect: [x0, y0, x1, y1], rtl }], in user space.
// rtl: the page's words mostly read right to left, so text starts at the
// right of its place. On a form printed sideways, "right" is as it reads.
export function findSpots({ lines, texts, view }) {
  // A form printed on its side: find its places as if it were upright, then
  // turn them back.
  const turn = readingTurn(texts);
  if (turn) {
    const spots = findUpright(turnLines(lines, turn), turnTexts(texts, turn), turnRect(view, turn));
    return spots.map((s) => ({ ...s, rect: turnRect(s.rect, -turn) }));
  }
  return findUpright(lines, texts, view);
}

// The quarter turn most of the page's words read at.
export function readingTurn(texts) {
  const weight = new Map();
  for (const t of texts) if (hasLetters(t.str)) weight.set(t.angle ?? 0, (weight.get(t.angle ?? 0) ?? 0) + t.str.length);
  let best = 0;
  for (const [a, w] of weight) if (w > (weight.get(best) ?? 0)) best = a;
  return best;
}

// Turning by -deg, so text that reads at deg reads along x. Back with -(-deg).
function turnPoint(x, y, deg) {
  const r = (-deg * Math.PI) / 180, c = Math.round(Math.cos(r)), s = Math.round(Math.sin(r));
  return [x * c - y * s, x * s + y * c];
}
function turnRect(r, deg) {
  const [ax, ay] = turnPoint(r[0], r[1], deg), [bx, by] = turnPoint(r[2], r[3], deg);
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
}
function turnLines(lines, deg) {
  const h = [], v = [];
  const add = ([x0, y0], [x1, y1], dashed) => {
    if (Math.abs(y1 - y0) < 0.5) h.push({ y: y0, x0: Math.min(x0, x1), x1: Math.max(x0, x1), dashed });
    else v.push({ x: x0, y0: Math.min(y0, y1), y1: Math.max(y0, y1), dashed });
  };
  for (const s of lines.h) add(turnPoint(s.x0, s.y, deg), turnPoint(s.x1, s.y, deg), s.dashed);
  for (const s of lines.v) add(turnPoint(s.x, s.y0, deg), turnPoint(s.x, s.y1, deg), s.dashed);
  return { h, v };
}
function turnTexts(texts, deg) {
  return texts.map((t) => {
    const [x0, y0, x1, y1] = turnRect([t.x0, t.y0, t.x1, t.y1], deg), [x, y] = turnPoint(t.x, t.y, deg);
    return { ...t, x0, y0, x1, y1, x, y, angle: (((t.angle ?? 0) - deg) % 360 + 360) % 360, upright: t.angle === deg };
  });
}

function findUpright(lines, texts, view) {
  const rtl = texts.filter((t) => t.rtl).length > texts.filter((t) => hasLetters(t.str) && !t.rtl).length;
  const checks = findCheckboxes(texts);
  const spots = checks.map((rect) => ({ kind: 'check', rect }));
  // Blank lines first: a box holding lines to write on is written on them.
  const writes = findBlanks(lines, texts);
  for (const cell of findCells(lines, view)) {
    if (checks.some((c) => overlap(c, cell) > area(c) / 2)) continue; // a cell of choices
    const free = freeSpace(cell, texts);
    if (free && !writes.some((w) => overlap(w, free) > Math.min(area(w), area(free)) * 0.3)) writes.push(free);
  }
  for (const rect of writes) {
    if (!checks.some((c) => overlap(c, rect) > 0)) spots.push({ kind: 'text', rect, rtl });
  }
  return spots;
}
