// Minimal ZIP reader (EPUB files are ZIP files). Uses the browser's built-in decompression,
// so no library is needed.

export function openZip(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);

  // The "end of central directory" record sits in the last 64 KB of the file.
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This file is not a valid EPUB (zip) file.');

  const entries = new Map();
  const lower = new Map(); // case-insensitive fallback, some EPUBs get letter case wrong
  const count = dv.getUint16(eocd + 10, true);
  const utf8 = new TextDecoder();
  let p = dv.getUint32(eocd + 16, true);
  for (let i = 0; i < count && dv.getUint32(p, true) === 0x02014b50; i++) {
    const nameLen = dv.getUint16(p + 28, true);
    const name = utf8.decode(u8.subarray(p + 46, p + 46 + nameLen));
    const entry = { method: dv.getUint16(p + 10, true), size: dv.getUint32(p + 20, true), offset: dv.getUint32(p + 42, true) };
    entries.set(name, entry);
    lower.set(name.toLowerCase(), entry);
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }

  const find = (name) => entries.get(name) || lower.get(name?.toLowerCase());

  async function bytes(name) {
    const e = find(name);
    if (!e) return null;
    const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
    const data = u8.subarray(start, start + e.size);
    if (e.method === 0) return data;
    if (e.method !== 8) throw new Error('This EPUB uses an unsupported compression.');
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  return {
    has: (name) => !!find(name),
    bytes,
    text: async (name) => {
      const b = await bytes(name);
      return b && new TextDecoder().decode(b);
    },
  };
}
