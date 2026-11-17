# Pared

Fixes PDFs exported at the wrong page size, such as a 9:16 portrait slide placed in the middle of an A4 landscape page. Pared:
- detects the real page,
- crops every page to it,
- lets you choose which pages to keep,
- can compress the images.

Everything runs in the browser: the PDF is never uploaded.

## Run locally

```sh
python3 -m http.server 8765   # from the repo root
# open http://127.0.0.1:8765/
```

It has to be served over HTTP, because ES modules and workers don't load from `file://`. There's no build step. Deploy the folder as-is to any static host (GitHub Pages, Cloudflare Pages, Vercel).

## Files

- `detect.js` holds the page detection logic. It has no DOM or pdf.js dependencies.
  - Draws up to 40 pages for each page size and combines the non-background area of all of them.
  - Assumes the real page is centred, so the empty bands on two sides tell it which way to crop.
  - Picks the smallest common aspect ratio that still contains all the content.
- `app.js` handles the UI: preview, draggable crop box, orientation switch, ratio presets, page thumbnails and selection, and the export controls. It uses pdf.js for rendering.
- `pdf-core.js` is the export engine, built on mupdf.js. It runs in the browser worker and in Node (handy for tests).
  - Sets the page boxes and keeps only the selected pages.
  - **Compression:** works out the largest size each image is drawn at, by walking content streams, form XObjects included. It then resamples to the target ppi with a box filter and re-encodes as JPEG.
  - **Skipped images:** 1-bit, tiny, and already-JPEG images at a sensible resolution. Also lossless images that compress well (logos, screenshots), since JPEG would only blur them.
  - Soft masks (transparency) are resized along with their image.
  - Saves with garbage collection, so skipped pages' images are actually removed.
- `export-worker.js` runs the engine off the main thread and uses the browser's JPEG encoder (4:2:0 chroma, much smaller than mupdf's 4:4:4).

Dependencies load from jsDelivr with pinned versions: pdfjs-dist 4.10.38 and mupdf 1.28.1. The mupdf engine is about 3.6 MB compressed. It starts loading in the background once analysis finishes.

## Licence

AGPL-3.0 (see `LICENSE`), matching mupdf.js, which Pared uses for export.

## Results on the Tzafit guide (152 MB, 50 pages)

| Export | Size | Time |
|---|---|---|
| 150 ppi | 5.7 MB | ~15 s |
| 200 ppi | 10.7 MB | ~18 s |
| 300 ppi | 25.0 MB | ~15 s |
| Pages 6–9, no compression | 8.7 MB | — |

## Next

- Bundle pdf.js and mupdf locally, so the site works offline and makes no third-party requests.
- Read the exporter's own clipping rectangle when one exists, for an exact box with no guessing.
- Drag-to-reorder pages (mupdf's `rearrangePages` already supports any order).
