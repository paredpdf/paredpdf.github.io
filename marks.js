// What goes on every exported page: page numbers and a watermark. Drawn by
// the browser (so any script works) and added to the PDF as pictures, like
// signatures.
import { TEXT_FONT, isRtlText } from './sign.js';

export const NUMBER_PT = 10;   // size of page numbers on the page, in points
export const NUMBER_LINE = 1.4;
export const MARGIN_PT = 24;   // from the edge of the page as cropped
export const NUMBER_INK = '#333';
export const WATERMARK_INK = 'rgba(100, 100, 100, 0.3)';

let measurer = null;
// Width of a line of text, in ems.
export function textWidth(text, weight = '') {
  measurer ??= document.createElement('canvas').getContext('2d');
  measurer.font = `${weight} 100px ${TEXT_FONT}`;
  return measurer.measureText(text).width / 100;
}

function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// One line of text filling the height of a w×h canvas, centred.
export function numberCanvas(text, w, h) {
  const c = canvasOf(w, h), ctx = c.getContext('2d');
  ctx.font = `${c.height / NUMBER_LINE}px ${TEXT_FONT}`;
  ctx.fillStyle = NUMBER_INK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.direction = isRtlText(text) ? 'rtl' : 'ltr';
  ctx.fillText(text, c.width / 2, c.height / 2);
  return c;
}

// Text across the page from the bottom left corner to the top right, as
// large as fits, in light grey that lets the page show through.
export function watermarkCanvas(text, w, h) {
  const c = canvasOf(w, h), ctx = c.getContext('2d');
  const diag = Math.hypot(c.width, c.height);
  const px = Math.min((diag * 0.7) / Math.max(textWidth(text, 'bold'), 0.1), Math.min(c.width, c.height) * 0.25);
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(-Math.atan2(c.height, c.width));
  ctx.font = `bold ${px}px ${TEXT_FONT}`;
  ctx.fillStyle = WATERMARK_INK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.direction = isRtlText(text) ? 'rtl' : 'ltr';
  ctx.fillText(text, 0, 0);
  return c;
}

export async function canvasPng(c) {
  const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

// Where a page number goes, in 0..1 of the page as shown (cropped, turned):
// [u0, v0, u1, v1], for a number w×h points on a page vw×vh points.
export function numberSpot(where, w, h, vw, vh) {
  const m = Math.min(MARGIN_PT, vh / 4, vw / 4);
  const v1 = 1 - m / vh, v0 = v1 - h / vh;
  const u0 = where === 'bl' ? m / vw : where === 'br' ? 1 - m / vw - w / vw : 0.5 - w / vw / 2;
  return [u0, v0, u0 + w / vw, v1];
}
