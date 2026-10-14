// Reading settings. Saved per device (a phone and a Mac usually want different sizes).

const KEY = 'dyslexreader.settings';

export const FONTS = {
  atkinson: { label: 'Atkinson Hyperlegible', css: '"Atkinson Hyperlegible", system-ui, sans-serif' },
  lexend: { label: 'Lexend', css: '"Lexend", system-ui, sans-serif' },
  opendyslexic: { label: 'OpenDyslexic', css: '"OpenDyslexic", system-ui, sans-serif' },
  verdana: { label: 'Verdana', css: 'Verdana, Geneva, sans-serif' },
  system: { label: 'System font', css: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
};

export const THEMES = { cream: 'Cream', white: 'White', peach: 'Peach', blue: 'Blue', green: 'Green', dark: 'Dark' };

export const DEFAULTS = {
  font: 'atkinson',
  size: 21,            // px
  letterSpacing: 2,    // hundredths of an em (2 = 0.02em)
  wordSpacingOn: false,
  wordSpacing: 15,     // hundredths of an em
  lineHeight: 1.6,
  lineWidth: 60,       // about this many letters per line
  theme: 'cream',
  paragraphGaps: true, // gap between paragraphs (off = indented first lines)
  italicsNormal: false,
  rulerLines: 2,
  voice: '',
  rate: 1,
};

let current = load();
const listeners = new Set();

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function get() {
  return current;
}

export function set(patch) {
  current = { ...current, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch {}
  apply();
  listeners.forEach((fn) => fn(current, patch));
}

export function reset() {
  set({ ...DEFAULTS, voice: current.voice });
}

export function onChange(fn) {
  listeners.add(fn);
}

// Push settings into CSS variables. The book text styles in app.css read them.
export function apply() {
  const s = current;
  const root = document.documentElement;
  root.dataset.theme = s.theme;
  const v = (name, value) => root.style.setProperty(name, value);
  v('--book-font', (FONTS[s.font] || FONTS.atkinson).css);
  v('--book-size', s.size + 'px');
  v('--book-lh', s.lineHeight);
  v('--book-ls', s.letterSpacing / 100 + 'em');
  v('--book-ws', s.wordSpacingOn ? s.wordSpacing / 100 + 'em' : 'normal');
  v('--book-pgap', s.paragraphGaps ? '0.9em' : '0');
  v('--book-indent', s.paragraphGaps ? '0' : '1.6em');
  document.getElementById('flow')?.classList.toggle('no-italic', s.italicsNormal);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(root).getPropertyValue('--bg').trim() || '#f6efdc';
}

// The CSS font strings the browser must have loaded before we measure pages.
export function fontFaces() {
  const fam = (FONTS[current.font] || FONTS.atkinson).css.split(',')[0];
  const size = current.size + 'px ';
  return [size + fam, 'italic ' + size + fam, 'bold ' + size + fam];
}
