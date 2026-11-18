// Builds the PDFs the browser tests load. Runs once before the suite.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mupdf, photoPixmap, signedPdf } from '../fixtures.js';

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

// Three plain A4 pages, each with its own photo, so skipping pages changes the size.
function photos() {
  const doc = new mupdf.PDFDocument();
  for (let i = 0; i < 3; i++) {
    const im = doc.addImage(new mupdf.Image(photoPixmap(1400, 1000, 11 + i)));
    const content = `0.8 0.2 0.1 rg 20 520 ${60 + i * 30} 20 re f\nq 400 0 0 285 100 200 cm /Im0 Do Q`;
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { XObject: { Im0: im } }, content));
  }
  return doc.saveToBuffer('compress=yes').asUint8Array().slice();
}

// A phone-photo-like signature: grey-ish paper with a dark scribble.
function signaturePhoto() {
  const w = 600, h = 240;
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  const px = pix.getPixels(), stride = pix.getStride();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const paper = 214 + ((x * 7 + y * 13) % 9); // slightly uneven, not pure white
      const ink = Math.abs(y - (120 + 60 * Math.sin(x / 40))) < 5 && x > 60 && x < 540;
      px.set(ink ? [30, 32, 40] : [paper, paper, paper - 6], y * stride + x * 3);
    }
  }
  return pix.asPNG().slice();
}

function blankPhoto() {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 200, 100], false);
  pix.getPixels().fill(235);
  return pix.asPNG().slice();
}

export default function globalSetup() {
  fs.mkdirSync(FIXTURES, { recursive: true });
  fs.writeFileSync(path.join(FIXTURES, 'letterboxed.pdf'), letterboxed(6));
  fs.writeFileSync(path.join(FIXTURES, 'letterboxed-noclip.pdf'), letterboxed(6, { clip: false }));
  fs.writeFileSync(path.join(FIXTURES, 'long.pdf'), letterboxed(120));
  fs.writeFileSync(path.join(FIXTURES, 'photos.pdf'), photos());
  fs.writeFileSync(path.join(FIXTURES, 'signed.pdf'), signedPdf(1));
  fs.writeFileSync(path.join(FIXTURES, 'locked.pdf'), new mupdf.PDFDocument(letterboxed(3))
    .saveToBuffer('encrypt=aes-256,user-password=open,owner-password=boss').asUint8Array().slice());
  {
    // The usual letterboxed deck, with an author, the program and dates.
    const doc = new mupdf.PDFDocument(letterboxed(2));
    const info = doc.addObject(doc.newDictionary());
    info.put('Title', doc.newString('Deck'));
    info.put('Author', doc.newString('Ada Example'));
    info.put('Creator', doc.newString('Keynote'));
    info.put('CreationDate', doc.newString('D:20260101120000Z'));
    doc.getTrailer().put('Info', info);
    fs.writeFileSync(path.join(FIXTURES, 'with-author.pdf'), doc.saveToBuffer('').asUint8Array().slice());
  }
  fs.writeFileSync(path.join(FIXTURES, 'signature.png'), signaturePhoto());
  fs.writeFileSync(path.join(FIXTURES, 'blank.png'), blankPhoto());
  fs.writeFileSync(path.join(FIXTURES, 'unsigned-field.pdf'), signedPdf(0, { unsigned: 1 }));
}
