// Adding a book: detect the format, convert it to the app's simple format, store it.

import { db, persist } from '../db.js';
import { parseEpub } from './epub.js';
import { parseTxt } from './txt.js';
import { parseMobi, UserError } from './mobi.js';

export { UserError };

// Bump this when an importer changes, so books are converted again from their original file.
export const PARSER_VERSION = 1;

export async function importFile(file, onProgress) {
  const buf = await file.arrayBuffer();
  const id = await fingerprint(buf);
  const existing = await db.get('books', id);
  if (existing) return { id, existed: true, title: existing.title };

  const blob = new Blob([buf], { type: file.type || 'application/octet-stream' });
  const format = detect(file.name, new Uint8Array(buf, 0, Math.min(buf.byteLength, 100)));
  const parsed = await parse(format, buf, file.name, onProgress);
  await save(id, format, parsed, { addedAt: Date.now() });
  await db.put('files', { id, blob, name: file.name });
  persist();
  return { id, title: parsed.title };
}

// Convert a stored book again (after an app update improved an importer).
export async function reprocess(id, onProgress) {
  const book = await db.get('books', id);
  const file = await db.get('files', id);
  if (!book || !file) return;
  const parsed = await parse(book.format, await file.blob.arrayBuffer(), file.name, onProgress);
  await save(id, book.format, parsed, { addedAt: book.addedAt, title: book.title, author: book.author });
}

async function parse(format, buf, name, onProgress) {
  if (format === 'pdf') {
    const { parsePdf } = await import('./pdf.js'); // pdf.js is only loaded when needed
    return parsePdf(buf, { name, onProgress });
  }
  if (format === 'epub') return parseEpub(buf, { name, onProgress });
  if (format === 'mobi') return parseMobi(buf, { name });
  return parseTxt(buf, { name });
}

async function save(id, format, p, keep) {
  if (!p.sections.length || !p.sections.some((s) => s.chars > 0 || s.html.includes('<img'))) {
    throw new UserError('No readable text was found in this book.');
  }
  const sectionStarts = [];
  let total = 0;
  for (const s of p.sections) { sectionStarts.push(total); total += s.chars; }
  await db.put('content', { id, sections: p.sections, toc: p.toc, anchors: p.anchors, resources: p.resources, pictureOnly: !!p.pictureOnly });
  await db.put('books', {
    id, format,
    title: keep.title || p.title || 'Untitled',
    author: keep.author ?? p.author ?? '',
    lang: p.lang || '',
    cover: await thumbnail(p.cover),
    addedAt: keep.addedAt,
    totalChars: total,
    sectionStarts,
    parser: PARSER_VERSION,
  });
}

function detect(name, head) {
  const ascii = (a, b) => String.fromCharCode(...head.subarray(a, b));
  if (ascii(0, 5) === '%PDF-') return 'pdf';
  if (ascii(0, 2) === 'PK') return 'epub';
  if (['BOOKMOBI', 'TEXtREAd'].includes(ascii(60, 68))) return 'mobi';
  const ext = name.split('.').pop().toLowerCase();
  if (['txt', 'text', 'md'].includes(ext) || !head.includes(0)) return 'txt';
  throw new UserError('This kind of file is not supported. Please use EPUB, MOBI, PDF or TXT.');
}

// Same file = same id on every device, so the sync file can match books.
async function fingerprint(buf) {
  if (crypto.subtle) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    return [...hash.slice(0, 16)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  // Fallback for non-secure pages (e.g. testing over plain http): FNV-1a over the bytes.
  const u8 = new Uint8Array(buf);
  let h = 0x811c9dc5;
  for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i], 16777619);
  return 'f' + (h >>> 0).toString(16) + u8.length.toString(16);
}

// Small cover picture for the shelf.
async function thumbnail(blob) {
  if (!blob) return null;
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 400 / bmp.width);
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  } catch {
    return blob;
  }
}
