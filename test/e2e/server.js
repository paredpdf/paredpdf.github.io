// Minimal static server for the browser tests: serves the repo root the way
// GitHub Pages does, with correct types for .mjs, .wasm and .webmanifest.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stampWorker } from '../../scripts/stamp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = Number(process.env.PORT || 8790);
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
};

// For the update tests: under /t/<name>/ the site is served as if deployed,
// with sw.js stamped as the version last set by POST /deploy/<name>/<version>.
// Each test uses its own <name>, so parallel tests don't see each other's
// deploys.
const deployed = new Map();

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const set = url.pathname.match(/^\/deploy\/([\w-]+)\/([0-9a-f]{7,40})$/);
  if (set && req.method === 'POST') { deployed.set(set[1], set[2]); res.writeHead(204).end(); return; }
  let pathname = url.pathname, version = null;
  const under = pathname.match(/^\/t\/([\w-]+)(\/.*)$/);
  if (under) { version = deployed.get(under[1]) ?? null; pathname = under[2]; }
  let file = path.join(root, decodeURIComponent(pathname));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    if (version && path.basename(file) === 'sw.js' && path.dirname(file) === root) data = stampWorker(data.toString(), version);
    // Mark the app's own scripts with the version, so a test can tell which
    // deploy a page is running.
    else if (version && file.endsWith('.js') && path.dirname(file) === root) data = `${data}\n/* deployed ${version} */\n`;
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} on http://127.0.0.1:${port}`));
