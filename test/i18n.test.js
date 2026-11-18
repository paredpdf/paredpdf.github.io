import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LANGS, strings, pickLang, t, ltr } from '../i18n.js';
import { parseRange } from '../pages.js';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const html = read('index.html');
const app = read('app.js');

test('every language has the same strings, of the same kind', () => {
  const en = strings('en');
  for (const code of LANGS) {
    const s = strings(code);
    assert.deepEqual(Object.keys(s).sort(), Object.keys(en).sort(), `${code} has different keys from en`);
    for (const k of Object.keys(en)) assert.equal(typeof s[k], typeof en[k], `${code}.${k} is a ${typeof s[k]}`);
  }
});

test('the page only uses plain strings that exist', () => {
  const keys = [...html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 30);
  for (const k of keys) assert.equal(typeof strings('en')[k], 'string', `index.html uses ${k}`);
});

test('every string the app asks for exists', () => {
  const keys = [...app.matchAll(/\bt\('([a-z][\w.]*)'/g)].map((m) => m[1]);
  // Keys built at runtime, like `export.ppi${n}` and `range.${code}`.
  for (const n of [150, 200, 300]) keys.push(`export.ppi${n}`);
  for (const ph of ['open', 'pages', 'scan', 'save']) keys.push(`export.${ph}`);
  for (const c of ['notRange', 'backwards', 'outside']) keys.push(`range.${c}`);
  assert.ok(keys.length > 50);
  for (const k of keys) assert.ok(k in strings('en'), `app.js uses missing ${k}`);
});

test('the ppi options in the page match the app presets', () => {
  const values = [...html.matchAll(/<option value="(\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(values, ['150', '200', '300']);
});

test('functions render without leaving placeholders', () => {
  const params = { page: 3, n: 7, k: 2, p: 4, pos: 2, deg: 90, size: '1 MB', sheet: 'A4', shape: '9:16', label: '9:16',
    orient: 'x', part: '7-3', a: 7, b: 3, done: 1, total: 2, name: 'f.pdf', before: '2 MB', pct: 50, msg: 'boom',
    commit: 'abc1234', when: '18 Nov 2026', v: 'Keynote', list: 'dates' };
  for (const code of LANGS) {
    for (const [k, v] of Object.entries(strings(code))) {
      if (typeof v !== 'function') continue;
      const out = v(params);
      assert.equal(typeof out, 'string');
      assert.ok(!/undefined|\$\{|NaN/.test(out), `${code}.${k}: ${out}`);
    }
  }
});

test('the English detection sentences read as before', () => {
  assert.equal(t('detect.found', { shape: '9:16 portrait', sheet: 'A4 landscape', centred: true, exact: true }),
    "A 9:16 portrait page, centred on the A4 landscape sheet. The PDF marks this outline itself, so it's exact.");
  assert.equal(t('detect.found', { shape: '16:9 landscape', sheet: 'A4 portrait', sure: false }),
    'A 16:9 landscape page, centred on the A4 portrait sheet. Check the preview and adjust if needed.');
  assert.equal(t('pager.label', { page: 3, n: 6, pos: 1 }), 'Page 3 of 6 · now 1st');
  assert.equal(ltr('A4'), 'A4'); // no bidi marks in English
});

test('picks the language from the URL, then the saved choice, then the browser', () => {
  assert.equal(pickLang({ languages: ['he-IL', 'en'] }), 'he');
  assert.equal(pickLang({ languages: ['fr-FR', 'de'] }), 'en');
  assert.equal(pickLang({ saved: 'en', languages: ['he'] }), 'en');
  assert.equal(pickLang({ search: '?lang=he', saved: 'en' }), 'he');
  assert.equal(pickLang({ search: '?lang=xx', saved: 'he' }), 'he');
});

test('range errors carry a code and params for translation', () => {
  const err = (s) => { try { parseRange(s, 10); } catch (e) { return e; } };
  assert.deepEqual([err('abc').code, err('abc').params], ['notRange', { part: 'abc' }]);
  assert.deepEqual([err('7-3').code, err('7-3').params], ['backwards', { part: '7-3', a: 7, b: 3 }]);
  assert.deepEqual([err('5-12').code, err('5-12').params], ['outside', { part: '5-12', n: 10 }]);
  assert.equal(strings('en')['range.backwards'](err('7-3').params), err('7-3').message);
  assert.equal(strings('he')['range.backwards'](err('7-3').params), '"7-3" הפוך. התכוונתם ל־3-7?');
});

test('Arabic uses its plural forms for page counts', () => {
  const ar = strings('ar')['export.downloadN'];
  assert.deepEqual([1, 2, 3, 10, 11, 100, 103].map((n) => ar({ n }).split(' · ')[1]),
    ['صفحة واحدة', 'صفحتان', '3 صفحات', '10 صفحات', '11 صفحة', '100 صفحة', '103 صفحات']);
});

test('picks Spanish and Arabic from regional browser languages', () => {
  assert.equal(pickLang({ languages: ['es-MX'] }), 'es');
  assert.equal(pickLang({ languages: ['ar-EG', 'en'] }), 'ar');
});

test('page ranges accept the Arabic comma', () => {
  assert.deepEqual(parseRange('1، 3-4', 10), [1, 3, 4]);
});
