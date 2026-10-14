// Sync file: reading places and highlights in one small JSON file.
// Loading it merges with what is on this device; the most recently changed version wins.

import { db } from './db.js';
import { saveFile } from './ui.js';
import { UserError } from './import/index.js';

export async function exportSync() {
  const data = {
    app: 'dyslexreader',
    kind: 'sync',
    version: 1,
    exportedAt: new Date().toISOString(),
    positions: await db.all('positions'),
    highlights: await db.all('highlights'),
  };
  const date = new Date().toISOString().slice(0, 10);
  await saveFile(`reader-sync-${date}.json`, JSON.stringify(data), 'application/json');
}

export async function importSync(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new UserError('This file is not a sync file.');
  }
  if (data?.app !== 'dyslexreader' || data.kind !== 'sync') throw new UserError('This file is not a sync file from this app.');

  const isNum = (v) => Number.isFinite(v);
  const okPosition = (p) => typeof p?.bookId === 'string' && isNum(p.anchor?.s) && isNum(p.anchor?.b) && isNum(p.anchor?.o);
  const okHighlight = (h) => typeof h?.id === 'string' && typeof h.bookId === 'string' && typeof h.text === 'string' &&
    [h.s, h.b1, h.o1, h.b2, h.o2].every(isNum);

  const newer = (a, b) => (a.updatedAt || 0) > (b?.updatedAt || 0);

  const localPos = new Map((await db.all('positions')).map((p) => [p.bookId, p]));
  const positions = [];
  for (const p of (data.positions || []).filter(okPosition)) {
    const mine = localPos.get(p.bookId);
    if (!mine || newer(p, mine)) positions.push({ ...p, lastOpenedAt: Math.max(p.lastOpenedAt || 0, mine?.lastOpenedAt || 0) });
  }

  const localHl = new Map((await db.all('highlights')).map((h) => [h.id, h]));
  const highlights = (data.highlights || []).filter(okHighlight).filter((h) => newer(h, localHl.get(h.id)));

  if (positions.length) await db.putMany('positions', positions);
  if (highlights.length) await db.putMany('highlights', highlights);
  return { positions: positions.length, highlights: highlights.length };
}
