

export function tokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean);
}

export function idfFrom(texts) {
  const documents = [...texts];
  const seen = new Map();
  for (const text of documents) {
    for (const word of new Set(tokens(text))) seen.set(word, (seen.get(word) || 0) + 1);
  }
  const total = Math.max(1, documents.length);
  const weights = new Map();
  for (const [word, count] of seen) weights.set(word, Math.log(1 + total / count));
  return weights;
}

const WEIGHT_OF_AN_UNSEEN_WORD = Math.log(2);

export function similarity(a, b, idf = null) {
  const left = new Set(tokens(a));
  const right = new Set(tokens(b));
  if (!left.size && !right.size) return 1;
  if (!left.size || !right.size) return 0;
  const weight = (word) => (idf ? (idf.get(word) ?? WEIGHT_OF_AN_UNSEEN_WORD) : 1);
  let shared = 0;
  let union = 0;
  for (const word of left) union += weight(word);
  for (const word of right) {
    if (left.has(word)) shared += weight(word);
    else union += weight(word);
  }
  return shared / union;
}

export function blockId(key) {
  let hash = 0x811c9dc5;
  for (const char of String(key)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let second = 0x9e3779b9;
  for (const char of String(key)) {
    second = Math.imul(second ^ char.charCodeAt(0), 0x85ebca6b) >>> 0;
  }
  return `${hash.toString(36)}${second.toString(36)}`;
}

export const MATCH_FLOOR = 0.25;

export const MATCH_CERTAIN = 0.5;

export const MATCH_MARGIN = 2;

export function reconcileBlocks(previous = {}, rows = [], { now = null, keep = null, keepRetiredFor = 7 * 86_400_000 } = {}) {
  const prior = Object.entries(previous).map(([id, block]) => ({ id, ...block }));
  
  
  const idf = idfFrom([...rows.map((row) => row.text ?? row.key), ...prior.map((block) => block.text ?? block.key)]);
  const claimed = new Set();
  const ids = {};
  const blocks = {};

  const claim = (row, block, { changed }) => {
    claimed.add(block.id);
    ids[row.key] = block.id;
    blocks[block.id] = {
      key: row.key,
      text: row.text ?? row.key,
      section: row.section ?? null,
      firstSeen: block.firstSeen ?? now,
      updatedAt: changed ? now : (block.updatedAt ?? now),
      retired: false
    };
  };

  const unmatched = [];
  for (const row of rows) {
    const exact = prior.find((block) => !claimed.has(block.id) && block.key === row.key);
    if (exact) claim(row, exact, { changed: false });
    else unmatched.push(row);
  }

  
  
  
  
  
  
  const pairs = [];
  for (const row of unmatched) {
    const scored = [];
    for (const block of prior) {
      if (claimed.has(block.id)) continue;
      if ((row.section ?? null) !== (block.section ?? null)) continue;
      scored.push({ row, block, score: similarity(row.text ?? row.key, block.text ?? block.key, idf) });
    }
    scored.sort((a, b) => b.score - a.score);
    const runnerUp = scored[1]?.score ?? 0;
    for (const candidate of scored) {
      if (candidate.score < MATCH_FLOOR) break;
      if (candidate.score >= MATCH_CERTAIN) { pairs.push(candidate); continue; }
      if (runnerUp === 0 || candidate.score >= runnerUp * MATCH_MARGIN) pairs.push(candidate);
    }
  }
  pairs.sort((a, b) => b.score - a.score || String(a.row.key).localeCompare(String(b.row.key)));
  const taken = new Set();
  for (const pair of pairs) {
    if (claimed.has(pair.block.id) || taken.has(pair.row.key)) continue;
    taken.add(pair.row.key);
    claim(pair.row, pair.block, { changed: true });
  }

  for (const row of unmatched) {
    if (taken.has(row.key)) continue;
    
    
    
    let id = blockId(row.key);
    for (let n = 2; blocks[id] || claimed.has(id); n += 1) id = `${blockId(row.key)}-${n}`;
    claimed.add(id);
    ids[row.key] = id;
    blocks[id] = { key: row.key, text: row.text ?? row.key, section: row.section ?? null, firstSeen: now, updatedAt: now, retired: false };
  }

  const cutoff = now ? Date.parse(now) - keepRetiredFor : null;
  for (const block of prior) {
    if (claimed.has(block.id)) continue;
    const retiredAt = block.retiredAt ?? now;
    const wanted = keep?.has?.(block.id)
      || !cutoff
      || !Number.isFinite(Date.parse(retiredAt))
      || Date.parse(retiredAt) >= cutoff;
    if (!wanted) continue;
    blocks[block.id] = { ...block, retiredAt, retired: true };
    delete blocks[block.id].id;
  }

  return { ids, blocks };
}

export function draftKeyFor(block) {
  return `brief:${block}`;
}

export function straysFor({ rowIds = [], conversationIds = [], draftKeys = [], date = '' } = {}) {
  const onBrief = new Set(rowIds);
  const prefix = `brief-${date}-`;
  const found = new Map();
  for (const id of conversationIds) {
    if (!id.startsWith(prefix)) continue;
    const block = id.slice(prefix.length);
    if (onBrief.has(block)) continue;
    found.set(block, { block, thread: true, draft: false });
  }
  for (const key of draftKeys) {
    if (!key.startsWith('brief:')) continue;
    const block = key.slice('brief:'.length);
    if (onBrief.has(block)) continue;
    const prior = found.get(block);
    if (prior) prior.draft = true;
    else found.set(block, { block, thread: false, draft: true });
  }
  return [...found.values()];
}
