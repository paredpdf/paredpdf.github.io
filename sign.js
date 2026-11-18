// Visual signatures: drawing one, turning a photo of one into transparent
// ink, and rendering either at any size. A signature is plain data, so it can
// be stored and redrawn sharp at export size:
//   { kind: 'draw', strokes: [[x, y, x, y, ...], ...], width, aspect, color }
//     points are 0..1 across and down the signature's box; width is the line
//     width as a fraction of the box height; aspect is width / height.
//   { kind: 'image', url, aspect }   a transparent PNG data URL

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
