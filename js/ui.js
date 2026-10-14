// Small shared UI helpers: element builder, panel, dialogs, toast, busy overlay, file saving.

export const $ = (sel) => document.querySelector(sel);

// el('button.btn.primary', { onclick }, 'Label', child, ...)
export function el(spec, props = {}, ...children) {
  const [tag, ...classes] = spec.split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'style') node.style.cssText = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k in node && k !== 'list') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

// ---- Panel (one at a time) ----
let panelClose = null;

export function openPanel(title, body, { modal = true, onClose, cls = '' } = {}) {
  closePanel();
  $('#panel').className = 'panel ' + cls;
  $('#panel-title').textContent = title;
  $('#panel-body').replaceChildren(body);
  $('#panel').hidden = false;
  $('#scrim').hidden = !modal;
  $('#panel-body').scrollTop = 0;
  panelClose = onClose || null;
}

export function closePanel() {
  if ($('#panel').hidden) return false;
  $('#panel').hidden = true;
  $('#scrim').hidden = true;
  const fn = panelClose;
  panelClose = null;
  fn?.();
  return true;
}

export const panelOpen = () => !$('#panel').hidden;

$('#panel-close').addEventListener('click', closePanel);
$('#scrim').addEventListener('click', closePanel);

// ---- Dialogs ----
function dialog(build) {
  const d = $('#dialog');
  return new Promise((resolve) => {
    const done = (value) => { d.close(); resolve(value); };
    d.replaceChildren(...build(done));
    d.onclose = () => resolve(undefined);
    d.oncancel = () => resolve(undefined);
    d.showModal();
  });
}

export function confirmBox(title, text, okLabel = 'OK', danger = false) {
  return dialog((done) => [
    el('h2', {}, title),
    el('p', {}, text),
    el('div.row', {},
      el('button.btn', { onclick: () => done(false) }, 'Cancel'),
      el(danger ? 'button.btn.danger' : 'button.btn.primary', { onclick: () => done(true) }, okLabel)),
  ]);
}

export function alertBox(title, text) {
  return dialog((done) => [el('h2', {}, title), el('p', {}, text), el('div.row', {}, el('button.btn.primary', { onclick: () => done(true) }, 'OK'))]);
}

// Returns the new note text, '' to delete it, or undefined when cancelled.
export function noteBox(quote, note = '') {
  return dialog((done) => {
    const ta = el('textarea', { value: note, placeholder: 'Write a short note…', 'aria-label': 'Note' });
    setTimeout(() => ta.focus(), 50);
    return [
      el('h2', {}, 'Note'),
      el('blockquote', {}, quote),
      ta,
      el('div.row', {},
        note ? el('button.btn.danger', { onclick: () => done('') }, 'Delete note') : null,
        el('button.btn', { onclick: () => done(undefined) }, 'Cancel'),
        el('button.btn.primary', { onclick: () => done(ta.value.trim()) }, 'Save')),
    ];
  });
}

// ---- Toast & busy ----
let toastTimer;
export function toast(text, ms = 3000) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

export function busy(text, value, max) {
  $('#busy').hidden = text == null;
  if (text == null) return;
  $('#busy-text').textContent = text;
  const bar = $('#busy-bar');
  if (value == null) bar.removeAttribute('value');
  else { bar.max = max; bar.value = value; }
}

// ---- Saving a file: share sheet on phones/tablets, normal download on computers ----
export async function saveFile(name, text, type) {
  const file = new File([text], name, { type });
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const a = el('a', { href: URL.createObjectURL(file), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export function timeAgo(t) {
  if (!t) return '';
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
