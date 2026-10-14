// EPUB importer: reads the package file, walks the chapters in reading order,
// and keeps the table of contents and pictures.

import { openZip } from './zip.js';
import { Builder, addHTML } from './html.js';

const XLINK = 'http://www.w3.org/1999/xlink';
const OPS = 'http://www.idpf.org/2007/ops';

export async function parseEpub(buf, { onProgress } = {}) {
  const zip = openZip(buf);
  const container = parseXML(await zip.text('META-INF/container.xml'));
  const opfPath = byTag(container, 'rootfile')[0]?.getAttribute('full-path');
  if (!opfPath || !zip.has(opfPath)) throw new Error('This EPUB is missing its package file.');
  const opf = parseXML(await zip.text(opfPath));

  const meta = (tag) => byTag(opf, tag)[0]?.textContent.replace(/\s+/g, ' ').trim() || '';
  const manifest = new Map();
  for (const item of byTag(opf, 'item')) {
    manifest.set(item.getAttribute('id'), {
      path: resolve(opfPath, item.getAttribute('href')),
      type: item.getAttribute('media-type') || '',
      props: item.getAttribute('properties') || '',
    });
  }
  const items = [...manifest.values()];
  const spineEl = byTag(opf, 'spine')[0];
  const spine = byTag(opf, 'itemref').map((r) => manifest.get(r.getAttribute('idref'))).filter(Boolean);

  // Table of contents: EPUB 3 "nav" document, or the older NCX file.
  const toc = [];
  const nav = items.find((i) => /\bnav\b/.test(i.props));
  const ncx = manifest.get(spineEl?.getAttribute('toc')) || items.find((i) => i.type === 'application/x-dtbncx+xml');
  if (nav) readNav(parseXHTML(await zip.text(nav.path)), nav.path, toc);
  if (!toc.length && ncx) readNcx(parseXML(await zip.text(ncx.path)), ncx.path, toc);

  const b = new Builder();
  const used = new Map(); // resource path -> media type
  for (const t of toc) b.toc(t.title, t.key, t.level);

  for (let i = 0; i < spine.length; i++) {
    onProgress?.(i, spine.length);
    const item = spine[i];
    if (!/html|xml/.test(item.type)) continue;
    const text = await zip.text(item.path);
    if (!text) continue;
    const doc = parseXHTML(text);
    b.section(toc.find((t) => t.key.split('#')[0] === item.path)?.title || '');
    b.anchor(item.path);
    addHTML(doc.body || byTag(doc, 'body')[0] || doc.documentElement, b, {
      key: (id) => item.path + '#' + id,
      image: (node) => {
        const src = node.getAttribute('src') || node.getAttributeNS(XLINK, 'href') || node.getAttribute('href');
        if (!src || src.startsWith('data:')) return null;
        const path = resolve(item.path, src);
        if (!zip.has(path)) return null;
        used.set(path, items.find((m) => m.path === path)?.type || mimeFromName(path));
        return path;
      },
    });
  }

  const resources = {};
  for (const [path, type] of used) resources[path] = new Blob([await zip.bytes(path)], { type });

  // Cover picture
  const coverId = byTag(opf, 'meta').find((m) => m.getAttribute('name') === 'cover')?.getAttribute('content');
  const coverItem = items.find((i) => /\bcover-image\b/.test(i.props)) || manifest.get(coverId) ||
    items.find((i) => i.type.startsWith('image/') && /cover/i.test(i.path));
  let cover = null;
  if (coverItem?.type.startsWith('image/')) {
    const bytes = await zip.bytes(coverItem.path);
    if (bytes) cover = new Blob([bytes], { type: coverItem.type });
  }

  const creators = byTag(opf, 'creator').map((c) => c.textContent.trim()).filter(Boolean);
  return {
    title: meta('title'),
    author: creators.slice(0, 3).join(', '),
    lang: meta('language'),
    cover,
    resources,
    ...b.finish(),
  };
}

function readNav(doc, navPath, out) {
  const navs = byTag(doc, 'nav');
  const nav = navs.find((n) => (n.getAttributeNS(OPS, 'type') || n.getAttribute('epub:type') || '').includes('toc')) || navs[0];
  const list = nav && [...nav.children].find((c) => c.localName === 'ol');
  const walk = (ol, level) => {
    for (const li of [...ol.children].filter((c) => c.localName === 'li')) {
      const a = [...li.children].find((c) => c.localName === 'a' || c.localName === 'span');
      const href = a?.getAttribute('href');
      if (href) out.push({ title: a.textContent, key: resolve(navPath, href, true), level });
      const sub = [...li.children].find((c) => c.localName === 'ol');
      if (sub) walk(sub, level + 1);
    }
  };
  if (list) walk(list, 1);
}

function readNcx(doc, ncxPath, out) {
  const walk = (parent, level) => {
    for (const p of [...parent.children].filter((c) => c.localName === 'navPoint')) {
      const label = byTag(p, 'text')[0]?.textContent || '';
      const src = byTag(p, 'content')[0]?.getAttribute('src');
      if (src) out.push({ title: label, key: resolve(ncxPath, src, true), level });
      walk(p, level + 1);
    }
  };
  const map = byTag(doc, 'navMap')[0];
  if (map) walk(map, 1);
}

// ---- helpers ----
function byTag(node, name) {
  return [...node.getElementsByTagNameNS('*', name)];
}

function parseXML(text) {
  return new DOMParser().parseFromString(text || '<x/>', 'application/xml');
}

function parseXHTML(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
  if (!doc.getElementsByTagName('parsererror').length) return doc;
  return new DOMParser().parseFromString(text, 'text/html'); // forgiving fallback for sloppy files
}

// Resolve an href relative to the file it appears in. Keeps "#fragment" when asked.
function resolve(fromPath, href, keepHash = false) {
  const url = new URL(href, 'https://book/' + fromPath);
  const path = decodeURIComponent(url.pathname.slice(1));
  return keepHash && url.hash ? path + '#' + decodeURIComponent(url.hash.slice(1)) : path;
}

function mimeFromName(path) {
  const ext = path.split('.').pop().toLowerCase();
  return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' }[ext] || 'application/octet-stream';
}
