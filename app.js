import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';
import {
  FULL, RATIOS, findContentBox, unionBoxes, detectPageBox, boxForRatio, padBox, ratiosFor, flipRatioId, nameRatio,
  pageClipRects, isPageLikeClip, clipPageBox,
} from './detect.js';
import { parseRange, formatRange } from './pages.js';
import { isLargeForDevice, isMemoryError } from './limits.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
const PDFJS_ASSETS = {
  cMapUrl: new URL('./vendor/pdfjs/cmaps/', import.meta.url).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('./vendor/pdfjs/standard_fonts/', import.meta.url).href,
};

const MAX_SAMPLES_PER_GROUP = 40;   // pages rendered for detection, per sheet size
const DETECT_PX = 1000;             // longest side of the detection render
const THUMB_W = 84, THUMB_MAX_H = 150;
const QUALITY = { 150: 72, 200: 78, 300: 85 }; // JPEG quality per resolution preset

const $ = (id) => document.getElementById(id);
const el = Object.fromEntries([
  'drop', 'file', 'pick', 'work', 'stageWrap', 'stage', 'canvas', 'crop', 'shade', 'contentOutline', 'excludedBadge',
  'prev', 'next', 'pageLabel', 'includePage', 'showContent',
  'selCount', 'range', 'rangeErr', 'selAll', 'selNone', 'resetOrder', 'thumbs',
  'fname', 'fmeta', 'progress', 'progressBar', 'progressText',
  'detectCard', 'confidence', 'detectText', 'groupSel',
  'boxCard', 'orientP', 'orientL', 'chips', 'rSize', 'rMm', 'rRatio',
  'exportCard', 'memWarn', 'compress', 'ppiField', 'ppi', 'compressHint', 'download', 'saveProgress', 'saveBar', 'saveText',
  'reset', 'error',
].map((id) => [id, $(id)]));

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
  thumbObserver?.disconnect();
  evictObserver?.disconnect();
  thumbQueue.length = 0;
  state?.pdf?.destroy();
  state = null;
  el.file.value = '';
  el.thumbs.replaceChildren();
  el.work.hidden = true;
  el.reset.hidden = true;
  el.drop.hidden = false;
}

async function open(file) {
  resetAll();
  const my = session;
  el.drop.hidden = true;
  el.work.hidden = false;
  el.reset.hidden = false;
  for (const k of ['detectCard', 'boxCard', 'exportCard', 'error', 'saveProgress']) el[k].hidden = true;
  el.fname.textContent = file.name;
  el.fmeta.textContent = `${fmtBytes(file.size)} · reading…`;
  el.saveText.textContent = '';

  try {
    // pdf.js takes ownership of this buffer (it moves to its worker). The
    // export re-reads the file instead of keeping a second copy in memory.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false, ...PDFJS_ASSETS }).promise;
    if (my !== session) return;
    state = { file, pdf, n: pdf.numPages, page: 1, groups: [], groupOf: [], selected: null, lastToggled: null, thumbs: [], order: [] };
    state.order = Array.from({ length: state.n }, (_, i) => i + 1);
    state.selected = new Uint8Array(state.n + 1).fill(1);
    await collectGroups(my);
    if (my !== session) return;
    const g0 = state.groups[0];
    el.fmeta.textContent = `${fmtBytes(file.size)} · ${state.n} page${state.n > 1 ? 's' : ''} · ${fmtSheet(g0.W, g0.H)}`;
    el.memWarn.hidden = !isLargeForDevice(file.size, {
      deviceMemory: navigator.deviceMemory, coarsePointer: matchMedia('(pointer: coarse)').matches,
    });
    buildThumbs();
    updateSelectionUI();
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
      g = {
        key, W: vp.width, H: vp.height, pages: [], content: null, clips: [], detected: null, box: { ...FULL }, mode: 'full',
        orient: vp.width > vp.height ? 'portrait' : 'landscape', done: false,
      };
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
    g.clips.push(await outermostPageClip(page));

    const last = k === plan.length - 1 || plan[k + 1][0] !== g;
    if (last) {
      g.detected = clipPageBox(g.clips, g.content, g.W, g.H) || detectPageBox(g.content, g.W, g.H);
      g.done = true;
      setMode(g, 'auto');
    }
  }
  canvas.width = canvas.height = 0;
  el.progress.hidden = true;
  el.exportCard.hidden = false;
  refreshPanel();
  warmWorker();
}

// The outermost rectangular clip on the page that could be the real page,
// as a normalised box (see clipPageBox), or null.
async function outermostPageClip(page) {
  const list = await page.getOperatorList();
  const vp = page.getViewport({ scale: 1 });
  for (const r of pageClipRects(list.fnArray, list.argsArray, pdfjsLib.OPS)) {
    const [ax, ay, bx, by] = vp.convertToViewportRectangle(r);
    const b = {
      x0: Math.min(ax, bx) / vp.width, y0: Math.min(ay, by) / vp.height,
      x1: Math.max(ax, bx) / vp.width, y1: Math.max(ay, by) / vp.height,
    };
    if (isPageLikeClip(b)) return b;
  }
  return null;
}

function samplePages(pages) {
  if (pages.length <= MAX_SAMPLES_PER_GROUP) return pages;
  const out = new Set();
  for (let i = 0; i < MAX_SAMPLES_PER_GROUP; i++) {
    out.add(pages[Math.round((i * (pages.length - 1)) / (MAX_SAMPLES_PER_GROUP - 1))]);
  }
  return [...out];
}

/* ---------- crop modes & orientation ---------- */

const ratioOrient = (id) => (!RATIOS.some((r) => r.id === id) || id === '1:1' ? null : id.endsWith('-l') ? 'landscape' : 'portrait');
const boxOrient = (g, b) => ((b.x1 - b.x0) * g.W > (b.y1 - b.y0) * g.H ? 'landscape' : 'portrait');

function setMode(g, mode) {
  g.mode = mode;
  if (mode === 'auto') { g.box = { ...g.detected.box }; g.orient = boxOrient(g, g.box); }
  else if (mode === 'full') g.box = { ...FULL };
  else if (mode === 'content') g.box = g.content ? padBox(g.content, 0.01) : { ...FULL };
  else if (mode !== 'custom') {
    const rt = RATIOS.find((r) => r.id === mode);
    if (rt) g.box = boxForRatio(rt.r, g.W, g.H);
  }
  boxChanged(g);
}

function setOrientation(g, o) {
  if (g.orient === o) return;
  g.orient = o;
  const ro = ratioOrient(g.mode);
  if (ro && ro !== o) setMode(g, flipRatioId(g.mode));
  else refreshPanel();
}
el.orientP.addEventListener('click', () => curGroup()?.done && setOrientation(curGroup(), 'portrait'));
el.orientL.addEventListener('click', () => curGroup()?.done && setOrientation(curGroup(), 'landscape'));

function boxChanged(g) {
  if (g === curGroup()) { placeOverlay(); refreshPanel(); }
  layoutThumbs(g);
}

function curGroup() { return state?.groupOf[state.page]; }

function refreshPanel() {
  const g = curGroup();
  if (!g || !g.done) return;
  el.detectCard.hidden = false;
  el.boxCard.hidden = false;

  const d = g.detected;
  el.confidence.className = `badge ${d.confidence}`;
  el.confidence.textContent = { exact: 'Exact', high: 'Confident' }[d.confidence] || 'Best guess';
  const sheet = fmtSheet(g.W, g.H);
  const dw = (d.box.x1 - d.box.x0) * g.W, dh = (d.box.y1 - d.box.y0) * g.H;
  if (d.reason === 'blank') el.detectText.textContent = 'These pages look blank, so there is nothing to detect.';
  else if (d.reason === 'fills-sheet') el.detectText.textContent = `The content already fills the ${sheet} sheet. It doesn't look letterboxed.`;
  else {
    const shape = d.ratio ? `${d.ratio.label} ${dw < dh ? 'portrait' : 'landscape'}` : `${fmtPt(dw)} × ${fmtPt(dh)} pt`;
    if (d.confidence === 'exact') {
      el.detectText.textContent = `${article(shape)} ${shape} page${d.centred ? ', centred' : ''} on the ${sheet} sheet. `
        + 'The PDF marks this outline itself, so it\'s exact.';
    } else {
      el.detectText.textContent = `${article(shape)} ${shape} page, centred on the ${sheet} sheet.` +
        (d.confidence === 'high' ? '' : ' Check the preview and adjust if needed.');
    }
  }

  el.groupSel.hidden = state.groups.length < 2;
  if (state.groups.length > 1) {
    el.groupSel.replaceChildren(...state.groups.map((gg) => {
      const b = chip(`${fmtPt(gg.W)}×${fmtPt(gg.H)} · ${gg.pages.length}p`, gg === g, () => showPage(gg.pages[0]));
      b.title = 'Pages of this sheet size share one crop box';
      return b;
    }));
  }

  el.orientP.setAttribute('aria-pressed', String(g.orient === 'portrait'));
  el.orientL.setAttribute('aria-pressed', String(g.orient === 'landscape'));

  const opts = [['auto', d.ratio ? `Auto (${d.ratio.label})` : 'Auto']];
  for (const rt of ratiosFor(g.orient)) opts.push([rt.id, rt.label]);
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

el.prev.addEventListener('click', () => stepPage(-1));
el.next.addEventListener('click', () => stepPage(1));
const stepPage = (d) => showPage(state.order[state.order.indexOf(state.page) + d]);
el.showContent.addEventListener('change', placeOverlay);
el.includePage.addEventListener('change', () => { setSelected(state.page, el.includePage.checked); });
document.addEventListener('keydown', (e) => {
  if (!state || el.work.hidden || e.target.closest('input, button, select')) return;
  if (e.key === 'ArrowLeft') stepPage(-1);
  if (e.key === 'ArrowRight') stepPage(1);
});
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => state && showPage(state.page), 120); });

async function showPage(n) {
  if (!state || n < 1 || n > state.n) return;
  const prevGroup = curGroup();
  const prevPage = state.page;
  state.page = n;
  updatePager();
  state.thumbs[prevPage]?.el.classList.remove('cur');
  state.thumbs[n]?.el.classList.add('cur');
  updateCurrentInclusion();

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

let drag = null, dragFrame = 0;
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
  const g = drag.g;
  g.box = b;
  g.mode = 'custom';
  g.orient = boxOrient(g, b);
  placeOverlay();
  refreshPanel();
  cancelAnimationFrame(dragFrame);
  dragFrame = requestAnimationFrame(() => layoutThumbs(g));
});
const endDrag = () => { drag = null; };
el.crop.addEventListener('pointerup', endDrag);
el.crop.addEventListener('pointercancel', endDrag);

/* ---------- thumbnails ---------- */

let thumbObserver = null, evictObserver = null;
const thumbQueue = [];
let thumbBusy = false;

function buildThumbs() {
  thumbObserver?.disconnect();
  evictObserver?.disconnect();
  // Free thumbnails scrolled far out of view (long documents would
  // otherwise keep a bitmap per page) and redraw them when they return.
  evictObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) continue;
      const t = state.thumbs[Number(e.target.closest('.thumb').dataset.p)];
      if (!t.rendered) continue;
      t.canvas.width = t.canvas.height = 0;
      t.rendered = false;
      thumbObserver.observe(t.clip);
    }
  }, { root: el.thumbs, rootMargin: '1500px' });
  thumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      thumbObserver.unobserve(e.target);
      thumbQueue.push(Number(e.target.closest('.thumb').dataset.p));
    }
    pumpThumbs();
  }, { root: el.thumbs, rootMargin: '200px' });

  const frag = document.createDocumentFragment();
  for (let p = 1; p <= state.n; p++) {
    const t = document.createElement('div');
    t.className = 'thumb';
    t.dataset.p = p;
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: true });
    cb.setAttribute('aria-label', `Export page ${p}`);
    const frame = document.createElement('div');
    frame.className = 'tframe';
    const clip = document.createElement('div');
    clip.className = 'tclip';
    clip.title = `Preview page ${p}`;
    const canvas = document.createElement('canvas');
    clip.append(canvas);
    frame.append(clip);
    const bar = document.createElement('div');
    bar.className = 'tbar';
    const handle = Object.assign(document.createElement('button'), { type: 'button', className: 'tdrag', textContent: '⠿' });
    handle.setAttribute('aria-label', `Move page ${p}: drag, or use the arrow keys`);
    handle.title = 'Drag to reorder';
    const num = Object.assign(document.createElement('span'), { className: 'tnum', textContent: p });
    bar.append(handle, num);
    t.append(cb, frame, bar);
    frag.append(t);
    state.thumbs[p] = { el: t, cb, clip, canvas, rendered: false };
  }
  el.thumbs.replaceChildren(frag);
  for (const g of state.groups) layoutThumbs(g);
  for (let p = 1; p <= state.n; p++) {
    thumbObserver.observe(state.thumbs[p].clip);
    evictObserver.observe(state.thumbs[p].clip);
  }
}

// Size each tile to the crop box and slide the full-sheet render inside it.
function layoutThumbs(g) {
  if (!state?.thumbs.length) return;
  const b = g.box;
  const bw = (b.x1 - b.x0) * g.W, bh = (b.y1 - b.y0) * g.H;
  let w = THUMB_W, h = (THUMB_W * bh) / bw;
  if (h > THUMB_MAX_H) { w = (w * THUMB_MAX_H) / h; h = THUMB_MAX_H; }
  const cw = w / (b.x1 - b.x0), ch = (cw * g.H) / g.W;
  for (const p of g.pages) {
    const t = state.thumbs[p];
    Object.assign(t.clip.style, { width: `${w}px`, height: `${h}px` });
    Object.assign(t.clip.parentElement.style, { width: `${w}px`, height: `${h}px` });
    Object.assign(t.canvas.style, { width: `${cw}px`, height: `${ch}px`, left: `${-b.x0 * cw}px`, top: `${-b.y0 * ch}px` });
  }
}

async function pumpThumbs() {
  if (thumbBusy) return;
  thumbBusy = true;
  const my = session;
  try {
    while (thumbQueue.length && my === session) {
      const p = thumbQueue.shift();
      const g = state.groupOf[p], t = state.thumbs[p];
      if (t.rendered) continue;
      const page = await state.pdf.getPage(p);
      if (my !== session) return;
      // Enough pixels for the tile even if the crop box later narrows a bit.
      const scale = ((THUMB_W * 2.5) / g.W) * Math.min(2, window.devicePixelRatio || 1);
      const vp = page.getViewport({ scale });
      t.canvas.width = Math.round(vp.width);
      t.canvas.height = Math.round(vp.height);
      const ctx = t.canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, t.canvas.width, t.canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise.catch(() => {});
      t.rendered = true;
    }
  } finally {
    thumbBusy = false;
  }
}

/* ---------- reordering pages ---------- */

// Drag the handle under a thumbnail (any pointer), or the thumbnail itself
// with a mouse. Tiles move live as you drag; the order is read back from
// the grid when you let go. The handle also responds to arrow keys.
let reorder = null, justDragged = false;

el.thumbs.addEventListener('pointerdown', (e) => {
  const tile = e.target.closest('.thumb');
  const handle = e.target.closest('.tdrag');
  if (!tile || e.button > 0) return;
  if (!handle && !(e.pointerType === 'mouse' && e.target.closest('.tclip'))) return;
  reorder = { tile, id: e.pointerId, x: e.clientX, y: e.clientY, started: false };
  e.target.setPointerCapture(e.pointerId);
});
el.thumbs.addEventListener('pointermove', (e) => {
  if (!reorder || e.pointerId !== reorder.id) return;
  if (!reorder.started) {
    if (Math.hypot(e.clientX - reorder.x, e.clientY - reorder.y) < 6) return;
    reorder.started = true;
    reorder.tile.classList.add('dragging');
  }
  const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.thumb');
  if (over && over !== reorder.tile && el.thumbs.contains(over)) {
    const r = over.getBoundingClientRect();
    over[e.clientX > r.left + r.width / 2 ? 'after' : 'before'](reorder.tile);
  }
  const box = el.thumbs.getBoundingClientRect();
  if (e.clientY < box.top + 40) el.thumbs.scrollTop -= 16;
  else if (e.clientY > box.bottom - 40) el.thumbs.scrollTop += 16;
});
const endReorder = (e) => {
  if (!reorder || e.pointerId !== reorder.id) return;
  if (reorder.started) {
    reorder.tile.classList.remove('dragging');
    readOrderFromGrid();
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 0); // swallow the click that follows
  }
  reorder = null;
};
el.thumbs.addEventListener('pointerup', endReorder);
el.thumbs.addEventListener('pointercancel', endReorder);

el.thumbs.addEventListener('keydown', (e) => {
  const handle = e.target.closest('.tdrag');
  if (!handle) return;
  const d = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
  if (!d) return;
  e.preventDefault();
  const tile = handle.closest('.thumb');
  const sib = d < 0 ? tile.previousElementSibling : tile.nextElementSibling;
  if (!sib) return;
  sib[d < 0 ? 'before' : 'after'](tile);
  handle.focus();
  readOrderFromGrid();
});

el.resetOrder.addEventListener('click', () => {
  state.order = Array.from({ length: state.n }, (_, i) => i + 1);
  el.thumbs.append(...state.order.map((p) => state.thumbs[p].el));
  orderChanged();
});

function readOrderFromGrid() {
  state.order = [...el.thumbs.children].map((t) => Number(t.dataset.p));
  orderChanged();
}

function orderChanged() {
  el.resetOrder.hidden = state.order.every((p, i) => p === i + 1);
  updatePager();
}

function updatePager() {
  const i = state.order.indexOf(state.page);
  const moved = i + 1 !== state.page;
  el.pageLabel.textContent = `Page ${state.page} of ${state.n}${moved ? ` · now ${i + 1}${ordinal(i + 1)}` : ''}`;
  el.prev.disabled = i === 0;
  el.next.disabled = i === state.n - 1;
}

const ordinal = (n) => (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');

/* ---------- page selection ---------- */

el.thumbs.addEventListener('click', (e) => {
  const t = e.target.closest('.thumb');
  if (!t || justDragged) return;
  const p = Number(t.dataset.p);
  if (e.target.matches('input[type=checkbox]')) {
    const v = e.target.checked;
    if (e.shiftKey && state.lastToggled) {
      // A range in the order the pages are shown, which may differ after reordering.
      const i0 = state.order.indexOf(p), i1 = state.order.indexOf(state.lastToggled);
      for (let i = Math.min(i0, i1); i <= Math.max(i0, i1); i++) state.selected[state.order[i]] = v ? 1 : 0;
    } else {
      state.selected[p] = v ? 1 : 0;
    }
    state.lastToggled = p;
    updateSelectionUI();
  } else if (e.target.closest('.tclip')) {
    showPage(p);
  }
});
el.selAll.addEventListener('click', () => { state.selected.fill(1); updateSelectionUI(); });
el.selNone.addEventListener('click', () => { state.selected.fill(0); updateSelectionUI(); });
el.range.addEventListener('input', () => { el.range.classList.remove('bad'); el.rangeErr.hidden = true; });
el.range.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.range.blur(); });
el.range.addEventListener('change', () => {
  try {
    const pages = parseRange(el.range.value, state.n);
    state.selected.fill(0);
    for (const p of pages) state.selected[p] = 1;
    updateSelectionUI();
  } catch (err) {
    el.range.classList.add('bad');
    el.rangeErr.textContent = err.message;
    el.rangeErr.hidden = false;
  }
});

function setSelected(p, v) {
  state.selected[p] = v ? 1 : 0;
  state.lastToggled = p;
  updateSelectionUI();
}

function selectedPages() {
  const out = [];
  for (let p = 1; p <= state.n; p++) if (state.selected[p]) out.push(p);
  return out;
}

function updateSelectionUI() {
  const pages = selectedPages();
  el.selCount.textContent = `${pages.length} of ${state.n} selected`;
  if (document.activeElement !== el.range) el.range.value = pages.length === state.n ? '' : formatRange(pages);
  el.range.placeholder = pages.length === state.n ? `All (1-${state.n})` : 'e.g. 1-5, 8, 10-12';
  for (let p = 1; p <= state.n; p++) {
    const t = state.thumbs[p];
    if (!t) continue;
    const on = !!state.selected[p];
    t.cb.checked = on;
    t.el.classList.toggle('off', !on);
  }
  updateCurrentInclusion();
  el.download.disabled = pages.length === 0;
  el.download.textContent = pages.length === 0 ? 'Select at least one page'
    : `Download PDF · ${pages.length} page${pages.length > 1 ? 's' : ''}`;
}

function updateCurrentInclusion() {
  const on = !!state.selected[state.page];
  el.includePage.checked = on;
  el.excludedBadge.hidden = on;
  el.stage.classList.toggle('excluded', !on);
}

/* ---------- export (in a worker, via mupdf) ---------- */

el.download.addEventListener('click', exportPdf);
el.compress.addEventListener('change', () => {
  el.ppiField.hidden = !el.compress.checked;
  el.compressHint.textContent = el.compress.checked
    ? 'Shrinks photos to the chosen resolution and saves them as JPEG. Text and vector graphics aren\'t touched.'
    : 'Images are kept as they are. Skipped pages and their images are still removed.';
});

let worker = null, workerReady = null;
const pending = new Map();
let jobId = 0;

function warmWorker() {
  if (worker) return workerReady;
  const w = new Worker(new URL('./export-worker.js', import.meta.url), { type: 'module' });
  worker = w;
  workerReady = new Promise((resolve, reject) => {
    w.addEventListener('message', (e) => {
      const m = e.data;
      if (m.type === 'ready') return resolve();
      const job = pending.get(m.id);
      if (!job) return;
      if (m.type === 'progress') job.onProgress(m);
      else { pending.delete(m.id); m.type === 'done' ? job.resolve(m) : job.reject(Object.assign(new Error(m.message), { memory: m.memory })); }
    });
    w.addEventListener('error', (e) => {
      const err = Object.assign(
        new Error(e.message || 'The PDF engine stopped unexpectedly. Try again, or export fewer pages at a time.'),
        { memory: isMemoryError(e.message) },
      );
      reject(err);
      for (const job of pending.values()) job.reject(err);
      pending.clear();
      if (worker === w) { worker = null; workerReady = null; }
    });
  });
  workerReady.catch(() => {});
  return workerReady;
}

function retireWorker() {
  // A fresh worker per export hands the wasm heap back to the browser.
  worker?.terminate();
  worker = null;
  workerReady = null;
}

async function exportPdf() {
  if (!state) return;
  const my = session;
  const pages = selectedPages();
  if (!pages.length) return;
  el.download.disabled = true;
  el.error.hidden = true;
  el.saveProgress.hidden = true;
  const say = (t) => { el.saveText.textContent = t; };

  try {
    // Page boxes in PDF user space. convertToPdfPoint handles /Rotate and
    // boxes that don't start at 0,0.
    const boxes = [];
    for (let i = 1; i <= state.n; i++) {
      const b = state.groupOf[i].box;
      if (!state.selected[i] || (b.x0 === 0 && b.y0 === 0 && b.x1 === 1 && b.y1 === 1)) { boxes.push(null); continue; }
      const vp = (await state.pdf.getPage(i)).getViewport({ scale: 1 });
      const [ax, ay] = vp.convertToPdfPoint(b.x0 * vp.width, b.y0 * vp.height);
      const [bx, by] = vp.convertToPdfPoint(b.x1 * vp.width, b.y1 * vp.height);
      boxes.push([Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)].map((v) => Math.round(v * 1000) / 1000));
    }
    const ppi = Number(el.ppi.value);
    const compress = el.compress.checked ? { ppi, quality: QUALITY[ppi] ?? 78 } : null;

    say('Loading the PDF engine…');
    await warmWorker();
    if (my !== session) return;
    const id = ++jobId;
    const data = new Uint8Array(await state.file.arrayBuffer());
    const result = await new Promise((resolve, reject) => {
      pending.set(id, {
        resolve, reject,
        onProgress: (m) => {
          if (my !== session) return;
          if (m.phase === 'images' && m.total) {
            el.saveProgress.hidden = false;
            el.saveBar.style.width = `${(m.done / m.total) * 100}%`;
            say(`Compressing images… ${m.done} / ${m.total}`);
          } else {
            say({ open: 'Opening the PDF…', pages: 'Removing skipped pages…', scan: 'Finding images…', save: 'Writing the file…' }[m.phase] || 'Working…');
          }
        },
      });
      // Transferred, not copied: the worker owns the only copy from here on.
      worker.postMessage({ id, bytes: data, opts: { boxes, keep: state.order.filter((p) => state.selected[p]).map((p) => p - 1), compress } }, [data.buffer]);
    });
    retireWorker();
    if (my !== session) return;

    const base = state.file.name.replace(/\.pdf$/i, '');
    const name = `${base}${compress ? `_${ppi}ppi` : '_cropped'}.pdf`;
    const url = URL.createObjectURL(new Blob([result.bytes], { type: 'application/pdf' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    el.saveProgress.hidden = true;
    const before = state.file.size, after = result.bytes.length;
    const line = document.createElement('div');
    line.className = 'result';
    line.append(`Saved ${name}: ${fmtBytes(before)} → `);
    const strong = document.createElement('strong');
    strong.textContent = fmtBytes(after);
    line.append(strong, after < before ? ` (${Math.min(99, Math.floor((1 - after / before) * 100))}% smaller)` : '');
    el.saveText.replaceChildren(line);
  } catch (err) {
    console.error(err);
    retireWorker();
    el.saveProgress.hidden = true;
    say('');
    showError(err?.memory || isMemoryError(err)
      ? 'This device ran out of memory while exporting. Try fewer pages at a time, a lower image resolution, or a computer.'
      : /encrypt|password/i.test(err?.message || '')
        ? 'This PDF is encrypted, so it can’t be rewritten here.'
        : `Couldn't write the PDF: ${err?.message || err}`);
  } finally {
    if (state) el.download.disabled = selectedPages().length === 0;
  }
}

/* ---------- offline support ---------- */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('offline support unavailable', err));
  });
}

/* ---------- opening PDFs from outside the page ---------- */

// "Open with" on an installed app (File Handling API).
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async ({ files }) => {
    if (files?.length) open(await files[0].getFile());
  });
}

// Shared from another app (Web Share Target): the service worker parks the
// file in a cache and redirects here with ?shared=1.
async function openShared() {
  if (!new URLSearchParams(location.search).has('shared') || !('caches' in window)) return;
  history.replaceState(null, '', location.pathname);
  const cache = await caches.open('pared-share');
  const res = await cache.match('shared.pdf');
  if (!res) return;
  const name = decodeURIComponent(res.headers.get('x-filename') || 'shared.pdf');
  const blob = await res.blob();
  await cache.delete('shared.pdf');
  open(new File([blob], name, { type: 'application/pdf' }));
}
openShared();

/* ---------- helpers ---------- */

function showError(msg) { el.error.textContent = msg; el.error.hidden = false; el.progress.hidden = true; }
const fmtPt = (v) => (Math.round(v * 10) / 10).toString();
const fmtMm = (pt) => (Math.round((pt * 25.4 / 72) * 10) / 10).toString();
const article = (s) => (/^(a|e|i|o|u|8|11|18)/i.test(s) ? 'An' : 'A');
function fmtBytes(b) {
  if (b < 1e3) return `${b} B`;
  if (b < 1e6) return `${(b / 1e3).toFixed(0)} KB`;
  return `${(b / 1e6).toFixed(1)} MB`;
}
function fmtSheet(W, H) {
  const iso = [['A3', 842, 1191], ['A4', 595, 842], ['A5', 420, 595], ['Letter', 612, 792], ['Legal', 612, 1008]];
  const lo = Math.min(W, H), hi = Math.max(W, H);
  const hit = iso.find(([, a, b]) => Math.abs(a - lo) < 2 && Math.abs(b - hi) < 2);
  const orient = W > H ? 'landscape' : W < H ? 'portrait' : 'square';
  return hit ? `${hit[0]} ${orient}` : `${fmtMm(W)} × ${fmtMm(H)} mm`;
}
