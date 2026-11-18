// Interface text in English and Hebrew. Hebrew is written right to left, so
// switching to it also flips the page direction (see setLang).
//
// A value is a string or a function of one params object. Keys used in
// index.html (data-i18n, data-i18n-<attr>) take no params.

const pages = { en: (n) => (n === 1 ? '1 page' : `${n} pages`), he: (n) => (n === 1 ? 'עמוד אחד' : `${n} עמודים`) };

const STRINGS = {
  en: {
    'lang.switch': 'עברית',
    'lang.switchAria': 'החלפה לעברית',
    'tag.main': 'Fix the page size, crop the margins, shrink the file.',
    'tag.private': '100% in your browser, nothing uploaded.',
    'drop.title': 'Drop a PDF here',
    'drop.text': 'Pared finds the real page inside a sheet that was exported at the wrong size (a portrait slide on a landscape page, for example), crops to it, and can shrink the file.',
    'drop.pick': 'Choose a PDF',

    'stage.notExported': 'Not exported',
    'stage.turned': ({ deg }) => `Turned ${deg}° clockwise in the export`,
    'pager.prev': 'Previous page',
    'pager.next': 'Next page',
    'pager.label': ({ page, n, pos }) => `Page ${page} of ${n}${pos ? ` · now ${pos}${ordinal(pos)}` : ''}`,
    'pager.include': 'Export this page',
    'pager.showContent': 'Show detected content',

    'pages.title': 'Pages',
    'pages.rangeAria': 'Pages to export',
    'pages.rangeEg': 'e.g. 1-5, 8, 10-12',
    'pages.rangeAll': ({ n }) => `All (1-${n})`,
    'pages.all': 'All',
    'pages.none': 'None',
    'pages.resetOrder': 'Reset order',
    'pages.hint': 'Click a thumbnail to preview it, and use its checkbox to include or skip it (shift-click for a range). Drag ⠿ to change the order, and press ↻ to rotate a page.',
    'pages.selected': ({ k, n }) => `${k} of ${n} selected`,
    'range.notRange': ({ part }) => `"${part}" isn't a page or range. Use something like 1-5, 8.`,
    'range.backwards': ({ part, a, b }) => `"${part}" is backwards. Did you mean ${b}-${a}?`,
    'range.outside': ({ part, n }) => `"${part}" is outside 1-${n}.`,
    'thumb.export': ({ p }) => `Export page ${p}`,
    'thumb.preview': ({ p }) => `Preview page ${p}`,
    'thumb.move': ({ p }) => `Move page ${p}: drag, or use the arrow keys`,
    'thumb.moveTitle': 'Drag to reorder',
    'thumb.rotate': ({ p }) => `Rotate page ${p} clockwise`,
    'thumb.rotateTitle': 'Rotate 90° clockwise',

    'file.reading': ({ size }) => `${size} · reading…`,
    'file.meta': ({ size, n, sheet }) => `${size} · ${pages.en(n)} · ${sheet}`,
    'progress.analyse': ({ k, n }) => `Looking for the real page… ${k} / ${n}`,

    'detect.title': 'Detected page',
    'detect.exact': 'Exact',
    'detect.high': 'Confident',
    'detect.guess': 'Best guess',
    'detect.blank': 'These pages look blank, so there is nothing to detect.',
    'detect.fills': ({ sheet }) => `The content already fills the ${sheet} sheet. It doesn't look letterboxed.`,
    'detect.shape': ({ label, orient }) => `${label} ${orient}`,
    'detect.found': ({ shape, sheet, centred, exact, sure }) =>
      `${article(shape)} ${shape} page${exact ? (centred ? ', centred' : '') : ', centred'} on the ${sheet} sheet.`
      + (exact ? " The PDF marks this outline itself, so it's exact." : sure ? '' : ' Check the preview and adjust if needed.'),
    'detect.groupTitle': 'Pages of this sheet size share one crop box',
    'detect.groupChip': ({ size, n }) => `${size} · ${n}p`,

    'box.title': 'Keep this area',
    'box.scopeAria': 'Apply this crop to',
    'box.scopeAll': 'All pages',
    'box.scopeSize': 'Pages this size',
    'box.scopePage': 'This page only',
    'box.ownHint': ({ p }) => `Only page ${p} uses this crop. The other pages keep the shared one.`,
    'box.othersHint': ({ n }) => (n === 1 ? '1 page has its own crop.' : `${n} pages have their own crop.`),
    'box.orientAria': 'Orientation',
    'box.portrait': 'Portrait',
    'box.landscape': 'Landscape',
    'box.square': 'Square',
    'box.auto': 'Auto',
    'box.autoWith': ({ label }) => `Auto (${label})`,
    'box.fitContent': 'Fit content',
    'box.wholeSheet': 'Whole sheet',
    'box.custom': 'Custom',
    'box.size': 'Size',
    'box.mm': 'In mm',
    'box.shape': 'Shape',
    'box.dragHint': 'Drag the edges in the preview to fine-tune.',
    'sheet.portrait': 'portrait',
    'sheet.landscape': 'landscape',
    'sheet.square': 'square',

    'export.title': 'Export',
    'export.memWarn': 'This is a large file for a phone or tablet. If the export fails, export fewer pages at a time.',
    'export.compress': 'Compress images',
    'export.resolution': 'Image resolution',
    'export.ppi150': '150 ppi · smallest file',
    'export.ppi200': '200 ppi · sharp on screens',
    'export.ppi300': '300 ppi · good for printing',
    'export.hintOn': "Shrinks photos to the chosen resolution and saves them as JPEG. Text and vector graphics aren't touched.",
    'export.hintOff': 'Images are kept as they are. Skipped pages and their images are still removed.',
    'export.estimating': 'Estimating the file size…',
    'export.estimate': 'Estimated size: ',
    'export.estimateNow': ({ size }) => ` (now ${size})`,
    'export.download': 'Download PDF',
    'export.downloadN': ({ n }) => `Download PDF · ${pages.en(n)}`,
    'export.selectOne': 'Select at least one page',
    'export.loading': 'Loading the PDF engine…',
    'export.open': 'Opening the PDF…',
    'export.pages': 'Removing skipped pages…',
    'export.scan': 'Finding images…',
    'export.images': ({ done, total }) => `Compressing images… ${done} / ${total}`,
    'export.save': 'Writing the file…',
    'export.working': 'Working…',
    'export.saved': ({ name, before }) => `Saved ${name}: ${before} → `,
    'export.smaller': ({ pct }) => ` (${pct}% smaller)`,
    'reset': 'Start over',

    'err.password': 'This PDF is password-protected. Remove the password and try again.',
    'err.read': ({ msg }) => `Couldn't read this PDF: ${msg}`,
    'err.memory': 'This device ran out of memory while exporting. Try fewer pages at a time, a lower image resolution, or a computer.',
    'err.encrypted': 'This PDF is encrypted, so it can’t be rewritten here.',
    'err.write': ({ msg }) => `Couldn't write the PDF: ${msg}`,
    'err.engine': 'The PDF engine stopped unexpectedly. Try again, or export fewer pages at a time.',

    'foot.source': 'Source code',
    'foot.version': ({ commit, when }) => `Version ${commit}, deployed ${when}`,
  },

  he: {
    'lang.switch': 'English',
    'lang.switchAria': 'Switch to English',
    'tag.main': 'מתקנים את גודל העמוד, חותכים את השוליים ומקטינים את הקובץ.',
    'tag.private': 'הכול קורה בדפדפן, שום דבר לא מועלה.',
    'drop.title': 'גררו לכאן קובץ PDF',
    'drop.text': 'Pared מוצא את העמוד האמיתי בתוך גיליון שיוצא בגודל הלא נכון (למשל שקף לאורך על עמוד לרוחב), חותך אליו, ויכול גם להקטין את הקובץ.',
    'drop.pick': 'בחירת קובץ PDF',

    'stage.notExported': 'לא ייוצא',
    'stage.turned': ({ deg }) => `מסובב ב־${deg}° עם כיוון השעון בייצוא`,
    'pager.prev': 'העמוד הקודם',
    'pager.next': 'העמוד הבא',
    'pager.label': ({ page, n, pos }) => `עמוד ${page} מתוך ${n}${pos ? ` · עכשיו במקום ${pos}` : ''}`,
    'pager.include': 'לייצא את העמוד הזה',
    'pager.showContent': 'להציג את התוכן שזוהה',

    'pages.title': 'עמודים',
    'pages.rangeAria': 'עמודים לייצוא',
    'pages.rangeEg': 'למשל 1-5, 8, 10-12',
    'pages.rangeAll': ({ n }) => `הכול (1-${n})`,
    'pages.all': 'הכול',
    'pages.none': 'אף אחד',
    'pages.resetOrder': 'איפוס הסדר',
    'pages.hint': 'לחיצה על תמונה ממוזערת מציגה אותה, ותיבת הסימון שלה קובעת אם לכלול אותה או לדלג עליה (Shift ולחיצה בוחרים טווח). גוררים את ⠿ כדי לשנות את הסדר, ולוחצים על ↻ כדי לסובב עמוד.',
    'pages.selected': ({ k, n }) => `${k} מתוך ${n} נבחרו`,
    'range.notRange': ({ part }) => `"${part}" הוא לא עמוד או טווח. כתבו למשל 1-5, 8.`,
    'range.backwards': ({ part, a, b }) => `"${part}" הפוך. התכוונתם ל־${b}-${a}?`,
    'range.outside': ({ part, n }) => `"${part}" מחוץ לטווח 1-${n}.`,
    'thumb.export': ({ p }) => `לייצא את עמוד ${p}`,
    'thumb.preview': ({ p }) => `תצוגה מקדימה של עמוד ${p}`,
    'thumb.move': ({ p }) => `הזזת עמוד ${p}: גוררים, או משתמשים במקשי החיצים`,
    'thumb.moveTitle': 'גררו כדי לשנות את הסדר',
    'thumb.rotate': ({ p }) => `סיבוב עמוד ${p} עם כיוון השעון`,
    'thumb.rotateTitle': 'סיבוב ב־90° עם כיוון השעון',

    'file.reading': ({ size }) => `${size} · קורא…`,
    'file.meta': ({ size, n, sheet }) => `${size} · ${pages.he(n)} · ${sheet}`,
    'progress.analyse': ({ k, n }) => `מחפש את העמוד האמיתי… ${k} / ${n}`,

    'detect.title': 'העמוד שזוהה',
    'detect.exact': 'מדויק',
    'detect.high': 'בטוח',
    'detect.guess': 'הערכה',
    'detect.blank': 'העמודים האלה נראים ריקים, אז אין מה לזהות.',
    'detect.fills': ({ sheet }) => `התוכן כבר ממלא את גיליון ה־${sheet}. לא נראה שיש סביבו שוליים מיותרים.`,
    'detect.shape': ({ label, orient }) => `${label} ${orient}`,
    'detect.found': ({ shape, sheet, centred, exact, sure }) =>
      `עמוד ${shape}${exact ? (centred ? ', ממורכז' : '') : ', ממורכז'} על גיליון ${sheet}.`
      + (exact ? ' קובץ ה־PDF מסמן את קו המתאר הזה בעצמו, כך שהוא מדויק.' : sure ? '' : ' כדאי לבדוק בתצוגה המקדימה ולתקן אם צריך.'),
    'detect.groupTitle': 'עמודים בגודל הגיליון הזה חולקים תיבת חיתוך אחת',
    'detect.groupChip': ({ size, n }) => `${size} · ${n} עמ׳`,

    'box.title': 'האזור שנשמר',
    'box.scopeAria': 'להחיל את החיתוך על',
    'box.scopeAll': 'כל העמודים',
    'box.scopeSize': 'עמודים בגודל הזה',
    'box.scopePage': 'רק העמוד הזה',
    'box.ownHint': ({ p }) => `רק עמוד ${p} משתמש בחיתוך הזה. שאר העמודים נשארים עם החיתוך המשותף.`,
    'box.othersHint': ({ n }) => (n === 1 ? 'לעמוד אחד יש חיתוך משלו.' : `ל־${n} עמודים יש חיתוך משלהם.`),
    'box.orientAria': 'כיוון',
    'box.portrait': 'לאורך',
    'box.landscape': 'לרוחב',
    'box.square': 'ריבוע',
    'box.auto': 'אוטומטי',
    'box.autoWith': ({ label }) => `אוטומטי (${label})`,
    'box.fitContent': 'התאמה לתוכן',
    'box.wholeSheet': 'הגיליון כולו',
    'box.custom': 'מותאם אישית',
    'box.size': 'גודל',
    'box.mm': 'במ״מ',
    'box.shape': 'צורה',
    'box.dragHint': 'אפשר לגרור את הקצוות בתצוגה המקדימה כדי לכוונן.',
    'sheet.portrait': 'לאורך',
    'sheet.landscape': 'לרוחב',
    'sheet.square': 'ריבועי',

    'export.title': 'ייצוא',
    'export.memWarn': 'זה קובץ גדול לטלפון או לטאבלט. אם הייצוא נכשל, ייצאו פחות עמודים בכל פעם.',
    'export.compress': 'לדחוס תמונות',
    'export.resolution': 'רזולוציית התמונות',
    'export.ppi150': '\u2066150 ppi\u2069 · הקובץ הקטן ביותר',
    'export.ppi200': '\u2066200 ppi\u2069 · חד על מסכים',
    'export.ppi300': '\u2066300 ppi\u2069 · מתאים להדפסה',
    'export.hintOn': 'מקטין תמונות לרזולוציה שנבחרה ושומר אותן כ־JPEG. טקסט וגרפיקה וקטורית לא משתנים.',
    'export.hintOff': 'התמונות נשארות כמו שהן. עמודים שדילגתם עליהם והתמונות שלהם עדיין מוסרים.',
    'export.estimating': 'מעריך את גודל הקובץ…',
    'export.estimate': 'גודל משוער: ',
    'export.estimateNow': ({ size }) => ` (כרגע ${size})`,
    'export.download': 'הורדת PDF',
    'export.downloadN': ({ n }) => `הורדת PDF · ${pages.he(n)}`,
    'export.selectOne': 'בחרו לפחות עמוד אחד',
    'export.loading': 'טוען את מנוע ה־PDF…',
    'export.open': 'פותח את ה־PDF…',
    'export.pages': 'מסיר עמודים שדילגתם עליהם…',
    'export.scan': 'מחפש תמונות…',
    'export.images': ({ done, total }) => `דוחס תמונות… ${done} / ${total}`,
    'export.save': 'כותב את הקובץ…',
    'export.working': 'עובד…',
    'export.saved': ({ name, before }) => `נשמר ${name}: ${before} ← `,
    'export.smaller': ({ pct }) => ` (קטן ב־${pct}%)`,
    'reset': 'להתחיל מחדש',

    'err.password': 'קובץ ה־PDF הזה מוגן בסיסמה. הסירו את הסיסמה ונסו שוב.',
    'err.read': ({ msg }) => `לא הצלחתי לקרוא את קובץ ה־PDF: ${msg}`,
    'err.memory': 'למכשיר נגמר הזיכרון במהלך הייצוא. נסו פחות עמודים בכל פעם, רזולוציית תמונות נמוכה יותר, או מחשב.',
    'err.encrypted': 'קובץ ה־PDF הזה מוצפן, ולכן אי אפשר לשכתב אותו כאן.',
    'err.write': ({ msg }) => `לא הצלחתי לכתוב את קובץ ה־PDF: ${msg}`,
    'err.engine': 'מנוע ה־PDF נעצר באופן לא צפוי. נסו שוב, או ייצאו פחות עמודים בכל פעם.',

    'foot.source': 'קוד המקור',
    'foot.version': ({ commit, when }) => `גרסה ${commit}, עלתה ב־${when}`,
  },
};

export const LANGS = Object.keys(STRINGS);
const RTL = new Set(['he']);
let current = 'en';

export const lang = () => current;
export const isRtl = () => RTL.has(current);

export function t(key, params = {}) {
  const v = STRINGS[current][key] ?? STRINGS.en[key];
  if (v === undefined) throw new Error(`Missing string: ${key}`);
  return typeof v === 'function' ? v(params) : v;
}

// Keep a left-to-right run (a size, a file name, "A4") in one piece inside
// right-to-left text. A no-op in English, so English text stays plain.
export const ltr = (s) => (isRtl() ? `⁦${s}⁩` : String(s));

// The language to start in: ?lang=, then the saved choice, then the browser's.
export function pickLang({ search = '', saved = null, languages = [] } = {}) {
  const q = new URLSearchParams(search).get('lang');
  for (const c of [q, saved, ...languages.map((l) => l.toLowerCase().split('-')[0])]) {
    if (c && STRINGS[c]) return c;
  }
  return 'en';
}

// Switch language and translate the page's static text. The app re-renders
// its dynamic text itself afterwards.
export function setLang(code, root = document) {
  current = STRINGS[code] ? code : 'en';
  const html = root.documentElement;
  html.lang = current;
  html.dir = isRtl() ? 'rtl' : 'ltr';
  for (const node of root.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const attr of ['aria-label', 'placeholder', 'title']) {
    for (const node of root.querySelectorAll(`[data-i18n-${attr}]`)) node.setAttribute(attr, t(node.getAttribute(`data-i18n-${attr}`)));
  }
}

export function strings(code) { return STRINGS[code]; }

function ordinal(n) { return n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'; }
function article(s) { return /^(a|e|i|o|u|8|11|18)/i.test(s) ? 'An' : 'A'; }
