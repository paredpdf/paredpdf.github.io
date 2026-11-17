# TruePage

Fixes PDFs exported at the wrong page size, such as a 9:16 portrait slide placed in the middle of an A4 landscape page. TruePage detects the real page and crops every page to it. Everything runs in the browser: the PDF is never uploaded.

## Run locally

```sh
python3 -m http.server 8765   # from the repo root
# open http://127.0.0.1:8765/
```

It has to be served over HTTP, because ES modules don't load from `file://`. There's no build step. Deploy the folder as-is to any static host (GitHub Pages, Cloudflare Pages, Vercel).

## How it works

- `detect.js` holds the detection logic. It has no DOM or pdf.js dependencies, so it can be unit-tested.
  - Draws up to 40 pages for each page size and finds the non-background area on each, then combines them.
  - Assumes the exporter centred the real page, so the empty bands on two sides tell it which way to crop.
  - Picks the smallest common aspect ratio (9:16, 2:3, A4, 3:4, Letter, 4:5, 1:1, plus landscape versions) that still contains all the content.
- `app.js` handles the UI, preview, draggable crop box and export.
  - pdf.js draws the pages.
  - pdf-lib sets Media/Crop/Bleed/Trim/ArtBox on each page.
  - Pages are grouped by sheet size, and each group gets its own crop box.
  - pdf.js `convertToPdfPoint` maps the box to PDF coordinates, which handles rotated pages and boxes that don't start at 0,0.

Libraries load from jsDelivr with pinned versions: pdfjs-dist 4.10.38 and pdf-lib 1.17.1.

## Next

- Optional compression (downsample images to about 200 ppi), using MuPDF or Ghostscript compiled to run in the browser.
- Bundle the libraries locally so the site works offline and makes no third-party requests.
- Read the exporter's own clipping rectangle when one exists, for an exact box with no guessing.
