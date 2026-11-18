// Writes the commit and deploy time into index.html, so the live site can
// show which version it is, and the commit into sw.js, so installed copies
// update as one. Run by the deploy job only; the committed file
// keeps the empty values, and the footer then shows no version.
//
//   node scripts/stamp.js <commit sha> [ISO time]
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function stamp(html, commit, time) {
  if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error(`Not a commit hash: ${commit}`);
  if (Number.isNaN(Date.parse(time))) throw new Error(`Not a time: ${time}`);
  let out = html;
  for (const [name, value] of [['pared-commit', commit], ['pared-deployed', time]]) {
    const empty = `<meta name="${name}" content="">`;
    if (!out.includes(empty)) throw new Error(`index.html has no empty ${name} meta tag`);
    out = out.replace(empty, `<meta name="${name}" content="${value}">`);
  }
  return out;
}

// The service worker's version: a changed sw.js is how browsers notice a
// new deploy, and its caches are named for it.
export function stampWorker(js, commit) {
  if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error(`Not a commit hash: ${commit}`);
  const dev = "const VERSION = 'dev';";
  if (!js.includes(dev)) throw new Error("sw.js has no `const VERSION = 'dev';`");
  return js.replace(dev, `const VERSION = '${commit.slice(0, 12)}';`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [commit, time = new Date().toISOString()] = process.argv.slice(2);
  const page = new URL('../index.html', import.meta.url), worker = new URL('../sw.js', import.meta.url);
  fs.writeFileSync(page, stamp(fs.readFileSync(page, 'utf8'), commit, time));
  fs.writeFileSync(worker, stampWorker(fs.readFileSync(worker, 'utf8'), commit));
  console.log(`Stamped ${commit.slice(0, 7)} at ${time}`);
}
