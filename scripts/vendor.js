// Copies the browser builds of pdf.js and mupdf from node_modules into
// vendor/, so the site serves them itself instead of loading them from a
// CDN. Run after changing either version in package.json:
//
//   npm install && npm run vendor
//
// test/vendor.test.js fails if vendor/ drifts from the installed versions.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = (...p) => path.join(root, 'node_modules', ...p);

export const VENDOR = {
  pdfjs: {
    from: nm('pdfjs-dist'),
    files: ['build/pdf.min.mjs', 'build/pdf.worker.min.mjs', 'LICENSE'],
    dirs: ['standard_fonts', 'cmaps'],
  },
  mupdf: {
    from: nm('mupdf'),
    files: ['dist/mupdf.js', 'dist/mupdf-wasm.js', 'dist/mupdf-wasm.wasm', 'LICENSE'],
    dirs: [],
  },
};

// Every vendored file as [source, destination].
export function vendorFiles() {
  const out = [];
  for (const [name, { from, files, dirs }] of Object.entries(VENDOR)) {
    for (const f of files) out.push([path.join(from, f), path.join(root, 'vendor', name, path.basename(f))]);
    for (const d of dirs) {
      for (const f of fs.readdirSync(path.join(from, d))) {
        out.push([path.join(from, d, f), path.join(root, 'vendor', name, d, f)]);
      }
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.rmSync(path.join(root, 'vendor'), { recursive: true, force: true });
  for (const [src, dst] of vendorFiles()) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  const version = (p) => JSON.parse(fs.readFileSync(path.join(p, 'package.json'))).version;
  console.log(`vendored pdfjs-dist ${version(VENDOR.pdfjs.from)} and mupdf ${version(VENDOR.mupdf.from)}`);
}
