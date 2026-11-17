// Service worker: makes Pared work offline once it has been opened.
//
// - App files are network-first (with a short timeout), so a new deploy
//   shows up on the next load and the cached copy is used offline.
// - vendor/ files are cache-first: they are large and only change when
//   their versions change, and the vendor cache name includes those
//   versions (test/sw.test.js keeps it in sync with package.json).

const APP_CACHE = 'pared-app-v1';
const VENDOR_CACHE = 'pared-vendor-pdfjs-4.10.38-mupdf-1.28.1';
const NETWORK_TIMEOUT_MS = 4000;

const APP_FILES = [
  './', 'index.html', 'style.css', 'app.js', 'detect.js', 'pages.js', 'pdf-core.js', 'export-worker.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];
const VENDOR_FILES = [
  'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs',
  'vendor/mupdf/mupdf.js', 'vendor/mupdf/mupdf-wasm.js', 'vendor/mupdf/mupdf-wasm.wasm',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    await (await caches.open(APP_CACHE)).addAll(APP_FILES);
    const vendor = await caches.open(VENDOR_CACHE);
    const missing = [];
    for (const f of VENDOR_FILES) if (!(await vendor.match(f))) missing.push(f);
    await vendor.addAll(missing);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([APP_CACHE, VENDOR_CACHE]);
    for (const key of await caches.keys()) if (key.startsWith('pared-') && !keep.has(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const path = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  event.respondWith(path.startsWith('vendor/') ? cacheFirst(req) : networkFirst(req));
});

async function cacheFirst(req) {
  const cache = await caches.open(VENDOR_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone()); // fonts and CMaps are cached as they're used
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(APP_CACHE);
  try {
    const res = await withTimeout(fetch(req), NETWORK_TIMEOUT_MS);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: true })
      || (req.mode === 'navigate' && await cache.match('index.html'));
    if (hit) return hit;
    throw new Error(`offline and not cached: ${req.url}`);
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
