// The reader's client-side reducers: what the device shows is the server's last confirmed state
// with every op it has not yet had acknowledged folded on top. Pure functions, no storage and no
// network, so the merge rules are tested here and the browser module only moves bytes.
//
// Merge rules (the server applies the same ones when the op log is replayed):
// - notes and replies are an add-wins set keyed by client-minted ids; a delete is a tombstone
//   (deletedAt) that removes only what the device had seen;
// - document flags (starred, archived, aside, defer, status) and the reading position are
//   last-writer-wins per field by the instant the device recorded;
// - the furthest point read only ever rises, and seconds read add up.

export const OFFLINE_WINDOW_MS = 7 * 86_400_000;
export const DEFAULT_BUDGET_BYTES = 100 * 1024 * 1024;

export function newClientId(prefix = 'h') {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const isoAt = (ms) => new Date(ms).toISOString();

/** A deferred document is off the shelf until its hour, or while it waits on a condition. */
export function isWaiting(row, now = Date.now()) {
  if (!row) return false;
  if (row.defer_until) return row.defer_until > isoAt(now);
  return String(row.defer_condition || '') !== '';
}

/** Starred, on the live shelf (the inbox), or saved, changed or read in the past week. */
export function inOfflineSet(row, now = Date.now(), windowMs = OFFLINE_WINDOW_MS) {
  if (!row) return false;
  if (row.starred) return true;
  const since = isoAt(now - windowMs);
  for (const at of [row.added_at, row.updated_at, row.last_read_at, row.read_at]) if (at && at >= since) return true;
  if (row.archived || row.aside) return false;
  return !isWaiting(row, now);
}

const orderAt = (row) => row.read_at || row.added_at || '';

/** The same shelves the server draws (reader-store library()), drawn from rows on the device. */
export function libraryView(rows, { view = 'live', status = null, now = Date.now(), limit = 200 } = {}) {
  const out = [];
  for (const row of rows) {
    if (!row || row.kind === 'chat') continue;
    const archived = Boolean(row.archived);
    if (view === 'archived') { if (!archived) continue; }
    else {
      if (archived) continue;
      if (view === 'aside') { if (!row.aside) continue; }
      else if (view === 'deferred') { if (row.aside || !isWaiting(row, now)) continue; }
      else if (view === 'starred') { if (!row.starred) continue; }
      else if (row.aside || isWaiting(row, now)) continue;
    }
    if (status && (row.status || 'unread') !== status) continue;
    out.push({ ...row, order_at: orderAt(row) });
  }
  out.sort((a, b) => (orderAt(b).localeCompare(orderAt(a))) || String(b.added_at || '').localeCompare(String(a.added_at || '')));
  return out.slice(0, limit);
}

/** Title, byline, site and excerpt, then note text: the search box with nobody to ask. */
export function searchLocal(rows, notes = [], query = '') {
  const words = String(query || '').toLowerCase().split(/\s+/u).filter(Boolean);
  if (!words.length) return { docs: [], notes: [] };
  const hit = (text) => { const t = String(text || '').toLowerCase(); return words.every((w) => t.includes(w)); };
  const docs = rows.filter((row) => row.kind !== 'chat' && hit(`${row.title} ${row.byline} ${row.site} ${row.excerpt}`))
    .slice(0, 40)
    .map((row) => ({ id: row.id, section_idx: 0, title: row.title, site: row.site, url: row.url, kind: row.kind,
      snippet: escapeHtml(String(row.excerpt || '').slice(0, 160)) }));
  const found = notes.filter((n) => !n.deletedAt && hit(`${n.quote} ${n.note}`)).slice(0, 40)
    .map((n) => ({ id: n.id, doc_id: n.docId, title: n.docTitle || '', quote: n.quote, note: n.note,
      section_idx: n.sectionIdx, color: n.color, kind: n.kind }));
  return { docs, notes: found };
}

function escapeHtml(text) {
  return text.replace(/[&<>"]/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

/** Which doc an op is about. */
export function opDoc(op) {
  return op?.docId || op?.payload?.docId || null;
}

// --- folding ops onto rows and bodies ------------------------------------------------------------

function applyFields(target, fields, at) {
  const next = { ...target };
  if (fields.starred !== undefined) next.starred = fields.starred ? 1 : 0;
  if (fields.archived !== undefined) next.archived = fields.archived ? 1 : 0;
  if (fields.aside !== undefined) next.aside = fields.aside ? 1 : 0;
  if (fields.defer !== undefined) {
    const d = fields.defer || {};
    next.defer_until = d.until || null;
    next.defer_condition = d.condition || null;
    next.deferred_at = d.until || d.condition ? at : null;
  }
  return next;
}

function statusPatch(state, status, at) {
  const next = { ...(state || {}), status };
  if (status === 'finished') { next.percent = 1; next.finished_at = at; }
  else { next.finished_at = null; if (status === 'unread') next.percent = 0; }
  next.last_read_at = at;
  return next;
}

/** One op onto one shelf row; returns the same object when the op is not about it. */
export function applyOpToRow(row, op) {
  if (!row || opDoc(op) !== row.id) return row;
  const p = op.payload || {};
  switch (op.kind) {
    case 'doc.patch': {
      let next = applyFields(row, p.fields || {}, op.at);
      if (p.fields?.status) {
        const s = statusPatch({ status: row.status, percent: row.percent }, p.fields.status, op.at);
        next = { ...next, status: s.status, percent: s.percent };
      }
      return next;
    }
    case 'progress': {
      const percent = Math.max(Number(row.percent || 0), Number(p.percent || 0));
      return { ...row, read_at: op.at, last_read_at: op.at, section_idx: Number(p.sectionIdx || 0),
        percent, status: percent >= 0.95 ? 'finished' : 'reading' };
    }
    case 'note.save':
      return p.create && !p.parentId ? { ...row, notes: Number(row.notes || 0) + 1 } : row;
    case 'note.delete':
      return p.root ? { ...row, notes: Math.max(0, Number(row.notes || 0) - 1) } : row;
    default:
      return row;
  }
}

export function foldRow(row, ops = []) {
  let next = row;
  for (const op of ops) next = applyOpToRow(next, op);
  return next;
}

function rootOf(highlights, id) {
  return highlights.find((h) => h.id === id) || highlights.find((h) => (h.replies || []).some((r) => r.id === id)) || null;
}

function defined(object) {
  const out = {};
  for (const [k, v] of Object.entries(object)) if (v !== undefined) out[k] = v;
  return out;
}

const NOTE_FIELDS = ['sectionIdx', 'anchorKey', 'color', 'quote', 'prefix', 'suffix', 'start', 'end', 'note', 'tags', 'author'];

/** A note op onto a list of note threads (root notes, each with its replies). */
export function applyNoteOp(highlights = [], op) {
  const p = op.payload || {};
  if (op.kind === 'note.save') {
    if (p.parentId) {
      const root = rootOf(highlights, p.parentId);
      if (!root) return highlights;
      const reply = { id: p.id, note: String(p.note ?? ''), author: p.author === 'tophat' ? 'tophat' : 'owner', createdAt: op.at, updatedAt: op.at };
      const replies = root.replies || [];
      const had = replies.find((r) => r.id === p.id);
      const nextReplies = had
        ? replies.map((r) => (r.id === p.id ? { ...r, note: reply.note, updatedAt: op.at } : r))
        : [...replies, reply];
      return highlights.map((h) => (h.id === root.id ? { ...h, replies: nextReplies } : h));
    }
    const existing = highlights.find((h) => h.id === p.id);
    const fields = defined(Object.fromEntries(NOTE_FIELDS.map((k) => [k, p[k]])));
    if (existing) {
      const merged = { ...existing, ...fields, updatedAt: op.at, deletedAt: null };
      merged.kind = merged.note ? 'note' : (p.kind || existing.kind || 'highlight');
      return highlights.map((h) => (h.id === p.id ? merged : h));
    }
    const created = {
      id: p.id, docId: p.docId, sectionIdx: Number(p.sectionIdx || 0), anchorKey: p.anchorKey ?? null,
      kind: p.note ? 'note' : (p.kind || 'highlight'), color: p.color || 'yellow',
      quote: String(p.quote || ''), prefix: String(p.prefix || ''), suffix: String(p.suffix || ''),
      start: Number(p.start || 0), end: Number(p.end || 0), note: String(p.note || ''), tags: String(p.tags || ''),
      createdAt: op.at, updatedAt: op.at, deletedAt: null, parentId: null,
      author: p.author === 'tophat' ? 'tophat' : 'owner', replies: [], pending: true
    };
    return [...highlights, created];
  }
  if (op.kind === 'note.delete') {
    const root = highlights.find((h) => h.id === p.id);
    if (root) return highlights.map((h) => (h.id === p.id ? { ...h, deletedAt: op.at } : h));
    const parent = rootOf(highlights, p.id);
    if (!parent) return highlights;
    return highlights.map((h) => (h.id === parent.id ? { ...h, replies: (h.replies || []).filter((r) => r.id !== p.id) } : h));
  }
  if (op.kind === 'note.restore') {
    return highlights.map((h) => (h.id === p.id ? { ...h, deletedAt: null } : h));
  }
  return highlights;
}

/** Whole-document percent weighted by words per section, as reader-store markProgress works it out. */
export function weightedPercent(sections = [], progressRows = []) {
  const ratios = new Map(progressRows.map((r) => [Number(r.section_idx), Number(r.ratio) || 0]));
  const total = sections.reduce((sum, s) => sum + Math.max(1, Number(s.words || 1)), 0) || 1;
  const done = sections.reduce((sum, s) => sum + Math.max(1, Number(s.words || 1)) * (ratios.get(Number(s.idx)) || 0), 0);
  return Math.max(0, Math.min(1, done / total));
}

/**
 * One op onto a document body: anything with doc, highlights and progress, which is both what the
 * device stores and what GET /api/reader/doc answers.
 */
export function applyOpToBody(body, op) {
  if (!body) return body;
  const id = body.id || body.doc?.id;
  if (opDoc(op) !== id && !(op.kind?.startsWith('note.') && rootOf(body.highlights || [], op.payload?.id || op.payload?.parentId))) return body;
  const p = op.payload || {};
  if (op.kind.startsWith('note.')) return { ...body, highlights: applyNoteOp(body.highlights || [], op) };
  if (op.kind === 'doc.patch') {
    let doc = applyFields(body.doc || {}, p.fields || {}, op.at);
    let state = doc.state;
    if (p.fields?.status) state = statusPatch(state, p.fields.status, op.at);
    doc = { ...doc, state };
    return { ...body, doc };
  }
  if (op.kind === 'progress') {
    const idx = Number(p.sectionIdx || 0);
    const rows = [...(body.progress?.sections || [])];
    const at = rows.findIndex((r) => Number(r.section_idx) === idx);
    const prior = at >= 0 ? rows[at] : null;
    const newer = !prior || !prior.updated_at || prior.updated_at <= op.at;
    const row = {
      doc_id: id, section_idx: idx,
      ratio: Math.max(Number(prior?.ratio || 0), Math.max(0, Math.min(1, Number(p.ratio) || 0))),
      scroll_top: newer ? Math.round(Number(p.scrollTop || 0)) : Number(prior?.scroll_top || 0),
      seconds: Number(prior?.seconds || 0) + Math.round(Number(p.seconds || 0)),
      updated_at: newer ? op.at : prior.updated_at
    };
    if (at >= 0) rows[at] = row; else rows.push(row);
    const sectionList = (body.sections || []).map((s) => ({ idx: s.idx, words: s.words }));
    const percent = Math.max(Number(body.doc?.state?.percent || body.progress?.state?.percent || 0),
      sectionList.length ? weightedPercent(sectionList, rows) : row.ratio);
    const state = {
      ...(body.progress?.state || body.doc?.state || {}),
      status: percent >= 0.95 ? 'finished' : 'reading', percent,
      section_idx: newer ? idx : Number(body.progress?.state?.section_idx || 0),
      last_read_at: newer ? op.at : body.progress?.state?.last_read_at
    };
    return { ...body, doc: { ...(body.doc || {}), state }, progress: { state, sections: rows } };
  }
  return body;
}

export function foldBody(body, ops = []) {
  let next = body;
  for (const op of ops) next = applyOpToBody(next, op);
  return next;
}

/** What GET /api/reader/doc/:id answers, built from a stored body; null if that section is not here. */
export function docResponse(body, sectionIdx = null) {
  if (!body?.doc) return null;
  const sections = body.sections || [];
  const state = body.progress?.state || body.doc.state || null;
  const idx = sectionIdx === null || sectionIdx === undefined ? Number(state?.section_idx || 0) : Number(sectionIdx) || 0;
  const row = sections.find((s) => Number(s.idx) === idx) || sections.find((s) => Number(s.idx) === 0) || null;
  if (!row || typeof row.html !== 'string') return null;
  const highlights = (body.highlights || []).filter((h) => !h.deletedAt);
  return {
    doc: { ...body.doc, state },
    section: { idx: row.idx, title: row.title, html: row.html || '', words: row.words, error: row.error || null },
    sections: sections.map((s) => ({ idx: s.idx, href: s.href || '', title: s.title || '', words: s.words || 0 })),
    links: body.links || [],
    highlights,
    notesScope: 'document',
    noteCount: highlights.length,
    progress: body.progress || { state, sections: [] },
    ingest: null,
    local: true
  };
}

/**
 * Fold a GET /api/reader/doc answer into a stored body. A full body (from the sync endpoint)
 * replaces everything; an answer for one section adds that section's HTML and keeps the rest.
 */
export function absorbDocResponse(body, response) {
  if (!response?.doc) return body;
  const prior = body || { id: response.doc.id, sections: [], complete: false };
  const byIdx = new Map((prior.sections || []).map((s) => [Number(s.idx), s]));
  const list = response.sections || (prior.sections || []).map(({ html, ...rest }) => rest);
  const sections = list.map((s) => ({ ...(byIdx.get(Number(s.idx)) || {}), ...s }));
  if (response.section) {
    const idx = Number(response.section.idx);
    const at = sections.findIndex((s) => Number(s.idx) === idx);
    const merged = { ...(at >= 0 ? sections[at] : { idx }), title: response.section.title, words: response.section.words,
      html: response.section.html || '', error: response.section.error || null };
    if (at >= 0) sections[at] = merged; else sections.push(merged);
  }
  // A book's notes may have been sent for one section only; keep the others we already had.
  const highlights = response.notesScope === 'section' && response.section
    ? [...(prior.highlights || []).filter((h) => h.sectionIdx !== response.section.idx), ...(response.highlights || [])]
    : (response.highlights || prior.highlights || []);
  return {
    ...prior,
    id: response.doc.id,
    doc: response.doc,
    sections,
    links: response.links || prior.links || [],
    highlights,
    progress: response.progress || prior.progress,
    complete: Boolean(prior.complete) && sections.every((s) => typeof s.html === 'string')
  };
}

// --- what to keep -------------------------------------------------------------------------------

/** Lower is kept first: starred, then what he is reading this week, then the inbox, then the rest. */
export function priorityOf(row, now = Date.now()) {
  if (row.starred) return 0;
  const since = isoAt(now - OFFLINE_WINDOW_MS);
  if (row.read_at && row.read_at >= since) return 1;
  if (!row.archived && !row.aside && !isWaiting(row, now)) return 2;
  return 3;
}

/**
 * Which bodies to fetch and which to drop, under a byte budget. Members of the offline set are
 * kept in priority order; a document opened on this device outside the set stays while there is
 * room, newest opened first; a document with an op still waiting is never dropped.
 */
export function planSync(manifestDocs, local, { budget = DEFAULT_BUDGET_BYTES, pinned = new Set(), now = Date.now() } = {}) {
  const byId = new Map(manifestDocs.map((d) => [d.id, d]));
  const cost = (id) => {
    const have = local.get(id);
    if (have?.bytes) return have.bytes;
    return Math.round((Number(byId.get(id)?.bytes || 0) + 4096) * 1.15);
  };
  const members = manifestDocs.filter((d) => d.member)
    .sort((a, b) => (priorityOf(a, now) - priorityOf(b, now)) || orderAt(b).localeCompare(orderAt(a)));
  const keep = new Set();
  let used = 0;
  for (const id of pinned) if (byId.has(id) || local.has(id)) { keep.add(id); used += cost(id); }
  for (const doc of members) {
    if (keep.has(doc.id)) continue;
    const c = cost(doc.id);
    if (used + c > budget) continue;
    keep.add(doc.id);
    used += c;
  }
  const opened = [...local.entries()].filter(([id, meta]) => !keep.has(id) && byId.has(id) && meta.openedAt)
    .sort((a, b) => String(b[1].openedAt).localeCompare(String(a[1].openedAt)));
  for (const [id] of opened) {
    const c = cost(id);
    if (used + c > budget) continue;
    keep.add(id);
    used += c;
  }
  const fetch = [...keep].filter((id) => {
    const have = local.get(id);
    const want = byId.get(id);
    return want && (!have || !have.complete || have.version !== want.version);
  });
  const evict = [...local.keys()].filter((id) => !keep.has(id) && !pinned.has(id));
  return { keep, fetch, evict, used };
}

/**
 * The server is not there: no answer at all, a gateway error that is not ours, or an HTML page
 * where JSON belongs (what Cloudflare sends when the origin is gone). A 502 in JSON is the server
 * itself answering, e.g. /api/reader/read saying a site did not answer, and is passed through.
 */
export function serverDown(response) {
  if (!response) return true;
  const status = Number(response.status || 0);
  if (status === 0) return true;
  const type = response.headers?.get?.('content-type') || '';
  if (/application\/json/iu.test(type)) return false;
  if (status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530)) return true;
  // A 4xx page is the server (or the tunnel's auth) answering; a 2xx or 5xx page in place of JSON is not.
  return (status < 400 || status >= 500) && /text\/html/iu.test(type);
}

/** Two pending position reports for the same section become one: furthest point, newest place, summed time. */
export function coalesceProgress(prior, next) {
  const p = prior.payload || {};
  const q = next.payload || {};
  return {
    ...prior,
    at: next.at > prior.at ? next.at : prior.at,
    payload: {
      ...p, ...q,
      ratio: Math.max(Number(p.ratio || 0), Number(q.ratio || 0)),
      percent: Math.max(Number(p.percent || 0), Number(q.percent || 0)),
      scrollTop: next.at >= prior.at ? q.scrollTop : p.scrollTop,
      seconds: Number(p.seconds || 0) + Number(q.seconds || 0)
    }
  };
}
