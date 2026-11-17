// Page-range helpers for the page selector. Pure functions, no DOM.

// Parse a range string like "1-5, 8, 10-" into a sorted list of 1-based
// page numbers. Empty or "all" means every page. Throws with a readable
// message on bad input.
export function parseRange(str, n) {
  const s = str.trim().replace(/\s*[-–]\s*/g, '-');
  if (!s || /^all$/i.test(s)) return Array.from({ length: n }, (_, i) => i + 1);
  const out = new Set();
  for (const part of s.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)?-(\d+)?$/) || part.match(/^(\d+)$/);
    if (!m) throw new Error(`"${part}" isn't a page or range. Use something like 1-5, 8.`);
    const a = Number(m[1] ?? 1), b = part.includes('-') ? Number(m[2] ?? n) : a;
    if (a > b) throw new Error(`"${part}" is backwards. Did you mean ${b}-${a}?`);
    if (a < 1 || b > n) throw new Error(`"${part}" is outside 1-${n}.`);
    for (let i = a; i <= b; i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

// Format a sorted list of page numbers compactly: [1,2,3,5] -> "1-3, 5".
export function formatRange(pages) {
  const parts = [];
  for (let i = 0; i < pages.length; i++) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    parts.push(j > i ? `${pages[i]}-${pages[j]}` : `${pages[i]}`);
    i = j;
  }
  return parts.join(', ');
}
