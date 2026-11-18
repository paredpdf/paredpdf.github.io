import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';
import {
  FULL, RATIOS, findContentBox, unionBoxes, detectPageBox, boxForRatio, padBox, ratiosFor, flipRatioId, nameRatio,
  pageClipRects, isPageLikeClip, clipPageBox,
} from './detect.js';
import { parseRange, formatRange } from './pages.js';
import { isLargeForDevice, isMemoryError } from './limits.js';
import { t, ltr, isRtl, lang, locale, setLang, pickLang } from './i18n.js';
import { INKS, fontsFor, createPad, imageToSignature, typedSignature, loadFont, fontCss, signaturePng, signaturePreview } from './sign.js';

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
  'drop', 'file', 'pick', 'work', 'stageWrap', 'stage', 'canvas', 'crop', 'shade', 'contentOutline', 'excludedBadge', 'rotBadge',
  'prev', 'next', 'pageLabel', 'includePage', 'showContent',
  'selCount', 'range', 'rangeErr', 'selAll', 'selNone', 'resetOrder', 'thumbs',
  'fname', 'fmeta', 'progress', 'progressBar', 'progressText',
  'detectCard', 'confidence', 'detectText', 'groupSel',
  'boxCard', 'scopeAll', 'scopePage', 'scopeHint', 'orientP', 'orientL', 'chips', 'rSize', 'rMm', 'rRatio',
  'exportCard', 'memWarn', 'sigWarn', 'compress', 'ppiField', 'ppi', 'compressHint', 'estimate', 'download', 'saveProgress', 'saveBar', 'saveText',
  'reset', 'error', 'lang', 'version', 'versionLink',
  'signCard', 'addSign', 'signHint', 'signDlg', 'tabDraw', 'tabType', 'tabUpload', 'paneDraw', 'paneType', 'paneUpload', 'pad', 'sigFile', 'sigPick', 'sigImg',
  'sigName', 'fontChips',
  'sigErr', 'sigClear', 'sigCancel', 'sigUse',
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
  cancelEstimate();
  estimate = null;
  showEstimate();
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
  for (const k of ['detectCard', 'boxCard', 'signCard', 'exportCard', 'error', 'saveProgress']) el[k].hidden = true;
  el.fname.textContent = file.name;
  el.fmeta.textContent = t('file.reading', { size: fmtBytes(file.size) });
  el.saveText.textContent = '';

  try {
    // pdf.js takes ownership of this buffer (it moves to its worker). The
    // export re-reads the file instead of keeping a second copy in memory.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false, ...PDFJS_ASSETS }).promise;
    if (my !== session) return;
    state = { file, pdf, n: pdf.numPages, page: 1, groups: [], groupOf: [], selected: null, lastToggled: null, thumbs: [], order: [] };
    state.order = Array.from({ length: state.n }, (_, i) => i + 1);
    state.rot = new Int16Array(state.n + 1); // extra clockwise rotation per page
    state.override = new Map(); // page -> its own crop (see cropOf)
    state.signs = []; // { page, sig, box } signatures placed on pages
    state.selected = new Uint8Array(state.n + 1).fill(1);
    await collectGroups(my);
    if (my !== session) return;
    const g0 = state.groups[0];
    showFileMeta();
    state.large = isLargeForDevice(file.size, {
      deviceMemory: navigator.deviceMemory, coarsePointer: matchMedia('(pointer: coarse)').matches,
    });
    el.memWarn.hidden = !state.large;
    buildThumbs();
    updateSelectionUI();
    showPage(1);
    await analyse(my);
  } catch (err) {
    if (my !== session) return;
    console.error(err);
    showError(err?.name === 'PasswordException' ? t('err.password') : t('err.read', { msg: err?.message || err }));
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
      g.sheet = g; // see cropOf
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
    el.progressText.textContent = t('progress.analyse', { k: k + 1, n: plan.length });
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
  el.signCard.hidden = false;
  refreshPanel();
  warmWorker();
  scheduleEstimate(0);
  checkSignatures(my);
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

// A page's crop: its own if it has one, otherwise the crop shared by every
// page of its sheet size (its group). Both carry box, mode and orient, plus
// `sheet`, the group with the sheet size and detection results.
function cropOf(p) { return state.override.get(p) ?? state.groupOf[p]; }
function curCrop() { return state && cropOf(state.page); }

function setMode(c, mode) {
  const g = c.sheet;
  c.mode = mode;
  if (mode === 'auto') { c.box = { ...g.detected.box }; c.orient = boxOrient(g, c.box); }
  else if (mode === 'full') c.box = { ...FULL };
  else if (mode === 'content') c.box = g.content ? padBox(g.content, 0.01) : { ...FULL };
  else if (mode !== 'custom') {
    const rt = RATIOS.find((r) => r.id === mode);
    if (rt) c.box = boxForRatio(rt.r, g.W, g.H);
  }
  boxChanged(c);
}

function setOrientation(g, o) {
  if (g.orient === o) return;
  g.orient = o;
  const ro = ratioOrient(g.mode);
  if (ro && ro !== o) setMode(g, flipRatioId(g.mode));
  else refreshPanel();
}
el.orientP.addEventListener('click', () => curGroup()?.done && setOrientation(curCrop(), 'portrait'));
el.orientL.addEventListener('click', () => curGroup()?.done && setOrientation(curCrop(), 'landscape'));

el.scopeAll.addEventListener('click', () => {
  if (state.override.delete(state.page)) boxChanged(curGroup());
});
el.scopePage.addEventListener('click', () => {
  if (state.override.has(state.page)) return;
  const g = curGroup();
  state.override.set(state.page, { box: { ...g.box }, mode: g.mode, orient: g.orient, sheet: g });
  boxChanged(curCrop());
});

function boxChanged(c) {
  if (c === curCrop()) { placeOverlay(); refreshPanel(); }
  layoutThumbs(c.sheet);
}

function curGroup() { return state?.groupOf[state.page]; }

function refreshPanel() {
  const g = curGroup();
  if (!g || !g.done) return;
  const c = curCrop();
  el.detectCard.hidden = false;
  el.boxCard.hidden = false;

  const d = g.detected;
  el.confidence.className = `badge ${d.confidence}`;
  el.confidence.textContent = t({ exact: 'detect.exact', high: 'detect.high' }[d.confidence] || 'detect.guess');
  const sheet = fmtSheet(g.W, g.H);
  const dw = (d.box.x1 - d.box.x0) * g.W, dh = (d.box.y1 - d.box.y0) * g.H;
  if (d.reason === 'blank') el.detectText.textContent = t('detect.blank');
  else if (d.reason === 'fills-sheet') el.detectText.textContent = t('detect.fills', { sheet });
  else {
    const shape = d.ratio
      ? t('detect.shape', { label: ltr(d.ratio.label), orient: t(dw < dh ? 'sheet.portrait' : 'sheet.landscape') })
      : ltr(`${fmtPt(dw)} × ${fmtPt(dh)} pt`);
    el.detectText.textContent = t('detect.found', {
      shape, sheet, centred: d.centred, exact: d.confidence === 'exact', sure: d.confidence === 'high',
    });
  }

  el.groupSel.hidden = state.groups.length < 2;
  if (state.groups.length > 1) {
    el.groupSel.replaceChildren(...state.groups.map((gg) => {
      const b = chip(t('detect.groupChip', { size: ltr(`${fmtPt(gg.W)}×${fmtPt(gg.H)}`), n: gg.pages.length }), gg === g, () => showPage(gg.pages[0]));
      b.title = t('detect.groupTitle');
      return b;
    }));
  }

  const own = state.override.has(state.page);
  el.scopeAll.setAttribute('aria-pressed', String(!own));
  el.scopePage.setAttribute('aria-pressed', String(own));
  el.scopeAll.textContent = t(state.groups.length > 1 ? 'box.scopeSize' : 'box.scopeAll');
  const owners = g.pages.filter((p) => state.override.has(p)).length;
  el.scopeHint.hidden = !owners;
  el.scopeHint.textContent = own ? t('box.ownHint', { p: state.page }) : t('box.othersHint', { n: owners });

  el.orientP.setAttribute('aria-pressed', String(c.orient === 'portrait'));
  el.orientL.setAttribute('aria-pressed', String(c.orient === 'landscape'));

  const opts = [['auto', d.ratio ? t('box.autoWith', { label: ltr(d.ratio.label) }) : t('box.auto')]];
  for (const rt of ratiosFor(c.orient)) opts.push([rt.id, rt.label]);
  opts.push(['content', t('box.fitContent')], ['full', t('box.wholeSheet')]);
  if (c.mode === 'custom') opts.push(['custom', t('box.custom')]);
  el.chips.replaceChildren(...opts.map(([id, label]) => chip(label, c.mode === id, () => setMode(c, id))));

  const w = (c.box.x1 - c.box.x0) * g.W, h = (c.box.y1 - c.box.y0) * g.H;
  el.rSize.textContent = ltr(`${fmtPt(w)} × ${fmtPt(h)} pt`);
  el.rMm.textContent = ltr(`${fmtMm(w)} × ${fmtMm(h)} mm`);
  const named = nameRatio(w, h);
  el.rRatio.textContent = `${t(w < h ? 'box.portrait' : w > h ? 'box.landscape' : 'box.square')}${named ? ` · ${ltr(named)}` : ''} · ${ltr((w / h).toFixed(3))}`;
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
  if (!state || el.work.hidden || el.signDlg.open || e.target.closest('input, button, select, .sig')) return;
  // Pages run right to left in Hebrew, so the left arrow goes forward there.
  const fwd = isRtl() ? 'ArrowLeft' : 'ArrowRight', back = isRtl() ? 'ArrowRight' : 'ArrowLeft';
  if (e.key === back) stepPage(-1);
  if (e.key === fwd) stepPage(1);
});
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => state && showPage(state.page), 120); });

async function showPage(n) {
  if (!state || n < 1 || n > state.n) return;
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
  renderSigns();
  refreshPanel(); // the new page may have its own crop

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
  setRect(el.crop, curCrop().box);
  setRect(el.shade, curCrop().box);
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
  const c = curCrop();
  if (!c) return;
  e.preventDefault();
  el.crop.setPointerCapture(e.pointerId);
  const r = el.stage.getBoundingClientRect();
  drag = { c, h: e.target.dataset.h || 'move', sx: e.clientX, sy: e.clientY, w: r.width, h0: r.height, start: { ...c.box } };
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
  const c = drag.c;
  c.box = b;
  c.mode = 'custom';
  c.orient = boxOrient(c.sheet, b);
  placeOverlay();
  refreshPanel();
  cancelAnimationFrame(dragFrame);
  dragFrame = requestAnimationFrame(() => layoutThumbs(c.sheet));
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
    const frame = document.createElement('div');
    frame.className = 'tframe';
    const clip = document.createElement('div');
    clip.className = 'tclip';
    const canvas = document.createElement('canvas');
    clip.append(canvas);
    frame.append(clip);
    const bar = document.createElement('div');
    bar.className = 'tbar';
    const handle = Object.assign(document.createElement('button'), { type: 'button', className: 'tdrag', textContent: '⠿' });
    const num = Object.assign(document.createElement('span'), { className: 'tnum', textContent: p });
    const rotate = Object.assign(document.createElement('button'), { type: 'button', className: 'trot', textContent: '↻' });
    bar.append(handle, num, rotate);
    t.append(cb, frame, bar);
    frag.append(t);
    state.thumbs[p] = { el: t, cb, clip, canvas, handle, rotate, rendered: false };
  }
  el.thumbs.replaceChildren(frag);
  labelThumbs();
  for (const g of state.groups) layoutThumbs(g);
  for (let p = 1; p <= state.n; p++) {
    thumbObserver.observe(state.thumbs[p].clip);
    evictObserver.observe(state.thumbs[p].clip);
  }
}

// Size each tile to the crop box and slide the full-sheet render inside it.
function layoutThumbs(g) {
  if (!state?.thumbs.length) return;
  for (const p of g.pages) {
    const b = cropOf(p).box;
    const bw = (b.x1 - b.x0) * g.W, bh = (b.y1 - b.y0) * g.H;
    let w = THUMB_W, h = (THUMB_W * bh) / bw;
    if (h > THUMB_MAX_H) { w = (w * THUMB_MAX_H) / h; h = THUMB_MAX_H; }
    const cw = w / (b.x1 - b.x0), ch = (cw * g.H) / g.W;
    const t = state.thumbs[p];
    t.el.classList.toggle('own', state.override.has(p));
    Object.assign(t.clip.style, { width: `${w}px`, height: `${h}px` });
    Object.assign(t.clip.parentElement.style, { width: `${w}px`, height: `${h}px` });
    // Show the page turned, scaled to fit the same footprint when on its side.
    const deg = state.rot[p];
    t.clip.style.transform = deg ? `rotate(${deg}deg)${deg % 180 ? ` scale(${Math.min(w / h, h / w)})` : ''}` : '';
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
    const pastMiddle = e.clientX > r.left + r.width / 2;
    over[pastMiddle !== isRtl() ? 'after' : 'before'](reorder.tile);
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
  const d = { ArrowLeft: isRtl() ? 1 : -1, ArrowUp: -1, ArrowRight: isRtl() ? -1 : 1, ArrowDown: 1 }[e.key];
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
  el.pageLabel.textContent = t('pager.label', { page: state.page, n: state.n, pos: moved ? i + 1 : 0 });
  el.prev.disabled = i === 0;
  el.next.disabled = i === state.n - 1;
}


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
  } else if (e.target.closest('.trot')) {
    state.rot[p] = (state.rot[p] + 90) % 360;
    layoutThumbs(state.groupOf[p]);
    updateCurrentInclusion();
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
    el.rangeErr.textContent = err.code ? t(`range.${err.code}`, err.params) : err.message;
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
  el.selCount.textContent = t('pages.selected', { k: pages.length, n: state.n });
  if (document.activeElement !== el.range) el.range.value = pages.length === state.n ? '' : formatRange(pages);
  el.range.placeholder = pages.length === state.n ? t('pages.rangeAll', { n: state.n }) : t('pages.rangeEg');
  for (let p = 1; p <= state.n; p++) {
    const t = state.thumbs[p];
    if (!t) continue;
    const on = !!state.selected[p];
    t.cb.checked = on;
    t.el.classList.toggle('off', !on);
  }
  updateCurrentInclusion();
  el.download.disabled = pages.length === 0;
  scheduleEstimate();
  el.download.textContent = pages.length === 0 ? t('export.selectOne') : t('export.downloadN', { n: pages.length });
}

function updateCurrentInclusion() {
  const on = !!state.selected[state.page];
  el.includePage.checked = on;
  el.excludedBadge.hidden = on;
  const deg = state.rot[state.page];
  el.rotBadge.hidden = !on || !deg;
  el.rotBadge.textContent = t('stage.turned', { deg });
  el.stage.classList.toggle('excluded', !on);
}

/* ---------- signatures ---------- */

let pad = null, dlgMode = 'draw', ink = 'black', uploaded = null, uploadedBlob = null, typedFont = null;

el.addSign.addEventListener('click', openSignDialog);

function openSignDialog() {
  el.signDlg.showModal();
  pad ??= createPad(el.pad, { onChange: updateSignButtons });
  pad.setColor(INKS[ink]);
  setDlgMode(dlgMode);
}

function setDlgMode(mode) {
  dlgMode = mode;
  for (const [m, tab, pane] of [['draw', el.tabDraw, el.paneDraw], ['type', el.tabType, el.paneType], ['upload', el.tabUpload, el.paneUpload]]) {
    tab.setAttribute('aria-pressed', String(mode === m));
    pane.hidden = mode !== m;
  }
  if (mode === 'type') { renderFontChips(); el.sigName.focus(); }
  el.sigErr.hidden = true;
  if (mode === 'draw') pad.redraw(); // the canvas has its size only once shown
  updateSignButtons();
}

function updateSignButtons() {
  const empty = dlgMode === 'draw' ? pad.isEmpty() : dlgMode === 'type' ? !el.sigName.value.trim() : !uploaded;
  el.sigUse.disabled = empty;
  el.sigClear.disabled = empty;
}

el.tabDraw.addEventListener('click', () => setDlgMode('draw'));
el.tabType.addEventListener('click', () => setDlgMode('type'));
el.tabUpload.addEventListener('click', () => setDlgMode('upload'));
el.sigName.addEventListener('input', () => { renderFontChips(); updateSignButtons(); });
el.sigName.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !el.sigUse.disabled) { e.preventDefault(); el.sigUse.click(); } });

// One button per style, each showing the name (or a sample) in that font.
function renderFontChips() {
  const text = el.sigName.value.trim() || t('sign.namePh');
  const fonts = fontsFor(text);
  typedFont ??= { he: 'gveret', ar: 'ruqaa' }[lang()] ?? 'dancing';
  if (!fonts.some((f) => f.id === typedFont)) typedFont = fonts[0].id;
  el.fontChips.replaceChildren(...fonts.map((f) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'fontchip', textContent: text });
    b.style.font = fontCss(f.id, 26);
    b.style.color = INKS[ink];
    b.dir = 'auto';
    b.title = f.name;
    b.setAttribute('aria-label', `${text}, ${f.name}`); // starts with what's shown, then the style
    b.setAttribute('aria-pressed', String(f.id === typedFont));
    b.addEventListener('click', () => { typedFont = f.id; renderFontChips(); });
    loadFont(f.id, text).catch(() => {});
    return b;
  }));
}
for (const sw of el.signDlg.querySelectorAll('.swatch')) {
  sw.addEventListener('click', async () => {
    ink = sw.dataset.ink;
    for (const o of el.signDlg.querySelectorAll('.swatch')) o.setAttribute('aria-pressed', String(o === sw));
    pad.setColor(INKS[ink]);
    if (dlgMode === 'type') renderFontChips();
    if (uploadedBlob) await useImage(uploadedBlob); // recolour the photo's ink
  });
}
el.sigPick.addEventListener('click', () => el.sigFile.click());
el.sigImg.addEventListener('click', () => el.sigFile.click());
el.sigFile.addEventListener('change', () => { const f = el.sigFile.files?.[0]; if (f) useImage(f); el.sigFile.value = ''; });

async function useImage(blob) {
  el.sigErr.hidden = true;
  try {
    const sig = await imageToSignature(blob, INKS[ink]);
    if (!sig) throw new Error('blank');
    uploaded = sig;
    uploadedBlob = blob;
    el.sigImg.src = sig.url;
    el.sigImg.hidden = false;
    el.sigPick.hidden = true;
  } catch (err) {
    console.warn(err);
    el.sigErr.textContent = t('sign.badImage');
    el.sigErr.hidden = false;
  }
  updateSignButtons();
}

el.sigClear.addEventListener('click', () => {
  if (dlgMode === 'draw') pad.clear();
  else if (dlgMode === 'type') { el.sigName.value = ''; renderFontChips(); updateSignButtons(); el.sigName.focus(); }
  else { uploaded = uploadedBlob = null; el.sigImg.hidden = true; el.sigPick.hidden = false; updateSignButtons(); }
});
el.sigCancel.addEventListener('click', () => el.signDlg.close());
el.sigUse.addEventListener('click', async () => {
  const sig = dlgMode === 'draw' ? pad.toSignature()
    : dlgMode === 'type' ? await typedSignature(el.sigName.value, typedFont, INKS[ink])
      : uploaded;
  if (!sig) return;
  el.signDlg.close();
  placeSignature(sig);
});

// Put a new signature in the middle of the current page's crop area, about a
// third of its width, keeping the signature's shape.
function placeSignature(sig) {
  const crop = cropOf(state.page).box;
  const sa = stageAspect();
  let w = (crop.x1 - crop.x0) * 0.35, h = (w * sa) / sig.aspect;
  const maxH = (crop.y1 - crop.y0) * 0.25;
  if (h > maxH) { w *= maxH / h; h = maxH; }
  const cx = (crop.x0 + crop.x1) / 2, cy = (crop.y0 + crop.y1) / 2;
  const item = { page: state.page, sig, box: { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 } };
  state.signs.push(item);
  renderSigns();
  signNode(item)?.focus();
}

// Width / height of the preview, so boxes in 0..1 units keep a shape on screen.
function stageAspect() { const g = curGroup(); return g.W / g.H; }

const signNodes = new Map(); // item -> element on the stage

function signNode(item) { return signNodes.get(item); }

function renderSigns() {
  for (const node of signNodes.values()) node.remove();
  signNodes.clear();
  if (!state) return;
  for (const item of state.signs.filter((x) => x.page === state.page)) {
    const node = document.createElement('div');
    node.className = 'sig';
    node.tabIndex = 0;
    node.setAttribute('role', 'group'); // not img: an image can't hold the × button
    node.setAttribute('aria-label', t('sign.itemAria'));
    const img = document.createElement('img');
    img.alt = '';
    (item.preview ??= signaturePreview(item.sig)).then((url) => { img.src = url; });
    const del = Object.assign(document.createElement('button'), { type: 'button', className: 'sig-del', textContent: '×' });
    del.setAttribute('aria-label', t('sign.remove'));
    del.title = t('sign.remove');
    const rs = document.createElement('div');
    rs.className = 'sig-rs';
    rs.title = t('sign.resize');
    node.append(img, del, rs);
    setRect(node, item.box);
    node.item = item;
    el.stage.append(node);
    signNodes.set(item, node);
  }
  el.signHint.hidden = !state.signs.length;
}

function removeSign(item) {
  state.signs = state.signs.filter((x) => x !== item);
  renderSigns();
}

// Keep a signature inside its page's crop area, so it isn't cut off.
function clampSign(item, b) {
  const c = cropOf(item.page).box;
  const w = Math.min(b.x1 - b.x0, c.x1 - c.x0), h = Math.min(b.y1 - b.y0, c.y1 - c.y0);
  const x0 = Math.min(Math.max(b.x0, c.x0), c.x1 - w), y0 = Math.min(Math.max(b.y0, c.y0), c.y1 - h);
  return { x0, y0, x1: x0 + w, y1: y0 + h };
}

let signDrag = null;
el.stage.addEventListener('pointerdown', (e) => {
  const node = e.target.closest('.sig');
  if (!node || e.button > 0) return;
  e.stopPropagation();
  if (e.target.closest('.sig-del')) return;
  e.preventDefault();
  node.focus();
  node.setPointerCapture(e.pointerId);
  const r = el.stage.getBoundingClientRect();
  signDrag = { node, item: node.item, id: e.pointerId, resize: !!e.target.closest('.sig-rs'),
    sx: e.clientX, sy: e.clientY, w: r.width, h: r.height, start: { ...node.item.box } };
});
el.stage.addEventListener('pointermove', (e) => {
  if (!signDrag || e.pointerId !== signDrag.id) return;
  const d = signDrag, dx = (e.clientX - d.sx) / d.w, dy = (e.clientY - d.sy) / d.h, b = d.start;
  let nb;
  if (d.resize) {
    // Corner drag: grow or shrink, keeping the signature's shape.
    // At most as big as the crop area; clampSign then slides it back inside
    // if it grew past an edge.
    const aspect = ((b.x1 - b.x0) * d.w) / ((b.y1 - b.y0) * d.h);
    const c = cropOf(d.item.page).box;
    const maxW = Math.min(c.x1 - c.x0, ((c.y1 - c.y0) * d.h * aspect) / d.w);
    const nw = Math.min(maxW, Math.max(0.03, b.x1 - b.x0 + dx));
    nb = { x0: b.x0, y0: b.y0, x1: b.x0 + nw, y1: b.y0 + (nw * d.w) / aspect / d.h };
  } else {
    nb = { x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy };
  }
  d.item.box = clampSign(d.item, nb);
  setRect(d.node, d.item.box);
});
const endSignDrag = (e) => { if (signDrag && e.pointerId === signDrag.id) signDrag = null; };
el.stage.addEventListener('pointerup', endSignDrag);
el.stage.addEventListener('pointercancel', endSignDrag);
el.stage.addEventListener('click', (e) => {
  const del = e.target.closest('.sig-del');
  if (del) removeSign(del.closest('.sig').item);
});
el.stage.addEventListener('keydown', (e) => {
  const node = e.target.closest('.sig');
  if (!node || e.target !== node) return;
  const item = node.item, b = item.box, step = e.shiftKey ? 0.05 : 0.005;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSign(item); return; }
  const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (!mv) return;
  e.preventDefault();
  e.stopPropagation(); // not the page arrows
  item.box = clampSign(item, { x0: b.x0 + mv[0], y0: b.y0 + mv[1], x1: b.x1 + mv[0], y1: b.y1 + mv[1] });
  setRect(node, item.box);
});

// What the engine needs: each signature as a PNG sized for 300 ppi at its
// size on the page, and its rectangle in PDF user space.
async function signatureStamps() {
  const stamps = [];
  for (const item of state.signs) {
    if (!state.selected[item.page]) continue;
    const vp = (await state.pdf.getPage(item.page)).getViewport({ scale: 1 });
    const b = item.box;
    const [ax, ay] = vp.convertToPdfPoint(b.x0 * vp.width, b.y0 * vp.height);
    const [bx, by] = vp.convertToPdfPoint(b.x1 * vp.width, b.y1 * vp.height);
    const k = Math.min(300 / 72, 2400 / ((b.x1 - b.x0) * vp.width));
    const png = await signaturePng(item.sig, (b.x1 - b.x0) * vp.width * k, (b.y1 - b.y0) * vp.height * k);
    stamps.push({ page: item.page - 1, rect: [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)], png });
  }
  return stamps;
}

/* ---------- export (in a worker, via mupdf) ---------- */

el.download.addEventListener('click', exportPdf);
el.compress.addEventListener('change', () => {
  el.ppiField.hidden = !el.compress.checked;
  showCompressHint();
  showEstimate();
});

function showCompressHint() {
  el.compressHint.textContent = t(el.compress.checked ? 'export.hintOn' : 'export.hintOff');
}
el.ppi.addEventListener('change', showEstimate);

/* ---------- size estimate (in its own short-lived worker) ---------- */

const PRESETS = [...el.ppi.options].map((o) => Number(o.value));
let estimate = null;      // { key, sizes } once known for the current selection
let estimateTimer = 0, estimateWorker = null, estimateKey = '';

function keepList() {
  return state.order.filter((p) => state.selected[p]).map((p) => p - 1);
}

function scheduleEstimate(delay = 600) {
  if (!state || !state.groups.every((g) => g.done)) return;
  clearTimeout(estimateTimer);
  const keep = keepList();
  const key = keep.join(',');
  if (state.large || !keep.length) { cancelEstimate(); estimate = null; showEstimate(); return; }
  if (key === estimateKey) return; // already estimated or estimating
  cancelEstimate();
  estimateKey = key;
  estimate = null;
  showEstimate();
  estimateTimer = setTimeout(() => runEstimate(key, keep), delay);
}

function cancelEstimate() {
  clearTimeout(estimateTimer);
  estimateWorker?.terminate();
  estimateWorker = null;
  estimateKey = '';
}

async function runEstimate(key, keep) {
  const my = session;
  const data = new Uint8Array(await state.file.arrayBuffer());
  if (my !== session || estimateKey !== key) return;
  let w = null;
  try {
    // Crop boxes don't change the size noticeably; the page subset does, so
    // only that is sent.
    const sizes = await oneShot('estimate', data, {
      keep, presets: PRESETS.map((ppi) => ({ ppi, quality: QUALITY[ppi] ?? 78 })),
    }, (x) => { w = x; estimateWorker = x; });
    if (estimateWorker !== w || my !== session) return;
    estimate = { key, sizes };
  } catch (err) {
    console.warn('size estimate failed', err);
    if (estimateWorker === w) estimate = null;
  } finally {
    if (estimateWorker === w) { estimateWorker = null; showEstimate(); }
  }
}

// Run one job in a worker of its own, thrown away afterwards so its memory
// goes back to the browser. `bytes` is transferred, not copied. If the caller
// terminates the worker (onStart hands it over), the promise never settles.
function oneShot(kind, bytes, opts, onStart) {
  const w = new Worker(new URL('./export-worker.js', import.meta.url), { type: 'module' });
  onStart?.(w);
  return new Promise((resolve, reject) => {
    // Messages sent before the worker has loaded mupdf can be lost, so wait
    // for "ready" before sending the job.
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') w.postMessage({ id: 0, kind, bytes, opts }, [bytes.buffer]);
      else if (m.type === 'done') resolve(m.result);
      else if (m.type === 'error') reject(new Error(m.message));
    };
    w.onerror = (e) => reject(new Error(e.message || `${kind} failed`));
  }).finally(() => w.terminate());
}

/* ---------- existing digital signatures ---------- */

// Exporting rewrites the file, which breaks any digital signature in it, so
// say so up front. pdf.js can tell there are signature fields but not whether
// they're signed, so only then is mupdf asked to look.
async function checkSignatures(my) {
  const fields = await state.pdf.getFieldObjects().catch(() => null);
  if (my !== session || !fields || !Object.values(fields).flat().some((f) => f.type === 'signature')) return;
  const data = new Uint8Array(await state.file.arrayBuffer());
  if (my !== session) return;
  try {
    const { signed } = await oneShot('inspect', data, {});
    if (my !== session) return;
    state.signed = signed;
    showSigWarn();
  } catch (err) {
    console.warn('signature check failed', err);
  }
}

function showSigWarn() {
  el.sigWarn.hidden = !state?.signed;
  if (state?.signed) el.sigWarn.textContent = t('export.sigWarn', { n: state.signed });
}

function showEstimate() {
  const known = estimate && estimate.key === estimateKey ? estimate.sizes : null;
  [...el.ppi.options].forEach((o, i) => {
    const label = t(`export.ppi${PRESETS[i]}`);
    o.textContent = known ? `${label} · ${ltr(`≈ ${fmtBytes(known.presets[i])}`)}` : label;
  });
  if (!state || state.large || !estimateKey) { el.estimate.hidden = true; return; }
  el.estimate.hidden = false;
  if (!known) { el.estimate.textContent = t('export.estimating'); return; }
  const size = el.compress.checked ? known.presets[PRESETS.indexOf(Number(el.ppi.value))] : known.none;
  el.estimate.replaceChildren(t('export.estimate'), Object.assign(document.createElement('strong'), { textContent: ltr(`≈ ${fmtBytes(size)}`) }),
    t('export.estimateNow', { size: fmtBytes(state.file.size) }));
}

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
        new Error(e.message || t('err.engine')),
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
  // Free the estimate's memory for the export; it reruns on the next change.
  if (estimateWorker) { cancelEstimate(); showEstimate(); }
  const say = (t) => { el.saveText.textContent = t; };

  try {
    // Page boxes in PDF user space. convertToPdfPoint handles /Rotate and
    // boxes that don't start at 0,0.
    const boxes = [];
    for (let i = 1; i <= state.n; i++) {
      const b = cropOf(i).box;
      if (!state.selected[i] || (b.x0 === 0 && b.y0 === 0 && b.x1 === 1 && b.y1 === 1)) { boxes.push(null); continue; }
      const vp = (await state.pdf.getPage(i)).getViewport({ scale: 1 });
      const [ax, ay] = vp.convertToPdfPoint(b.x0 * vp.width, b.y0 * vp.height);
      const [bx, by] = vp.convertToPdfPoint(b.x1 * vp.width, b.y1 * vp.height);
      boxes.push([Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)].map((v) => Math.round(v * 1000) / 1000));
    }
    const ppi = Number(el.ppi.value);
    const compress = el.compress.checked ? { ppi, quality: QUALITY[ppi] ?? 78 } : null;
    const stamps = await signatureStamps();

    say(t('export.loading'));
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
            say(t('export.images', { done: m.done, total: m.total }));
          } else {
            say(t(['open', 'pages', 'scan', 'save'].includes(m.phase) ? `export.${m.phase}` : 'export.working'));
          }
        },
      });
      // Transferred, not copied: the worker owns the only copy from here on.
      worker.postMessage({ id, bytes: data, opts: { boxes, keep: keepList(),
        rotate: Array.from(state.rot.subarray(1)), compress, stamps } }, [data.buffer]);
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
    line.append(t('export.saved', { name: ltr(name), before: fmtBytes(before) }));
    const strong = document.createElement('strong');
    strong.textContent = fmtBytes(after);
    line.append(strong, after < before ? t('export.smaller', { pct: Math.min(99, Math.floor((1 - after / before) * 100)) }) : '');
    el.saveText.replaceChildren(line);
  } catch (err) {
    console.error(err);
    retireWorker();
    el.saveProgress.hidden = true;
    say('');
    showError(err?.memory || isMemoryError(err) ? t('err.memory')
      : /encrypt|password/i.test(err?.message || '') ? t('err.encrypted')
        : t('err.write', { msg: err?.message || err }));
  } finally {
    if (state) el.download.disabled = selectedPages().length === 0;
    if (state && my === session) scheduleEstimate();
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

/* ---------- language ---------- */

function storedLang() { try { return localStorage.getItem('pared-lang'); } catch { return null; } }

setLang(pickLang({ search: location.search, saved: storedLang(), languages: navigator.languages || [navigator.language || ''] }));
showVersion();
showCompressHint();
showEstimate();

el.lang.value = lang();
el.lang.addEventListener('change', () => {
  try { localStorage.setItem('pared-lang', el.lang.value); } catch { /* private mode: just this visit */ }
  setLang(el.lang.value);
  rerender();
});

// Redraw every piece of text the app writes itself, in the current language.
function rerender() {
  showVersion();
  if (state) renderSigns();
  showSigWarn();
  showCompressHint();
  showEstimate();
  if (!state) return;
  if (state.groups.length && state.groups[0].W) showFileMeta();
  labelThumbs();
  updateSelectionUI();
  updatePager();
  updateCurrentInclusion();
  refreshPanel();
}

// Which deploy this is, from the meta tags the deploy job fills in. A copy
// served straight from the repo has them empty and shows no version.
function showVersion() {
  const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content || '';
  const commit = meta('pared-commit'), deployed = new Date(meta('pared-deployed'));
  el.version.hidden = !commit || Number.isNaN(deployed.getTime());
  if (el.version.hidden) return;
  const when = new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(deployed);
  el.versionLink.textContent = t('foot.version', { commit: ltr(commit.slice(0, 7)), when });
  el.versionLink.href = `https://github.com/paredpdf/paredpdf.github.io/commit/${commit}`;
  el.versionLink.title = `${commit}\n${deployed.toISOString()}`;
}

function showFileMeta() {
  const g0 = state.groups[0];
  el.fmeta.textContent = t('file.meta', { size: fmtBytes(state.file.size), n: state.n, sheet: fmtSheet(g0.W, g0.H) });
}

function labelThumbs() {
  for (let p = 1; p <= state.n; p++) {
    const th = state.thumbs[p];
    if (!th) continue;
    th.cb.setAttribute('aria-label', t('thumb.export', { p }));
    th.clip.title = t('thumb.preview', { p });
    th.handle.setAttribute('aria-label', t('thumb.move', { p }));
    th.handle.title = t('thumb.moveTitle');
    th.rotate.setAttribute('aria-label', t('thumb.rotate', { p }));
    th.rotate.title = t('thumb.rotateTitle');
  }
}

/* ---------- helpers ---------- */

function showError(msg) { el.error.textContent = msg; el.error.hidden = false; el.progress.hidden = true; }
const fmtPt = (v) => (Math.round(v * 10) / 10).toString();
const fmtMm = (pt) => (Math.round((pt * 25.4 / 72) * 10) / 10).toString();
function fmtBytes(b) {
  if (b < 1e3) return ltr(`${b} B`);
  if (b < 1e6) return ltr(`${(b / 1e3).toFixed(0)} KB`);
  return ltr(`${(b / 1e6).toFixed(1)} MB`);
}
function fmtSheet(W, H) {
  const iso = [['A3', 842, 1191], ['A4', 595, 842], ['A5', 420, 595], ['Letter', 612, 792], ['Legal', 612, 1008]];
  const lo = Math.min(W, H), hi = Math.max(W, H);
  const hit = iso.find(([, a, b]) => Math.abs(a - lo) < 2 && Math.abs(b - hi) < 2);
  const orient = t(W > H ? 'sheet.landscape' : W < H ? 'sheet.portrait' : 'sheet.square');
  return hit ? `${ltr(hit[0])} ${orient}` : ltr(`${fmtMm(W)} × ${fmtMm(H)} mm`);
}
