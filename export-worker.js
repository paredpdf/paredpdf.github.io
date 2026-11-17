// Runs the export off the main thread so the page stays responsive.
import * as mupdf from 'https://cdn.jsdelivr.net/npm/mupdf@1.28.1/dist/mupdf.js';
import { processPdf } from './pdf-core.js';

// Browser JPEG encoder: 4:2:0 chroma subsampling, much smaller than mupdf's.
async function encodeJpeg(rgb, w, h, quality) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    rgba[j] = rgb[i]; rgba[j + 1] = rgb[i + 1]; rgba[j + 2] = rgb[i + 2]; rgba[j + 3] = 255;
  }
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: quality / 100 });
  return new Uint8Array(await blob.arrayBuffer());
}

self.onmessage = async (e) => {
  const { id, bytes, opts } = e.data;
  try {
    const r = await processPdf(mupdf, bytes, {
      ...opts,
      encodeJpeg: typeof OffscreenCanvas === 'function' ? encodeJpeg : null,
    }, (p) => self.postMessage({ type: 'progress', id, ...p }));
    self.postMessage({ type: 'done', id, bytes: r.bytes, stats: r.stats }, [r.bytes.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err?.message || err) });
  }
};

self.postMessage({ type: 'ready' });
