// Highlights: select text, pick a colour, optionally add a note.
// They are drawn with the browser's CSS Highlight API, so the book text itself is never changed.

import { db } from './db.js';
import { $, el, icon, openPanel, closePanel, noteBox, saveFile } from './ui.js';
import { R, rangeOf, locate, goTo, sectionTitle, showControls } from './reader.js';

const COLORS = ['yellow', 'green', 'blue'];
const EMOJI = { yellow: '🟨', green: '🟩', blue: '🟦' };
const menu = $('#sel-menu');
let list = []; // highlights of the open book
let painted = []; // [{ h, range }] in the section on screen
let target = null; // the highlight the menu is about (null = new selection)
let pending = null; // the selected range waiting for a colour

export async function load(bookId) {
  list = (await db.byBook('highlights', bookId)).filter((h) => !h.deleted);
}

export function paint() {
  if (!window.CSS?.highlights) return;
  const sets = {};
  for (const c of [...COLORS, 'note']) sets[c] = new Highlight();
  painted = [];
  for (const h of list) {
    if (h.s !== R.s) continue;
    const range = resolve(h);
    if (!range) continue;
    painted.push({ h, range });
    (sets[h.color] || sets.yellow).add(range);
    if (h.note) sets.note.add(range);
  }
  for (const c in sets) CSS.highlights.set('hl-' + c, sets[c]);
}

const squash = (t) => t.replace(/\s+/g, '');

// Find the highlight's text. If the book was converted again and moved, search for the quote.
function resolve(h) {
  try {
    if (R.blocks[h.b1] && R.blocks[h.b2]) {
      const r = rangeOf(h.b1, h.o1, h.b2, h.o2);
      if (squash(r.toString()) === squash(h.text)) return r;
    }
    for (let b = 0; b < R.blocks.length; b++) {
      const i = R.blocks[b].textContent.indexOf(h.text);
      if (i >= 0) {
        Object.assign(h, { b1: b, o1: i, b2: b, o2: i + h.text.length });
        return rangeOf(b, i, b, i + h.text.length);
      }
    }
  } catch {}
  return null;
}

// ---- Selecting text ----
let selTimer;
let mouseDown = false; // with a mouse, wait until the button is released before showing the menu
document.addEventListener('selectionchange', () => {
  clearTimeout(selTimer);
  selTimer = setTimeout(onSelection, 300);
});
document.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') mouseDown = true; });
document.addEventListener('pointerup', (e) => {
  if (e.pointerType !== 'mouse' || !mouseDown) return;
  mouseDown = false;
  clearTimeout(selTimer);
  selTimer = setTimeout(onSelection, 10);
});

function currentSelection() {
  const sel = document.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  return $('#flow').contains(r.commonAncestorContainer) ? r : null;
}

function onSelection() {
  if (!R.book || mouseDown) return;
  const sel = document.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) {
    if (!target) hideMenu();
    return;
  }
  const r = sel.getRangeAt(0);
  if (!$('#flow').contains(r.commonAncestorContainer)) return;
  target = null;
  pending = r.cloneRange();
  showMenu(r.getBoundingClientRect(), false);
}

function showMenu(rect, existing) {
  menu.querySelector('[data-act="remove"]').hidden = !existing;
  menu.querySelector('[data-act="note"]').lastChild.textContent = existing && target?.note ? 'Edit note' : 'Note';
  menu.hidden = false;
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const below = rect.bottom + 14;
  const top = below + mh < window.innerHeight - 8 ? below : Math.max(8, rect.top - mh - 14);
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - mw / 2), window.innerWidth - mw - 8);
  menu.style.top = top + 'px';
  menu.style.left = left + 'px';
}

export function hideMenu() {
  menu.hidden = true;
  target = null;
  pending = null;
}

export const menuOpen = () => !menu.hidden;

menu.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the text selected
menu.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const { color, act } = btn.dataset;
  const h = target;
  const range = currentSelection()?.cloneRange() || pending;
  hideMenu();
  if (h) {
    if (color) await update(h, { color });
    else if (act === 'note') await editNote(h);
    else if (act === 'remove') await remove(h);
  } else if (range) {
    const created = await create(range, color || 'yellow');
    document.getSelection().removeAllRanges();
    if (created && act === 'note') await editNote(created);
  }
});

// Tapping on a highlight opens its menu. Returns true when a highlight was hit.
export function tapAt(x, y) {
  for (const { h, range } of painted) {
    for (const r of range.getClientRects()) {
      if (x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2) {
        target = h;
        pending = null;
        showMenu(r, true);
        return true;
      }
    }
  }
  return false;
}

// ---- Saving ----
async function create(range, color) {
  let a = locate(range.startContainer, range.startOffset);
  let z = locate(range.endContainer, range.endOffset);
  if (!a || !z) return null;
  if (z.o === 0 && z.b > a.b) z = { b: z.b - 1, o: R.blocks[z.b - 1].textContent.length };
  // Trim spaces at both ends, then grow to whole words.
  const t1 = R.blocks[a.b].textContent;
  while (a.o < t1.length && /\s/.test(t1[a.o]) && (a.b < z.b || a.o < z.o)) a.o++;
  const t2 = R.blocks[z.b].textContent;
  while (z.o > 0 && /\s/.test(t2[z.o - 1]) && (a.b < z.b || z.o > a.o)) z.o--;
  const inWord = (t, i) => /[\p{L}\p{N}'’-]/u.test(t[i] || '');
  while (a.o > 0 && inWord(t1, a.o - 1) && inWord(t1, a.o)) a.o--;
  while (z.o < t2.length && inWord(t2, z.o) && inWord(t2, z.o - 1)) z.o++;
  const parts = [];
  for (let b = a.b; b <= z.b; b++) {
    const t = R.blocks[b].textContent;
    parts.push(t.slice(b === a.b ? a.o : 0, b === z.b ? z.o : t.length));
  }
  const text = parts.join('\n').trim();
  if (!text) return null;
  const now = Date.now();
  const h = {
    id: crypto.randomUUID?.() || now.toString(36) + Math.random().toString(36).slice(2),
    bookId: R.book.id, s: R.s, b1: a.b, o1: a.o, b2: z.b, o2: z.o,
    text, color, note: '', createdAt: now, updatedAt: now,
  };
  list.push(h);
  await db.put('highlights', h);
  paint();
  return h;
}

async function update(h, patch) {
  Object.assign(h, patch, { updatedAt: Date.now() });
  await db.put('highlights', h);
  paint();
}

async function remove(h) {
  list = list.filter((x) => x !== h);
  await update(h, { deleted: true }); // kept as "deleted" so the sync file removes it on other devices too
}

async function editNote(h) {
  const note = await noteBox(h.text, h.note);
  if (note !== undefined) await update(h, { note });
}

const byPlace = (a, b) => a.s - b.s || a.b1 - b.b1 || a.o1 - b.o1;

// ---- The list of highlights ----
export function openList() {
  const items = [...list].sort(byPlace);
  const body = el('div');
  if (!items.length) {
    body.append(el('p.lead', {}, 'No highlights yet.'), el('p.lead', {}, 'Select some text, then pick a colour.'));
  } else {
    body.append(el('div.panel-actions', {}, el('button.btn.primary.wide', { onclick: exportMarkdown }, 'Export as Markdown')));
    let chapter = null;
    for (const h of items) {
      const c = sectionTitle(h.s, h.b1);
      body.append(el('div.hl-item', {},
        c !== chapter ? el('div.chap', {}, c) : null,
        el(`button.quote.${h.color}`, { onclick: () => { closePanel(); showControls(false); goTo({ s: h.s, b: h.b1, o: h.o1 }); } }, h.text),
        h.note ? el('div.note', {}, h.note) : null,
        el('div.acts', {},
          el('button.btn.ghost', { onclick: async () => { await editNote(h); openList(); } }, icon('note'), h.note ? 'Edit note' : 'Add note'),
          el('button.btn.ghost', { onclick: async () => { await remove(h); openList(); } }, icon('trash'), 'Remove'))));
      chapter = c;
    }
  }
  openPanel('Highlights', body);
}

function exportMarkdown() {
  const book = R.book;
  const lines = [`# ${book.title}`, ''];
  if (book.author) lines.push(`*${book.author}*`, '');
  lines.push(`Highlights exported on ${new Date().toLocaleDateString()}`, '');
  let chapter = null;
  for (const h of [...list].sort(byPlace)) {
    const c = sectionTitle(h.s, h.b1);
    if (c && c !== chapter) lines.push(`## ${c}`, '');
    chapter = c;
    h.text.split('\n').forEach((t, i) => lines.push(`> ${i === 0 ? EMOJI[h.color] + ' ' : ''}${t}`));
    lines.push('');
    if (h.note) lines.push(`**Note:** ${h.note}`, '');
  }
  const name = book.title.replace(/[\\/:*?"<>|]+/g, '').slice(0, 80) + ' - highlights.md';
  saveFile(name, lines.join('\n'), 'text/markdown');
}
