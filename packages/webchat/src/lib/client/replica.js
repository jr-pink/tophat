

const DB_NAME = 'tophat-webchat';
const DB_VERSION = 1;
const EVENTS = 'events';
const BLOBS = 'blobs';
const META = 'meta';

// A week of every conversation he touched, transcripts whole, is about 160MB of event content on the live
// store. The budget leaves room for that twice over; eviction drops the least recently active conversations
// first, so the week goes last. The budget is about twice the window.
export const EVENT_BUDGET_BYTES = 1_000_000_000;
export const BLOB_BUDGET_BYTES = 150_000_000;
const EVICT_TO = 0.8;
export const SCAN_CHUNK = 20_000;


function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function eventBytes(event) {
  return JSON.stringify(event).length + 64;
}

const OUTBOX_KEY = 'tophat-webchat-outbox';

export function readOutboxSync(key = OUTBOX_KEY) {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeOutboxSync(actions, key = OUTBOX_KEY) {
  try {
    if (!globalThis.localStorage) return false;
    globalThis.localStorage.setItem(key, JSON.stringify(actions));
    return true;
  } catch {
    return false;
  }
}

// `name` and `outboxKey` say whose replica this is. The app's is the default; a multiplayer room
// (client/mp-session.js) opens its own database and outbox under the room's token, so a room tab
// on his own browser neither reads his chats nor replays his queued sends into the room.
//
// `eventBudget` and `scanChunk` are the eviction knobs (tests shrink them): the byte budget of the event store,
// and how many events one eviction-scan transaction reads before it lets writers in.
export async function openReplica(indexedDBImpl = globalThis.indexedDB, { name = DB_NAME, outboxKey = OUTBOX_KEY, eventBudget = EVENT_BUDGET_BYTES, scanChunk = SCAN_CHUNK } = {}) {
  if (!indexedDBImpl) return memoryReplica();
  let db;
  try {
    const request = indexedDBImpl.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(EVENTS)) {
        const store = database.createObjectStore(EVENTS, { keyPath: 'cursor' });
        store.createIndex('conversation', 'conversation_id');
      }
      if (!database.objectStoreNames.contains(BLOBS)) {
        database.createObjectStore(BLOBS, { keyPath: 'key' });
      }
      if (!database.objectStoreNames.contains(META)) database.createObjectStore(META);
    };
    db = await promisify(request);
  } catch {
    return memoryReplica();
  }

  async function meta(key, fallback) {
    try {
      const tx = db.transaction(META, 'readonly');
      return (await promisify(tx.objectStore(META).get(key))) ?? fallback;
    } catch { return fallback; }
  }

  async function setMeta(key, value) {
    const tx = db.transaction(META, 'readwrite');
    tx.objectStore(META).put(value, key);
    await done(tx);
  }

  let evicting = null;
  const replica = {
    kind: 'indexeddb',

    async cursor() { return meta('cursor', 0); },

    async usage() { return { events: await meta('eventBytes', 0), blobs: await meta('blobBytes', 0) }; },

    
    
    
    
    
    async readAll() {
      try {
        const tx = db.transaction(EVENTS, 'readonly');
        return (await promisify(tx.objectStore(EVENTS).getAll())) || [];
      } catch { return []; }
    },

    
    
    
    
    
    async readRecent(limit = 25_000) {
      if (limit <= 0) return [];
      try {
        const tx = db.transaction(EVENTS, 'readonly');
        const rows = [];
        await new Promise((resolve, reject) => {
          const request = tx.objectStore(EVENTS).openCursor(null, 'prev');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor || rows.length >= limit) return resolve();
            rows.push(cursor.value);
            cursor.continue();
          };
        });
        return rows.reverse();
      } catch { return []; }
    },

    async readConversation(conversationId) {
      try {
        const tx = db.transaction(EVENTS, 'readonly');
        const index = tx.objectStore(EVENTS).index('conversation');
        const rows = (await promisify(index.getAll(conversationId))) || [];
        return rows.sort((a, b) => a.cursor - b.cursor);
      } catch { return []; }
    },

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    async append(events) {
      if (!events.length) return;
      try {
        const tx = db.transaction([EVENTS, META], 'readwrite');
        const store = tx.objectStore(EVENTS);
        const metaStore = tx.objectStore(META);
        let bytes = 0;
        let highest = 0;
        for (const event of events) {
          store.put(event);
          bytes += eventBytes(event);
          highest = Math.max(highest, event.cursor);
        }
        
        
        
        
        
        
        const total = ((await promisify(metaStore.get('eventBytes'))) ?? 0) + bytes;
        metaStore.put(total, 'eventBytes');
        if (highest) {
          const priorCursor = (await promisify(metaStore.get('cursor'))) ?? 0;
          metaStore.put(Math.max(highest, priorCursor), 'cursor');
        }
        await done(tx);
        if (total > eventBudget) await replica.evictEvents();
      } catch {  }
    },

    
    
    
    // One scan at a time: while a scan runs the stored total is still the old, over-budget one, so every append
    // that lands meanwhile would start a scan of its own. Callers during a scan get the scan's result.
    evictEvents(budget = eventBudget) {
      if (!evicting) evicting = replica.scanAndEvict(budget).finally(() => { evicting = null; });
      return evicting;
    },

    async scanAndEvict(budget) {
      
      
      
      
      
      const perConversation = new Map();
      try {
        // Short readonly transactions, one chunk each: a scan of the whole store in one transaction kept every
        // append (readwrite) and every read behind it for the length of the scan (tens of seconds at 650k events).
        let after = null;
        for (;;) {
          const scan = db.transaction(EVENTS, 'readonly');
          const range = after === null ? null : IDBKeyRange.lowerBound(after, true);
          let read = 0;
          await new Promise((resolve, reject) => {
            const request = scan.objectStore(EVENTS).openCursor(range);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor) { after = null; return resolve(); }
              const event = cursor.value;
              const entry = perConversation.get(event.conversation_id) || { bytes: 0, last: '', cursors: [] };
              entry.bytes += eventBytes(event);
              entry.last = event.at > entry.last ? event.at : entry.last;
              entry.cursors.push(event.cursor);
              perConversation.set(event.conversation_id, entry);
              after = event.cursor;
              if (++read >= scanChunk) return resolve();
              cursor.continue();
            };
          });
          if (after === null) break;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      } catch { return []; }
      let total = [...perConversation.values()].reduce((sum, entry) => sum + entry.bytes, 0);
      const ordered = [...perConversation.entries()].sort((a, b) => String(a[1].last).localeCompare(String(b[1].last)));
      const dropped = [];
      const tx = db.transaction([EVENTS], 'readwrite');
      const store = tx.objectStore(EVENTS);
      for (const [conversationId, entry] of ordered) {
        if (total <= budget * EVICT_TO) break;
        for (const cursor of entry.cursors) store.delete(cursor);
        total -= entry.bytes;
        dropped.push(conversationId);
      }
      await done(tx);
      await setMeta('eventBytes', total);
      // A conversation that was dropped is no longer held, so the background sync must start it
      // from the beginning again if it comes back into the window.
      if (dropped.length) {
        const synced = { ...(await meta('synced', {})) };
        for (const id of dropped) delete synced[id];
        await setMeta('synced', synced);
      }
      return dropped;
    },

    async readBlob(key) {
      try {
        const tx = db.transaction(BLOBS, 'readwrite');
        const store = tx.objectStore(BLOBS);
        const record = await promisify(store.get(key));
        if (!record) return null;
        store.put({ ...record, touched: Date.now() }); 
        await done(tx);
        return record.value;
      } catch { return null; }
    },

    async writeBlob(key, value, bytes) {
      try {
        const tx = db.transaction(BLOBS, 'readwrite');
        tx.objectStore(BLOBS).put({ key, value, bytes, touched: Date.now() });
        await done(tx);
        const total = (await meta('blobBytes', 0)) + bytes;
        await setMeta('blobBytes', total);
        if (total > BLOB_BUDGET_BYTES) await replica.evictBlobs();
      } catch {  }
    },

    async evictBlobs(budget = BLOB_BUDGET_BYTES) {
      const tx = db.transaction(BLOBS, 'readwrite');
      const store = tx.objectStore(BLOBS);
      const records = (await promisify(store.getAll())) || [];
      let total = records.reduce((sum, record) => sum + (record.bytes || 0), 0);
      for (const record of records.sort((a, b) => a.touched - b.touched)) {
        if (total <= budget * EVICT_TO) break;
        store.delete(record.key);
        total -= record.bytes || 0;
      }
      await done(tx);
      await setMeta('blobBytes', total);
    },

    
    
    
    
    async readHeaders() { return meta('headers', []); },
    async writeHeaders(headers) { await setMeta('headers', headers); },

    async lastOpened() { return meta('lastOpened', null); },
    async setLastOpened(id) { await setMeta('lastOpened', id); },

    
    
    async readLatest(conversationId, limit = 400) {
      try {
        const tx = db.transaction(EVENTS, 'readonly');
        const index = tx.objectStore(EVENTS).index('conversation');
        const rows = [];
        await new Promise((resolve, reject) => {
          const request = index.openCursor(IDBKeyRange.only(conversationId), 'prev');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor || rows.length >= limit) return resolve();
            rows.push(cursor.value);
            cursor.continue();
          };
        });
        return rows.reverse();
      } catch { return []; }
    },

    
    
    
    
    // Older history of one conversation, newest first up to `limit`, then returned in order: what
    // "load earlier" reads when the server cannot be asked.
    async readBefore(conversationId, before, limit = 400) {
      try {
        const tx = db.transaction(EVENTS, 'readonly');
        const index = tx.objectStore(EVENTS).index('conversation');
        const rows = [];
        await new Promise((resolve, reject) => {
          const request = index.openCursor(conversationId, 'prev');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor || rows.length >= limit) return resolve();
            if (cursor.value.cursor < before) rows.push(cursor.value);
            cursor.continue();
          };
        });
        return rows.reverse();
      } catch { return []; }
    },

    // Every cursor held for one conversation, so a background sync writes only what is missing
    // and the byte count is not inflated by rewriting rows the replica already has.
    async conversationCursors(conversationId) {
      try {
        const tx = db.transaction(EVENTS, 'readonly');
        const index = tx.objectStore(EVENTS).index('conversation');
        return (await promisify(index.getAllKeys(conversationId))) || [];
      } catch { return []; }
    },

    // How far each conversation is held contiguously from its first event (week-sync.js).
    async readSynced() { return meta('synced', {}); },
    async writeSynced(map) { try { await setMeta('synced', map); } catch {  } },

    async readOutbox() {
      const sync = readOutboxSync(outboxKey);
      if (sync.length) return sync;
      return meta('outbox', []);
    },
    async writeOutbox(actions) {
      if (writeOutboxSync(actions, outboxKey)) await setMeta('outbox', []);
      else await setMeta('outbox', actions);
    },
    async clear() {
      const tx = db.transaction([EVENTS, BLOBS, META], 'readwrite');
      tx.objectStore(EVENTS).clear();
      tx.objectStore(BLOBS).clear();
      tx.objectStore(META).clear();
      await done(tx);
    }
  };
  return replica;
}

export function memoryReplica() {
  const events = new Map();
  const blobs = new Map();
  let outbox = [];
  let headers = [];
  let lastOpened = null;
  let cursor = 0;
  let synced = {};
  return {
    kind: 'memory',
    async cursor() { return cursor; },
    async usage() { return { events: 0, blobs: 0 }; },
    async readAll() { return [...events.values()].sort((a, b) => a.cursor - b.cursor); },
    async readConversation(id) { return (await this.readAll()).filter((event) => event.conversation_id === id); },
    async append(list) { for (const event of list) { events.set(event.cursor, event); cursor = Math.max(cursor, event.cursor); } },
    async evictEvents() { return []; },
    async readBlob(key) { return blobs.get(key) ?? null; },
    async writeBlob(key, value) { blobs.set(key, value); },
    async evictBlobs() {},
    async readHeaders() { return headers; },
    async writeHeaders(next) { headers = next; },
    async lastOpened() { return lastOpened; },
    async setLastOpened(id) { lastOpened = id; },
    async readLatest(id, limit = 400) { return (await this.readConversation(id)).slice(-limit); },
    async readRecent(limit = 25_000) { return (await this.readAll()).slice(-limit); },
    async readBefore(id, before, limit = 400) { return (await this.readConversation(id)).filter((event) => event.cursor < before).slice(-limit); },
    async conversationCursors(id) { return (await this.readConversation(id)).map((event) => event.cursor); },
    async readSynced() { return synced; },
    async writeSynced(next) { synced = next; },
    async readOutbox() { return outbox; },
    async writeOutbox(next) { outbox = next; },
    async clear() { events.clear(); blobs.clear(); outbox = []; cursor = 0; synced = {}; }
  };
}
