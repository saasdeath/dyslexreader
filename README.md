# Reader

A calm, dyslexia-friendly reading app for EPUB, MOBI, PDF and TXT books.
It runs in the browser on iPhone, iPad and Mac, and works offline.

Your books, reading places and highlights are stored **only on your device**
(in the browser's database). Nothing is uploaded.

## Install it

**iPhone / iPad (Safari):** open the app's address, tap **Share**, then **Add to Home Screen**.

**Mac (Chrome):** open the app's address, then click the **Install** icon at the right end of the address bar.

After the first visit, the app opens without internet.

## Using it

- **Add book:** pick an EPUB, MOBI, PDF or TXT file. On a Mac you can also drag files onto the window.
- **Turn pages:** arrow keys, Space, a click or tap on the left or right side, or a swipe.
- **Menu:** tap or click the middle of the page.
- **Text:** font, size, letter / word / line spacing, line width, paragraphs, italics, background colour.
- **Highlights:** select text, pick a colour, and add a note if you like. The **Highlights** list jumps back to
  each one and exports them as Markdown.
- **Ruler:** dims everything except 1–3 lines. Move it with ↑ ↓, the mouse, or by dragging up and down.
- **Listen:** reads aloud with the device's voices, highlights the words, and turns pages by itself.
- **Original** (PDF only): shows the real printed page, for photos and tables.

### Sync between devices

There is no server, so syncing is done by hand with a small file:

1. On the device you used last: **Sync → Save sync file** (save to iCloud Drive, or AirDrop it).
2. On the other device: **Sync → Load sync file**.

The newest reading place and highlights win. Books themselves are not in the file:
add the same book file on each device (the app recognises it by its content).

## For maintenance

Plain HTML, CSS and JavaScript. No build step, no npm.

| Path | What it does |
| --- | --- |
| `index.html`, `css/app.css` | Page structure, themes and all styling |
| `js/main.js` | Start-up: library or book, depending on the address |
| `js/library.js` | The shelf, adding/removing books, sync panel |
| `js/reader.js` | Pages (CSS columns), navigation, saving your place, PDF original pages |
| `js/settings.js`, `js/settings-panel.js` | Reading settings and their panel |
| `js/highlights.js` | Highlights, notes, list, Markdown export |
| `js/ruler.js`, `js/tts.js` | Reading ruler, read-aloud |
| `js/sync.js` | Sync file save/load and merge |
| `js/db.js` | IndexedDB storage |
| `js/import/` | Converts each format into the app's simple format (`html.js` explains it) |
| `sw.js` | Offline copy of the app |
| `vendor/pdfjs/` | Mozilla pdf.js 6.3.289 (legacy build, for older iPhones/iPads too) |
| `fonts/` | OpenDyslexic, Lexend, Atkinson Hyperlegible Next (SIL Open Font License) |

**Run it locally:** `python3 -m http.server 8765` in this folder, then open <http://localhost:8765>.
Add `?sw` to the address to test offline mode locally.

**After changing any file:** change `VERSION` in `sw.js` (for example `reader-v2`),
otherwise installed copies keep the old version. If you add a file, add it to `FILES` in `sw.js` too.

**After changing an importer** (`js/import/`): raise `PARSER_VERSION` in `js/import/index.js`,
so books already added are converted again from their original file.

`books/` is for your own test books and is never committed.
