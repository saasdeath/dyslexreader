// Offline support: keeps a copy of the app on the device so it opens without internet.
// Your books and highlights are NOT here; they live in the browser's database.
//
// IMPORTANT: change VERSION whenever you change any app file (or add one to FILES),
// otherwise installed devices keep using the old copy.
const VERSION = 'reader-v1';

const FILES = [
  './',
  'css/app.css',
  'fonts/atkinson-400-italic.woff2',
  'fonts/atkinson-400-normal.woff2',
  'fonts/atkinson-700-italic.woff2',
  'fonts/atkinson-700-normal.woff2',
  'fonts/lexend-400-normal.woff2',
  'fonts/lexend-700-normal.woff2',
  'fonts/opendyslexic-400-italic.woff2',
  'fonts/opendyslexic-400-normal.woff2',
  'fonts/opendyslexic-700-italic.woff2',
  'fonts/opendyslexic-700-normal.woff2',
  'icons/icon.svg',
  'index.html',
  'js/db.js',
  'js/highlights.js',
  'js/import/epub.js',
  'js/import/html.js',
  'js/import/index.js',
  'js/import/mobi.js',
  'js/import/pdf.js',
  'js/import/txt.js',
  'js/import/zip.js',
  'js/library.js',
  'js/main.js',
  'js/reader.js',
  'js/ruler.js',
  'js/settings-panel.js',
  'js/settings.js',
  'js/sync.js',
  'js/tts.js',
  'js/ui.js',
  'manifest.webmanifest',
  'vendor/pdfjs/pdf.min.mjs',
  'vendor/pdfjs/pdf.worker.min.mjs',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll([...new Set(FILES)])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Serve from the saved copy first; fall back to the network.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
