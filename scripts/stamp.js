// Writes the commit and deploy time into index.html, so the live site can
// show which version it is. Run by the deploy job only; the committed file
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [commit, time = new Date().toISOString()] = process.argv.slice(2);
  const file = new URL('../index.html', import.meta.url);
  fs.writeFileSync(file, stamp(fs.readFileSync(file, 'utf8'), commit, time));
  console.log(`Stamped ${commit.slice(0, 7)} at ${time}`);
}
