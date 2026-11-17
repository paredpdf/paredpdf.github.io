import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
import {
  FULL, RATIOS, findContentBox, unionBoxes, detectPageBox, boxForRatio, padBox, ratiosForSheet, nameRatio,
} from './detect.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';

const MAX_SAMPLES_PER_GROUP = 40;   // pages rendered for detection, per sheet size
const DETECT_PX = 1000;             // longest side of the detection render

const $ = (id) => document.getElementById(id);
const el = {
  drop: $('drop'), file: $('file'), pick: $('pick'), work: $('work'),
  stageWrap: $('stageWrap'), stage: $('stage'), canvas: $('canvas'), crop: $('crop'), shade: $('shade'), contentOutline: $('contentOutline'),
  prev: $('prev'), next: $('next'), pageLabel: $('pageLabel'), showContent: $('showContent'),
  fname: $('fname'), fmeta: $('fmeta'), progress: $('progress'), progressBar: $('progressBar'), progressText: $('progressText'),
  detectCard: $('detectCard'), confidence: $('confidence'), detectText: $('detectText'), groupSel: $('groupSel'),
  boxCard: $('boxCard'), chips: $('chips'), rSize: $('rSize'), rMm: $('rMm'), rRatio: $('rRatio'),
  actions: $('actions'), download: $('download'), saveText: $('saveText'), reset: $('reset'), error: $('error'),
};

let state = null;
let renderTask = null;
let session = 0; // bumps on every new file so stale async work can bail out

/* ---------- file intake ---------- */

el.pick.addEventListener('click', (e) => { e.stopPropagation(); el.file.click(); });
el.drop.addEventListener('click', () => el.file.click());
el.drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.file.click(); } });
el.file.addEventListener('change', () => { if (el.file.files[0]) open(el.file.files[0]); });
for (const t of ['dragenter', 'dragover']) {
  document.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.add('over'); });
}
for (const t of ['dragleave', 'drop']) {
  document.addEventListener(t, (e) => { e.preventDefault(); if (t === 'drop' || e.target === el.drop) el.drop.classList.remove('over'); });
}
document.addEventListener('drop', (e) => {
  const f = [...(e.dataTransfer?.files || [])].find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (f) open(f);
});
el.reset.addEventListener('click', resetAll);

function resetAll() {
  session++;
  state?.pdf?.destroy();
  state = null;
  el.file.value = '';
  el.work.hidden = true;
  el.drop.hidden = false;
}

async function open(file) {
  resetAll();
  const my = session;
  el.drop.hidden = true;
  el.work.hidden = false;
  for (const k of ['detectCard', 'boxCard', 'actions', 'error']) el[k].hidden = true;
  el.fname.textContent = file.name;
  el.fmeta.textContent = `${fmtBytes(file.size)} · reading…`;
  el.saveText.textContent = '';

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // pdf.js may take ownership of the buffer it is given, so hand it a copy.
    const pdf = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
    if (my !== session) return;
    state = { file, bytes, pdf, n: pdf.numPages, page: 1, groups: [], groupOf: [] };
    await collectGroups(my);
    if (my !== session) return;
    const g0 = state.groups[0];
    el.fmeta.textContent = `${fmtBytes(file.size)} · ${state.n} page${state.n > 1 ? 's' : ''} · ${fmtSheet(g0.W, g0.H)}`;
    showPage(1);
    await analyse(my);
  } catch (err) {
    if (my !== session) return;
    console.error(err);
    showError(err?.name === 'PasswordException'
      ? 'This PDF is password-protected. Remove the password and try again.'
      : `Couldn't read this PDF: ${err?.message || err}`);
  }
}

/* ---------- analysis ---------- */

// Pages are grouped by rendered sheet size, so mixed-size documents get one
// crop box per size instead of one box forced onto every page.
async function collectGroups(my) {
  const byKey = new Map();
  for (let i = 1; i <= state.n; i++) {
    const page = await state.pdf.getPage(i);
    if (my !== session) return;
    const vp = page.getViewport({ scale: 1 });
    const key = `${Math.round(vp.width)}x${Math.round(vp.height)}`;
    let g = byKey.get(key);
    if (!g) {
      g = { key, W: vp.width, H: vp.height, pages: [], content: null, detected: null, box: FULL, mode: 'full', done: false };
      byKey.set(key, g);
      state.groups.push(g);
    }
    g.pages.push(i);
    state.groupOf[i] = g;
  }
}

async function analyse(my) {
  const plan = state.groups.flatMap((g) => samplePages(g.pages).map((p) => [g, p]));
  el.progress.hidden = false;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  for (let k = 0; k < plan.length; k++) {
    const [g, p] = plan[k];
    el.progressText.textContent = `Looking for the real page… ${k + 1} / ${plan.length}`;
    el.progressBar.style.width = `${((k + 1) / plan.length) * 100}%`;
    const page = await state.pdf.getPage(p);
    const scale = DETECT_PX / Math.max(g.W, g.H);
    const vp = page.getViewport({ scale });
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    if (my !== session) return;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    g.content = unionBoxes(g.content, findContentBox(img.data, canvas.width, canvas.height));
    page.cleanup();

    const last = k === plan.length - 1 || plan[k + 1][0] !== g;
    if (last) {
      g.detected = detectPageBox(g.content, g.W, g.H);
      g.done = true;
      setMode(g, 'auto');
    }
  }
  canvas.width = canvas.height = 0;
  el.progress.hidden = true;
  el.actions.hidden = false;
  refreshPanel();
}

function samplePages(pages) {
  if (pages.length <= MAX_SAMPLES_PER_GROUP) return pages;
  const out = new Set();
  for (let i = 0; i < MAX_SAMPLES_PER_GROUP; i++) {
    out.add(pages[Math.round((i * (pages.length - 1)) / (MAX_SAMPLES_PER_GROUP - 1))]);
  }
  return [...out];
}

/* ---------- crop modes ---------- */

function setMode(g, mode) {
  g.mode = mode;
  if (mode === 'auto') g.box = { ...g.detected.box };
  else if (mode === 'full') g.box = { ...FULL };
  else if (mode === 'content') g.box = g.content ? padBox(g.content, 0.01) : { ...FULL };
  else if (mode !== 'custom') {
    const rt = RATIOS.find((r) => r.id === mode);
    if (rt) g.box = boxForRatio(rt.r, g.W, g.H);
  }
  if (g === curGroup()) { placeOverlay(); refreshPanel(); }
}

function curGroup() { return state?.groupOf[state.page]; }

function refreshPanel() {
  const g = curGroup();
  if (!g || !g.done) return;
  el.detectCard.hidden = false;
  el.boxCard.hidden = false;

  const d = g.detected;
  el.confidence.className = `badge ${d.confidence}`;
  el.confidence.textContent = d.confidence === 'high' ? 'Confident' : 'Best guess';
  const sheet = fmtSheet(g.W, g.H);
  const dw = (d.box.x1 - d.box.x0) * g.W, dh = (d.box.y1 - d.box.y0) * g.H;
  if (d.reason === 'blank') el.detectText.textContent = 'These pages look blank, so there is nothing to detect.';
  else if (d.reason === 'fills-sheet') el.detectText.textContent = `The content already fills the ${sheet} sheet. It doesn't look letterboxed.`;
  else {
    const shape = d.ratio ? `${d.ratio.label} ${dw < dh ? 'portrait' : 'landscape'}` : `${fmtPt(dw)} × ${fmtPt(dh)} pt`;
    el.detectText.textContent = `${article(shape)} ${shape} page, centred on the ${sheet} sheet.` +
      (d.confidence === 'high' ? '' : ' Check the preview and adjust if needed.');
  }

  el.groupSel.hidden = state.groups.length < 2;
  if (state.groups.length > 1) {
    el.groupSel.replaceChildren(...state.groups.map((gg) => {
      const b = chip(`${fmtPt(gg.W)}×${fmtPt(gg.H)} · ${gg.pages.length}p`, gg === g, () => showPage(gg.pages[0]));
      b.title = 'Pages of this sheet size share one crop box';
      return b;
    }));
  }

  const opts = [['auto', d.ratio ? `Auto (${d.ratio.label})` : 'Auto']];
  for (const rt of ratiosForSheet(g.W, g.H)) opts.push([rt.id, rt.label]);
  opts.push(['content', 'Fit content'], ['full', 'Whole sheet']);
  if (g.mode === 'custom') opts.push(['custom', 'Custom']);
  el.chips.replaceChildren(...opts.map(([id, label]) => chip(label, g.mode === id, () => setMode(g, id))));

  const w = (g.box.x1 - g.box.x0) * g.W, h = (g.box.y1 - g.box.y0) * g.H;
  el.rSize.textContent = `${fmtPt(w)} × ${fmtPt(h)} pt`;
  el.rMm.textContent = `${fmtMm(w)} × ${fmtMm(h)} mm`;
  const named = nameRatio(w, h);
  el.rRatio.textContent = `${w < h ? 'Portrait' : w > h ? 'Landscape' : 'Square'}${named ? ` · ${named}` : ''} · ${(w / h).toFixed(3)}`;
}

function chip(label, pressed, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.textContent = label;
  b.setAttribute('aria-pressed', String(pressed));
  b.addEventListener('click', onClick);
  return b;
}

/* ---------- preview ---------- */

el.prev.addEventListener('click', () => showPage(state.page - 1));
el.next.addEventListener('click', () => showPage(state.page + 1));
el.showContent.addEventListener('change', placeOverlay);
document.addEventListener('keydown', (e) => {
  if (!state || el.work.hidden || e.target.closest('input, button')) return;
  if (e.key === 'ArrowLeft') showPage(state.page - 1);
  if (e.key === 'ArrowRight') showPage(state.page + 1);
});
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => state && showPage(state.page), 120); });

async function showPage(n) {
  if (!state || n < 1 || n > state.n) return;
  const prevGroup = curGroup();
  state.page = n;
  el.pageLabel.textContent = `Page ${n} of ${state.n}`;
  el.prev.disabled = n === 1;
  el.next.disabled = n === state.n;

  const g = curGroup();
  const wrap = el.stageWrap;
  const pad = parseFloat(getComputedStyle(wrap).paddingLeft) * 2;
  const availW = wrap.clientWidth - pad;
  const availH = Math.max(320, window.innerHeight - 230);
  const fit = Math.min(availW / g.W, availH / g.H);
  const cssW = Math.floor(g.W * fit), cssH = Math.floor(g.H * fit);
  el.stage.style.width = `${cssW}px`;
  el.stage.style.height = `${cssH}px`;
  placeOverlay();
  if (g !== prevGroup) refreshPanel();

  const my = session;
  renderTask?.cancel();
  const page = await state.pdf.getPage(n);
  if (my !== session || state.page !== n) return;
  const dpr = window.devicePixelRatio || 1;
  const vp = page.getViewport({ scale: fit * dpr });
  // Render offscreen, then swap, so the preview doesn't flash white.
  const off = document.createElement('canvas');
  off.width = Math.round(vp.width);
  off.height = Math.round(vp.height);
  const ctx = off.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, off.width, off.height);
  renderTask = page.render({ canvasContext: ctx, viewport: vp });
  try { await renderTask.promise; } catch (e) { if (e?.name === 'RenderingCancelledException') return; throw e; }
  if (state?.page !== n) return;
  el.canvas.width = off.width;
  el.canvas.height = off.height;
  el.canvas.style.width = `${cssW}px`;
  el.canvas.style.height = `${cssH}px`;
  el.canvas.getContext('2d').drawImage(off, 0, 0);
}

function placeOverlay() {
  const g = curGroup();
  if (!g) return;
  setRect(el.crop, g.box);
  setRect(el.shade, g.box);
  const showC = el.showContent.checked && g.content;
  el.contentOutline.hidden = !showC;
  if (showC) setRect(el.contentOutline, g.content);
}

function setRect(node, b) {
  node.style.left = `${b.x0 * 100}%`;
  node.style.top = `${b.y0 * 100}%`;
  node.style.width = `${(b.x1 - b.x0) * 100}%`;
  node.style.height = `${(b.y1 - b.y0) * 100}%`;
}

/* ---------- dragging the crop box ---------- */

let drag = null;
el.crop.addEventListener('pointerdown', (e) => {
  const g = curGroup();
  if (!g) return;
  e.preventDefault();
  el.crop.setPointerCapture(e.pointerId);
  const r = el.stage.getBoundingClientRect();
  drag = { g, h: e.target.dataset.h || 'move', sx: e.clientX, sy: e.clientY, w: r.width, h0: r.height, start: { ...g.box } };
});
el.crop.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = (e.clientX - drag.sx) / drag.w, dy = (e.clientY - drag.sy) / drag.h0;
  const s = drag.start, b = { ...s }, MIN = 0.03;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  if (drag.h === 'move') {
    const bw = s.x1 - s.x0, bh = s.y1 - s.y0;
    b.x0 = clamp(s.x0 + dx, 0, 1 - bw); b.x1 = b.x0 + bw;
    b.y0 = clamp(s.y0 + dy, 0, 1 - bh); b.y1 = b.y0 + bh;
  } else {
    if (drag.h.includes('w')) b.x0 = clamp(s.x0 + dx, 0, s.x1 - MIN);
    if (drag.h.includes('e')) b.x1 = clamp(s.x1 + dx, s.x0 + MIN, 1);
    if (drag.h.includes('n')) b.y0 = clamp(s.y0 + dy, 0, s.y1 - MIN);
    if (drag.h.includes('s')) b.y1 = clamp(s.y1 + dy, s.y0 + MIN, 1);
  }
  drag.g.box = b;
  if (drag.g.mode !== 'custom') { drag.g.mode = 'custom'; }
  placeOverlay();
  refreshPanel();
});
const endDrag = () => { drag = null; };
el.crop.addEventListener('pointerup', endDrag);
el.crop.addEventListener('pointercancel', endDrag);

/* ---------- export ---------- */

el.download.addEventListener('click', exportPdf);

async function exportPdf() {
  if (!state) return;
  const my = session;
  el.download.disabled = true;
  el.error.hidden = true;
  try {
    el.saveText.textContent = 'Preparing…';
    await nextFrame();
    const { PDFDocument } = window.PDFLib;
    const doc = await PDFDocument.load(state.bytes, { updateMetadata: false });
    const pages = doc.getPages();
    for (let i = 1; i <= state.n; i++) {
      const g = state.groupOf[i];
      const vp = (await state.pdf.getPage(i)).getViewport({ scale: 1 });
      // convertToPdfPoint accounts for /Rotate and non-zero box origins.
      const [ax, ay] = vp.convertToPdfPoint(g.box.x0 * vp.width, g.box.y0 * vp.height);
      const [bx, by] = vp.convertToPdfPoint(g.box.x1 * vp.width, g.box.y1 * vp.height);
      const x = Math.min(ax, bx), y = Math.min(ay, by), w = Math.abs(bx - ax), h = Math.abs(by - ay);
      const p = pages[i - 1];
      p.setMediaBox(x, y, w, h);
      p.setCropBox(x, y, w, h);
      p.setBleedBox(x, y, w, h);
      p.setTrimBox(x, y, w, h);
      p.setArtBox(x, y, w, h);
      if (i % 25 === 0) { el.saveText.textContent = `Cropping page ${i} of ${state.n}…`; await nextFrame(); }
    }
    el.saveText.textContent = 'Writing file…';
    await nextFrame();
    const out = await doc.save({ useObjectStreams: false });
    if (my !== session) return;
    const name = state.file.name.replace(/\.pdf$/i, '') + '_cropped.pdf';
    const url = URL.createObjectURL(new Blob([out], { type: 'application/pdf' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    el.saveText.textContent = `Saved ${name} (${fmtBytes(out.length)}).`;
  } catch (err) {
    console.error(err);
    el.saveText.textContent = '';
    showError(/encrypt/i.test(err?.message || '')
      ? 'This PDF is encrypted, so it can’t be rewritten here.'
      : `Couldn't write the cropped PDF: ${err?.message || err}`);
  } finally {
    el.download.disabled = false;
  }
}

/* ---------- helpers ---------- */

function showError(msg) { el.error.textContent = msg; el.error.hidden = false; el.progress.hidden = true; }
const nextFrame = () => new Promise((r) => setTimeout(r, 0));
const fmtPt = (v) => (Math.round(v * 10) / 10).toString();
const fmtMm = (pt) => (Math.round((pt * 25.4 / 72) * 10) / 10).toString();
function fmtBytes(b) {
  if (b < 1e3) return `${b} B`;
  if (b < 1e6) return `${(b / 1e3).toFixed(0)} KB`;
  return `${(b / 1e6).toFixed(1)} MB`;
}
const article = (s) => (/^(a|e|i|o|u|8|11|18)/i.test(s) ? 'An' : 'A');
function fmtSheet(W, H) {
  const iso = [['A3', 842, 1191], ['A4', 595, 842], ['A5', 420, 595], ['Letter', 612, 792], ['Legal', 612, 1008]];
  const lo = Math.min(W, H), hi = Math.max(W, H);
  const hit = iso.find(([, a, b]) => Math.abs(a - lo) < 2 && Math.abs(b - hi) < 2);
  const orient = W > H ? 'landscape' : W < H ? 'portrait' : 'square';
  return hit ? `${hit[0]} ${orient}` : `${fmtMm(W)} × ${fmtMm(H)} mm`;
}
