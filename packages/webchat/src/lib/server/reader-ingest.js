// Getting a book into the reader without holding it in memory.
//
// Three things happen here, and all three are bounded. The upload is piped to disk a chunk at a
// time, so a 100 MB book never exists as one buffer. And the chapter HTML is not stored at all:
// it is parsed from the file when a chapter is opened, through a handle kept warm for a minute,
// because storing 271 MB of markup to render 40 KB of it is the same mistake in a different
// place.

import { createWriteStream } from 'node:fs';
import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isEpubFile, openEpubFile } from './reader-epub.js';
import { hashId, readerStoreDir } from './reader-store.js';

const epubDir = () => {
  const dir = join(readerStoreDir(), 'epub');
  mkdirSync(dir, { recursive: true });
  return dir;
};

export const bookPath = (id) => join(epubDir(), `${id}.epub`);

/** Stream a request body to a file on disk. Returns the path and the byte count. */
export async function receiveUpload(body) {
  const path = join(epubDir(), `upload-${randomBytes(8).toString('hex')}.part`);
  const source = body instanceof Readable ? body : Readable.fromWeb(body);
  await pipeline(source, createWriteStream(path));
  return { path, bytes: statSync(path).size };
}

// --- open handles ------------------------------------------------------------------------------
// A handle holds the central directory (a Map of entries) and one file descriptor, not the book.
// Chapters are read through it, and it closes itself after a minute of nobody reading.

const HANDLE_IDLE_MS = 60_000;
const handles = new Map();

// The last few chapters he looked at, parsed. A book on disk never changes (a re-upload hashes to
// a new id), so the only way to hold a stale chapter is to hold a wrong id, and closing the
// handle drops them. Paging back one chapter was costing a full parse again.
const CHAPTER_CACHE_MAX = 6;
const chapters = new Map();   // `${id}:${order}` -> html


export function handleFor(id) {
  const existing = handles.get(id);
  if (existing) {
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => closeHandle(id), HANDLE_IDLE_MS).unref?.();
    return existing.handle;
  }
  const handle = openEpubFile(bookPath(id));
  const entry = { handle, timer: setTimeout(() => closeHandle(id), HANDLE_IDLE_MS) };
  entry.timer.unref?.();
  handles.set(id, entry);
  return handle;
}

export function closeHandle(id) {
  const entry = handles.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  handles.delete(id);
  for (const key of [...chapters.keys()]) if (key.startsWith(`${id}:`)) chapters.delete(key);
  try { entry.handle.close(); } catch { /* already closed */ }
}

export function closeAllHandles() {
  for (const id of [...handles.keys()]) closeHandle(id);
}

// --- ingest ------------------------------------------------------------------------------------

const running = new Map();   // id -> { total, done, state, error, startedAt }

export const ingestStatus = (id) => running.get(id) || null;

/**
 * Save the book and lay out its chapters, then read them in the background.
 *
 * The rows are written first with their titles and no text, so the contents rail and the pager
 * work the moment the upload finishes; the text arrives chapter by chapter behind it. Yielding to
 * the event loop between chapters is what keeps the server answering: an earlier version parsed
 * the whole book inside the request and a 100 MB upload wedged everything for minutes.
 */
export function ingestEpub({ store, uploadPath, name = '', bytes = 0 }) {
  if (!isEpubFile(uploadPath)) {
    rmSync(uploadPath, { force: true });
    throw new Error('that file is not an EPUB');
  }
  const probe = openEpubFile(uploadPath);
  let id;
  try {
    const meta = probe.meta;
    id = hashId('e', meta.identifier || `${meta.title}:${meta.author}:${name}:${bytes}`);
    const spine = probe.spine;
    renameSync(uploadPath, bookPath(id));
    store.saveDoc({
      id,
      kind: 'epub',
      url: null,
      canonicalUrl: null,
      title: meta.title || name.replace(/\.epub$/iu, '') || 'Untitled book',
      byline: meta.author || '',
      site: 'EPUB',
      seriesKey: `epub:${id}`,
      lang: meta.language || '',
      excerpt: '',
      publishedAt: null,
      words: 0,
      sections: spine.length,
      meta: { file: `${id}.epub`, bytes, sourceName: name, toc: probe.toc.slice(0, 500) }
    });
    store.setSections(id, spine.map((item) => ({
      href: item.href,
      title: probe.titleFor(item.order) || `Chapter ${item.order + 1}`,
      html: '',
      text: '',
      words: 0
    })));
    store.setLinks(id, []);
    running.set(id, { total: spine.length, done: 0, state: 'reading', error: null, startedAt: Date.now() });
  } finally {
    probe.close();
  }

  // Nothing awaits this: the upload answers as soon as the chapters are listed.
  readChapters({ store, id }).catch((cause) => {
    const status = running.get(id);
    if (status) running.set(id, { ...status, state: 'failed', error: cause.message });
  });
  return { id, status: running.get(id) };
}

const breathe = () => new Promise((resolve) => setImmediate(resolve));

// How many chapters share one transaction, and how much text, whichever comes first. The byte cap
// is what keeps a run of very long chapters from making one enormous transaction: sqlite's memory
// for a batch tracks the text in it, not the number of rows.
const BATCH = 64;
const BATCH_BYTES = 2 * 1024 * 1024;

async function readChapters({ store, id }) {
  const handle = openEpubFile(bookPath(id));
  let words = 0;
  let done = 0;
  try {
    // Chapters are written in batches of one transaction each: one fsync per batch instead of one
    // per chapter, and the event loop runs between every chapter so the server keeps answering
    // while a long book is read.
    let batch = [];
    let batchBytes = 0;
    const flush = () => {
      if (!batch.length) return;
      const pending = batch;
      batch = [];
      batchBytes = 0;
      store.batch(() => {
        for (const section of pending) {
          store.setSectionText(id, section.order, {
            title: section.title || `Chapter ${section.order + 1}`,
            text: section.text,
            words: section.words
          });
        }
      });
    };

    for (const section of handle.sections()) {
      batch.push(section);
      batchBytes += section.text.length;
      words += section.words || 0;
      done += 1;
      if (batch.length >= BATCH || batchBytes >= BATCH_BYTES) {
        flush();
        if (done % (BATCH * 5) === 0) store.checkpoint();
      }
      const status = running.get(id);
      if (status) running.set(id, { ...status, done, words });
      await breathe();
    }
    flush();
    store.checkpoint();
    store.countWords(id);
    const status = running.get(id);
    running.set(id, { ...(status || {}), state: 'ready', done, words, total: status?.total ?? done });
  } finally {
    handle.close();
  }
}

/** The HTML of one chapter, parsed on demand. Stored text is what search uses; this is for reading. */
export function chapterHtml(id, order) {
  const key = `${id}:${order}`;
  const hit = chapters.get(key);
  if (hit !== undefined) {
    chapters.delete(key);       // touch, so the cache keeps what he is actually reading
    chapters.set(key, hit);
    handleFor(id);              // and keep the file handle from idling out under him
    return hit;
  }
  const handle = handleFor(id);
  const section = handle.section(order);
  const html = section ? section.html : '';
  chapters.set(key, html);
  while (chapters.size > CHAPTER_CACHE_MAX) chapters.delete(chapters.keys().next().value);
  return html;
}

/** Drop the parsed chapters of one book, or of every book. */
export function forgetChapters(id = null) {
  if (id === null) { chapters.clear(); return; }
  for (const key of [...chapters.keys()]) if (key.startsWith(`${id}:`)) chapters.delete(key);
}
