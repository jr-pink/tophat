// The sidebar title of a chat an arrival opens. the owner uses the chat list as an inbox. Before
// this, a wake-born chat was titled from the first line of the push plane's text, "1 new arrival
// looks like someone on the owner's side has to act:", so every one read the same. A title is "Who:
// what", the sender or service and the gist of what is needed, e.g. "Vercel: gamutink.com and
// www.gamutink.com misconfigured".
//
// The push plane's interpreter writes one per wake when it can (rev6/push/wake.mjs sends it as
// `title`); this module cleans that, and derives one from the wake text itself when none came (an
// older push, a relay), so the title never falls back to the generic first line.

export const MAX_TITLE = 90;
const MAX_WHAT = 64;

// Verbs that only say the sender said something: "Vercel reports X" reads as "Vercel: X".
const REPORTING = /^(?:reports?|says?|confirms?|notes?|writes?|announces?|states?|notifies|warns?|alerts?)\s+(?:that\s+)?/iu;
const LEADING_VERB = /^([A-Z][\w.'&-]*(?:\s+[A-Z][\w.'&-]*){0,2})\s+(?:asks|reports|says|wants|confirms|needs|sent|posted|requests|invites|cancelled|notes|writes|shared|replied|offers|proposes)\b/u;

function oneLine(text) {
  return String(text ?? '').replace(/\s+/gu, ' ').trim();
}

function clamp(text, max) {
  const t = oneLine(text).replace(/[\s,;:.-]+$/u, '');
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/u, '')}…`;
}

/** A caller-supplied title, made safe for the sidebar; '' when there is nothing usable. */
export function cleanTitle(title) {
  const t = oneLine(title).replace(/^["'`]+|["'`]+$/gu, '');
  return t ? clamp(t, MAX_TITLE) : '';
}

function cleanWho(who) {
  let w = oneLine(who).replace(/(?:\s*\([^)]*\))+\s*$/u, '').replace(/^["']+|["']+$/gu, '').trim();
  if (!w || /^unknown sender$/iu.test(w)) return '';
  // A bare handle (an address, a Matrix id) is not a name a person reads the sidebar by.
  if (/[@:]/u.test(w) && !/\s/u.test(w)) return '';
  w = w.replace(/\.(?:com|io|net|org|co)$/iu, '');
  return clamp(w[0].toUpperCase() + w.slice(1), 30);
}

function firstClause(text) {
  const t = oneLine(text);
  const m = t.match(/^(.*?)(?:;\s|\.\s+(?=[A-Z])|\s[–—]\s|$)/u);
  return (m ? m[1] : t).trim();
}

/** Parse the first arrival of a push wake text into {who, needed, subject, excerpt, count}. */
export function parseWake(text) {
  const body = String(text ?? '');
  const count = (body.match(/^\s*\d+\.\s+Source:/gmu) || []).length;
  const from = body.match(/^\s*From:\s*(.*?),\s+at\s/mu)?.[1] || '';
  const needed = body.match(/^\s*Needed, per push:\s*(.*)$/mu)?.[1] || '';
  const excerpt = body.match(/^\s*Excerpt:\s*"(.*)"\s*$/mu)?.[1] || '';
  const subject = excerpt.match(/Subject:\s*(.*?)\s+From:/u)?.[1] || '';
  const mailFrom = excerpt.match(/From:\s*"?([^"<]+?)"?\s*</u)?.[1] || '';
  const source = body.match(/^\s*\d+\.\s+Source:\s*([^\s,(]+)/mu)?.[1] || '';
  return { count, from, needed: /^unstated$/iu.test(needed.trim()) ? '' : needed, excerpt, subject, mailFrom, source };
}

/**
 * "Who: what" for a push wake text, or '' when the text is not one. Who is the resolved sender,
 * else the mail From name, else a capitalised name the needed-line opens with; what is the first
 * clause of what push said is needed, else the mail subject, else the excerpt.
 */
export function arrivalTitle(text) {
  const w = parseWake(text);
  if (!w.count) return '';
  let what = firstClause(w.needed) || oneLine(w.subject) || firstClause(w.excerpt);
  let who = cleanWho(w.from) || cleanWho(w.mailFrom);
  if (!who) who = cleanWho(what.match(LEADING_VERB)?.[1] || '');
  if (!who) who = { beeper: 'Message', imessage: 'Text' }[w.source] || (/mail/iu.test(w.source) ? 'Email' : 'Arrival');
  // Drop the sender's own name from the start of the gist, and a bare reporting verb after it.
  const names = [who, who.split(/\s+/u)[0]].filter(Boolean);
  for (const name of names) {
    const lead = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:\\.com)?(?:'s)?,?\\s+`, 'iu');
    if (lead.test(what)) { what = what.replace(lead, ''); break; }
  }
  what = what.replace(REPORTING, '');
  what = clamp(what, MAX_WHAT);
  if (!what) return '';
  if (!/^\S*\./u.test(what)) what = what[0].toUpperCase() + what.slice(1);
  const more = w.count > 1 ? ` (+${w.count - 1} more)` : '';
  return clamp(`${who}: ${what}`, MAX_TITLE - more.length) + more;
}
