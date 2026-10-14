// App start: apply settings, then show the library or a book depending on the address.
//   #/            library
//   #/read/<id>   reading a book

import * as settings from './settings.js';
import { closePanel } from './ui.js';
import { showLibrary, hideLibrary } from './library.js';
import { R, openBook, closeBook } from './reader.js';

settings.apply();

async function route() {
  const m = location.hash.match(/^#\/read\/(.+)$/);
  closePanel();
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (R.book?.id === id) return;
    closeBook();
    hideLibrary();
    if (!(await openBook(id))) location.hash = '';
  } else {
    closeBook();
    await showLibrary();
  }
}

window.addEventListener('hashchange', route);
route();

// Offline support (installed app). Not used during local development unless "?sw" is in the address.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || new URLSearchParams(location.search).has('sw'))) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Offline mode unavailable:', e));
}
