// Read-aloud with the browser's built-in voices. Speaks one sentence at a time,
// highlights the sentence and the current word, and turns pages by itself.

import { $, toast } from './ui.js';
import * as settings from './settings.js';
import * as ruler from './ruler.js';
import { R, rangeOf, locate, pageOf, showPageOf, goTo } from './reader.js';

const synth = window.speechSynthesis;
let state = null; // { items: [{ b, start, end, text }], i, playing }
let utter = null; // keep a reference: Chrome drops events of forgotten utterances
let wakeLock = null;

export const active = () => !!state;

export function voices() {
  return synth ? synth.getVoices() : [];
}

export function start() {
  if (!synth) return toast('Read-aloud is not available in this browser.');
  if (state) return state.playing ? pause() : resume();
  const p = ruler.startPoint();
  const from = (p && locate(p.node, p.offset)) || R.anchor;
  state = { items: sentences(from.b, from.o), i: 0, playing: true };
  $('#tts-bar').hidden = false;
  updateBar();
  keepAwake(true);
  speak();
}

export function stop() {
  if (!state) return;
  state = null;
  utter = null;
  synth?.cancel();
  clearMarks();
  $('#tts-bar').hidden = true;
  keepAwake(false);
}

function pause() {
  state.playing = false;
  utter = null;
  synth.cancel();
  updateBar();
}

function resume() {
  state.playing = true;
  updateBar();
  speak();
}

function speak() {
  if (!state?.playing) return;
  const item = state.items[state.i];
  if (!item) return nextSection();
  const s = settings.get();
  const u = new SpeechSynthesisUtterance(item.text);
  const voice = pickVoice(s.voice);
  if (voice) { u.voice = voice; u.lang = voice.lang; } else if (R.book.lang) u.lang = R.book.lang;
  u.rate = s.rate;
  u.onboundary = (e) => { if (utter === u && e.name !== 'sentence') markWord(item, e.charIndex, e.charLength); };
  u.onend = () => {
    if (utter !== u) return;
    state.i++;
    speak();
  };
  u.onerror = (e) => {
    if (utter !== u || e.error === 'interrupted' || e.error === 'canceled') return;
    toast('Read-aloud stopped: ' + e.error);
    stop();
  };
  utter = u;
  markSentence(item);
  synth.speak(u);
}

async function nextSection() {
  if (R.s >= R.content.sections.length - 1) {
    stop();
    return toast('This is the end of the book.');
  }
  await goTo({ s: R.s + 1, b: 0, o: 0 });
  if (!state) return;
  state.items = sentences(0, 0);
  state.i = 0;
  speak();
}

// Split the section into sentences, starting at block b, character o.
function sentences(b0, o0) {
  const out = [];
  const seg = window.Intl?.Segmenter ? new Intl.Segmenter(R.book.lang || undefined, { granularity: 'sentence' }) : null;
  for (let b = b0; b < R.blocks.length; b++) {
    const text = R.blocks[b].textContent;
    const parts = seg ? [...seg.segment(text)].map((x) => [x.index, x.segment]) : [...text.matchAll(/[^.!?]+[.!?]+["”’)]*\s*|[^.!?]+$/g)].map((m) => [m.index, m[0]]);
    for (let [start, str] of parts) {
      let end = start + str.trimEnd().length;
      if (b === b0 && end <= o0) continue;
      if (b === b0 && start < o0) start = o0;
      const t = text.slice(start, end);
      if (/[\p{L}\p{N}]/u.test(t)) out.push({ b, start, end, text: t });
    }
  }
  return out;
}

function markSentence(item) {
  if (!window.CSS?.highlights) return follow(item.b, item.start);
  CSS.highlights.set('tts-sentence', new Highlight(rangeOf(item.b, item.start, item.b, item.end)));
  CSS.highlights.delete('tts-word');
  follow(item.b, item.start);
}

function markWord(item, index, length) {
  const start = item.start + index;
  if (!length) length = (item.text.slice(index).match(/^\S+/) || [''])[0].length;
  const end = Math.min(start + length, item.end);
  if (end <= start) return;
  if (window.CSS?.highlights) CSS.highlights.set('tts-word', new Highlight(rangeOf(item.b, start, item.b, end)));
  follow(item.b, start);
}

// Turn the page when the voice reaches the next one, and keep the ruler on the spoken line.
function follow(b, o) {
  const a = { s: R.s, b, o };
  if (pageOf(a) !== R.page) showPageOf(a);
  const r = rangeOf(b, o, b, Math.min(o + 1, R.blocks[b].textContent.length)).getClientRects()[0];
  ruler.focusRect(r);
}

function clearMarks() {
  CSS.highlights?.delete('tts-sentence');
  CSS.highlights?.delete('tts-word');
}

export function pickVoice(name) {
  const all = voices();
  if (name) {
    const v = all.find((x) => x.voiceURI === name || x.name === name);
    if (v) return v;
  }
  const lang = (R.book?.lang || navigator.language || 'en').slice(0, 2).toLowerCase();
  const same = all.filter((v) => v.lang.toLowerCase().startsWith(lang));
  return same.find((v) => v.default) || same.find((v) => v.localService) || same[0] || null;
}

function updateBar() {
  const playing = state?.playing;
  const btn = $('#tts-play');
  btn.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('#tts-rate').textContent = settings.get().rate.toFixed(1) + '×';
}

function setRate(d) {
  const rate = Math.round(Math.min(2, Math.max(0.5, settings.get().rate + d)) * 10) / 10;
  settings.set({ rate });
  updateBar();
  if (state?.playing) { utter = null; synth.cancel(); speak(); } // restart the sentence at the new speed
}

async function keepAwake(on) {
  try {
    if (on && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    else { await wakeLock?.release(); wakeLock = null; }
  } catch {}
}

$('#tts-play').addEventListener('click', () => start());
$('#tts-stop').addEventListener('click', stop);
$('#tts-slower').addEventListener('click', () => setRate(-0.1));
$('#tts-faster').addEventListener('click', () => setRate(0.1));
