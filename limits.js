// Memory limits: when to warn about a large file, and how to recognise an
// out-of-memory failure. Pure functions, shared by the page and the worker.

// Above this, phones and tablets may run out of memory during export.
export const LARGE_FILE_BYTES = 80e6;

// device: { deviceMemory (GB, Chromium only), coarsePointer (touch screen) }
export function isLargeForDevice(size, { deviceMemory, coarsePointer } = {}) {
  if (size < LARGE_FILE_BYTES) return false;
  return (deviceMemory !== undefined && deviceMemory <= 4) || !!coarsePointer;
}

// True for the ways a browser or WebAssembly reports running out of memory.
export function isMemoryError(err) {
  if (err instanceof RangeError) return true;
  const msg = String(err?.message ?? err ?? '');
  return /out of memory|\bOOM\b|memory access out of bounds|allocation failed|could not allocate|cannot enlarge memory|array buffer allocation/i.test(msg);
}
