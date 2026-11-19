// The rendered card of an automated event (the owner, 2026-11-18 14:51 PST: "make the automated events have a rendered
// thing ... render the chat and highlight which items were in the event . and which are included as just context. or for mail,
// it should render the mail threads"). The push plane sends the structured payload beside the text (`cards` on POST
// /api/inbound; rev6/push/cards.mjs documents the schema); the server stores it on the user turn next to the text, and
// Message.svelte draws it above the collapsed event line. The text the model reads is never changed by any of this.
//
// acceptCards() is the one place a payload is trusted: it drops what is not a card, caps sizes, and keeps image urls to the
// authed /api/file route only. The rest are pure helpers the card renders with.

const MAX_CARDS = 8, MAX_MESSAGES = 30, MAX_TEXT = 8000, MAX_BYTES = 400_000;
const str = (v, n = 400) => (typeof v === 'string' ? v.slice(0, n) : '');
const STATES = new Set(['read', 'delivered', 'sent', 'failed']);
const KINDS = new Set(['image', 'video', 'audio', 'file']);
const isoOk = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : '');

function attachment(a) {
  if (!a || typeof a !== 'object') return null;
  const url = typeof a.url === 'string' && /^\/api\/file\?path=/u.test(a.url) ? a.url.slice(0, 600) : '';
  const out = { name: str(a.name, 200) || 'attachment', kind: KINDS.has(a.kind) ? a.kind : 'file' };
  if (str(a.mime, 100)) out.mime = str(a.mime, 100);
  if (Number.isFinite(a.size)) out.size = a.size;
  if (url) out.url = url;
  if (Number.isFinite(a.width) && Number.isFinite(a.height)) { out.width = a.width; out.height = a.height; }
  return out;
}

function message(kind, m) {
  if (!m || typeof m !== 'object') return null;
  const out = { id: str(m.id, 200), at: isoOk(m.at), in_event: m.in_event === true, text: str(m.text, MAX_TEXT) };
  if (m.system === true) out.system = true;
  if (m.edited === true) out.edited = true;
  if (m.recalled === true) out.recalled = true;
  if (m.self === true) out.self = true;
  out.from = str(m.from, 200);
  if (kind === 'mail') {
    for (const k of ['to', 'cc', 'subject']) if (str(m[k], 1000)) out[k] = str(m[k], 1000);
  } else {
    if (m.status && STATES.has(m.status.state)) {
      out.status = { state: m.status.state };
      for (const k of ['delivered_at', 'read_at']) if (isoOk(m.status[k])) out.status[k] = m.status[k];
      if (Number.isFinite(m.status.read_by)) out.status.read_by = m.status.read_by;
    }
    if (Array.isArray(m.reactions)) {
      const r = m.reactions.filter((x) => x && typeof x.emoji === 'string' && x.emoji).slice(0, 24).map((x) => ({ emoji: str(x.emoji, 16), from: str(x.from, 80), self: x.self === true }));
      if (r.length) out.reactions = r;
    }
    if (m.reply_to && typeof m.reply_to === 'object') out.reply_to = { from: str(m.reply_to.from, 80), text: str(m.reply_to.text, 200) };
  }
  if (Array.isArray(m.attachments)) {
    const a = m.attachments.slice(0, 12).map(attachment).filter(Boolean);
    if (a.length) out.attachments = a;
  }
  return out;
}

/** The sanitized cards of a stored or posted payload; [] for anything that is not one. Never throws. */
export function acceptCards(raw) {
  try {
    if (!Array.isArray(raw)) return [];
    const cards = [];
    for (const c of raw.slice(0, MAX_CARDS)) {
      if (!c || typeof c !== 'object' || !['chat', 'mail'].includes(c.kind) || !Array.isArray(c.messages)) continue;
      const messages = c.messages.slice(-MAX_MESSAGES).map((m) => message(c.kind, m)).filter(Boolean);
      if (!messages.length) continue;
      const card = { v: 1, kind: c.kind, source: str(c.source, 60), messages };
      for (const k of ['thread', 'title', 'account', 'subject']) if (str(c[k], 300)) card[k] = str(c[k], 300);
      if (c.group === true) card.group = true;
      cards.push(card);
    }
    return JSON.stringify(cards).length > MAX_BYTES ? cards.map((c) => ({ ...c, messages: c.messages.slice(-8) })) : cards;
  } catch { return []; }
}

// ---- helpers the card draws with ---------------------------------------------------------------------------------------
const day = (iso, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

/** "2:09 PM" in the viewer's zone (tz undefined) or the named one. */
export function clock(iso, tz) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(t)) : '';
}

/** The separator above a run of messages from one day: "Today", "Yesterday", "Wed, Nov 18". `now` is injectable. */
export function dayLabel(iso, now = Date.now(), tz) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  if (day(iso, tz) === day(new Date(now).toISOString(), tz)) return 'Today';
  if (day(iso, tz) === day(new Date(now - 86400e3).toISOString(), tz)) return 'Yesterday';
  const year = day(iso, tz).slice(0, 4) === day(new Date(now).toISOString(), tz).slice(0, 4);
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', ...(year ? {} : { year: 'numeric' }) }).format(new Date(t));
}

export const dayKey = (iso, tz) => (Number.isFinite(Date.parse(iso)) ? day(iso, tz) : '');

/** Messages with a separator row before the first one of each day, so the card reads like the app's own thread. */
export function withDays(messages, tz) {
  const out = [];
  let last = '';
  for (const m of messages) {
    const k = dayKey(m.at, tz);
    if (k && k !== last) { out.push({ divider: true, at: m.at, key: `d:${k}` }); last = k; }
    out.push(m);
  }
  return out;
}

/** The small line under one of the owner's own bubbles: "Read 2:41 PM", "Delivered", "Sent", "Not delivered". */
export function statusLabel(status, { time = true, tz } = {}) {
  if (!status) return '';
  if (status.state === 'failed') return 'Not delivered';
  if (status.state === 'read') return `Read${status.read_by > 1 ? ` by ${status.read_by}` : ''}${time && status.read_at ? ` ${clock(status.read_at, tz)}` : ''}`;
  if (status.state === 'delivered') return 'Delivered';
  return status.state === 'sent' ? 'Sent' : '';
}

export function sizeLabel(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1e6) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
}

/** A name for a sender: a phone number that an identity labelled "Contact +1..." reads as the number; "Name <addr>" as Name. */
export function shortName(from) {
  const s = String(from ?? '').trim().replace(/^Contact\s+(?=\+?\d)/u, '');
  const named = s.match(/^"?([^"<]+?)"?\s*<[^>]+>$/u);
  return (named ? named[1] : s.replace(/^<|>$/gu, '')) || 'Unknown';
}

export const initials = (name) => {
  const w = shortName(name).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/u).filter(Boolean);
  return ((w[0]?.[0] || '?') + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase();
};

/** What the header of a chat card names: the thread's title, else its non-owner senders. */
export function cardTitle(card) {
  if (card.title) return card.title;
  const names = [...new Set(card.messages.filter((m) => !m.self && !m.system).map((m) => shortName(m.from)))];
  return names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '');
}

/** The system-line wording: a "[system] " tag the intake adds is dropped. */
export const systemText = (m) => (m.recalled && !m.text ? `${shortName(m.from)} unsent a message` : String(m.text || '').replace(/^\[system(?: message)?\]\s*/iu, '').trim() || 'System message');

/** A mail body without its quoted tail ("On ... wrote:" and "> " lines); `trimmed` says whether anything was cut. */
export function stripQuoted(text) {
  const lines = String(text ?? '').split('\n');
  const cut = lines.findIndex((l, i) => /^\s*On .{6,200}wrote:\s*$/u.test(l) || (/^\s*On .{6,160}$/u.test(l) && /wrote:\s*$/u.test(lines[i + 1] || '')) || /^\s*-{2,}\s*(?:Original Message|Forwarded message)/iu.test(l) || /^\s*>/u.test(l));
  const kept = (cut >= 0 ? lines.slice(0, cut) : lines).join('\n').trim();
  return { text: kept || String(text ?? '').trim(), trimmed: cut >= 0 && Boolean(kept) };
}
