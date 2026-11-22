// Service worker: makes Pared work offline once it has been opened, and
// switches versions all at once.
//
// - VERSION is the deployed commit, written in by scripts/stamp.js. Each
//   deploy therefore changes this file, which is how the browser notices a
//   new version. Its app files are all fetched afresh into one cache named
//   for that version, and a running page is only ever served from the cache
//   it started with, so old and new files never mix.
// - A new version takes over when the page asks for it (see app.js): at once
//   on the start screen, or after "Reload" when a file is open.
// - Served straight from the repo, VERSION stays 'dev' and app files are
//   network-first instead, so local changes show up on reload.
// - vendor/ files are cache-first under a name that includes the library
//   versions (test/sw.test.js keeps it in sync with package.json).

const VERSION = 'dev';
const APP_CACHE = `pared-app-${VERSION}`;
const VENDOR_CACHE = 'pared-vendor-pdfjs-4.10.38-mupdf-1.28.1-fonts-5.3.0';
const SHARE_CACHE = 'pared-share';
const NETWORK_TIMEOUT_MS = 4000;
const STAMPED = VERSION !== 'dev';

const APP_FILES = [
  './', 'index.html', 'style.css', 'app.js', 'detect.js', 'pages.js', 'limits.js', 'i18n.js', 'sign.js', 'zip.js', 'images.js', 'marks.js', 'pdf-core.js', 'export-worker.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];
const VENDOR_FILES = [
  'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs',
  'vendor/mupdf/mupdf.js', 'vendor/mupdf/mupdf-wasm.js', 'vendor/mupdf/mupdf-wasm.wasm',
  // Signature fonts, so typing a signature works offline too.
  'vendor/fonts/dancing-script/dancing-script-latin-400-normal.woff2', 'vendor/fonts/dancing-script/dancing-script-latin-ext-400-normal.woff2',
  'vendor/fonts/caveat/caveat-latin-400-normal.woff2', 'vendor/fonts/caveat/caveat-latin-ext-400-normal.woff2',
  'vendor/fonts/gveret-levin/gveret-levin-latin-400-normal.woff2', 'vendor/fonts/gveret-levin/gveret-levin-hebrew-400-normal.woff2',
  'vendor/fonts/aref-ruqaa/aref-ruqaa-latin-400-normal.woff2', 'vendor/fonts/aref-ruqaa/aref-ruqaa-arabic-400-normal.woff2',
  'vendor/fonts/playpen-sans-hebrew/playpen-sans-hebrew-latin-400-normal.woff2', 'vendor/fonts/playpen-sans-hebrew/playpen-sans-hebrew-hebrew-400-normal.woff2',
  'vendor/fonts/amatic-sc/amatic-sc-latin-400-normal.woff2', 'vendor/fonts/amatic-sc/amatic-sc-hebrew-400-normal.woff2',
  'vendor/fonts/solitreo/solitreo-latin-400-normal.woff2', 'vendor/fonts/solitreo/solitreo-hebrew-400-normal.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // Fresh from the server, past the browser's HTTP cache, so this
    // version's files are all this version's.
    const app = await caches.open(APP_CACHE);
    await app.addAll(APP_FILES.map((f) => new Request(f, { cache: 'reload' })));
    const vendor = await caches.open(VENDOR_CACHE);
    const missing = [];
    for (const f of VENDOR_FILES) if (!(await vendor.match(f))) missing.push(f);
    await vendor.addAll(missing);
    // The very first install has nothing to replace. Later ones wait until
    // the page says it's a good moment (an update mid-edit would mix files).
    if (!self.registration.active || !STAMPED) await self.skipWaiting();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([APP_CACHE, VENDOR_CACHE, SHARE_CACHE]);
    for (const key of await caches.keys()) if (key.startsWith('pared-') && !keep.has(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.method === 'POST' && url.pathname.endsWith('/share')) { event.respondWith(receiveShare(req)); return; }
  if (req.method !== 'GET') return;
  const path = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  event.respondWith(path.startsWith('vendor/') ? cacheFirst(req) : STAMPED ? fromThisVersion(req) : networkFirst(req));
});

// PDFs or photos shared to the installed app (Web Share Target). Park them
// in a cache, in order, and redirect to the app, which picks them up and
// removes them.
async function receiveShare(req) {
  const form = await req.formData();
  const files = form.getAll('pdf').filter((f) => f instanceof File);
  const cache = await caches.open(SHARE_CACHE);
  for (const old of await cache.keys()) await cache.delete(old);
  for (const [k, file] of files.entries()) {
    await cache.put(`shared-${k}`, new Response(file, {
      headers: { 'content-type': file.type || 'application/pdf', 'x-filename': encodeURIComponent(file.name || 'shared.pdf') },
    }));
  }
  return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
}

async function cacheFirst(req) {
  const cache = await caches.open(VENDOR_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone()); // fonts and CMaps are cached as they're used
  return res;
}

// Everything from this version's cache; only files it doesn't hold (such as
// the docs pages) come from the network.
async function fromThisVersion(req) {
  const cache = await caches.open(APP_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true })
    || (req.mode === 'navigate' && await cache.match('index.html'));
  return hit || fetch(req);
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
