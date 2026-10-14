// MOBI importer for classic Kindle files (MOBI 6, the kind Calibre makes).
// Newer Kindle files (AZW3 / KF8) and DRM-protected files are not supported:
// convert those to EPUB with Calibre.

import { Builder, addHTML } from './html.js';
import { parseTxt } from './txt.js';

export class UserError extends Error {}

export function parseMobi(buf, { name } = {}) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);

  // Palm database: a list of records.
  const count = dv.getUint16(76);
  const offsets = [];
  for (let i = 0; i < count; i++) offsets.push(dv.getUint32(78 + i * 8));
  offsets.push(u8.length);
  const record = (i) => u8.subarray(offsets[i], offsets[i + 1]);

  const r0 = record(0);
  const h = new DataView(r0.buffer, r0.byteOffset, r0.byteLength);
  const compression = h.getUint16(0);
  const textRecords = h.getUint16(8);
  const encryption = h.getUint16(12);
  const isMobi = String.fromCharCode(...r0.subarray(16, 20)) === 'MOBI';

  if (encryption) throw new UserError('This book has DRM (copy protection), so it cannot be opened.');
  if (compression === 17480) throw new UserError('This Kindle file uses a format this app cannot read. Please convert it to EPUB with Calibre.');
  if (compression !== 1 && compression !== 2) throw new UserError('This MOBI file uses an unknown compression.');

  const headerLen = isMobi ? h.getUint32(20) : 0;
  const version = isMobi ? h.getUint32(36) : 0;
  if (version >= 8) throw new UserError('This is a newer Kindle file (AZW3 / KF8). Please convert it to EPUB with Calibre.');
  const encoding = isMobi ? h.getUint32(28) : 1252;
  const firstImage = isMobi ? h.getUint32(0x6c) : 0;
  const extraFlags = isMobi && headerLen >= 0xe4 ? h.getUint16(0xf2) : 0;
  const exth = isMobi && h.getUint32(0x80) & 0x40 ? readExth(r0.subarray(16 + headerLen)) : new Map();

  // Decompress the text records into one byte array.
  const parts = [];
  let total = 0;
  for (let i = 1; i <= textRecords; i++) {
    let rec = trimTrailing(record(i), extraFlags);
    if (compression === 2) rec = palmDoc(rec);
    parts.push(rec);
    total += rec.length;
  }
  const raw = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { raw.set(p, pos); pos += p.length; }

  const charset = encoding === 65001 ? 'utf-8' : 'windows-1252';
  if (!isMobi) return parseTxt(raw.buffer, { name }); // plain PalmDOC text

  const utf8 = new TextDecoder(charset);
  const exthText = (type) => (exth.get(type) || []).map((v) => utf8.decode(v).trim());
  const title = exthText(503)[0] || utf8.decode(r0.subarray(h.getUint32(0x54), h.getUint32(0x54) + h.getUint32(0x58)));
  const author = exthText(100).join(', ');
  const lang = exthText(524)[0] || '';

  // Pictures are stored in records, numbered from "firstImage".
  const resources = {};
  const imageAt = (i) => {
    const bytes = i < count ? record(i) : null;
    const type = bytes && sniffImage(bytes);
    return type ? new Blob([bytes], { type }) : null;
  };

  const html = withFileposAnchors(raw, charset)
    .replace(/<mbp:pagebreak[^>]*>/gi, '<hr class="page-break">')
    .replace(/<\/?mbp:[^>]*>/gi, '');
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // Table of contents: the book's own contents page, linked with filepos numbers.
  const b = new Builder();
  const tocPos = html.match(/<reference[^>]*type="toc"[^>]*filepos=0*(\d+)/i)?.[1];
  if (tocPos) {
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
    walker.currentNode = doc.getElementById('filepos' + tocPos) || doc.body;
    for (let n = walker.nextNode(); n && !n.classList.contains('page-break'); n = walker.nextNode()) {
      if (n.localName === 'a' && n.getAttribute('filepos')) b.toc(n.textContent, 'filepos' + +n.getAttribute('filepos'));
    }
  }

  addHTML(doc.body, b, {
    key: (id) => id,
    image: (node) => {
      const n = parseInt(node.getAttribute('recindex'), 10);
      if (!n) return null;
      const key = 'img' + n;
      if (!(key in resources)) resources[key] = imageAt(firstImage + n - 1);
      return resources[key] ? key : null;
    },
    heading: mobiHeading,
  });

  const coverIndex = exth.get(201) ? new DataView(exth.get(201)[0].buffer, exth.get(201)[0].byteOffset).getUint32(0) : -1;
  const cover = coverIndex >= 0 ? imageAt(firstImage + coverIndex) : null;
  for (const k in resources) if (!resources[k]) delete resources[k];

  return { title, author, lang, cover, resources, ...b.finish() };
}

// MOBI books mark headings with big <font size="…"> instead of <h1>.
function mobiHeading(node) {
  const name = node.localName;
  if (name !== 'p' && name !== 'div' && name !== 'blockquote') return null;
  const text = node.textContent.trim();
  if (!text || text.length > 150) return null;
  const walker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (!t.data.trim()) continue;
    const font = t.parentElement.closest('font[size]');
    const size = font && node.contains(font) ? parseInt(font.getAttribute('size'), 10) : 3;
    if (!(size >= 4 || font?.getAttribute('size')?.startsWith('+'))) return null;
  }
  return 'h2';
}

// Links in MOBI point to byte positions ("filepos"). Insert an anchor at each target
// so the contents page and notes can find their place after parsing.
function withFileposAnchors(raw, charset) {
  const oneToOne = new TextDecoder('windows-1252').decode(raw); // 1 byte = 1 character, for searching
  const targets = new Set();
  for (const m of oneToOne.matchAll(/filepos=["']?0*(\d+)/gi)) targets.add(+m[1]);
  const sorted = [...targets].filter((p) => p < raw.length).sort((a, b) => a - b);
  const chunks = [];
  let last = 0;
  const enc = new TextEncoder();
  for (const p of sorted) {
    let at = p;
    const lt = oneToOne.lastIndexOf('<', at - 1);
    if (lt > oneToOne.lastIndexOf('>', at - 1)) at = lt; // don't insert inside a tag
    if (at < last) continue;
    chunks.push(raw.subarray(last, at), enc.encode(`<a id="filepos${p}"></a>`));
    last = at;
  }
  chunks.push(raw.subarray(last));
  return new TextDecoder(charset).decode(concat(chunks));
}

function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let i = 0;
  for (const c of chunks) { out.set(c, i); i += c.length; }
  return out;
}

function readExth(e) {
  const map = new Map();
  if (String.fromCharCode(...e.subarray(0, 4)) !== 'EXTH') return map;
  const dv = new DataView(e.buffer, e.byteOffset, e.byteLength);
  const n = dv.getUint32(8);
  let p = 12;
  for (let i = 0; i < n && p + 8 <= e.length; i++) {
    const type = dv.getUint32(p);
    const len = dv.getUint32(p + 4);
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(e.subarray(p + 8, p + len));
    p += len;
  }
  return map;
}

// Text records can end with extra index data that is not part of the text.
function trimTrailing(rec, flags) {
  let size = rec.length;
  for (let bit = 15; bit > 0; bit--) {
    if (!(flags & (1 << bit))) continue;
    let v = 0;
    for (let j = Math.max(0, size - 4); j < size; j++) {
      if (rec[j] & 0x80) v = 0;
      v = (v << 7) | (rec[j] & 0x7f);
    }
    size -= v;
  }
  if (flags & 1) size -= (rec[size - 1] & 3) + 1;
  return rec.subarray(0, Math.max(0, size));
}

// PalmDOC (LZ77-style) decompression.
function palmDoc(src) {
  let out = new Uint8Array(src.length * 8 + 16);
  let o = 0;
  const grow = (n) => {
    if (o + n <= out.length) return;
    const bigger = new Uint8Array((o + n) * 2);
    bigger.set(out);
    out = bigger;
  };
  for (let i = 0; i < src.length; ) {
    const c = src[i++];
    if (c === 0 || (c >= 9 && c <= 0x7f)) {
      grow(1);
      out[o++] = c;
    } else if (c <= 8) {
      grow(c);
      out.set(src.subarray(i, i + c), o);
      o += c;
      i += c;
    } else if (c >= 0xc0) {
      grow(2);
      out[o++] = 0x20;
      out[o++] = c ^ 0x80;
    } else {
      const pair = (c << 8) | src[i++];
      const dist = (pair >> 3) & 0x7ff;
      const len = (pair & 7) + 3;
      grow(len);
      for (let k = 0; k < len; k++, o++) out[o] = out[o - dist];
    }
  }
  return out.subarray(0, o);
}

function sniffImage(b) {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return null;
}
