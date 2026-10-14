// Turns book HTML (from EPUB, MOBI, …) into the app's own simple format.
//
// A book is a list of sections (usually chapters). Each section is a flat list of blocks:
//   <p>, <h2>, <h3>, <p class="li">, <pre>, <hr>, <figure><img></figure>
// Inside blocks only <em>, <strong>, <sup>, <sub>, <br> and <img> are kept.
// All publisher styling is dropped, so the reader's own settings always win
// (never justified, your font, your spacing).
//
// Positions in the book are stored as { s: section, b: block, o: character offset in the block },
// so they stay correct when the font size or screen size changes.

const SECTION_LIMIT = 50000; // characters; very long chapters are split so pages lay out quickly

export class Builder {
  constructor() {
    this.doc = document.implementation.createHTMLDocument('');
    this.sections = [{ title: '', blocks: [], chars: 0 }];
    this.anchors = {}; // key -> [section, block]
    this.tocEntries = []; // { title, key, level }
  }

  get cur() {
    return this.sections[this.sections.length - 1];
  }

  el(tag, cls) {
    const node = this.doc.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  // Start a new section (does nothing if the current one is still empty).
  section(title = '') {
    if (!this.cur.blocks.length) {
      this.cur.title ||= title;
      return;
    }
    this.moveDanglingAnchors();
    this.sections.push({ title, blocks: [], chars: 0 });
  }

  // Anchors that point just past the end of the current section belong to the next one.
  moveDanglingAnchors() {
    const s = this.sections.length - 1;
    const end = this.cur.blocks.length;
    for (const k in this.anchors) {
      const [as, ab] = this.anchors[k];
      if (as === s && ab === end) this.anchors[k] = [s + 1, 0];
    }
  }

  anchor(key) {
    if (key && !(key in this.anchors)) this.anchors[key] = [this.sections.length - 1, this.cur.blocks.length];
  }

  toc(title, key, level = 1) {
    title = (title || '').replace(/\s+/g, ' ').trim();
    if (title) this.tocEntries.push({ title, key, level });
  }

  add(node) {
    const c = this.cur;
    const heading = node.localName === 'h2' || node.localName === 'h3';
    if (c.blocks.length && (c.chars > SECTION_LIMIT || (heading && c.chars > SECTION_LIMIT / 2))) {
      this.section(heading ? node.textContent.trim() : c.title);
    }
    this.cur.blocks.push(node);
    this.cur.chars += node.textContent.length;
  }

  finish() {
    if (this.sections.length > 1 && !this.cur.blocks.length) this.sections.pop();
    const last = this.sections.length - 1;
    for (const k in this.anchors) {
      const a = this.anchors[k];
      if (a[0] > last) this.anchors[k] = [last, Math.max(0, this.sections[last].blocks.length - 1)];
      else if (a[1] >= this.sections[a[0]].blocks.length) a[1] = Math.max(0, this.sections[a[0]].blocks.length - 1);
    }
    const toc = [];
    for (const t of this.tocEntries) {
      const a = this.anchors[t.key];
      if (a) toc.push({ title: t.title, level: t.level, s: a[0], b: a[1] });
    }
    // No usable table of contents: list the sections that have titles.
    if (!toc.length) {
      this.sections.forEach((sec, s) => {
        if (sec.title && sec.title !== this.sections[s - 1]?.title) toc.push({ title: sec.title, level: 1, s, b: 0 });
      });
    }
    return {
      sections: this.sections.map((s) => ({ title: s.title, chars: s.chars, html: s.blocks.map((b) => b.outerHTML).join('') })),
      anchors: this.anchors,
      toc,
    };
  }
}

const BLOCK = new Set(('address article aside blockquote body center dd details dialog dir div dl dt fieldset figcaption figure ' +
  'footer form h1 h2 h3 h4 h5 h6 header hgroup hr html li main menu nav ol p pre section summary table tbody thead tfoot tr td th ul').split(' '));
const SKIP = new Set(('head title script style link meta noscript template iframe object embed audio video canvas ' +
  'button input select textarea map area math').split(' '));
const EM = new Set(['em', 'i', 'cite', 'dfn', 'var']);
const STRONG = new Set(['strong', 'b']);

// Add the body of an HTML/XHTML document (or any element) to the builder.
//   opts.key(id)      -> anchor key for an element id (EPUB prefixes the file name)
//   opts.image(el)    -> resource key for an <img>/<image>, or null
//   opts.heading(el)  -> 'h2' | 'h3' | null, extra heading detection (MOBI uses font sizes)
export function addHTML(root, builder, opts) {
  walk(root, 'p', builder, opts);
}

function nameOf(node) {
  return node.localName.toLowerCase();
}

function isHidden(node) {
  if (node.hasAttribute('hidden')) return true;
  const style = node.getAttribute('style');
  return !!style && /display\s*:\s*none/i.test(style);
}

function registerIds(node, b, o) {
  const id = node.getAttribute('id') || (nameOf(node) === 'a' && node.getAttribute('name'));
  if (id) b.anchor(o.key(id));
}

function hasBlockInside(node) {
  for (const d of node.getElementsByTagName('*')) if (BLOCK.has(nameOf(d))) return true;
  return false;
}

function blockTag(node, parentTag, o) {
  const name = nameOf(node);
  const custom = o.heading?.(node);
  if (custom) return custom;
  if (name === 'h1' || name === 'h2') return 'h2';
  if (/^h[3-6]$/.test(name)) return 'h3';
  if (name === 'li') return 'li';
  if (name === 'pre') return 'pre';
  return parentTag === 'p' ? 'p' : parentTag;
}

function walk(node, tag, b, o) {
  let run = [];
  const flush = () => {
    if (run.length) emit(run, tag, b, o);
    run = [];
  };
  for (const ch of node.childNodes) {
    if (ch.nodeType === 3) {
      run.push(ch);
      continue;
    }
    if (ch.nodeType !== 1) continue;
    const name = nameOf(ch);
    if (name === 'hr' && ch.classList.contains('page-break')) {
      flush();
      b.section('');
      continue;
    }
    if (SKIP.has(name) || isHidden(ch)) {
      registerIds(ch, b, o);
      continue;
    }
    if (!BLOCK.has(name) && !hasBlockInside(ch)) {
      run.push(ch);
      continue;
    }
    flush();
    registerIds(ch, b, o);
    if (name === 'hr') {
      b.add(b.el('hr'));
      continue;
    }
    walk(ch, BLOCK.has(name) ? blockTag(ch, tag, o) : tag, b, o);
  }
  flush();
}

function emit(nodes, tag, b, o) {
  const out = tag === 'li' ? b.el('p', 'li') : b.el(tag);
  inline(nodes, out, b, o);
  const hasText = /\S/.test(out.textContent);
  // Pictures become their own blocks, so they can be shown large. Tiny inline ones stay in the text.
  for (const img of [...out.querySelectorAll('img')]) {
    const w = +img.getAttribute('width') || 0;
    const h = +img.getAttribute('height') || 0;
    if (hasText && w && h && w <= 64 && h <= 64) continue;
    img.removeAttribute('width');
    img.removeAttribute('height');
    const fig = b.el('figure');
    fig.append(img);
    b.add(fig);
  }
  if (!hasText) return;
  normalizeSpace(out, tag === 'pre');
  const text = out.textContent;
  if ((tag === 'h2' || tag === 'h3') && text.length > 300) {
    const p = b.el('p');
    p.append(...out.childNodes);
    b.add(p);
    return;
  }
  b.add(out);
}

function inline(nodes, parent, b, o) {
  for (const n of nodes) {
    if (n.nodeType === 3) {
      parent.append(n.data.replace(/­/g, ''));
      continue;
    }
    if (n.nodeType !== 1) continue;
    const name = nameOf(n);
    registerIds(n, b, o);
    if (SKIP.has(name) || isHidden(n)) continue;
    if (name === 'br') {
      parent.append(b.el('br'));
    } else if (name === 'img' || name === 'image') {
      addImage(n, parent, b, o);
    } else if (name === 'svg') {
      const img = n.getElementsByTagName('image')[0];
      if (img) addImage(img, parent, b, o);
    } else if (name === 'sup' || name === 'sub') {
      const w = b.el(name);
      inline(n.childNodes, w, b, o);
      parent.append(w);
    } else if (EM.has(name) || looks(n, /italic|ital\b|emph/)) {
      const w = b.el('em');
      inline(n.childNodes, w, b, o);
      parent.append(w);
    } else if (STRONG.has(name) || looks(n, /bold|strong/)) {
      const w = b.el('strong');
      inline(n.childNodes, w, b, o);
      parent.append(w);
    } else {
      inline(n.childNodes, parent, b, o); // unwrap everything else (span, a, font, …)
    }
  }
}

// Spans styled as italic/bold through a class or inline style.
function looks(node, re) {
  return re.test((node.getAttribute('class') || '') + ' ' + (node.getAttribute('style') || '').replace(/font-style\s*:\s*/i, ''));
}

function addImage(node, parent, b, o) {
  const key = o.image?.(node);
  if (!key) return;
  const img = b.el('img');
  img.dataset.res = key;
  img.alt = node.getAttribute('alt') || '';
  for (const a of ['width', 'height']) if (node.getAttribute(a)) img.setAttribute(a, node.getAttribute(a));
  parent.append(img);
}

// Collapse whitespace the way the browser would show it, so the stored text equals what you see.
function normalizeSpace(el, pre) {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  if (pre) {
    const first = walker.nextNode();
    if (first?.nodeType === 3) first.data = first.data.replace(/^\r?\n/, '');
    return;
  }
  let prevSpace = true;
  let last = null;
  const trimLast = () => {
    if (last) last.data = last.data.replace(/ $/, '');
  };
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 1) {
      if (n.localName === 'br') {
        // A space after a line break: invisible on screen, but keeps words apart for read-aloud and search.
        trimLast();
        n.after(n.ownerDocument.createTextNode(' '));
        prevSpace = false;
      } else if (n.localName === 'img') {
        prevSpace = false;
      }
      continue;
    }
    let t = n.data.replace(/[ \t\n\r\f]+/g, ' ');
    if (prevSpace && t.startsWith(' ')) t = t.slice(1);
    n.data = t;
    if (t) {
      prevSpace = t.endsWith(' ');
      last = n;
    }
  }
  trimLast();
}

// Text helpers shared by the TXT and PDF importers.
export function textBlock(b, tag, text, attrs) {
  const node = tag === 'li' ? b.el('p', 'li') : b.el(tag);
  node.textContent = text;
  if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
}
