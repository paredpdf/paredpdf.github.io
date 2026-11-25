import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pageLines, textBoxes, findSpots, findCells, findCheckboxes, findBlanks, freeSpace } from '../formspots.js';
import { flatFormPdf, FLAT_FORM, mupdf } from './fixtures.js';

const { OPS } = pdfjs;
const inside = (r, [x, y]) => x > r[0] && x < r[2] && y > r[1] && y < r[3];
const within = (a, b, slack = 3) => a[0] >= b[0] - slack && a[1] >= b[1] - slack && a[2] <= b[2] + slack && a[3] <= b[3] + slack;

async function readPage(bytes) {
  const pdf = await pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise;
  const page = await pdf.getPage(1);
  const list = await page.getOperatorList();
  const text = await page.getTextContent();
  const fontName = (id) => { try { return page.commonObjs.get(id)?.name ?? ''; } catch { return ''; } };
  const out = { lines: pageLines(list.fnArray, list.argsArray, OPS), texts: textBoxes(text.items, fontName), view: page.view };
  await pdf.destroy();
  return out;
}

const pageWith = (content) => {
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, {}, content));
  return doc.saveToBuffer('').asUint8Array().slice();
};

test('reads the lines a page draws, through transforms and rectangles', async () => {
  const { lines } = await readPage(pageWith('q 1 0 0 1 10 20 cm 0 0 m 100 0 l S Q 50 50 100 40 re S 300 300 m 300 400 l S'));
  assert.ok(lines.h.some((s) => Math.abs(s.y - 20) < 0.1 && Math.abs(s.x0 - 10) < 0.1 && Math.abs(s.x1 - 110) < 0.1));
  assert.ok(lines.h.some((s) => Math.abs(s.y - 90) < 0.1 && s.x0 < 50.1 && s.x1 > 149.9));
  assert.ok(lines.v.some((s) => Math.abs(s.x - 150) < 0.1 && s.y0 < 50.1 && s.y1 > 89.9));
  assert.ok(lines.v.some((s) => Math.abs(s.x - 300) < 0.1 && s.y1 - s.y0 > 99.9));
});

test('joins a double line drawn as a frame and its shadow into whole lines', async () => {
  // Two copies of one edge, half a point apart, of different lengths.
  const { lines } = await readPage(pageWith('100 100 m 100 400 l S 100.5 300 m 100.5 700 l S'));
  assert.equal(lines.v.length, 1);
  assert.ok(lines.v[0].y0 < 100.1 && lines.v[0].y1 > 699.9);
});

test('finds the cells, checkboxes and blank line of a flat form', async () => {
  const spots = findSpots(await readPage(flatFormPdf()));
  const checks = spots.filter((s) => s.kind === 'check'), texts = spots.filter((s) => s.kind === 'text');
  assert.equal(checks.length, 2);
  for (const [x, y] of FLAT_FORM.checks) {
    const c = FLAT_FORM.checkSize;
    assert.ok(checks.some((s) => inside(s.rect, [x + c * 0.35, y + c * 0.35])), `a checkbox at ${x},${y}`);
  }
  assert.equal(texts.length, 3);
  // Each cell's place is below its label, inside the cell.
  for (const cell of FLAT_FORM.cells) {
    const s = texts.find((t) => within(t.rect, cell, 0.1));
    assert.ok(s, `a place in ${cell}`);
    assert.ok(s.rect[3] < 729, 'below the label');
    assert.ok(s.rect[3] - s.rect[1] >= 7);
  }
  const [x0, y, x1] = FLAT_FORM.blank;
  assert.ok(texts.some((t) => Math.abs(t.rect[0] - x0) < 1 && Math.abs(t.rect[2] - x1) < 1 && t.rect[1] >= y && t.rect[1] < y + 2), 'above the blank line');
  assert.ok(texts.every((t) => !t.rtl), 'an English form reads from the left');
});

test('a page without boxes has nowhere to write', async () => {
  assert.deepEqual(findSpots(await readPage(pageWith('BT /F1 12 Tf 72 700 Td (Just a letter.) Tj ET'))), []);
});

test('a cell of choices is left to its checkboxes', () => {
  const lines = { h: [{ y: 100, x0: 0, x1: 200 }, { y: 140, x0: 0, x1: 200 }], v: [{ x: 0, y0: 100, y1: 140 }, { x: 200, y0: 100, y1: 140 }] };
  const texts = [{ str: 'q', x0: 10, y0: 110, x1: 19, y1: 122, size: 12, x: 10, y: 112, upright: true, font: 'ZapfDingbats', rtl: false }];
  assert.equal(findCells(lines, [0, 0, 300, 300]).length, 1);
  const spots = findSpots({ lines, texts, view: [0, 0, 300, 300] });
  assert.deepEqual(spots.map((s) => s.kind), ['check']);
});

test('checkboxes: box characters, and box letters only in symbol fonts', () => {
  const t = (str, font) => ({ str, font, x0: 0, y0: 0, x1: 10, y1: 12, size: 12, x: 0, y: 2, upright: true });
  assert.equal(findCheckboxes([t('☐', 'Arial')]).length, 1);
  assert.equal(findCheckboxes([t('q', 'ABCDEF+ZapfDingbats')]).length, 1);
  assert.equal(findCheckboxes([t('o', 'Wingdings-Regular')]).length, 1);
  assert.equal(findCheckboxes([t('q', 'Helvetica')]).length, 0);
  assert.equal(findCheckboxes([t('qq', 'ZapfDingbats')]).length, 2);
});

test('a label at the side of a one-line cell leaves the rest to write in; a heading in the middle leaves nothing', () => {
  const cell = [0, 0, 300, 16];
  const word = (x0, x1) => ({ str: 'Email', x0, x1, y0: 3, y1: 13, size: 10 });
  const side = freeSpace(cell, [word(240, 298)]);
  assert.ok(side && side[0] < 5 && side[2] <= 240);
  assert.equal(freeSpace(cell, [word(120, 180)]), null);
});

test('a blank inside a sentence counts; an underlined word does not', () => {
  const lines = { h: [{ y: 100, x0: 200, x1: 260 }], v: [] };
  const sentence = (str) => [{ str, x0: 100, x1: 400, y0: 98, y1: 110, size: 10, rtl: false, x: 100, y: 100, upright: true }];
  // 30 characters over 300 points: the line is under characters 10..15.
  const blank = `Living in ${' '.repeat(7)}since then.  `, word = 'Living in a settlement since t';
  assert.equal(blank.length, 30);
  assert.equal(word.length, 30);
  assert.equal(findBlanks(lines, sentence(blank)).length, 1);
  assert.equal(findBlanks(lines, sentence(word)).length, 0);
});
