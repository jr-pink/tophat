import { webchatDeviceId } from './device-id.js';


const REPORT_MS = 1500;

/** The one device id (client/device-id.js). */
export const deviceId = (storage = globalThis.localStorage) => webchatDeviceId(storage);

export function createReading({ fetchImpl, device = deviceId(), now = () => Date.now() } = {}) {
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  let pending = null;
  let lastSentAt = 0;
  let timer = null;
  
  
  let mine = null;

  function flush() {
    clearTimeout(timer);
    timer = null;
    if (!pending) return;
    const body = { ...pending, deviceId: device };
    mine = body;
    pending = null;
    lastSentAt = now();
    
    
    doFetch('/api/reading', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true
    }).catch(() => {});
  }

  return {
    device,

    
    report(conversationId, itemId, ratio) {
      if (!conversationId) return;
      pending = { conversationId, itemId: itemId || null, ratio: Number(ratio) || 0 };
      if (timer) return;
      const wait = Math.max(0, REPORT_MS - (now() - lastSentAt));
      timer = setTimeout(flush, wait);
    },

    

    flush,

    async positions() {
      try {
        const response = await doFetch('/api/reading');
        if (!response.ok) return { latest: null, positions: [] };
        return await response.json();
      } catch {
        return { latest: null, positions: [] };
      }
    },

    

    shouldRestore(position) {
      if (!position?.conversationId) return false;
      if (position.deviceId === device) return false;
      if (mine && mine.conversationId === position.conversationId
        && mine.itemId === position.itemId) return false;
      return true;
    }
  };
}
