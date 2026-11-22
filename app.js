import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';
import {
  FULL, RATIOS, findContentBox, unionBoxes, detectPageBox, boxForRatio, padBox, ratiosFor, flipRatioId, nameRatio,
  pageClipRects, isPageLikeClip, clipPageBox,
} from './detect.js';
import { parseRange, formatRange } from './pages.js';
import { isLargeForDevice, isMemoryError } from './limits.js';
import { t, ltr, isRtl, lang, locale, setLang, pickLang } from './i18n.js';
import { makeZip } from './zip.js';
import { imagesToPdfs, isImageFile, isPdfFile } from './images.js';
import { NUMBER_PT, NUMBER_LINE, textWidth, numberCanvas, watermarkCanvas, canvasPng, numberSpot } from './marks.js';
import { INKS, fontsFor, createPad, imageToSignature, typedSignature, loadFont, fontCss, signaturePng, signaturePreview,
  textItem, markItem, isRtlText, TEXT_FONT, TEXT_LINE, TEXT_PAD, fieldPng } from './sign.js';

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
  'drop', 'file', 'pick', 'work', 'stageWrap', 'stageBox', 'stage', 'canvas', 'crop', 'shade', 'contentOutline', 'excludedBadge', 'rotBadge',
  'prev', 'next', 'pageLabel', 'includePage', 'showContent',
  'selCount', 'range', 'rangeErr', 'selAll', 'selNone', 'resetOrder', 'thumbs',
  'fname', 'fmeta', 'progress', 'progressBar', 'progressText',
  'detectCard', 'confidence', 'detectText', 'groupSel',
  'boxCard', 'scopeAll', 'scopePage', 'scopeHint', 'orientP', 'orientL', 'chips', 'rSize', 'rMm', 'rRatio',
  'exportCard', 'memWarn', 'sigWarn', 'strip', 'stripHint', 'pwCard', 'pwText', 'pw', 'keepPw', 'keepPwRow', 'outMode', 'everyField', 'everyN', 'metaDetails', 'metaList', 'compress', 'ppiField', 'ppi', 'compressHint', 'estimate', 'download', 'saveProgress', 'saveBar', 'saveText',
  'reset', 'error', 'lang', 'version', 'versionLink', 'about', 'updateBar', 'updateBtn', 'undo', 'redo',
  'signCard', 'addSign', 'signHint', 'signDlg', 'tabDraw', 'tabType', 'tabUpload', 'paneDraw', 'paneType', 'paneUpload', 'pad', 'sigFile', 'sigPick', 'sigImg',
  'sigName', 'fontChips',
  'sigErr', 'sigClear', 'sigCancel', 'sigUse', 'sigRemember', 'savedSigs', 'savedList', 'signDlgTitle',
  'addInitials', 'addDate', 'copyAll', 'copyDone', 'typeHint', 'addText', 'addCheck', 'addCross', 'formHint',
  'marksCard', 'numOn', 'numOpts', 'numWhere', 'numStyle', 'wmOn', 'wmOpts', 'wmText',
].map((id) => [id, $(id)]));

let state = null;
let renderTask = null;
let session = 0; // bumps on every new file so stale async work can bail out

/* ---------- file intake ---------- */

el.pick.addEventListener('click', (e) => { e.stopPropagation(); el.file.click(); });
el.drop.addEventListener('click', () => el.file.click());
el.drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.file.click(); } });
el.file.addEventListener('change', () => { if (el.file.files.length) open([...el.file.files]); });
for (const t of ['dragenter', 'dragover']) {
  document.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.add('over'); });
}
for (const t of ['dragleave', 'drop']) {
  document.addEventListener(t, (e) => { e.preventDefault(); if (t === 'drop' || e.target === el.drop) el.drop.classList.remove('over'); });
}
document.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files || [])].filter((f) => isPdfFile(f) || isImageFile(f));
  if (files.length) open(files);
});
// Back to the start is a good moment to switch to a waiting new version.
el.reset.addEventListener('click', () => (waitingWorker ? applyUpdate() : resetAll()));

function resetAll() {
  session++;
  thumbObserver?.disconnect();
  evictObserver?.disconnect();
  thumbQueue.length = 0;
  for (const d of state?.files ?? []) d.pdf.destroy();
  state = null;
  steps = [];
  stepAt = -1;
  cancelEstimate();
  estimate = null;
  showEstimate();
  el.file.value = '';
  el.thumbs.replaceChildren();
  el.work.hidden = true;
  el.reset.hidden = true;
  el.drop.hidden = false;
  el.about.hidden = false;
}

// Open one or more PDFs as one working document. passwords[k] is for files[k].
// Photos and other images among them become PDF pages first.
async function open(files, passwords = []) {
  files = Array.isArray(files) ? files : [files];
  resetAll();
  const my = session;
  el.drop.hidden = true;
  el.about.hidden = true;
  el.work.hidden = false;
  el.reset.hidden = false;
  for (const k of ['detectCard', 'boxCard', 'signCard', 'marksCard', 'exportCard', 'error', 'saveProgress', 'pwCard']) el[k].hidden = true;
  const named = () => {
    el.fname.textContent = files.length === 1 ? files[0].name : t('file.many', { n: files.length });
    el.fname.title = files.map((f) => f.name).join('\n');
  };
  named();
  el.saveText.textContent = '';

  let size = 0;
  try {
    if (files.some(isImageFile)) {
      files = await imagesToPdfs(files, (done, total) => { if (my === session) el.fmeta.textContent = t('file.photos', { done, total }); });
      if (my !== session) return;
      named();
    }
    size = files.reduce((n, f) => n + f.size, 0);
    el.fmeta.textContent = t('file.reading', { size: fmtBytes(size) });
    // pdf.js takes ownership of each buffer (it moves to its worker). The
    // export re-reads the files instead of keeping second copies in memory.
    const docs = [];
    for (let k = 0, offset = 0; k < files.length; k++) {
      const bytes = new Uint8Array(await files[k].arrayBuffer());
      let pdf;
      try {
        pdf = await pdfjsLib.getDocument({ data: bytes, password: passwords[k] ?? undefined, isEvalSupported: false, ...PDFJS_ASSETS }).promise;
      } catch (err) {
        for (const d of docs) d.pdf.destroy();
        if (my !== session) return;
        if (err?.name === 'PasswordException') {
          return askPassword(files, passwords, k, err.code === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD);
        }
        throw files.length > 1 ? new Error(`${files[k].name}: ${err?.message || err}`) : err;
      }
      if (my !== session) { pdf.destroy(); for (const d of docs) d.pdf.destroy(); return; }
      docs.push({ file: files[k], password: passwords[k] ?? null, pdf, n: pdf.numPages, offset });
      offset += pdf.numPages;
    }
    const n = docs.reduce((t, d) => t + d.n, 0);
    state = { files: docs, size, n, page: 1, groups: [], groupOf: [], selected: null, lastToggled: null, thumbs: [], order: [] };
    state.order = Array.from({ length: state.n }, (_, i) => i + 1);
    state.rot = new Int16Array(state.n + 1); // extra clockwise rotation per page
    state.override = new Map(); // page -> its own crop (see cropOf)
    state.signs = []; // { page, sig, box } signatures placed on pages
    state.fields = new Map(); // page -> promise of its form fields (see fieldsOf)
    state.formValues = new Map(); // field key -> value, for fields changed here
    state.selected = new Uint8Array(state.n + 1).fill(1);
    await collectGroups(my);
    if (my !== session) return;
    for (const d of docs) d.meta = await d.pdf.getMetadata().catch(() => null);
    if (my !== session) return;
    showStripHint();
    renderHidden();
    showFormHint(my);
    const g0 = state.groups[0];
    showFileMeta();
    state.large = isLargeForDevice(size, {
      deviceMemory: navigator.deviceMemory, coarsePointer: matchMedia('(pointer: coarse)').matches,
    });
    el.memWarn.hidden = !state.large;
    el.keepPwRow.hidden = !docs.some((d) => d.password);
    setupOutput();
    el.keepPw.checked = true;
    buildThumbs();
    updateSelectionUI();
    showPage(1);
    await analyse(my);
  } catch (err) {
    if (my !== session) return;
    console.error(err);
    showError(err?.code === 'image' ? t('err.image', { name: err.name }) : t('err.read', { msg: err?.message || err }));
  }
}

/* ---------- password-protected PDFs ---------- */

// The password stays in this page's memory: pdf.js gets it for the preview,
// and the workers for export. It is never stored.
let pwFor = null;
function askPassword(files, passwords, k, wrong) {
  pwFor = { files, passwords, k, wrong };
  el.fmeta.textContent = fmtBytes(files.reduce((t, f) => t + f.size, 0));
  el.pwCard.hidden = false;
  showPwText();
  el.pw.value = '';
  el.pw.focus();
}
function showPwText() {
  const { files, k, wrong } = pwFor;
  // With several files, say which one is asking.
  el.pwText.textContent = files.length > 1
    ? t(wrong ? 'pw.wrongFile' : 'pw.needFile', { name: ltr(files[k].name) })
    : t(wrong ? 'pw.wrong' : 'pw.need');
}
el.pwCard.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!pwFor || !el.pw.value) return;
  const passwords = [...pwFor.passwords];
  passwords[pwFor.k] = el.pw.value;
  open(pwFor.files, passwords);
});

/* ---------- analysis ---------- */

// Pages are grouped by rendered sheet size, so mixed-size documents get one
// crop box per size instead of one box forced onto every page.
async function collectGroups(my) {
  const byKey = new Map();
  for (let i = 1; i <= state.n; i++) {
    const page = await getPage(i);
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
    const page = await getPage(p);
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
  el.marksCard.hidden = false;
  showNumStyles();
  refreshPanel();
  resetHistory(); // the detected crops are where undo stops
  warmWorker();
  scheduleEstimate(0);
  inspectFiles(my);
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
  else { refreshPanel(); noteChange(); }
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
  noteChange();
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
  if (!state || el.work.hidden || el.signDlg.open || e.target.closest('input, textarea, button, select, .sig')) return;
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
  // Show the page turned as it will be exported: fit the turned shape, and
  // size the box around the stage to it.
  const deg = state.rot[n] || 0, side = deg % 180 !== 0;
  const fit = Math.min(availW / (side ? g.H : g.W), availH / (side ? g.W : g.H));
  const cssW = Math.floor(g.W * fit), cssH = Math.floor(g.H * fit);
  el.stage.style.width = `${cssW}px`;
  el.stage.style.height = `${cssH}px`;
  el.stage.style.setProperty('--rot', `${deg}deg`);
  el.stageBox.style.width = `${side ? cssH : cssW}px`;
  el.stageBox.style.height = `${side ? cssW : cssH}px`;
  placeOverlay();
  renderSigns();
  renderFields();
  refreshPanel(); // the new page may have its own crop

  const my = session;
  renderTask?.cancel();
  const page = await getPage(n);
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
  schedulePageMarks();
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

// A movement on screen, in the page's own 0..1 units: the stage may be
// turned, so undo its clockwise turn first. Uses the stage's own size, not
// its on-screen bounding box, which a turn swaps.
function screenToSheet(dx, dy) {
  const r = ((state.rot[state.page] || 0) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [(dx * c + dy * s) / el.stage.offsetWidth, (-dx * s + dy * c) / el.stage.offsetHeight];
}

/* ---------- dragging the crop box ---------- */

let drag = null, dragFrame = 0;
el.crop.addEventListener('pointerdown', (e) => {
  const c = curCrop();
  if (!c) return;
  e.preventDefault();
  el.crop.setPointerCapture(e.pointerId);
  drag = { c, h: e.target.dataset.h || 'move', sx: e.clientX, sy: e.clientY, start: { ...c.box } };
});
el.crop.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const [dx, dy] = screenToSheet(e.clientX - drag.sx, e.clientY - drag.sy);
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
const endDrag = () => { if (drag) { drag = null; noteChange(); } };
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
    // With several files, the first page of each says which file starts there.
    const d = docOf(p);
    if (state.files.length > 1 && p === d.offset + 1) {
      const tag = Object.assign(document.createElement('div'), { className: 'tfile', textContent: d.file.name });
      tag.title = d.file.name;
      t.filetag = tag; // added after the bar below
      t.classList.add('filestart');
    }
    const rotate = Object.assign(document.createElement('button'), { type: 'button', className: 'trot', textContent: '↻' });
    bar.append(handle, num, rotate);
    t.append(cb, frame, bar, ...(t.filetag ? [t.filetag] : []));
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
    t.sheet = { cw, ch, x0: b.x0, y0: b.y0 };
    renderThumbSigns(p);
  }
}

// A page's signatures on its thumbnail, where they sit on the page. The
// thumbnail turns with the page, so each is turned back, as in the preview.
function renderThumbSigns(p) {
  noteChange();
  const t = state?.thumbs[p];
  if (!t?.sheet) return;
  for (const old of t.clip.querySelectorAll('.tsig')) old.remove();
  const { cw, ch, x0, y0 } = t.sheet, deg = state.rot[p] || 0;
  for (const item of state.signs.filter((x) => x.page === p)) {
    const b = item.box, w = (b.x1 - b.x0) * cw, h = (b.y1 - b.y0) * ch;
    const [iw, ih] = deg % 180 ? [h, w] : [w, h];
    const img = Object.assign(document.createElement('img'), { className: 'tsig', alt: '' });
    Object.assign(img.style, {
      left: `${(b.x0 - x0) * cw + w / 2}px`, top: `${(b.y0 - y0) * ch + h / 2}px`, width: `${iw}px`, height: `${ih}px`,
      transform: `translate(-50%, -50%) rotate(${-deg}deg)`,
    });
    (item.preview ??= signaturePreview(item.sig)).then((url) => { img.src = url; });
    t.clip.append(img);
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
      const page = await getPage(p);
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
  noteChange();
  schedulePageMarks();
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
    if (p === state.page) showPage(p); // the preview turns too
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
  showNumStyles();
  schedulePageMarks();
  noteChange();
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
  showDownloadLabel();
}

function updateCurrentInclusion() {
  noteChange();
  schedulePageMarks();
  const on = !!state.selected[state.page];
  el.includePage.checked = on;
  el.excludedBadge.hidden = on;
  const deg = state.rot[state.page];
  el.rotBadge.hidden = !on || !deg;
  el.rotBadge.textContent = t('stage.turned', { deg });
  el.stageBox.classList.toggle('excluded', !on);
}

/* ---------- undo and redo ---------- */

// Snapshots of everything the person edits: crops, page order, rotation,
// which pages are kept, and placed signatures. A snapshot is taken a moment
// after changes settle (never mid-drag), and only when something actually
// differs from the current one, so a drag is one step and redrawing after
// an undo records nothing.
// Not called `history`: that would hide the browser's own history object.
const HISTORY_MAX = 100;
let steps = [], stepAt = -1, noteTimer = 0, restoring = false;
const sigIds = new WeakMap();
let nextSigId = 1;
const sigId = (sig) => { if (!sigIds.has(sig)) sigIds.set(sig, nextSigId++); return sigIds.get(sig); };

function snapshot() {
  return {
    groups: state.groups.map((g) => ({ box: { ...g.box }, mode: g.mode, orient: g.orient })),
    override: [...state.override].map(([p, c]) => [p, { box: { ...c.box }, mode: c.mode, orient: c.orient, sheet: c.sheet }]),
    order: [...state.order],
    rot: Array.from(state.rot),
    selected: Array.from(state.selected),
    signs: state.signs.map((x) => ({ ...x, box: { ...x.box } })),
    form: [...state.formValues],
  };
}

// What makes two snapshots the same (signatures by identity, not content).
const snapKey = (snap) => JSON.stringify({ ...snap, override: snap.override.map(([p, c]) => [p, c.box, c.mode, c.orient]),
  signs: snap.signs.map((x) => [x.page, sigId(x.sig), x.box]) });

function noteChange() {
  if (!state || restoring || !state.groups.every((g) => g.done)) return;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(recordStep, 350);
}

function recordStep() {
  if (!state) return;
  if (drag || signDrag || reorder) { noteTimer = setTimeout(recordStep, 200); return; } // wait for the drag to end
  const snap = snapshot(), key = snapKey(snap);
  if (steps[stepAt]?.key === key) return;
  steps = steps.slice(0, stepAt + 1);
  steps.push({ snap, key });
  if (steps.length > HISTORY_MAX) steps.shift();
  stepAt = steps.length - 1;
  showUndoState();
}

function resetHistory() {
  clearTimeout(noteTimer);
  steps = [];
  stepAt = -1;
  if (state) recordStep();
  showUndoState();
}

function stepHistory(d) {
  const to = stepAt + d;
  if (!state || to < 0 || to >= steps.length) return;
  clearTimeout(noteTimer);
  stepAt = to;
  restore(steps[to].snap);
  showUndoState();
}

function restore(snap) {
  restoring = true;
  try {
    state.groups.forEach((g, i) => Object.assign(g, { box: { ...snap.groups[i].box }, mode: snap.groups[i].mode, orient: snap.groups[i].orient }));
    state.override = new Map(snap.override.map(([p, c]) => [p, { ...c, box: { ...c.box } }]));
    state.order = [...snap.order];
    state.rot = Int16Array.from(snap.rot);
    state.selected = Uint8Array.from(snap.selected);
    dropTextEditor();
    state.signs = snap.signs.map((x) => ({ ...x, box: { ...x.box } }));
    state.formValues = new Map(snap.form);
    activeSign = null;
    el.copyAll.hidden = true;
    el.copyDone.hidden = true;
    el.thumbs.append(...state.order.map((p) => state.thumbs[p].el));
    for (const g of state.groups) layoutThumbs(g);
    updateSelectionUI();
    orderChanged();
    showPage(state.page);
    syncFields();
  } finally {
    restoring = false;
  }
}

function showUndoState() {
  el.undo.disabled = stepAt <= 0;
  el.redo.disabled = stepAt < 0 || stepAt >= steps.length - 1;
}

el.undo.addEventListener('click', () => stepHistory(-1));
el.redo.addEventListener('click', () => stepHistory(1));
document.addEventListener('keydown', (e) => {
  if (!state || el.work.hidden || el.signDlg.open || !(e.ctrlKey || e.metaKey)) return;
  if (e.target.closest('input[type="text"], input[type="number"], input[type="password"], textarea')) return; // their own undo
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); stepHistory(-1); }
  else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); stepHistory(1); }
});

/* ---------- signatures ---------- */

let pad = null, dlgMode = 'draw', ink = 'black', uploaded = null, uploadedBlob = null, typedFont = null;

el.addSign.addEventListener('click', () => openSignDialog('signature'));
el.addInitials.addEventListener('click', () => openSignDialog('initials'));
el.addDate.addEventListener('click', addDate);

// The dialog makes signatures and initials alike; initials start on the
// Type tab, filled in from the name typed for a signature.
// sigMode is the tab last used for a signature, so initials (always on the
// Type tab) don't change where "Add a signature" opens.
let dlgFor = 'signature', fullName = '', sigMode = 'draw';
function openSignDialog(what) {
  dlgFor = what;
  showDlgTitle();
  if (what === 'initials') {
    dlgMode = 'type';
    el.sigName.value = initialsOf(fullName || lastSavedName());
  } else {
    dlgMode = sigMode;
    el.sigName.value = fullName;
  }
  el.signDlg.showModal();
  pad ??= createPad(el.pad, { onChange: updateSignButtons });
  pad.setColor(INKS[ink]);
  setDlgMode(dlgMode);
}

function setDlgMode(mode) {
  dlgMode = mode;
  if (dlgFor === 'signature') sigMode = mode;
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
el.sigName.addEventListener('input', () => {
  if (dlgFor === 'signature') fullName = el.sigName.value.trim(); // kept even if the dialog is cancelled
  renderFontChips();
  updateSignButtons();
});
el.sigName.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !el.sigUse.disabled) { e.preventDefault(); el.sigUse.click(); } });

// One button per style, each showing the name (or a sample) in that font.
function renderFontChips() {
  const text = typedText() || t('sign.namePh');
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
    : dlgMode === 'type' ? await typedSignature(typedText(), typedFont, INKS[ink])
      : uploaded;
  if (!sig) return;
  el.signDlg.close();
  if (sig.kind === 'type' && dlgFor === 'signature') fullName = sig.text;
  if (el.sigRemember.checked) rememberSignature(sig);
  placeSignature(sig, dlgFor === 'initials' ? { width: 0.14 } : {});
});

function showDlgTitle() {
  el.signDlgTitle.textContent = t(dlgFor === 'initials' ? 'sign.dlgInitials' : 'sign.dlgTitle');
  el.typeHint.textContent = t(dlgFor === 'initials' ? 'sign.initialsHint' : 'sign.typeHint');
}

// What gets written: for initials, a name typed in full becomes its
// initials ("Shai Epstein" -> "S.E."); one word ("SE", "S.E.") stays as typed.
function typedText() {
  const raw = el.sigName.value.trim();
  return dlgFor === 'initials' && /\s/.test(raw) ? initialsOf(raw) : raw;
}

// "Ada Lovelace" -> "A.L.", by letters, whatever the script.
function initialsOf(name) {
  const words = String(name).trim().split(/[\s\-]+/).filter(Boolean);
  return words.length ? `${words.map((w) => Array.from(w)[0].toUpperCase()).join('.')}.` : '';
}

const lastSavedName = () => savedSignatures().find((x) => x.sig.kind === 'type')?.sig.text ?? '';

// Today's date, written like the signature: same handwriting and ink.
async function addDate() {
  if (!state) return;
  const text = new Intl.DateTimeFormat(locale(), { dateStyle: 'medium' }).format(new Date());
  const fits = fontsFor(text);
  const font = fits.some((f) => f.id === typedFont) ? typedFont : fits.find((f) => f.id === ({ he: 'gveret', ar: 'ruqaa' }[lang()] ?? 'dancing'))?.id ?? fits[0].id;
  placeSignature(await typedSignature(text, font, INKS[ink]), { width: 0.26 });
}

/* ---------- the PDF's own form fields ---------- */

// Fields are filled in right on the page: each becomes an input over its
// place. Values live in state.formValues (only the ones changed here), keyed
// by file and field name, so widgets of one field show one value.

const FIELD_TYPES = { Tx: 'text', Ch: 'choice' };

function fieldsOf(p) {
  if (!state.fields.has(p)) state.fields.set(p, loadFields(p));
  return state.fields.get(p);
}

async function loadFields(p) {
  const page = await getPage(p);
  const vp = page.getViewport({ scale: 1 });
  const src = state.files.indexOf(docOf(p));
  const list = [];
  for (const a of await page.getAnnotations({ intent: 'display' }).catch(() => [])) {
    if (a.annotationType !== 20 || a.hidden || a.readOnly || !a.fieldName) continue; // 20: widget
    const type = FIELD_TYPES[a.fieldType] ?? (a.checkBox ? 'check' : a.radioButton ? 'radio' : null);
    if (!type) continue;
    const [x0, y0, x1, y1] = vp.convertToViewportRectangle(a.rect);
    const c = a.defaultAppearanceData?.fontColor;
    list.push({
      key: `${src}:${a.fieldName}`, name: a.fieldName, label: a.alternativeText || a.fieldName, type, rect: a.rect,
      box: { x0: Math.min(x0, x1) / vp.width, y0: Math.min(y0, y1) / vp.height, x1: Math.max(x0, x1) / vp.width, y1: Math.max(y0, y1) / vp.height },
      initial: type === 'check' ? (a.fieldValue && a.fieldValue !== 'Off' ? a.exportValue : 'Off')
        : type === 'radio' ? (a.fieldValue ?? 'Off')
          : type === 'choice' ? ((Array.isArray(a.fieldValue) ? a.fieldValue[0] : a.fieldValue) ?? '') : (a.fieldValue ?? ''),
      on: a.checkBox ? a.exportValue : a.buttonValue, options: a.options ?? [], multiline: !!a.multiLine, maxLen: a.maxLen || 0,
      size: a.defaultAppearanceData?.fontSize || 0, color: c ? `rgb(${c[0]}, ${c[1]}, ${c[2]})` : '#000',
      align: a.textAlignment ?? 0, rotation: a.rotation || 0,
    });
  }
  return list;
}

const fieldValue = (d) => (state.formValues.has(d.key) ? state.formValues.get(d.key) : d.initial);

// The field's font size in points: its own, or one that fits it.
const fieldPt = (d, g) => d.size || (d.multiline ? 11 : Math.min(12, (d.box.y1 - d.box.y0) * g.H * 0.66));

async function renderFields() {
  const p = state?.page;
  if (!p) return;
  const list = await fieldsOf(p);
  if (!state || state.page !== p) return;
  for (const n of el.stage.querySelectorAll('.form-field')) n.remove(); // also any drawn by a call that finished first
  const g = state.groupOf[p], scale = el.stage.offsetWidth / g.W; // CSS px per point
  for (const d of list) {
    let node;
    if (d.type === 'text') {
      node = document.createElement(d.multiline ? 'textarea' : 'input');
      if (!d.multiline) node.type = 'text';
      if (d.maxLen) node.maxLength = d.maxLen;
      node.dir = 'auto';
      node.spellcheck = false;
      node.addEventListener('input', () => setField(d, node.value));
    } else if (d.type === 'choice') {
      node = document.createElement('select');
      const opts = d.options.map((o) => new Option(o.displayValue, o.exportValue));
      if (!d.options.some((o) => o.exportValue === d.initial)) opts.unshift(new Option('', d.initial));
      node.append(...opts);
      node.addEventListener('change', () => setField(d, node.value));
    } else {
      node = Object.assign(document.createElement('input'), { type: d.type === 'check' ? 'checkbox' : 'radio', name: `field-${d.key}` });
      node.addEventListener('change', () => setField(d, node.checked ? d.on : 'Off'));
    }
    node.classList.add('form-field', `ff-${d.type}`);
    node.field = d;
    node.setAttribute('aria-label', d.label);
    node.title = d.label;
    if (d.type === 'text' || d.type === 'choice') Object.assign(node.style, { fontSize: `${fieldPt(d, g) * scale}px`, color: d.color });
    setRect(node, d.box);
    el.stage.append(node);
  }
  syncFields();
}

function setField(d, value) {
  state.formValues.set(d.key, value);
  syncFields(d.key);
  noteChange();
}

// Show the current values: all widgets of a field show the same one.
function syncFields(key) {
  for (const node of el.stage.querySelectorAll('.form-field')) {
    const d = node.field;
    if (key && d.key !== key) continue;
    const v = fieldValue(d);
    if (d.type === 'check' || d.type === 'radio') node.checked = v === d.on;
    else if (node !== document.activeElement && node.value !== v) node.value = v;
    // A choice reads from the side its text starts, as it's exported.
    if (d.type === 'choice') node.dir = isRtlText(node.selectedOptions[0]?.text ?? '') ? 'rtl' : 'ltr';
  }
}

// Tell people the PDF has a form, once its fields are known.
async function showFormHint(my) {
  el.formHint.hidden = true;
  const found = await Promise.all(state.files.map((d) => d.pdf.getFieldObjects().catch(() => null)));
  if (my !== session) return;
  el.formHint.hidden = !found.some((f) => f && Object.keys(f).length);
}

// What the engine needs: each changed field on an exported page, with its
// text drawn at 300 ppi for the fields that show text.
async function fieldFills() {
  if (!state.formValues.size) return [];
  const fills = [];
  for (let p = 1; p <= state.n; p++) {
    if (!state.selected[p]) continue;
    for (const d of await fieldsOf(p)) {
      const value = fieldValue(d);
      if (!state.formValues.has(d.key) || value === d.initial) continue;
      if (d.type === 'radio' && value !== d.on) continue; // the chosen button sets the group
      const fill = { page: p - 1, name: d.name, rect: d.rect, type: d.type, value };
      if (d.type === 'text' || d.type === 'choice') {
        const shown = d.type === 'choice' ? (d.options.find((o) => o.exportValue === value)?.displayValue ?? value) : value;
        const W = Math.abs(d.rect[2] - d.rect[0]), H = Math.abs(d.rect[3] - d.rect[1]);
        const [w, h] = d.rotation % 180 ? [H, W] : [W, H];
        const k = Math.min(300 / 72, 2400 / w);
        fill.png = await fieldPng(shown, w * k, h * k, { k, size: d.size, align: d.align, multiline: d.multiline, color: d.color });
      }
      fills.push(fill);
    }
  }
  return fills;
}

/* ---------- text and marks ---------- */

const TEXT_PT = 11, MARK_PT = 14; // new ones' size on the page, in points

el.addText.addEventListener('click', () => {
  if (!state) return;
  const item = placeSized(textItem('', INKS[ink]), TEXT_PT * (TEXT_LINE + 2 * TEXT_PAD));
  editText(item);
});
el.addCheck.addEventListener('click', () => { if (state) signNode(placeSized(markItem('check', INKS[ink]), MARK_PT))?.focus(); });
el.addCross.addEventListener('click', () => { if (state) signNode(placeSized(markItem('cross', INKS[ink]), MARK_PT))?.focus(); });

// Put it in the middle of the current page's crop area, `heightPt` tall as
// the page shows.
function placeSized(sig, heightPt) {
  const p = state.page, g = state.groupOf[p], crop = cropOf(p).box;
  const side = (state.rot[p] || 0) % 180 !== 0;
  const [bw, bh] = viewToBox(g, side, heightPt * sig.aspect, heightPt);
  const cx = (crop.x0 + crop.x1) / 2, cy = (crop.y0 + crop.y1) / 2;
  const item = { page: p, sig };
  item.box = clampSign(item, { x0: cx - bw / 2, y0: cy - bh / 2, x1: cx + bw / 2, y1: cy + bh / 2 });
  state.signs.push(item);
  renderSigns();
  return item;
}

// A size as the page shows (points across, points down) in the page's own
// 0..1 units; on a page turned a quarter, across is down the page.
const viewToBox = (g, side, w, h) => (side ? [h / g.W, w / g.H] : [w / g.W, h / g.H]);

// Which page corner (in the page's own frame) shows at the top left and top
// right on screen, for each turn of the page.
const VIEW_CORNER = { 0: { tl: 'tl', tr: 'tr' }, 90: { tl: 'bl', tr: 'tl' }, 180: { tl: 'br', tr: 'bl' }, 270: { tl: 'tr', tr: 'br' } };

// Typing on the page. The text is typed in a field over the page, outside
// the stage (so it reads upright on a turned page), and the box grows from
// its starting corner as you type: top left, or top right for right-to-left
// text. The size of the letters stays as it is.
let textEdit = null; // { item, area }

function editText(item) {
  if (textEdit?.item === item) return;
  finishTextEdit();
  const node = signNode(item);
  if (!node) return;
  const area = Object.assign(document.createElement('textarea'), { className: 'text-edit', value: item.sig.text, spellcheck: true, rows: 1 });
  area.dir = 'auto';
  area.wrap = 'off';
  area.setAttribute('aria-label', t('sign.textPh'));
  area.placeholder = t('sign.textPh');
  textEdit = { item, area };
  node.classList.add('editing');
  el.stageBox.append(area);
  area.addEventListener('input', () => textChanged());
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); finishTextEdit(true); }
  });
  area.addEventListener('blur', () => { if (textEdit?.area === area) finishTextEdit(); });
  layoutTextEditor();
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
}

// The size of one em of this text on the page, in points.
function textEm(item) {
  const g = state.groupOf[item.page], b = item.box;
  const side = (state.rot[item.page] || 0) % 180 !== 0;
  const viewH = side ? (b.x1 - b.x0) * g.W : (b.y1 - b.y0) * g.H;
  return viewH / (item.sig.lines * TEXT_LINE + 2 * TEXT_PAD);
}

function textChanged() {
  const { item, area } = textEdit;
  const em = textEm(item), g = state.groupOf[item.page], b = item.box;
  const turn = state.rot[item.page] || 0;
  const sig = textItem(area.value, item.sig.color);
  const [bw, bh] = viewToBox(g, turn % 180 !== 0, em * (sig.w + 2 * TEXT_PAD), em * (sig.lines * TEXT_LINE + 2 * TEXT_PAD));
  // Keep the corner it grows from where it is.
  const corner = VIEW_CORNER[turn][isRtlText(area.value) ? 'tr' : 'tl'];
  const [x0, x1] = corner[1] === 'l' ? [b.x0, b.x0 + bw] : [b.x1 - bw, b.x1];
  const [y0, y1] = corner[0] === 't' ? [b.y0, b.y0 + bh] : [b.y1 - bh, b.y1];
  item.sig = sig;
  item.preview = null;
  item.box = clampSign(item, { x0, y0, x1, y1 });
  const node = signNode(item);
  if (node) setSigRect(node);
  layoutTextEditor();
  renderThumbSigns(item.page);
}

// The field sits exactly over the text when that's big enough to read; on
// a small page it's larger than the text, from the same corner.
function layoutTextEditor() {
  const { item, area } = textEdit;
  const node = signNode(item);
  if (!node) return;
  const px = (textEm(item) * el.stage.offsetWidth) / state.groupOf[item.page].W; // one em on screen
  const size = Math.max(16, px);
  Object.assign(area.style, { font: `${size}px/${TEXT_LINE} ${TEXT_FONT}`, color: item.sig.color, padding: `${TEXT_PAD * size}px` });
  area.rows = Math.max(1, area.value.split('\n').length);
  area.style.width = '0';
  area.style.width = `${area.scrollWidth}px`;
  const r = node.getBoundingClientRect(), box = el.stageBox.getBoundingClientRect();
  const rtl = isRtlText(area.value) || (!area.value && isRtl());
  area.style.top = `${r.top - box.top}px`;
  if (rtl) { area.style.left = 'auto'; area.style.right = `${box.right - r.right}px`; }
  else { area.style.right = 'auto'; area.style.left = `${r.left - box.left}px`; }
}

// Done typing: empty text is removed; otherwise it stays selected.
function finishTextEdit(refocus = false) {
  if (!textEdit) return;
  const { item } = textEdit;
  dropTextEditor();
  if (!item.sig.text.trim()) { removeSign(item); return; }
  // Updated in place: a click that ended the typing may be on another
  // item, whose node must stay.
  const node = signNode(item);
  if (!node) return;
  node.setAttribute('aria-label', signLabel(item));
  showPreview(item, node.querySelector('img'));
  if (refocus) node.focus();
}

function dropTextEditor() {
  if (!textEdit) return;
  const { item, area } = textEdit;
  textEdit = null;
  area.remove();
  signNode(item)?.classList.remove('editing');
}

/* ---------- the same signature on every page ---------- */

let activeSign = null; // the placed signature last selected
el.stage.addEventListener('focusin', (e) => {
  const node = e.target.closest('.sig');
  if (!node) return;
  activeSign = node.item;
  el.copyAll.hidden = state.n < 2;
  el.copyDone.hidden = true;
});

// Copy the selected one to every exported page: the same place and size
// relative to each page's crop area, keeping its shape. Pages that already
// have it are skipped, so pressing twice adds nothing.
el.copyAll.addEventListener('click', () => {
  const src = activeSign;
  if (!src || !state.signs.includes(src)) return;
  const c = cropOf(src.page).box, g = state.groupOf[src.page], b = src.box;
  const rx = (b.x0 - c.x0) / (c.x1 - c.x0), ry = (b.y0 - c.y0) / (c.y1 - c.y0), rw = (b.x1 - b.x0) / (c.x1 - c.x0);
  const shape = ((b.y1 - b.y0) * g.H) / ((b.x1 - b.x0) * g.W); // height / width, in points
  let added = 0;
  for (const p of state.order) {
    if (p === src.page || !state.selected[p] || state.signs.some((x) => x.page === p && x.sig === src.sig)) continue;
    const c2 = cropOf(p).box, g2 = state.groupOf[p];
    const w = rw * (c2.x1 - c2.x0), h = (w * g2.W * shape) / g2.H;
    const x0 = c2.x0 + rx * (c2.x1 - c2.x0), y0 = c2.y0 + ry * (c2.y1 - c2.y0);
    const item = { page: p, sig: src.sig, preview: src.preview };
    item.box = clampSign(item, { x0, y0, x1: x0 + w, y1: y0 + h });
    state.signs.push(item);
    renderThumbSigns(p);
    added++;
  }
  el.copyDone.textContent = t('sign.copied', { n: added });
  el.copyDone.hidden = false;
});

/* ---------- saved signatures (this browser only) ---------- */

// Kept in this browser's local storage, newest first, never uploaded. A
// signature is plain data (strokes, typed text and font, or a small PNG),
// so it redraws sharp. If storage is blocked or full, nothing is saved and
// signing still works.
const SAVED_KEY = 'pared-signatures', MAX_SAVED = 4;

function savedSignatures() {
  try {
    const list = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
    return Array.isArray(list) ? list.filter((x) => x?.sig?.kind) : [];
  } catch { return []; }
}

function storeSaved(list) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(list)); return true; } catch (err) { console.warn('could not save the signature', err); return false; }
}

function rememberSignature(sig) {
  const key = JSON.stringify(sig);
  const list = [{ id: `s${Date.now().toString(36)}`, sig }, ...savedSignatures().filter((x) => JSON.stringify(x.sig) !== key)];
  // If it doesn't fit, try with fewer old ones before giving up.
  for (let n = Math.min(MAX_SAVED, list.length); n > 0; n--) if (storeSaved(list.slice(0, n))) break;
  renderSaved();
}

function forgetSignature(id) {
  storeSaved(savedSignatures().filter((x) => x.id !== id));
  renderSaved();
}

function renderSaved() {
  const list = savedSignatures();
  el.savedSigs.hidden = !list.length;
  el.savedList.replaceChildren(...list.map((x, i) => {
    const item = Object.assign(document.createElement('div'), { className: 'saved-item' });
    const use = Object.assign(document.createElement('button'), { type: 'button', className: 'saved-sig' });
    use.setAttribute('aria-label', t('sign.useSaved', { n: i + 1 }));
    use.title = t('sign.useSavedTitle');
    const img = Object.assign(document.createElement('img'), { alt: '' });
    signaturePreview(x.sig).then((url) => { img.src = url; }).catch(() => {});
    use.append(img);
    use.addEventListener('click', () => { if (state) placeSignature(x.sig); });
    const forget = Object.assign(document.createElement('button'), { type: 'button', className: 'saved-forget', textContent: '×' });
    forget.setAttribute('aria-label', t('sign.forget', { n: i + 1 }));
    forget.title = t('sign.forgetTitle');
    forget.addEventListener('click', () => forgetSignature(x.id));
    item.append(use, forget);
    return item;
  }));
}

// Put a new signature in the middle of the current page's crop area, about a
// third of its width as shown, keeping the signature's shape. On a turned
// page "as shown" is across the page's own height, so the box is swapped.
function placeSignature(sig, { width = 0.35 } = {}) {
  const crop = cropOf(state.page).box;
  const SW = el.stage.offsetWidth, SH = el.stage.offsetHeight;
  const side = (state.rot[state.page] || 0) % 180 !== 0;
  const cw = (crop.x1 - crop.x0) * SW, ch = (crop.y1 - crop.y0) * SH;
  const [viewW, viewH] = side ? [ch, cw] : [cw, ch];
  let w = viewW * width, h = w / sig.aspect;
  if (h > viewH * 0.25) { w *= (viewH * 0.25) / h; h = viewH * 0.25; }
  const [bw, bh] = side ? [h / SW, w / SH] : [w / SW, h / SH];
  const cx = (crop.x0 + crop.x1) / 2, cy = (crop.y0 + crop.y1) / 2;
  const item = { page: state.page, sig, box: { x0: cx - bw / 2, y0: cy - bh / 2, x1: cx + bw / 2, y1: cy + bh / 2 } };
  state.signs.push(item);
  renderSigns();
  signNode(item)?.focus();
}

// Position a signature's box on the stage. On a turned page the image is
// turned back, so it reads upright as the page is shown and exported.
// The page corner (in the page's own frame) that shows top-right (×) and
// bottom-right (resize) on screen, for each turn of the page.
const DEL_CORNER = { 0: 'tr', 90: 'tl', 180: 'bl', 270: 'br' };
const RS_CORNER = { 0: 'br', 90: 'tr', 180: 'tl', 270: 'bl' };
function placeAtCorner(el, corner) {
  // 'auto', not '': clearing would fall back to the stylesheet's own corner.
  Object.assign(el.style, { top: 'auto', bottom: 'auto', left: 'auto', right: 'auto' });
  // Outside the corner, so even a small check mark isn't covered by them.
  el.style[corner[0] === 't' ? 'top' : 'bottom'] = '-24px';
  el.style[corner[1] === 'l' ? 'left' : 'right'] = '-24px';
}

function setSigRect(node) {
  const { box, page } = node.item;
  setRect(node, box);
  const turn = state.rot[page] || 0;
  placeAtCorner(node.querySelector('.sig-del'), DEL_CORNER[turn]);
  placeAtCorner(node.querySelector('.sig-rs'), RS_CORNER[turn]);
  const img = node.querySelector('img');
  const deg = state.rot[page] || 0;
  if (!deg) { img.removeAttribute('style'); return; }
  const w = (box.x1 - box.x0) * el.stage.offsetWidth, h = (box.y1 - box.y0) * el.stage.offsetHeight;
  const [iw, ih] = deg % 180 ? [h, w] : [w, h];
  Object.assign(img.style, { position: 'absolute', left: '50%', top: '50%', width: `${iw}px`, height: `${ih}px`,
    transform: `translate(-50%, -50%) rotate(${-deg}deg)` });
}

const signNodes = new Map(); // item -> element on the stage

function signNode(item) { return signNodes.get(item); }

function renderSigns() {
  if (textEdit && !(state && state.signs.includes(textEdit.item) && textEdit.item.page === state.page)) dropTextEditor();
  for (const node of signNodes.values()) node.remove();
  signNodes.clear();
  if (!state) return;
  for (const item of state.signs.filter((x) => x.page === state.page)) {
    const node = document.createElement('div');
    node.className = 'sig';
    node.tabIndex = 0;
    node.setAttribute('role', 'group'); // not img: an image can't hold the × button
    node.setAttribute('aria-label', signLabel(item));
    const img = document.createElement('img');
    img.alt = '';
    showPreview(item, img);
    const del = Object.assign(document.createElement('button'), { type: 'button', className: 'sig-del', textContent: '×' });
    del.setAttribute('aria-label', t('sign.remove'));
    del.title = t('sign.remove');
    const rs = document.createElement('div');
    rs.className = 'sig-rs';
    rs.title = t('sign.resize');
    node.append(img, del, rs);
    node.item = item;
    setSigRect(node);
    if (textEdit?.item === item) node.classList.add('editing');
    el.stage.append(node);
    signNodes.set(item, node);
  }
  el.signHint.hidden = !state.signs.length;
  renderThumbSigns(state.page);
  if (textEdit) layoutTextEditor();
}

// Typed ones (names, initials, dates, text) say what they say.
function signLabel(item) {
  const { kind, text, mark } = item.sig;
  if (kind === 'text') return `${text || t('sign.textPh')}. ${t('sign.textAria')}`;
  if (kind === 'mark') return `${t(mark === 'cross' ? 'sign.cross' : 'sign.check')}. ${t('sign.markAria')}`;
  return kind === 'type' ? `${text}. ${t('sign.itemAria')}` : t('sign.itemAria');
}

function showPreview(item, img) {
  const p = (item.preview ??= signaturePreview(item.sig));
  p.then((url) => { if (item.preview === p) img.src = url; });
}

function removeSign(item) {
  state.signs = state.signs.filter((x) => x !== item);
  if (activeSign === item) { activeSign = null; el.copyAll.hidden = true; }
  renderSigns();
}

// Keep a signature inside its page's crop area, so it isn't cut off.
function clampSign(item, b) {
  const c = cropOf(item.page).box;
  const w = Math.min(b.x1 - b.x0, c.x1 - c.x0), h = Math.min(b.y1 - b.y0, c.y1 - c.y0);
  const x0 = Math.min(Math.max(b.x0, c.x0), c.x1 - w), y0 = Math.min(Math.max(b.y0, c.y0), c.y1 - h);
  return { x0, y0, x1: x0 + w, y1: y0 + h };
}

let signDrag = null, thumbSignFrame = 0;
el.stage.addEventListener('pointerdown', (e) => {
  let node = e.target.closest('.sig');
  if (!node || e.button > 0) return;
  e.stopPropagation();
  if (e.target.closest('.sig-del')) return;
  // Finish typing first: an empty text goes, and the page's items with it
  // are drawn again.
  if (textEdit) { const item = node.item; finishTextEdit(); node = signNode(item); if (!node) return; }
  e.preventDefault();
  const wasFocused = document.activeElement === node;
  node.focus();
  node.setPointerCapture(e.pointerId);
  signDrag = { node, item: node.item, id: e.pointerId, resize: !!e.target.closest('.sig-rs'), wasFocused,
    sx: e.clientX, sy: e.clientY, w: el.stage.offsetWidth, h: el.stage.offsetHeight, start: { ...node.item.box } };
});
el.stage.addEventListener('pointermove', (e) => {
  if (!signDrag || e.pointerId !== signDrag.id) return;
  const d = signDrag, b = d.start;
  const [dx, dy] = screenToSheet(e.clientX - d.sx, e.clientY - d.sy);
  let nb;
  if (d.resize) {
    // Corner drag: grow or shrink, keeping the signature's shape, from the
    // corner opposite the handle (which sits bottom-right as shown, at a
    // different corner of the page's own frame when the page is turned).
    // At most as big as the crop area; clampSign then slides it back inside
    // if it grew past an edge.
    const aspect = ((b.x1 - b.x0) * d.w) / ((b.y1 - b.y0) * d.h);
    const c = cropOf(d.item.page).box;
    const corner = RS_CORNER[state.rot[d.item.page] || 0];
    const right = corner[1] === 'r', bottom = corner[0] === 'b';
    const maxW = Math.min(c.x1 - c.x0, ((c.y1 - c.y0) * d.h * aspect) / d.w);
    const nw = Math.min(maxW, Math.max(0.03, b.x1 - b.x0 + (right ? dx : -dx)));
    const nh = (nw * d.w) / aspect / d.h;
    const [x0, x1] = right ? [b.x0, b.x0 + nw] : [b.x1 - nw, b.x1];
    const [y0, y1] = bottom ? [b.y0, b.y0 + nh] : [b.y1 - nh, b.y1];
    nb = { x0, y0, x1, y1 };
  } else {
    nb = { x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy };
  }
  d.item.box = clampSign(d.item, nb);
  setSigRect(d.node);
  cancelAnimationFrame(thumbSignFrame);
  thumbSignFrame = requestAnimationFrame(() => renderThumbSigns(d.item.page));
});
const endSignDrag = (e) => {
  if (!signDrag || e.pointerId !== signDrag.id) return;
  const d = signDrag;
  signDrag = null;
  // A tap on text that was already selected (a second tap, or a double
  // click) opens it for typing; on small text the tap may land on its
  // resize button, which does nothing without a drag.
  const still = Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 5;
  if (e.type === 'pointerup' && still && d.wasFocused && d.item.sig.kind === 'text') editText(d.item);
};
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
  if ((e.key === 'Enter' || e.key === 'F2') && item.sig.kind === 'text') { e.preventDefault(); editText(item); return; }
  // Arrows move it on screen, whichever way the page is turned.
  const px = step * el.stage.offsetWidth;
  const key = { ArrowLeft: [-px, 0], ArrowRight: [px, 0], ArrowUp: [0, -px], ArrowDown: [0, px] }[e.key];
  if (!key) return;
  e.preventDefault();
  e.stopPropagation(); // not the page arrows
  const mv = screenToSheet(...key);
  item.box = clampSign(item, { x0: b.x0 + mv[0], y0: b.y0 + mv[1], x1: b.x1 + mv[0], y1: b.y1 + mv[1] });
  setSigRect(node);
  renderThumbSigns(item.page);
});

// What the engine needs: each signature as a PNG sized for 300 ppi at its
// size on the page, and its rectangle in PDF user space.
async function signatureStamps() {
  const stamps = [];
  for (const item of state.signs) {
    if (!state.selected[item.page]) continue;
    const vp = (await getPage(item.page)).getViewport({ scale: 1 });
    const b = item.box;
    // Drawn the way it shows: on a page turned a quarter, across the box.
    const side = (state.rot[item.page] || 0) % 180 !== 0;
    const [pw, ph] = side ? [(b.y1 - b.y0) * vp.height, (b.x1 - b.x0) * vp.width] : [(b.x1 - b.x0) * vp.width, (b.y1 - b.y0) * vp.height];
    const k = Math.min(300 / 72, 2400 / pw);
    const png = await signaturePng(item.sig, pw * k, ph * k);
    stamps.push({ page: item.page - 1, rect: pdfRect(vp, b), png });
  }
  return stamps;
}

// A box in the page's 0..1 units as a rectangle in PDF user space.
function pdfRect(vp, b) {
  const [ax, ay] = vp.convertToPdfPoint(b.x0 * vp.width, b.y0 * vp.height);
  const [bx, by] = vp.convertToPdfPoint(b.x1 * vp.width, b.y1 * vp.height);
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
}

/* ---------- page numbers and watermark ---------- */

// Added to every exported page when the export runs, and shown on the page
// in the preview. Positions follow the page as cropped and turned.

for (const c of [el.numOn, el.numWhere, el.numStyle, el.wmOn]) c.addEventListener('change', marksChanged);
el.wmText.addEventListener('input', marksChanged);

function marksChanged() {
  el.numOpts.hidden = !el.numOn.checked;
  el.wmOpts.hidden = !el.wmOn.checked;
  if (el.wmOn.checked && document.activeElement === el.wmOn && !el.wmText.value) el.wmText.focus();
  schedulePageMarks();
}

// The style menu shows what the numbers look like for this document.
function showNumStyles() {
  if (!state) return;
  const total = keepList().length || state.n;
  for (const o of el.numStyle.options) o.textContent = numberText(o.value, 1, total);
}

function numberText(style, n, total) {
  return style === 'of' ? ltr(`${n} / ${total}`) : style === 'page' ? t('marks.pageOf', { n, total }) : String(n);
}

// The crop as shown, in points across and down, and its turn.
function shownCrop(p) {
  const g = state.groupOf[p], c = cropOf(p).box, deg = state.rot[p] || 0;
  const cw = (c.x1 - c.x0) * g.W, ch = (c.y1 - c.y0) * g.H;
  return { c, deg, vw: deg % 180 ? ch : cw, vh: deg % 180 ? cw : ch };
}

// [u0, v0, u1, v1] in 0..1 of the page as shown, to a box in the page's own
// 0..1 units: undo the turn (clockwise), then place it in the crop.
function shownToBox(p, [u0, v0, u1, v1]) {
  const { c, deg } = shownCrop(p);
  const back = (u, v) => (deg === 90 ? [v, 1 - u] : deg === 180 ? [1 - u, 1 - v] : deg === 270 ? [1 - v, u] : [u, v]);
  const [a, b] = [back(u0, v0), back(u1, v1)];
  const x = (f) => c.x0 + f * (c.x1 - c.x0), y = (f) => c.y0 + f * (c.y1 - c.y0);
  return { x0: x(Math.min(a[0], b[0])), y0: y(Math.min(a[1], b[1])), x1: x(Math.max(a[0], b[0])), y1: y(Math.max(a[1], b[1])) };
}

// What page p gets: [{ kind, text, box, w, h }], w×h in points as shown.
function marksFor(p) {
  if (!state.selected[p]) return [];
  const out = [], { vw, vh } = shownCrop(p);
  if (el.numOn.checked) {
    const kept = keepList();
    const text = numberText(el.numStyle.value, kept.indexOf(p - 1) + 1, kept.length);
    const h = NUMBER_PT * NUMBER_LINE, w = (textWidth(text) + 0.6) * NUMBER_PT;
    out.push({ kind: 'number', text, w, h, box: shownToBox(p, numberSpot(el.numWhere.value, w, h, vw, vh)) });
  }
  const wm = el.wmText.value.trim();
  if (el.wmOn.checked && wm) out.push({ kind: 'watermark', text: wm, w: vw, h: vh, box: shownToBox(p, [0, 0, 1, 1]) });
  return out;
}

const drawMark = (m, w, h) => (m.kind === 'number' ? numberCanvas(m.text, w, h) : watermarkCanvas(m.text, w, h));

let marksFrame = 0;
function schedulePageMarks() {
  cancelAnimationFrame(marksFrame);
  marksFrame = requestAnimationFrame(renderPageMarks);
}

// The preview: each mark as an image on the stage, turned back on a turned
// page (as signatures are), so it reads as it will be exported.
function renderPageMarks() {
  for (const n of el.stage.querySelectorAll('.page-mark')) n.remove();
  if (!state || !state.groups.every((g) => g.done)) return;
  const p = state.page, g = state.groupOf[p], deg = state.rot[p] || 0;
  const scale = (el.stage.offsetWidth / g.W) * Math.min(2, window.devicePixelRatio || 1);
  for (const m of marksFor(p)) {
    const node = Object.assign(document.createElement('div'), { className: `page-mark pm-${m.kind}` });
    const canvas = drawMark(m, m.w * scale, m.h * scale);
    canvas.setAttribute('aria-hidden', 'true');
    setRect(node, m.box);
    const w = (m.box.x1 - m.box.x0) * el.stage.offsetWidth, h = (m.box.y1 - m.box.y0) * el.stage.offsetHeight;
    const [iw, ih] = deg % 180 ? [h, w] : [w, h];
    Object.assign(canvas.style, { position: 'absolute', left: '50%', top: '50%', width: `${iw}px`, height: `${ih}px`,
      transform: `translate(-50%, -50%) rotate(${-deg}deg)` });
    node.append(canvas);
    el.stage.append(node);
  }
}

// For the engine: numbers at 300 ppi; the watermark at 150, which is plenty
// for large soft letters, drawn once for pages of the same shape.
async function markStamps() {
  const stamps = [], shared = new Map();
  for (const i of keepList()) {
    const p = i + 1, vp = (await getPage(p)).getViewport({ scale: 1 });
    for (const m of marksFor(p)) {
      const k = Math.min((m.kind === 'number' ? 300 : 150) / 72, 3000 / Math.max(m.w, m.h));
      const key = `${m.kind}|${m.text}|${Math.round(m.w)}|${Math.round(m.h)}`;
      if (!shared.has(key)) shared.set(key, await canvasPng(drawMark(m, m.w * k, m.h * k)));
      stamps.push({ page: i, rect: pdfRect(vp, m.box), png: shared.get(key) });
    }
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
  const src = await readSources();
  if (my !== session || estimateKey !== key) return;
  let w = null;
  try {
    // Crop boxes don't change the size noticeably; the page subset does, so
    // only that is sent.
    const sizes = await oneShot('estimate', src, {
      keep, removePassword: !el.keepPw.checked, presets: PRESETS.map((ppi) => ({ ppi, quality: QUALITY[ppi] ?? 78 })),
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
function oneShot(kind, src, opts, onStart) {
  const w = new Worker(new URL('./export-worker.js', import.meta.url), { type: 'module' });
  onStart?.(w);
  return new Promise((resolve, reject) => {
    // Messages sent before the worker has loaded mupdf can be lost, so wait
    // for "ready" before sending the job.
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') w.postMessage({ id: 0, kind, bytes: src.input, opts: { ...opts, password: src.password } }, src.transfer);
      else if (m.type === 'done') resolve(m.result);
      else if (m.type === 'error') reject(new Error(m.message));
    };
    w.onerror = (e) => reject(new Error(e.message || `${kind} failed`));
  }).finally(() => w.terminate());
}

/* ---------- several files ---------- */

// The open file a page (1-based, through all files) comes from.
function docOf(p) { return state.files.find((d) => p > d.offset && p <= d.offset + d.n); }
function getPage(p) { const d = docOf(p); return d.pdf.getPage(p - d.offset); }
const baseName = (file) => file.name.replace(/\.pdf$/i, '');

// Fresh copies of the files for a worker: one PDF as bytes, several as a
// list to merge, each with its password. Transferred, not copied.
async function readSources() {
  const datas = await Promise.all(state.files.map(async (d) => new Uint8Array(await d.file.arrayBuffer())));
  return {
    input: datas.length === 1 ? datas[0] : state.files.map((d, k) => ({ bytes: datas[k], password: d.password })),
    password: state.files[0].password,
    transfer: datas.map((b) => b.buffer),
  };
}

/* ---------- save as: one PDF, one per file, or parts ---------- */

el.outMode.addEventListener('change', () => { el.everyField.hidden = el.outMode.value !== 'every'; showDownloadLabel(); });
el.everyN.addEventListener('input', showDownloadLabel);

function setupOutput() {
  const several = state.files.length > 1;
  const perFile = el.outMode.querySelector('option[value="files"]');
  perFile.disabled = perFile.hidden = !several;
  el.outMode.value = several ? 'files' : 'one';
  el.everyField.hidden = true;
  el.everyN.value = '1';
}

// Groups of output pages (0-based positions in the exported order) and a
// name for each, or null for a single PDF.
function outputGroups() {
  const order = keepList();
  let groups = null;
  if (el.outMode.value === 'files' && state.files.length > 1) {
    const byFile = new Map();
    order.forEach((src, i) => {
      const d = docOf(src + 1);
      if (!byFile.has(d)) byFile.set(d, []);
      byFile.get(d).push(i);
    });
    groups = [...byFile].map(([d, pages]) => ({ name: baseName(d.file), pages }));
  } else if (el.outMode.value === 'every') {
    const n = Math.max(1, Math.floor(Number(el.everyN.value) || 1));
    const base = baseName(state.files[0].file);
    groups = [];
    for (let i = 0; i < order.length; i += n) {
      const pages = order.slice(i, i + n).map((_, k) => i + k);
      groups.push({ name: pages.length === 1 ? `${base}_p${i + 1}` : `${base}_p${i + 1}-${i + pages.length}`, pages });
    }
  }
  // Names must differ inside the ZIP.
  const seen = new Map();
  for (const g of groups ?? []) {
    const k = seen.get(g.name) ?? 0;
    seen.set(g.name, k + 1);
    if (k) g.name += `_${k + 1}`;
  }
  return groups && groups.length > 1 ? groups : null;
}

function showDownloadLabel() {
  const pages = selectedPages().length;
  if (!pages) { el.download.textContent = t('export.selectOne'); return; }
  const groups = outputGroups();
  el.download.textContent = groups ? t('export.downloadZip', { n: groups.length }) : t('export.downloadN', { n: pages });
}

/* ---------- hidden details (metadata) ---------- */

el.strip.addEventListener('change', () => { showStripHint(); renderHidden(); });

const clip = (v, n = 60) => { const s = String(v).trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
// Values can be in any script: isolate them inside right-to-left text.
const iso = (v, n) => (isRtl() ? `⁨${clip(v, n)}⁩` : clip(v, n));

// Document info fields worth showing, in order, with their labels.
const INFO_FIELDS = [['Title', 'meta.f.title'], ['Author', 'meta.f.author'], ['Subject', 'meta.f.subject'], ['Keywords', 'meta.f.keywords'],
  ['Creator', 'meta.f.creator'], ['Producer', 'meta.f.producer'], ['CreationDate', 'meta.f.created'], ['ModDate', 'meta.f.modified']];

// Say what the PDF carries, so the choice is concrete: "This PDF has:
// author "Shai", made with Keynote, dates, where a photo was taken."
function showStripHint() {
  const infos = state?.files?.map((d) => d.meta?.info ?? {}) ?? [];
  const found = [];
  const authors = [...new Set(infos.map((i) => i.Author?.trim()).filter(Boolean))];
  if (authors.length) found.push(t('meta.author', { v: authors.map((a) => iso(a, 40)).join(', ') }));
  const tools = [...new Set(infos.map((i) => i.Creator?.trim() || i.Producer?.trim()).filter(Boolean))];
  if (tools.length) found.push(t('meta.software', { v: tools.map((a) => iso(a, 40)).join(', ') }));
  if (infos.some((i) => i.CreationDate || i.ModDate)) found.push(t('meta.dates'));
  if (state?.files?.some((d) => d.meta?.metadata)) found.push(t('meta.xmp'));
  const photos = state?.found?.photos ?? [];
  if (photos.some((p) => p.lat != null)) found.push(t('meta.location'));
  else if (photos.length) found.push(t('meta.photos', { n: photos.length }));
  if (state?.found?.apps.length) found.push(t('meta.appsShort'));
  const list = found.length ? ` ${t('export.stripFound', { list: found.join(', ') })}` : '';
  el.stripHint.textContent = (el.strip.checked ? t('export.stripOn') : t('export.stripOff')) + list;
}

function pdfDate(v) {
  const d = pdfjsLib.PDFDateString.toDateObject(v);
  return d ? new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(d) : v;
}
function exifDate(v) {
  const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d)/.exec(v ?? '');
  // EXIF times have no time zone: show them as written.
  return m ? new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })
    .format(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5])) : v;
}

// Everything found, file by file, each marked removed or kept on export.
function renderHidden() {
  const files = state?.files ?? [];
  const sections = files.map((d, k) => {
    const rows = [];
    const info = d.meta?.info ?? {};
    for (const [key, label] of INFO_FIELDS) {
      const v = info[key];
      if (typeof v !== 'string' || !v.trim()) continue;
      rows.push([t(label), /Date$/.test(key) ? pdfDate(v) : iso(v), key === 'Title']);
    }
    for (const [key, v] of Object.entries(info.Custom ?? {})) if (String(v).trim()) rows.push([ltr(key), iso(v), false]);
    const xmp = d.meta?.metadata?.getAll?.() ?? {};
    for (const [key, v] of Object.entries(xmp).slice(0, 12)) {
      const val = Array.isArray(v) ? v.join(', ') : v;
      if (String(val ?? '').trim()) rows.push([ltr(key), iso(val), false]);
    }
    (state.found?.photos ?? []).filter((p) => (p.file ?? 0) === k).forEach((p, i) => {
      const parts = [p.camera && iso(p.camera, 40), p.taken && t('meta.taken', { when: exifDate(p.taken) }),
        p.lat != null && t('meta.at', { place: ltr(`${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`) }),
        p.software && t('meta.editedWith', { v: iso(p.software, 30) })].filter(Boolean);
      rows.push([t('meta.photo', { n: i + 1 }), parts.join(' · '), false]);
    });
    const apps = (state.found?.apps ?? []).filter((a) => (a.file ?? 0) === k).map((a) => a.name ?? a);
    if (apps.length) rows.push([t('meta.apps'), apps.map((a) => iso(a, 30)).join(', '), false]);
    return { name: d.file.name, rows };
  }).filter((sec) => sec.rows.length);

  el.metaDetails.hidden = !sections.length;
  el.metaList.replaceChildren(...sections.map((sec) => {
    const frag = document.createDocumentFragment();
    if (files.length > 1) frag.append(Object.assign(document.createElement('h4'), { textContent: sec.name }));
    const dl = document.createElement('dl');
    for (const [label, value, kept] of sec.rows) {
      const dt = Object.assign(document.createElement('dt'), { textContent: label });
      const dd = Object.assign(document.createElement('dd'), { textContent: value });
      const removed = el.strip.checked && !kept;
      dd.append(' ', Object.assign(document.createElement('span'), { className: `mtag ${removed ? 'gone' : 'kept'}`, textContent: t(removed ? 'meta.removed' : 'meta.kept') }));
      dl.append(dt, dd);
    }
    frag.append(dl);
    return frag;
  }));
}

/* ---------- existing digital signatures, photo details ---------- */

// Exporting rewrites the file, which breaks any digital signature in it, so
// say so up front; and photo details hide inside images, where pdf.js can't
// look. Both need mupdf, which means a copy of every file in a worker, so on
// devices where the file is large it only runs when pdf.js sees signature
// fields (it can't tell whether they're signed).
async function inspectFiles(my) {
  let sigFields = false;
  for (const d of state.files) {
    const fields = await d.pdf.getFieldObjects().catch(() => null);
    if (my !== session) return;
    sigFields ||= !!fields && Object.values(fields).flat().some((f) => f.type === 'signature');
  }
  if (state.large && !sigFields) return;
  const src = await readSources();
  if (my !== session) return;
  try {
    const found = await oneShot('inspect', src, {});
    if (my !== session) return;
    state.signed = found.signed;
    state.found = found;
    showSigWarn();
    showStripHint();
    renderHidden();
  } catch (err) {
    console.warn('inspection failed', err);
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
    t('export.estimateNow', { size: fmtBytes(state.size) }));
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
      const vp = (await getPage(i)).getViewport({ scale: 1 });
      const [ax, ay] = vp.convertToPdfPoint(b.x0 * vp.width, b.y0 * vp.height);
      const [bx, by] = vp.convertToPdfPoint(b.x1 * vp.width, b.y1 * vp.height);
      boxes.push([Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)].map((v) => Math.round(v * 1000) / 1000));
    }
    const ppi = Number(el.ppi.value);
    const compress = el.compress.checked ? { ppi, quality: QUALITY[ppi] ?? 78 } : null;
    const stamps = [...await signatureStamps(), ...await markStamps()];
    const fields = await fieldFills();

    say(t('export.loading'));
    await warmWorker();
    if (my !== session) return;
    const id = ++jobId;
    const src = await readSources();
    const groups = outputGroups();
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
            say(m.phase === 'split' ? t('export.split', { done: m.done + 1, total: m.total })
              : t(['open', 'pages', 'scan', 'save'].includes(m.phase) ? `export.${m.phase}` : 'export.working'));
          }
        },
      });
      // Transferred, not copied: the worker owns the only copy from here on.
      worker.postMessage({ id, bytes: src.input, opts: { boxes, keep: keepList(),
        rotate: Array.from(state.rot.subarray(1)), compress, stamps, fields, stripMetadata: el.strip.checked,
        password: src.password, removePassword: !el.keepPw.checked, split: groups?.map((g) => g.pages) } }, src.transfer);
    });
    retireWorker();
    if (my !== session) return;

    const suffix = compress ? `_${ppi}ppi` : '_cropped';
    let name, blob, after;
    if (groups) {
      // Several PDFs: one ZIP download, since browsers block bursts of them.
      const zip = makeZip(groups.map((g, k) => ({ name: `${g.name}${suffix}.pdf`, bytes: result.parts[k] })));
      name = `${baseName(state.files[0].file)}${suffix}.zip`;
      blob = new Blob([zip], { type: 'application/zip' });
      after = result.parts.reduce((t, b) => t + b.length, 0);
    } else {
      name = `${baseName(state.files[0].file)}${suffix}.pdf`;
      blob = new Blob([result.bytes], { type: 'application/pdf' });
      after = result.bytes.length;
    }
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    el.saveProgress.hidden = true;
    const before = state.size;
    const line = document.createElement('div');
    line.className = 'result';
    line.append(groups ? t('export.savedMany', { name: ltr(name), n: groups.length, before: fmtBytes(before) })
      : t('export.saved', { name: ltr(name), before: fmtBytes(before) }));
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

// A deployed version installs in the background and waits (see sw.js). It
// takes over at a moment that can't lose work: straight away on the start
// screen, after "Reload" or "Start over" when a file is open. The page only
// reloads for a switch it asked for.
let waitingWorker = null, switching = false;
// Only a page that was already running on an earlier version can be
// updated. On a first visit the new worker takes control by itself, and
// some browsers (WebKit) report it as installed only after that: without
// this, that first install looked like an update and reloaded the page.
const ranOnEarlierVersion = !!navigator.serviceWorker?.controller;

function applyUpdate() {
  if (!waitingWorker) return;
  switching = true;
  waitingWorker.postMessage({ type: 'skip-waiting' });
}

function offerUpdate(reg) {
  const worker = reg.waiting;
  if (!worker || !ranOnEarlierVersion) return;
  waitingWorker = worker;
  if (!state) applyUpdate();
  else el.updateBar.hidden = false;
}

el.updateBtn.addEventListener('click', applyUpdate);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (switching) location.reload(); });
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      offerUpdate(reg);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => { if (w.state === 'installed') offerUpdate(reg); });
      });
    } catch (err) {
      console.warn('offline support unavailable', err);
    }
  });
}

/* ---------- opening PDFs from outside the page ---------- */

// "Open with" on an installed app (File Handling API).
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async ({ files }) => {
    if (files?.length) open(await Promise.all(files.map((h) => h.getFile())));
  });
}

// Shared from another app (Web Share Target): the service worker parks the
// file in a cache and redirects here with ?shared=1.
async function openShared() {
  if (!new URLSearchParams(location.search).has('shared') || !('caches' in window)) return;
  history.replaceState(null, '', location.pathname);
  const cache = await caches.open('pared-share');
  // One or more files (several photos can be shared at once), in order.
  const files = [];
  for (let k = 0; ; k++) {
    const res = await cache.match(`shared-${k}`);
    if (!res) break;
    const name = decodeURIComponent(res.headers.get('x-filename') || 'shared.pdf');
    files.push(new File([await res.blob()], name, { type: res.headers.get('content-type') || 'application/pdf' }));
    await cache.delete(`shared-${k}`);
  }
  if (files.length) open(files);
}
openShared();

/* ---------- language ---------- */

function storedLang() { try { return localStorage.getItem('pared-lang'); } catch { return null; } }

setLang(pickLang({ search: location.search, saved: storedLang(), languages: navigator.languages || [navigator.language || ''] }));
showVersion();
renderSaved();
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
  renderSaved();
  showDlgTitle();
  if (!el.pwCard.hidden) showPwText();
  if (state) { showStripHint(); renderHidden(); }
  if (state) { renderSigns(); showNumStyles(); schedulePageMarks(); }
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
  el.fmeta.textContent = t('file.meta', { size: fmtBytes(state.size), n: state.n, sheet: fmtSheet(g0.W, g0.H) });
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
