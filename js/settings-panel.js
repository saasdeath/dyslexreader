// The "Text" settings panel. Every change shows on the page straight away and is remembered.

import { el, icon, openPanel } from './ui.js';
import * as settings from './settings.js';
import { voices, pickVoice } from './tts.js';

export function openSettings() {
  openPanel('Text settings', build(), { modal: false, cls: 'short' });
}

function build() {
  const s = settings.get();
  const set = (patch) => settings.set(patch);
  const rebuild = () => document.getElementById('panel-body').replaceChildren(build());

  return el('div', {},
    group('Font',
      el('div.font-list', {}, Object.entries(settings.FONTS).map(([id, f]) =>
        el('button.font-opt', { style: `font-family:${f.css}`, 'aria-pressed': s.font === id, onclick: () => { set({ font: id }); rebuild(); } }, f.label)))),

    group('Size and spacing',
      stepper('Text size', 'size', { min: 14, max: 44, step: 1, fmt: (v) => v }),
      stepper('Letter spacing', 'letterSpacing', { min: 0, max: 25, step: 1, fmt: (v) => (v ? '+' + v : 'Normal') }),
      stepper('Line spacing', 'lineHeight', { min: 1.2, max: 2.8, step: 0.1, fmt: (v) => v.toFixed(1) }),
      stepper('Line width', 'lineWidth', { min: 30, max: 100, step: 5, fmt: (v) => v, hint: 'Letters per line, about' }),
      toggle('Word spacing', 'wordSpacingOn', 'Extra space between words', rebuild),
      s.wordSpacingOn ? stepper('Word space', 'wordSpacing', { min: 5, max: 80, step: 5, fmt: (v) => '+' + v }) : null),

    group('Paragraphs',
      toggle('Space between paragraphs', 'paragraphGaps', 'Off: first lines are indented instead'),
      toggle('Show italics as normal text', 'italicsNormal', 'Slanted letters can be harder to read')),

    group('Background',
      el('div.theme-list', {}, Object.entries(settings.THEMES).map(([id, label]) =>
        el('button.theme-opt', { 'data-theme': id, 'aria-pressed': s.theme === id, onclick: () => { set({ theme: id }); rebuild(); } }, label)))),

    group('Reading ruler',
      el('div.set-row', {}, el('span.lbl', {}, 'Lines in focus'),
        el('div.seg', {}, [1, 2, 3].map((n) =>
          el('button', { 'aria-pressed': s.rulerLines === n, onclick: () => { set({ rulerLines: n }); rebuild(); } }, n))))),

    group('Read aloud', voicePicker(s, rebuild),
      stepper('Speed', 'rate', { min: 0.5, max: 2, step: 0.1, fmt: (v) => v.toFixed(1) + '×' })),

    el('div.panel-actions', {}, el('button.btn.wide', { onclick: () => { settings.reset(); rebuild(); } }, 'Reset to defaults')),
  );
}

function group(title, ...children) {
  return el('section.set-group', {}, el('h3', {}, title), ...children);
}

function stepper(label, key, { min, max, step, fmt, hint }) {
  const out = el('output', {}, fmt(settings.get()[key]));
  const change = (dir) => {
    const v = Math.round(Math.min(max, Math.max(min, settings.get()[key] + dir * step)) * 100) / 100;
    settings.set({ [key]: v });
    out.textContent = fmt(v);
  };
  return el('div.set-row', {},
    el('span.lbl', {}, label, hint ? el('span.hint', {}, hint) : null),
    el('div.stepper', {},
      el('button.btn.round', { 'aria-label': 'Less ' + label.toLowerCase(), onclick: () => change(-1) }, icon('minus')),
      out,
      el('button.btn.round', { 'aria-label': 'More ' + label.toLowerCase(), onclick: () => change(1) }, icon('plus'))));
}

function toggle(label, key, hint, after) {
  const btn = el('button.switch', {
    role: 'switch', 'aria-checked': !!settings.get()[key], 'aria-label': label,
    onclick: () => {
      settings.set({ [key]: !settings.get()[key] });
      btn.setAttribute('aria-checked', !!settings.get()[key]);
      after?.();
    },
  });
  return el('div.set-row', {}, el('span.lbl', {}, label, hint ? el('span.hint', {}, hint) : null), btn);
}

function voicePicker(s, rebuild) {
  const list = voices();
  if (!list.length) {
    // Some browsers load their voices a moment later.
    speechSynthesis?.addEventListener('voiceschanged', rebuild, { once: true });
    return el('p.muted', {}, 'Loading voices…');
  }
  const chosen = pickVoice(s.voice);
  const lang = (navigator.language || 'en').slice(0, 2);
  const sorted = [...list].sort((a, b) =>
    (b.lang.startsWith(lang) - a.lang.startsWith(lang)) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
  const select = el('select', { 'aria-label': 'Voice', onchange: () => settings.set({ voice: select.value }) },
    sorted.map((v) => el('option', { value: v.voiceURI, selected: v === chosen }, `${v.name} (${v.lang})`)));
  return el('div.set-row', {}, el('span.lbl', {}, 'Voice'), select);
}
