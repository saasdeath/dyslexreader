// The shelf: your books with cover, progress and when you last read them.

import { db } from './db.js';
import { $, el, icon, openPanel, closePanel, confirmBox, alertBox, toast, busy, timeAgo } from './ui.js';
import { importFile, UserError } from './import/index.js';
import { exportSync, importSync } from './sync.js';

const shelf = $('#shelf');
const input = $('#file-input');
let coverUrls = [];

export async function showLibrary() {
  $('#library').hidden = false;
  await render();
}

export function hideLibrary() {
  $('#library').hidden = true;
}

async function render() {
  const [books, positions] = await Promise.all([db.all('books'), db.all('positions')]);
  const pos = new Map(positions.map((p) => [p.bookId, p]));
  const last = (b) => pos.get(b.id)?.lastOpenedAt || b.addedAt;
  books.sort((a, b) => last(b) - last(a));
  coverUrls.forEach(URL.revokeObjectURL);
  coverUrls = [];

  if (!books.length) {
    shelf.replaceChildren(el('div.empty', { style: 'grid-column:1/-1' },
      el('p', {}, 'Your library is empty.'),
      el('p.muted', {}, 'You can add EPUB, MOBI, PDF and TXT files.'),
      el('button.btn.primary', { onclick: () => input.click() }, icon('plus'), 'Add your first book')));
  } else {
    shelf.replaceChildren(...books.map((b) => card(b, pos.get(b.id))));
  }

  // Books you read on another device (from a sync file) that are not on this one yet.
  const here = new Set(books.map((b) => b.id));
  const missing = positions.filter((p) => !here.has(p.bookId) && p.title);
  const box = $('#missing');
  box.hidden = !missing.length;
  box.replaceChildren(
    el('h2', {}, 'From your other devices'),
    el('p.muted', {}, 'Add the same book file here to continue where you stopped.'),
    el('ul', {}, missing.map((p) => el('li', {},
      `${p.title}${p.author ? ' — ' + p.author : ''} (${Math.round((p.progress || 0) * 100)}%) `,
      el('button.btn.ghost', { onclick: async () => { await db.del('positions', p.bookId); render(); } }, 'Forget')))));
}

function card(book, p) {
  let cover;
  if (book.cover) {
    const url = URL.createObjectURL(book.cover);
    coverUrls.push(url);
    cover = el('img', { src: url, alt: '' });
  } else {
    const hue = [...book.title].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
    cover = el('div.gen-cover', { style: `background:hsl(${hue} 32% 36%)` }, el('b', {}, book.title), el('span', {}, book.author || ''));
  }
  const pct = Math.round((p?.progress || 0) * 100);
  return el('div.card', {},
    el('button.card-open', { onclick: () => { location.hash = '#/read/' + book.id; } },
      el('div.cover', {}, cover),
      el('div.t', {}, book.title),
      book.author ? el('div.a', {}, book.author) : null,
      el('div.bar-progress', { 'aria-hidden': 'true' }, el('i', { style: `width:${pct}%` })),
      el('div.m', {}, `${book.format.toUpperCase()} · ` + (p ? `${pct}% · opened ${timeAgo(p.lastOpenedAt)}` : 'Not started'))),
    el('button.card-more', { 'aria-label': 'Options for ' + book.title, onclick: () => bookOptions(book) }, icon('more')));
}

async function bookOptions(book) {
  const ok = await confirmBox(`Remove “${book.title}”?`,
    'The book, your place and your highlights will be removed from this device. Other devices are not changed.', 'Remove book', true);
  if (!ok) return;
  for (const h of await db.byBook('highlights', book.id)) await db.del('highlights', h.id);
  await Promise.all(['books', 'content', 'files'].map((s) => db.del(s, book.id)));
  await db.del('positions', book.id);
  toast('Book removed.');
  render();
}

// ---- Adding books ----

async function addFiles(files) {
  let lastId = null;
  for (const file of files) {
    busy(`Adding “${file.name}”…`);
    try {
      const r = await importFile(file, (i, n) => busy(`Adding “${file.name}”…`, i, n));
      if (r.existed) toast(`“${r.title}” is already in your library.`);
      lastId = r.id;
    } catch (e) {
      console.error(e);
      busy(null);
      await alertBox('This book could not be added', e instanceof UserError ? e.message : `“${file.name}” could not be read. (${e.message || e})`);
    }
  }
  busy(null);
  await render();
  return lastId;
}

const touch = matchMedia('(pointer: coarse)').matches;
if (!touch) input.accept = '.epub,.mobi,.prc,.azw,.pdf,.txt'; // phones grey out unknown types, so allow all there

$('#add-btn').addEventListener('click', () => input.click());
input.addEventListener('change', () => {
  const files = [...input.files];
  input.value = '';
  if (files.length) addFiles(files);
});

// Drag and drop files onto the window (computer).
let dragDepth = 0;
document.addEventListener('dragenter', (e) => { if (!$('#library').hidden && e.dataTransfer?.types.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
document.addEventListener('dragover', (e) => { if (!$('#library').hidden) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  if ($('#library').hidden) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) addFiles(files);
});

// ---- Sync between devices ----

$('#sync-btn').addEventListener('click', () => {
  const picker = el('input', { type: 'file', accept: touch ? null : '.json,application/json', hidden: true });
  picker.addEventListener('change', async () => {
    const file = picker.files[0];
    if (!file) return;
    try {
      const r = await importSync(file);
      closePanel();
      toast(`Updated ${r.positions} reading place${r.positions === 1 ? '' : 's'} and ${r.highlights} highlight${r.highlights === 1 ? '' : 's'}.`, 4000);
      render();
    } catch (e) {
      alertBox('This sync file could not be loaded', e instanceof UserError ? e.message : String(e.message || e));
    }
  });
  openPanel('Sync between devices', el('div', {},
    el('p.lead', {}, 'Move your reading place and highlights between your phone, tablet and computer.'),
    el('p.lead', {}, '1. On the device you used last, tap “Save sync file”. Save it to iCloud Drive, or AirDrop it.'),
    el('p.lead', {}, '2. On the other device, tap “Load sync file” and pick that file.'),
    el('p.lead.muted', {}, 'Books themselves are not included. Add the same book file on each device.'),
    el('div.panel-actions', {},
      el('button.btn.primary.wide', { onclick: exportSync }, 'Save sync file'),
      el('button.btn.wide', { onclick: () => picker.click() }, 'Load sync file')),
    picker));
});
