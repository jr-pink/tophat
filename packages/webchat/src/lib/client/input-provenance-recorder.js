

import { initialProvenance, provenanceStep } from '$lib/core/input-provenance.js';
import { isIncognito } from '$lib/core/incognito.js';

const ENDPOINT = '/api/dictation/provenance';


const NON_PRINTING = new Set([
  'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab', 'Escape',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Insert',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'Dead', 'Unidentified', 'Process'
]);

export function stampLocal(date = new Date()) {
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

function mono() {
  try { return performance.now(); } catch { return Date.now(); }
}

const SALT_KEY = 'tophat.provenance.salt';

function installSalt() {
  try {
    let salt = localStorage.getItem(SALT_KEY);
    if (!salt) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      salt = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(SALT_KEY, salt);
    }
    return salt;
  } catch {
    
    
    
    return null;
  }
}

let ephemeralSalt = null;

export async function hashId(value, salt) {
  if (!value) return null;
  try {
    const data = new TextEncoder().encode(`${salt ?? ''}:${value}`);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)].slice(0, 4).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

export async function enumerateInputs() {
  let salt = installSalt();
  if (!salt) {
    if (!ephemeralSalt) ephemeralSalt = `eph-${Math.random().toString(36).slice(2)}`;
    salt = ephemeralSalt;
  }
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return { devices: [], labelled: false, error: 'enumerateDevices refused' };
  }
  const inputs = devices.filter((d) => d.kind === 'audioinput');
  const rows = await Promise.all(inputs.map(async (d) => ({
    label: typeof d.label === 'string' ? d.label.slice(0, 200) : '',
    device_hash: await hashId(d.deviceId, salt),
    group_hash: await hashId(d.groupId, salt),
    
    
    
    alias: d.deviceId === 'default' || d.deviceId === 'communications' ? d.deviceId : null
  })));
  return {
    devices: rows,
    labelled: rows.some((r) => r.label !== ''),
    salt: installSalt() ? 'install' : 'ephemeral'
  };
}

function postRows(rows, { beacon = false } = {}) {
  if (!rows.length) return;
  const body = JSON.stringify({ rows, client_at: stampLocal() });
  try {
    if (beacon && navigator.sendBeacon) {
      
      
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
      return;
    }
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true
    }).catch(() => {});
  } catch {
    
  }
}

export function createInputProvenance({
  sessionId = null,
  conversationId = () => null,
  endpoint = ENDPOINT,
  flushMs = 15_000,
  post = postRows
} = {}) {
  // Rows about an incognito chat are never sent (core/incognito.js); a device row with no chat still is.
  const kept = (rows, options) => {
    const left = (rows || []).filter((row) => !isIncognito(row?.conversation_id));
    if (left.length) return post(left, options);
    return undefined;
  };
  const shared = recorder({ sessionId, conversationId, endpoint, flushMs, post: kept });
  return {
    attach: shared.attach,
    noteSent: shared.noteSent,
    recordDevices: shared.recordDevices,
    stop: shared.stop
  };
}

export function startProvenance({
  target = typeof document === 'undefined' ? null : document,
  ...options
} = {}) {
  if (!target) return () => {};
  const shared = createInputProvenance(options);
  const detach = shared.attach(target);
  return () => { detach?.(); shared.stop(); };
}

function recorder({
  sessionId = null,
  conversationId = () => null,
  endpoint = ENDPOINT,
  flushMs = 15_000,
  post = postRows
} = {}) {

  let state = initialProvenance({ sessionId, conversationId: safely(conversationId, null) });
  let pending = [];
  let timer = null;
  let hidden = null;
  let devicesSent = false;

  function safely(fn, fallback) {
    try { return fn(); } catch { return fallback; }
  }

  
  
  function feed(event) {
    try {
      const next = provenanceStep(state, event);
      state = next.state;
      if (next.rows.length) {
        pending.push(...next.rows.map((row) => ({ ...row, type: 'provenance', kind: row.class })));
        if (pending.length > 500) pending = pending.slice(-500);
      }
    } catch {
      
      
    }
  }

  function isTextField(node) {
    try {
      if (!node) return false;
      const tag = node.tagName;
      return tag === 'TEXTAREA' || (tag === 'INPUT' && /^(text|search)$/u.test(node.type || 'text'));
    } catch { return false; }
  }

  const onKeydown = (event) => {
    try {
      if (!isTextField(event.target)) return;
      feed({
        type: 'key',
        key: event.key,
        
        
        
        
        shift: event.shiftKey === true,
        offset: safely(() => event.target.selectionStart, null),
        printable: !(NON_PRINTING.has(event.key) || event.metaKey || event.ctrlKey),
        at: stampLocal(),
        mono: mono()
      });
    } catch {  }
  };

  
  
  
  const onBeforeInput = (event) => {
    try {
      if (!isTextField(event.target)) return;
      const text = typeof event.data === 'string'
        ? event.data
        : dataFromTransfer(event);
      feed({
        type: 'insert',
        inputType: event.inputType ?? null,
        text: text ?? '',
        offset: safely(() => event.target.selectionStart, null),
        removed: null,
        at: stampLocal(),
        mono: mono(),
        source: 'beforeinput'
      });
    } catch {  }
  };

  function dataFromTransfer(event) {
    try { return event.dataTransfer?.getData('text/plain') ?? ''; } catch { return ''; }
  }

  const onBoundary = (reason) => (event) => {
    try {
      if (event && event.target && !isTextField(event.target) && reason === 'blur') return;
      feed({ type: 'boundary', reason, at: stampLocal(), mono: mono() });
      flush();
    } catch {  }
  };

  const onComposition = (phase) => (event) => {
    try {
      if (!isTextField(event.target)) return;
      feed({ type: 'composition', phase, at: stampLocal(), mono: mono() });
    } catch {  }
  };

  function flush({ beacon = false } = {}) {
    try {
      if (!pending.length) return;
      const rows = pending.map((row) => ({ ...row, conversation_id: row.conversation_id ?? safely(conversationId, null) }));
      pending = [];
      post(rows, { beacon, endpoint });
    } catch {  }
  }

  
  async function recordDevices() {
    try {
      if (devicesSent) return;
      const inventory = await enumerateInputs();
      if (!inventory.labelled && !inventory.devices.length) return;
      devicesSent = true;
      post([{
        type: 'provenance',
        kind: 'devices',
        session_id: sessionId,
        conversation_id: safely(conversationId, null),
        ...inventory,
        user_agent: safely(() => navigator.userAgent.slice(0, 300), null),
        at: stampLocal()
      }], { endpoint });
    } catch {  }
  }

  
  
  
  
  const LISTENERS = [
    ['keydown', onKeydown, { capture: true, passive: true }],
    ['beforeinput', onBeforeInput, { capture: true, passive: true }],
    ['compositionstart', onComposition('start'), { capture: true, passive: true }],
    ['compositionend', onComposition('end'), { capture: true, passive: true }],
    ['blur', onBoundary('blur'), { capture: true, passive: true }]
  ];

  const attached = new Set();

  

  function attach(field) {
    if (!field || attached.has(field)) return () => {};
    const listeners = LISTENERS;
    try {
      for (const [name, fn, opts] of listeners) field.addEventListener(name, fn, opts);
      attached.add(field);
      if (!timer) timer = setInterval(() => flush(), flushMs);
      if (!hidden) {
        
        hidden = () => flush({ beacon: true });
        (field.ownerDocument?.defaultView ?? globalThis)
          .addEventListener?.('pagehide', hidden, { passive: true });
      }
    } catch {
      return () => {};
    }
    return function detach() {
      try {
        for (const [name, fn, opts] of listeners) field.removeEventListener(name, fn, opts);
        attached.delete(field);
        feed({ type: 'boundary', reason: 'detach', at: stampLocal(), mono: mono() });
        flush();
      } catch {  }
    };
  }

  

  function noteSent(text) {
    try {
      feed({ type: 'boundary', reason: 'sent', at: stampLocal(), mono: mono() });
      if (pending.length) {
        pending[pending.length - 1] = {
          ...pending[pending.length - 1],
          
          sent_text: typeof text === 'string' ? text.slice(0, 8_000) : null
        };
      }
      flush();
    } catch {  }
  }

  function stop() {
    try {
      for (const field of [...attached]) {
        for (const [name, fn, opts] of LISTENERS) field.removeEventListener(name, fn, opts);
      }
      attached.clear();
      if (timer) clearInterval(timer);
      timer = null;
      flush({ beacon: true });
    } catch {  }
  }

  return { attach, noteSent, recordDevices, stop };
}
