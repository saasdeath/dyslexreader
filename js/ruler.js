// Reading ruler: keeps 1–3 lines clear and dims the rest of the page.
// Move it with the ↑ ↓ keys, the mouse, or by dragging up/down with a finger.

import { $ } from './ui.js';
import * as settings from './settings.js';
import { R, next, prev } from './reader.js';

const band = $('#ruler');
let on = false;
let lines = []; // { top, bottom } of each line on the page, in screen pixels
let idx = 0; // first line inside the band
let startAtEnd = false;

export const isOn = () => on;

export function setOn(value) {
  on = value;
  $('#ruler-btn').setAttribute('aria-pressed', on);
  idx = 0;
  refresh();
}

const count = () => settings.get().rulerLines;

// Called after every page change (keep = true when only the band size changed).
export function refresh(keep = false) {
  if (!on || !R.book || $('#viewport').hidden) {
    band.hidden = true;
    return;
  }
  lines = measureLines();
  if (startAtEnd) idx = Math.max(0, lines.length - count());
  else if (!keep) idx = 0;
  startAtEnd = false;
  idx = Math.min(idx, Math.max(0, lines.length - 1));
  draw();
}

// Lines are grouped by their middle, because some fonts (OpenDyslexic) have letter boxes
// taller than the line spacing, so the boxes of neighbouring lines overlap.
function measureLines() {
  const s = settings.get();
  const lh = s.size * s.lineHeight;
  const vp = $('#viewport').getBoundingClientRect();
  const out = [];
  for (const blk of R.blocks) {
    let rects;
    if (blk.localName === 'figure' || blk.localName === 'hr') rects = [blk.getBoundingClientRect()];
    else {
      const r = document.createRange();
      r.selectNodeContents(blk);
      rects = r.getClientRects();
    }
    for (const rc of rects) {
      if (!rc.width || rc.right < vp.left + 2 || rc.left > vp.right - 2) continue; // not on this page
      const mid = (rc.top + rc.bottom) / 2;
      const half = rc.height > lh * 1.6 ? rc.height / 2 : lh / 2; // pictures keep their own height
      const line = out.find((l) => Math.abs(l.mid - mid) < lh * 0.4);
      if (line) {
        line.top = Math.min(line.top, mid - half);
        line.bottom = Math.max(line.bottom, mid + half);
      } else {
        out.push({ mid, top: mid - half, bottom: mid + half });
      }
    }
  }
  return out.sort((a, b) => a.top - b.top);
}

function draw() {
  if (!lines.length) {
    band.hidden = true;
    return;
  }
  const first = lines[idx];
  const last = lines[Math.min(idx + count() - 1, lines.length - 1)];
  const vp = $('#viewport').getBoundingClientRect();
  Object.assign(band.style, {
    left: vp.left - 8 + 'px',
    width: vp.width + 16 + 'px',
    top: first.top - 2 + 'px',
    height: last.bottom - first.top + 4 + 'px',
  });
  band.hidden = false;
}

// One line down (+1) or up (-1); turns the page at the edges.
export function move(d) {
  if (!lines.length) return d > 0 ? next() : prev();
  if (d > 0 && idx + count() >= lines.length) return next();
  if (d < 0 && idx === 0) {
    if (R.page === 0 && R.s === 0) return;
    startAtEnd = true;
    return prev();
  }
  idx += d;
  draw();
}

export function followY(y) {
  if (!on || !lines.length) return;
  let i = lines.findIndex((l) => y < l.bottom);
  if (i < 0) i = lines.length - 1;
  idx = Math.max(0, Math.min(i, lines.length - count()));
  draw();
}

// Read-aloud: keep the spoken words inside the band.
export function focusRect(rect) {
  if (!on || !rect) return;
  const mid = (rect.top + rect.bottom) / 2;
  const i = lines.findIndex((l) => mid >= l.top - 2 && mid <= l.bottom + 2);
  if (i >= 0 && (i < idx || i >= idx + count())) {
    idx = Math.min(i, Math.max(0, lines.length - count()));
    draw();
  }
}

// Where read-aloud should start when the ruler is on: the first line in the band.
export function startPoint() {
  if (!on || !lines.length) return null;
  const vp = $('#viewport').getBoundingClientRect();
  const y = (lines[idx].top + lines[idx].bottom) / 2;
  const x = vp.left + 16;
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    return p && { node: p.offsetNode, offset: p.offset };
  }
  const r = document.caretRangeFromPoint?.(x, y);
  return r && { node: r.startContainer, offset: r.startOffset };
}
