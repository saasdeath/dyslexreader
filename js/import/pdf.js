// PDF importer: extracts the text so your own reading settings apply.
// It rebuilds paragraphs from the printed lines, removes page numbers and running headers,
// joins words split by a hyphen at the end of a line, and finds chapters from the bookmarks.
// Every paragraph remembers its page (data-p) so you can switch to the original page view.

import { Builder, textBlock } from './html.js';

let pdfjsLoading;
export function loadPdfJs() {
  pdfjsLoading ??= import('../../vendor/pdfjs/pdf.min.mjs').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
    return pdfjs;
  });
  return pdfjsLoading;
}

export async function openPdf(bytes) {
  const pdfjs = await loadPdfJs();
  return pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
}

// Draw one page into a canvas, fitted inside maxW x maxH (CSS pixels).
export async function renderPage(doc, n, canvas, maxW, maxH) {
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(maxW / base.width, maxH / base.height);
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  const vp = page.getViewport({ scale: scale * ratio });
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  canvas.style.width = Math.floor(vp.width / ratio) + 'px';
  canvas.style.height = Math.floor(vp.height / ratio) + 'px';
  await page.render({ canvas, viewport: vp }).promise;
  page.cleanup();
}

export async function parsePdf(buf, { name = '', onProgress } = {}) {
  const doc = await openPdf(new Uint8Array(buf).slice()); // pdf.js takes ownership of the bytes it gets
  try {
    const meta = await doc.getMetadata().catch(() => ({}));
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      onProgress?.(n, doc.numPages);
      const page = await doc.getPage(n);
      const { height, width } = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      pages.push({ n, height, width, lines: toLines(content.items) });
      page.cleanup();
    }
    const marks = await bookmarks(doc);
    const cover = await coverImage(doc);
    const built = buildBook(pages, marks);
    return {
      title: meta.info?.Title?.trim() || name.replace(/\.[^.]+$/, ''),
      author: meta.info?.Author?.trim() || '',
      lang: '',
      cover,
      resources: {},
      ...built,
    };
  } finally {
    doc.loadingTask.destroy();
  }
}

// ---- 1. Text items -> lines ----
function toLines(items) {
  const lines = [];
  let cur = null;
  for (const it of items) {
    if (!('str' in it) || !it.str) continue;
    const [a, b, , d, x, y] = it.transform;
    const size = Math.hypot(a, b) || Math.abs(d) || 1;
    const sameLine = cur && Math.abs(y - cur.y) < Math.max(size, cur.size) * 0.55 && x > cur.x0 - 1;
    if (!sameLine) {
      cur = { x0: x, x1: x, y, size, segs: [], sizes: new Map() };
      lines.push(cur);
    } else if (x - cur.x1 > size * 0.15 && !/\s$/.test(lineText(cur)) && !/^\s/.test(it.str)) {
      cur.segs.push({ t: ' ' });
    }
    const raised = sameLine && y - cur.y > size * 0.2 && size < cur.size * 0.85;
    cur.segs.push({ t: it.str, sup: raised });
    cur.x1 = Math.max(cur.x1, x + it.width);
    if (!raised) cur.sizes.set(round(size), (cur.sizes.get(round(size)) || 0) + it.str.length);
  }
  for (const l of lines) {
    l.size = [...l.sizes].sort((p, q) => q[1] - p[1])[0]?.[0] || l.size; // the size most of the line uses
    l.str = lineText(l).replace(/\s+/g, ' ').trim();
    delete l.sizes;
  }
  return lines.filter((l) => l.str);
}

const round = (v) => Math.round(v * 2) / 2;
const lineText = (l) => l.segs.map((s) => s.t).join('');

// ---- 2. Lines -> paragraphs ----
function buildBook(pages, marks) {
  const all = pages.flatMap((p) => p.lines);
  if (all.reduce((n, l) => n + l.str.length, 0) < pages.length * 20) return pictureOnly(pages);

  const body = mode(all.map((l) => [l.size, l.str.length]));
  const bodyLines = all.filter((l) => Math.abs(l.size - body) < 0.6);
  const left = mode(bodyLines.map((l) => [Math.round(l.x0), 1]));
  const right = percentile(bodyLines.map((l) => l.x1), 0.9);
  const gaps = [];
  for (const p of pages) for (let i = 1; i < p.lines.length; i++) {
    const g = p.lines[i - 1].y - p.lines[i].y;
    if (g > 0 && g < body * 3) gaps.push([round(g), 1]);
  }
  const lineGap = mode(gaps) || body * 1.3;
  removeHeadersAndFooters(pages);

  const paras = [];
  let cur = null;
  let prev = null;
  for (const page of pages) {
    const lines = page.lines;
    if (looksLikePicturePage(lines, body, left, right)) {
      paras.push({ pic: true, page: page.n, y: Infinity });
      cur = null;
    }
    for (const line of lines) {
      const big = line.size >= body * 1.18;
      const centered = isCentered(line, left, right, body);
      const gap = prev && prev.page === page.n ? prev.y - line.y : null;
      // A centred line that continues a wide line above it, around the same middle (wrapped caption or quote).
      // (Inset on both sides; a normal new paragraph is only indented on the left.)
      const wrapped = !big && gap > 0 && gap < lineGap * 1.45 && prev.x1 - prev.x0 > (right - left) * 0.6 &&
        line.x0 > prev.x0 + body * 2 && line.x1 < prev.x1 - body * 2 &&
        Math.abs((prev.x0 + prev.x1) / 2 - (line.x0 + line.x1) / 2) < body * 1.5;
      let start;
      if (!cur) start = true;
      else if (wrapped) start = false;
      else if (big !== cur.big || centered || prev.centered) start = true; // titles and centred lines stand alone
      else if (prev.page !== page.n) {
        // First line on a new page: continue the paragraph unless the last one clearly ended.
        start = endsShort(prev, right, body, left) || line.x0 > prev.x0 + body * 0.6;
      } else {
        start = gap < 0 || gap > lineGap * 1.45 || line.x0 > prev.x0 + body * 0.6 || endsShort(prev, right, body, left) ||
          (!big && Math.abs(line.size - prev.size) > 1.5);
      }
      if (start) {
        cur = { big, size: line.size, page: page.n, y: line.y, segs: [] };
        paras.push(cur);
      } else {
        join(cur.segs, line);
      }
      cur.segs.push(...line.segs);
      prev = { ...line, page: page.n, centered };
    }
  }

  // ---- 3. Paragraphs -> sections and blocks ----
  const b = new Builder();
  let m = 0;
  for (const p of paras) {
    while (m < marks.length && (p.page > marks[m].page || (p.page === marks[m].page && p.y <= marks[m].y + 2))) {
      b.section(marks[m].title);
      b.anchor('m' + m);
      b.toc(marks[m].title, 'm' + m, marks[m].level);
      m++;
    }
    if (p.pic) {
      b.add(textBlock(b, 'p', `Page ${p.page} may have a picture. Tap here to see the original page.`, { class: 'pdf-pic', 'data-p': p.page }));
      continue;
    }
    const text = p.segs.map((s) => s.t).join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    let tag = 'p';
    if (p.big && text.length < 200) tag = p.size >= body * 1.45 ? 'h2' : 'h3';
    if (tag === 'h2' && !marks.length) b.section(text);
    b.add(blockFromSegs(b, tag, p.segs, p.page));
  }
  return b.finish();
}

// Join a new line onto a paragraph: remove end-of-line hyphens, keep dashes tight.
function join(segs, line) {
  const last = segs[segs.length - 1];
  const next = line.segs.find((s) => s.t.trim())?.t.trimStart() || '';
  const end = last.t.trimEnd();
  if (/[a-z]-$/i.test(end) && /^[a-z]/.test(next)) last.t = end.slice(0, -1);
  else if (/[—–]$/.test(end) || /^[—–]/.test(next)) last.t = end;
  else last.t = end + ' ';
  line.segs[0].t = line.segs[0].t.trimStart();
}

function blockFromSegs(b, tag, segs, page) {
  const node = b.el(tag);
  node.dataset.p = page;
  let text = '';
  const flushText = () => {
    if (text) node.append(text);
    text = '';
  };
  for (const s of segs) {
    if (s.sup) {
      flushText();
      const sup = b.el('sup');
      sup.textContent = s.t.trim();
      node.append(sup);
    } else {
      text += s.t;
    }
  }
  flushText();
  // Collapse whitespace across the pieces so stored text equals displayed text.
  const walker = b.doc.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let prevSpace = true;
  let last = null;
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    let v = t.data.replace(/\s+/g, ' ');
    if (prevSpace && v.startsWith(' ')) v = v.slice(1);
    t.data = v;
    if (v) { prevSpace = v.endsWith(' '); last = t; }
  }
  if (last) last.data = last.data.replace(/ $/, '');
  return node;
}

// The previous line stopped early: a sentence ended, or it is an item in a list.
const endsShort = (line, right, body, left) =>
  (line.x1 < right - body * 2.5 && /[.!?:;"”’)\]]$/.test(line.str)) || line.x1 < right - (right - left) * 0.35;

function isCentered(line, left, right, body) {
  const mid = (left + right) / 2;
  return line.x0 > left + body * 3 && line.x1 < right - body * 3 && Math.abs((line.x0 + line.x1) / 2 - mid) < body * 1.5;
}

function looksLikePicturePage(lines, body, left, right) {
  const chars = lines.reduce((n, l) => n + l.str.length, 0);
  if (chars < 15) return true;
  return lines.length <= 6 && lines.every((l) => isCentered(l, left, right, body) || l.size < body * 0.95);
}

// Running headers/footers repeat on many pages near the top or bottom; page numbers are just numbers.
function removeHeadersAndFooters(pages) {
  const key = (l) => l.str.replace(/\d+/g, '#').toLowerCase();
  const edge = (p) => {
    if (p.lines.length < 2) return [];
    const ys = p.lines.map((l) => l.y);
    const top = p.lines[ys.indexOf(Math.max(...ys))];
    const bottom = p.lines[ys.indexOf(Math.min(...ys))];
    return [top, bottom].filter((l) => l.y > p.height * 0.86 || l.y < p.height * 0.14);
  };
  const counts = new Map();
  for (const p of pages) for (const l of edge(p)) counts.set(key(l), (counts.get(key(l)) || 0) + 1);
  const repeated = Math.max(3, pages.length * 0.2);
  for (const p of pages) {
    const drop = edge(p).filter((l) => counts.get(key(l)) >= repeated || /^(page\s*)?[\divxlc]+(\s*(of|\/)\s*\d+)?$/i.test(l.str));
    p.lines = p.lines.filter((l) => !drop.includes(l));
  }
}

// A scanned PDF has no text: make one "picture" block per page; the reader opens the page view.
function pictureOnly(pages) {
  const b = new Builder();
  for (const p of pages) {
    b.add(textBlock(b, 'p', `Page ${p.n}. This page has no text. Tap here to see it.`, { class: 'pdf-pic', 'data-p': p.n }));
  }
  return { ...b.finish(), pictureOnly: true };
}

// Chapters from the PDF bookmarks (outline), top two levels.
async function bookmarks(doc) {
  const out = [];
  const outline = (await doc.getOutline().catch(() => null)) || [];
  const visit = async (items, level) => {
    for (const item of items) {
      try {
        const dest = typeof item.dest === 'string' ? await doc.getDestination(item.dest) : item.dest;
        if (dest) {
          const page = (typeof dest[0] === 'object' ? await doc.getPageIndex(dest[0]) : dest[0]) + 1;
          const y = dest[1]?.name === 'XYZ' && typeof dest[3] === 'number' ? dest[3] : Infinity;
          out.push({ title: item.title, page, y, level });
        }
      } catch {}
      if (level < 2 && item.items?.length) await visit(item.items, level + 1);
    }
  };
  await visit(outline, 1);
  return out.sort((a, b) => a.page - b.page || b.y - a.y);
}

async function coverImage(doc) {
  try {
    const canvas = document.createElement('canvas');
    await renderPage(doc, 1, canvas, 300 / (window.devicePixelRatio || 1), 450 / (window.devicePixelRatio || 1));
    return await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  } catch {
    return null;
  }
}

// ---- small statistics helpers ----
function mode(pairs) {
  const m = new Map();
  for (const [v, w] of pairs) m.set(v, (m.get(v) || 0) + w);
  let best = null;
  let bestW = -1;
  for (const [v, w] of m) if (w > bestW) { best = v; bestW = w; }
  return best;
}

function percentile(values, q) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) * q)] || 0;
}
