// Builds the PDFs the browser tests load. Runs once before the suite.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mupdf, photoPixmap } from '../fixtures.js';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '.fixtures');
export const SLIDE = { x: 253.6562, w: 334.6875 }; // a 9:16 slide centred on A4 landscape

// Like a Keynote export of a portrait deck: each A4 landscape sheet holds a
// 9:16 slide in the middle, clipped to the slide's rectangle. Each page gets
// a header bar of a different width so tests can tell pages apart.
function letterboxed(pages, { clip = true } = {}) {
  const doc = new mupdf.PDFDocument();
  const photo = doc.addImage(new mupdf.Image(photoPixmap(1600, 1200, 7)));
  for (let i = 0; i < pages; i++) {
    const { x, w } = SLIDE;
    const bar = 60 + i * 30;
    const content = [
      clip ? `q ${x} 0 ${w} 595 re W n` : 'q',
      `1 1 1 rg ${x} 0 ${w} 595 re f`,
      `0.1 0.3 0.6 rg ${x + 5} 560 ${w - 10} 30 re f`, // header across the slide
      `0.8 0.2 0.1 rg ${x + 20} 520 ${bar} 20 re f`, // per-page marker
      `q 300 0 0 225 ${x + 17} 200 cm /Im0 Do Q`,
      `0 0 0 rg ${x + 5} 5 ${w - 10} 8 re f`, // footer
      'Q',
    ].join('\n');
    doc.insertPage(-1, doc.addPage([0, 0, 842, 595], 0, { XObject: { Im0: photo } }, content));
  }
  return doc.saveToBuffer('compress=yes').asUint8Array().slice();
}

export default function globalSetup() {
  fs.mkdirSync(FIXTURES, { recursive: true });
  fs.writeFileSync(path.join(FIXTURES, 'letterboxed.pdf'), letterboxed(6));
  fs.writeFileSync(path.join(FIXTURES, 'letterboxed-noclip.pdf'), letterboxed(6, { clip: false }));
}
