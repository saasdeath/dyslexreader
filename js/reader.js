// The reading view. One section (chapter) is rendered at a time and cut into pages with
// CSS columns: every page is one column, and turning a page slides the next column into view.

import { db } from './db.js';
import * as settings from './settings.js';
import { $, el, openPanel, closePanel, panelOpen, toast, busy } from './ui.js';
import { PARSER_VERSION, reprocess } from './import/index.js';
import * as hl from './highlights.js';
import * as ruler from './ruler.js';
import * as tts from './tts.js';

const GAP = 48; // space between columns (never visible)
const PAD = 14; // extra room so letters at the column edge are never cut off

// Current reading state, shared with highlights, ruler and read-aloud.
export const R = {
  book: null,
  content: null,
  s: 0, // section shown
  page: 0, // page within the section
  pages: 1,
  step: 1, // column width + gap, in px
  blocks: [], // block elements of the section
  blockStarts: [], // character offset of each block within the section
  anchor: { s: 0, b: 0, o: 0 }, // where you are: section, block, character
};

const readerEl = $('#reader');
const viewport = $('#viewport');
const flow = $('#flow');
const urls = new Map();
let saveTimer;

// Run navigation steps one after another, so fast key presses can't overlap.
let chain = Promise.resolve();
const queue = (fn) => (chain = chain.then(fn).catch((e) => console.error(e)));

// ---------- Opening and closing ----------

export async function openBook(id) {
  let book = await db.get('books', id);
  if (!book) return false;
  if ((book.parser || 0) < PARSER_VERSION) {
    busy('Updating this book…');
    try { await reprocess(id); } finally { busy(null); }
    book = await db.get('books', id);
  }
  const content = await db.get('content', id);
  const pos = await db.get('positions', id);
  Object.assign(R, { book, content, anchor: validAnchor(pos?.anchor, content) });
  $('#book-title').textContent = book.title;
  $('#pdfview-btn').hidden = book.format !== 'pdf';
  readerEl.hidden = false;
  showControls(false);
  await hl.load(id);
  await queue(async () => {
    await layout();
    await render(R.anchor.s);
    showPage(pageOf(R.anchor), true);
  });
  savePosition();
  if (content.pictureOnly) togglePdfView(true);
  firstTimeTip();
  return true;
}

function firstTimeTip() {
  try {
    if (localStorage.getItem('dyslexreader.tip')) return;
    localStorage.setItem('dyslexreader.tip', '1');
  } catch { return; }
  const touch = matchMedia('(pointer: coarse)').matches;
  toast(touch ? 'Tip: tap the sides to turn the page. Tap the middle for the menu.'
    : 'Tip: use the arrow keys to turn the page. Click the middle for the menu.', 6000);
}

export function closeBook() {
  if (!R.book) return;
  tts.stop();
  ruler.setOn(false);
  hl.hideMenu();
  savePosition();
  pdf.doc?.loadingTask.destroy();
  pdf.doc = null;
  togglePdfView(false, true);
  for (const u of urls.values()) URL.revokeObjectURL(u);
  urls.clear();
  flow.replaceChildren();
  R.book = R.content = null;
  readerEl.hidden = true;
}

function validAnchor(a, content) {
  const s = Math.min(Math.max(a?.s | 0, 0), content.sections.length - 1);
  return { s, b: a?.s === s ? a.b | 0 : 0, o: a?.s === s ? a.o | 0 : 0 };
}

// ---------- Layout ----------

const safeProbe = el('div', { style: 'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)' });
const measure = el('span.book', { style: 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap' }, 'the quick brown fox jumps over the lazy dog');
document.body.append(safeProbe, measure);

async function layout() {
  const s = settings.get();
  await Promise.all(settings.fontFaces().map((f) => document.fonts.load(f).catch(() => {})));
  const cs = getComputedStyle(safeProbe);
  const safe = { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0, right: parseFloat(cs.paddingRight) || 0 };
  const W = window.innerWidth;
  const H = window.innerHeight;
  const side = W < 600 ? 22 : 48;
  const charW = measure.getBoundingClientRect().width / measure.textContent.length;
  const colW = Math.floor(Math.min(W - safe.left - safe.right - side * 2, s.lineWidth * charW));
  const top = safe.top + (H < 700 ? 30 : 52);
  const bottom = safe.bottom + (H < 700 ? 44 : 60);
  const pageH = Math.floor(H - top - bottom);
  R.step = colW + GAP;
  Object.assign(viewport.style, { left: Math.round((W - colW) / 2) - PAD + 'px', top: top + 'px', width: colW + 2 * PAD + 'px', height: pageH + 'px' });
  readerEl.style.setProperty('--col-w', colW + 'px');
  readerEl.style.setProperty('--gap', GAP + 'px');
  readerEl.style.setProperty('--pad', PAD + 'px');
  readerEl.style.setProperty('--page-h', pageH + 'px');
}

async function render(s) {
  R.s = s;
  flow.style.transform = '';
  flow.innerHTML = R.content.sections[s].html;
  for (const img of flow.querySelectorAll('img[data-res]')) img.src = resourceUrl(img.dataset.res);
  await Promise.all([...flow.querySelectorAll('img')].map((i) => i.decode().catch(() => {})));
  R.blocks = [...flow.children];
  let n = 0;
  R.blockStarts = R.blocks.map((b) => { const start = n; n += b.textContent.length; return start; });
  const last = R.blocks[R.blocks.length - 1];
  R.pages = last ? lastPageOf(last) + 1 : 1;
  hl.paint();
}

function resourceUrl(key) {
  if (!urls.has(key)) {
    const blob = R.content.resources?.[key];
    urls.set(key, blob ? URL.createObjectURL(blob) : '');
  }
  return urls.get(key);
}

function relayout() {
  if (!R.book) return;
  queue(async () => {
    const a = R.anchor;
    await layout();
    await render(a.s);
    showPage(pageOf(a), true);
    R.anchor = a;
  });
}

// ---------- Geometry: which page is a piece of text on? ----------

const flowLeft = () => flow.getBoundingClientRect().left;
const pageOfX = (x) => Math.max(0, Math.floor((x - flowLeft() + 2) / R.step));

function rectsOf(node) {
  const r = document.createRange();
  r.selectNodeContents(node);
  const rects = [...r.getClientRects()].filter((x) => x.width || x.height);
  return rects.length ? rects : [node.getBoundingClientRect()];
}
const firstPageOf = (blk) => pageOfX(rectsOf(blk)[0].left);
const lastPageOf = (blk) => { const r = rectsOf(blk); return pageOfX(r[r.length - 1].left); };

// The page holding character o of a block (skips spaces, which can sit at the end of a line).
function charPage(blk, o) {
  const text = blk.textContent;
  while (o < text.length - 1 && /\s/.test(text[o])) o++;
  const p = point(blk, o);
  const r = document.createRange();
  r.setStart(p.node, p.offset);
  r.setEnd(p.node, Math.min(p.offset + 1, p.node.length ?? 0));
  const rect = r.getClientRects()[0];
  return rect ? pageOfX(rect.left) : firstPageOf(blk);
}

export function pageOf(a) {
  const blk = R.blocks[Math.min(a.b, R.blocks.length - 1)];
  if (!blk) return 0;
  return a.o > 0 ? charPage(blk, a.o) : firstPageOf(blk);
}

// The first character visible on the current page.
function firstVisible() {
  const blocks = R.blocks;
  let lo = 0, hi = blocks.length - 1, b = Math.max(0, blocks.length - 1);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lastPageOf(blocks[mid]) >= R.page) { b = mid; hi = mid - 1; } else lo = mid + 1;
  }
  const blk = blocks[b];
  if (!blk || firstPageOf(blk) >= R.page) return { s: R.s, b, o: 0 };
  const len = blk.textContent.length;
  let l = 0, h = len - 1, o = 0;
  while (l <= h) {
    const mid = (l + h) >> 1;
    if (charPage(blk, mid) >= R.page) { o = mid; h = mid - 1; } else l = mid + 1;
  }
  return { s: R.s, b, o };
}

// Text position helpers (character offsets inside a block <-> DOM points).
export function point(blk, o) {
  const w = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT);
  let last = null;
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (o <= n.length) return { node: n, offset: o };
    o -= n.length;
    last = n;
  }
  return last ? { node: last, offset: last.length } : { node: blk, offset: 0 };
}

export function rangeOf(b1, o1, b2, o2) {
  const r = document.createRange();
  const p1 = point(R.blocks[b1], o1);
  const p2 = point(R.blocks[b2], o2);
  r.setStart(p1.node, p1.offset);
  r.setEnd(p2.node, p2.offset);
  return r;
}

export function locate(node, offset) {
  if (node === flow) return { b: Math.min(offset, R.blocks.length - 1), o: 0 };
  let blk = node.nodeType === 1 ? node : node.parentElement;
  while (blk && blk.parentElement !== flow) blk = blk.parentElement;
  if (!blk) return null;
  const r = document.createRange();
  r.setStart(blk, 0);
  r.setEnd(node, offset);
  return { b: R.blocks.indexOf(blk), o: r.toString().length };
}

// ---------- Pages ----------

function showPage(p, keepAnchor = false) {
  R.page = Math.min(Math.max(p, 0), R.pages - 1);
  flow.style.transform = `translateX(${-R.page * R.step}px)`;
  if (!keepAnchor) R.anchor = firstVisible();
  hl.hideMenu();
  ruler.refresh();
  updateInfo();
  scheduleSave();
}

export const showPageOf = (a) => showPage(pageOf(a));

export function next() {
  return queue(async () => {
    if (pdf.on) return pdfGo(pdf.page + 1);
    if (R.page < R.pages - 1) return showPage(R.page + 1);
    if (R.s < R.content.sections.length - 1) {
      await render(R.s + 1);
      return showPage(0);
    }
    if (!tts.active()) toast('This is the end of the book.');
  });
}

export function prev() {
  return queue(async () => {
    if (pdf.on) return pdfGo(pdf.page - 1);
    if (R.page > 0) return showPage(R.page - 1);
    if (R.s > 0) {
      await render(R.s - 1);
      showPage(R.pages - 1);
    }
  });
}

// Jump to a place in the book (contents, highlights). Resolves when shown.
export function goTo(a) {
  return queue(async () => {
    if (pdf.on) togglePdfView(false, true);
    if (a.s !== R.s) await render(a.s);
    showPage(pageOf(a), true);
    R.anchor = { s: a.s, b: a.b, o: a.o || 0 };
  });
}

// Used by read-aloud: make sure the section is rendered (without changing the page yet).
export function ensureSection(s) {
  return queue(async () => { if (s !== R.s) await render(s); });
}

export function progress() {
  const total = R.book?.totalChars;
  if (!total) return 0;
  if (R.s === R.content.sections.length - 1 && R.page === R.pages - 1) return 1;
  const at = R.book.sectionStarts[R.s] + (R.blockStarts[R.anchor.b] || 0) + R.anchor.o;
  return Math.min(1, at / total);
}

export function sectionTitle(s = R.s, b = R.anchor.b) {
  let title = R.content.sections[s]?.title || '';
  for (const t of R.content.toc) if (t.s < s || (t.s === s && t.b <= b)) title = t.title;
  return title;
}

function updateInfo() {
  const pct = Math.round(progress() * 100) + '%';
  if (pdf.on) {
    $('#page-info').textContent = `Original page ${pdf.page} of ${pdf.doc?.numPages || '?'}`;
    $('#where').textContent = `Original page ${pdf.page} · ${pct}`;
    return;
  }
  const left = R.pages - 1 - R.page;
  $('#page-info').textContent = pct;
  const chapter = sectionTitle();
  const pagesLeft = left === 0 ? 'last page in chapter' : left === 1 ? '1 page left in chapter' : `${left} pages left in chapter`;
  const where = [chapter, pagesLeft, pct].filter(Boolean).join(' · ');
  $('#where').textContent = where.charAt(0).toUpperCase() + where.slice(1);
}

// ---------- Saving your place ----------

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePosition, 700);
}

export function savePosition() {
  clearTimeout(saveTimer);
  if (!R.book) return;
  const now = Date.now();
  db.put('positions', {
    bookId: R.book.id, title: R.book.title, author: R.book.author,
    anchor: R.anchor, progress: progress(), lastOpenedAt: now, updatedAt: now,
  }).catch((e) => console.error(e));
}

document.addEventListener('visibilitychange', () => { if (document.hidden) savePosition(); });

// ---------- Original PDF pages ----------

const pdf = { on: false, doc: null, page: 1 };

export async function togglePdfView(on = !pdf.on, quiet = false, page) {
  if (on && R.book?.format === 'pdf') {
    if (!pdf.doc) {
      busy('Opening the original pages…');
      try {
        const { openPdf } = await import('./import/pdf.js');
        const file = await db.get('files', R.book.id);
        pdf.doc = await openPdf(new Uint8Array(await file.blob.arrayBuffer()));
      } finally {
        busy(null);
      }
    }
    tts.stop();
    pdf.page = page || currentPdfPage();
    pdf.on = true;
    readerEl.classList.add('pdf-mode');
    $('#pdf-view').hidden = false;
    viewport.hidden = true;
    ruler.refresh();
    await pdfGo(pdf.page);
  } else if (pdf.on || quiet) {
    const wasOn = pdf.on;
    pdf.on = false;
    readerEl.classList.remove('pdf-mode');
    $('#pdf-view').hidden = true;
    viewport.hidden = false;
    if (wasOn && !quiet) {
      const a = blockForPdfPage(pdf.page);
      if (a) await goTo(a);
    }
    ruler.refresh();
    updateInfo();
  }
  $('#pdfview-btn').setAttribute('aria-pressed', pdf.on);
}

function currentPdfPage() {
  for (let b = R.anchor.b; b >= 0; b--) if (R.blocks[b]?.dataset.p) return +R.blocks[b].dataset.p;
  return 1;
}

function blockForPdfPage(page) {
  const secs = R.content.sections;
  for (let s = 0; s < secs.length; s++) {
    let b = 0;
    // Blocks are a flat list, so each opening block tag is the next block.
    for (const m of secs[s].html.matchAll(/<(?:p|h2|h3|figure|hr|pre)\b([^>]*)>/g)) {
      const p = m[1].match(/data-p="(\d+)"/);
      if (p && +p[1] >= page) return { s, b, o: 0 };
      b++;
    }
  }
  return null;
}

async function pdfGo(n) {
  if (!pdf.doc) return;
  pdf.page = Math.min(Math.max(n, 1), pdf.doc.numPages);
  const box = viewport.getBoundingClientRect();
  const { renderPage } = await import('./import/pdf.js');
  await renderPage(pdf.doc, pdf.page, $('#pdf-canvas'), window.innerWidth - 24, (box.height || window.innerHeight - 100) + 40);
  updateInfo();
}

// ---------- Controls ----------

let hoverShown = false;
let hideTimer;

export function showControls(on = !readerEl.classList.contains('controls')) {
  readerEl.classList.toggle('controls', on);
  hoverShown = false;
}

$('#back-btn').addEventListener('click', () => { location.hash = ''; });
$('#settings-btn').addEventListener('click', () => import('./settings-panel.js').then((m) => m.openSettings()));
$('#toc-btn').addEventListener('click', showContents);
$('#hl-btn').addEventListener('click', () => hl.openList());
$('#ruler-btn').addEventListener('click', () => ruler.setOn(!ruler.isOn()));
$('#tts-btn').addEventListener('click', async () => {
  showControls(false);
  if (pdf.on) {
    await togglePdfView(false); // read-aloud works on the text, not the page picture
    await chain;
  }
  tts.start(); // no waiting otherwise: iPhones only allow speech to start directly from a tap
});
$('#pdfview-btn').addEventListener('click', () => togglePdfView());
for (const b of document.querySelectorAll('#reader .overlay button')) b.addEventListener('click', () => b.blur());

function showContents() {
  const toc = R.content.toc;
  let current = -1;
  toc.forEach((t, i) => { if (t.s < R.s || (t.s === R.s && t.b <= R.anchor.b)) current = i; });
  const list = el('ul.nav-list', {}, toc.map((t, i) =>
    el('li', {}, el(`button.lvl${Math.min(t.level, 3)}${i === current ? '.current' : ''}`, {
      onclick: () => { closePanel(); showControls(false); goTo({ s: t.s, b: t.b, o: 0 }); },
    }, t.title))));
  openPanel('Contents', toc.length ? list : el('p.lead', {}, 'This book has no table of contents.'));
  list.querySelector('.current')?.scrollIntoView({ block: 'center' });
}

// ---------- Input: taps, swipes, keys, wheel ----------

let g = null; // the current touch / click gesture

readerEl.addEventListener('pointerdown', (e) => {
  if (!e.isPrimary || e.target.closest('.overlay, .sel-menu, .tts-bar') || panelOpen()) { g = null; return; }
  g = {
    x: e.clientX, y: e.clientY, t: Date.now(), type: e.pointerType,
    hadSelection: !document.getSelection().isCollapsed || hl.menuOpen(), rulerDrag: false,
  };
});

readerEl.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse' && !e.buttons) {
    hoverControls(e);
    if (ruler.isOn() && !pdf.on) ruler.followY(e.clientY);
    return;
  }
  if (!g || g.type === 'mouse' || !ruler.isOn() || pdf.on) return;
  const dx = e.clientX - g.x;
  const dy = e.clientY - g.y;
  if (g.rulerDrag || (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx))) {
    g.rulerDrag = true;
    ruler.followY(e.clientY);
  }
});

readerEl.addEventListener('pointerup', (e) => {
  const gesture = g;
  g = null;
  if (!gesture || !e.isPrimary || gesture.rulerDrag) return;
  const dx = e.clientX - gesture.x;
  const dy = e.clientY - gesture.y;
  const dt = Date.now() - gesture.t;
  if (gesture.hadSelection) { hl.hideMenu(); return; }
  if (!document.getSelection().isCollapsed) return; // the user is selecting text
  if (gesture.type !== 'mouse' && Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 800) {
    stopReading();
    return dx < 0 ? next() : prev();
  }
  if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && dt < 600) tap(e);
});

function tap(e) {
  const pic = e.target.closest?.('.pdf-pic');
  if (pic) return togglePdfView(true, false, +pic.dataset.p);
  if (!pdf.on && hl.tapAt(e.clientX, e.clientY)) return;
  if (readerEl.classList.contains('controls')) return showControls(false);
  const third = window.innerWidth / 3;
  if (e.clientX < third) { stopReading(); prev(); }
  else if (e.clientX > third * 2) { stopReading(); next(); }
  else showControls(true);
}

function hoverControls(e) {
  const nearEdge = e.clientY < 90 || e.clientY > window.innerHeight - 140;
  clearTimeout(hideTimer);
  if (nearEdge && !readerEl.classList.contains('controls')) {
    readerEl.classList.add('controls');
    hoverShown = true;
  } else if (!nearEdge && hoverShown) {
    hideTimer = setTimeout(() => { if (hoverShown) showControls(false); }, 1200);
  }
}

// Turning pages yourself stops read-aloud (press Listen again to continue from the new page).
function stopReading() {
  if (tts.active()) tts.stop();
}

document.addEventListener('keydown', (e) => {
  if (readerEl.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
  if ($('#dialog').open || e.target.closest?.('input, textarea, select')) return;
  if (e.key === 'Escape') {
    if (hl.menuOpen()) hl.hideMenu();
    else if (!closePanel()) showControls(false);
    return;
  }
  if (panelOpen()) return;
  const go = (fn) => { e.preventDefault(); stopReading(); fn(); };
  switch (e.key) {
    case 'ArrowRight': case 'PageDown': return go(next);
    case 'ArrowLeft': case 'PageUp': return go(prev);
    case ' ': return go(e.shiftKey ? prev : next);
    case 'ArrowDown': if (ruler.isOn()) { e.preventDefault(); ruler.move(1); } else go(next); return;
    case 'ArrowUp': if (ruler.isOn()) { e.preventDefault(); ruler.move(-1); } else go(prev); return;
  }
});

let wheelLock = false;
let wheelSum = 0;
let wheelTimer;
readerEl.addEventListener('wheel', (e) => {
  if (panelOpen() || e.ctrlKey) return;
  e.preventDefault();
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => { wheelLock = false; wheelSum = 0; }, 250);
  if (wheelLock) return;
  wheelSum += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (Math.abs(wheelSum) > 40) {
    wheelLock = true;
    stopReading();
    wheelSum > 0 ? next() : prev();
  }
}, { passive: false });

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => (pdf.on ? pdfGo(pdf.page) : relayout()), 200);
});

const LAYOUT_KEYS = ['font', 'size', 'letterSpacing', 'wordSpacingOn', 'wordSpacing', 'lineHeight', 'lineWidth', 'paragraphGaps', 'italicsNormal'];
settings.onChange((s, patch) => {
  if (Object.keys(patch).some((k) => LAYOUT_KEYS.includes(k))) relayout();
  else ruler.refresh(true);
});
