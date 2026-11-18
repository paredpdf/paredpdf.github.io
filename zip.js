// Writes a ZIP file of already-compressed files (PDFs), stored without
// further compression. Pure function, no DOM: makeZip([{ name, bytes, date? }]).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// MS-DOS date and time, as ZIP stores them (local time, 2-second steps).
function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function makeZip(files) {
  const enc = new TextEncoder();
  const entries = files.map((f) => ({ ...f, nameBytes: enc.encode(f.name), crc: crc32(f.bytes), ...dosTime(f.date ?? new Date()) }));
  const size = entries.reduce((t, e) => t + 30 + e.nameBytes.length + e.bytes.length + 46 + e.nameBytes.length, 22);
  if (size > 0xffffffff || entries.length > 0xffff) throw new Error('Too large for a ZIP file');
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let o = 0;
  const u16 = (v) => { dv.setUint16(o, v, true); o += 2; };
  const u32 = (v) => { dv.setUint32(o, v, true); o += 4; };
  const header = (e, central) => {
    u32(central ? 0x02014b50 : 0x04034b50);
    if (central) u16(20); // made by
    u16(20); // version needed
    u16(0x0800); // UTF-8 names
    u16(0); // stored
    u16(e.time); u16(e.date);
    u32(e.crc); u32(e.bytes.length); u32(e.bytes.length);
    u16(e.nameBytes.length); u16(0); // no extra field
    if (central) { u16(0); u16(0); u16(0); u32(0); u32(e.offset); }
    out.set(e.nameBytes, o); o += e.nameBytes.length;
  };
  for (const e of entries) {
    e.offset = o;
    header(e, false);
    out.set(e.bytes, o); o += e.bytes.length;
  }
  const dir = o;
  for (const e of entries) header(e, true);
  const dirSize = o - dir;
  u32(0x06054b50); u16(0); u16(0); // end of central directory, disk 0
  u16(entries.length); u16(entries.length);
  u32(dirSize); u32(dir); u16(0); // no comment
  return out;
}
