// Plain text importer: rebuilds paragraphs from hard-wrapped lines and finds chapter headings.

import { Builder, textBlock } from './html.js';

export function parseTxt(buf, { name = '' } = {}) {
  let text = decode(buf).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  let title = name.replace(/\.[^.]+$/, '');
  let author = '';

  // Project Gutenberg files: read title/author and drop the licence header and footer.
  const start = text.match(/^\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG.*$/im);
  if (start) {
    const header = text.slice(0, start.index);
    title = header.match(/^Title:\s*(.+)$/m)?.[1].trim() || title;
    author = header.match(/^Author:\s*(.+)$/m)?.[1].trim() || '';
    text = text.slice(start.index + start[0].length);
  }
  const end = text.match(/^\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG/im);
  if (end) text = text.slice(0, end.index);

  // Most files separate paragraphs with blank lines; some put one paragraph per line.
  const lines = text.split('\n');
  const blankLines = lines.filter((l) => !l.trim()).length;
  const paragraphs = blankLines > lines.length * 0.04 ? text.split(/\n[ \t]*\n/) : lines;

  const b = new Builder();
  b.section(title);
  paragraphs.forEach((raw, i) => {
    let p = raw.replace(/\s*\n\s*/g, ' ').replace(/[ \t]+/g, ' ').trim();
    if (!p || /^\[Illustration[^\]]*\]?$/i.test(p)) return; // placeholders for pictures that are not in the file
    const kind = headingKind(p);
    if (kind === 'chapter') {
      p = p.replace(/^\[|\]$/g, '').trim();
      b.section(p);
      b.anchor('h' + i);
      b.toc(p, 'h' + i);
      b.add(textBlock(b, 'h2', p));
    } else {
      b.add(textBlock(b, kind === 'caps' ? 'h3' : 'p', p));
    }
  });
  return { title, author, lang: '', cover: null, resources: {}, ...b.finish() };
}

// 'chapter' starts a new chapter; 'caps' is a short ALL-CAPS line shown as a small heading.
function headingKind(p) {
  if (p.length > 70) return null;
  if (/^(chapter|book|part|volume|prologue|epilogue|preface|introduction|foreword|afterword)\b/i.test(p.replace(/\]$/, ''))) return 'chapter';
  if (/^\[|\]$/.test(p)) return null; // other [bracketed] notes
  if (/^[A-Z0-9 .,:;'’\-–—]+$/.test(p) && /[A-Z]{3}/.test(p) && p.length < 50) return 'caps';
  return null;
}

function decode(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}
