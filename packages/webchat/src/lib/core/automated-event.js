// the owner reads the chat as an inbox, so the transcript shows one muted line and the block opens on a click. The
// stored text and what the model sees are untouched; this only classifies and summarises text already on the client.
//
// Producers (grep "\[Automated" and "Relayed by Tophat" in rev5/, rev6/push/, workspace/watchers/):
//   [Automated event from the push plane; ...]          rev6/push/wake.mjs (arrivals, resolutions)
//   [Automated event from the goal retry timer, ...]    rev5/waits.mjs
//   [Automated event from <watcher> (...), ...]         order-watch, tophat-findmy, cart-checkout, ...
//   [Automated event from chat handoff (<sender title>); ...]  src/routes/api/agent/+server.js op handoff (chat_handoff)
//   [Automated notice from another tophat agent (...)]   rev6/push/tasks.mjs fixtures
//   [Relayed by Tophat from <name>, <time>] ...          relayed human text, not automated: left alone.
import { arrivalTitle } from './arrival-title.js';

export const SUMMARY_MAX = 90;

// The transcript a runtime missed (remote-runtime.js withSeed) goes in front of his message on the wire only.
const SEED_OPEN = /^\s*\[Earlier in this chat, which ran ([^\]]*?)\. Background only; the owner's new message follows the marker\.\]\n?/u;
export const SEED_CLOSE = '[End of earlier transcript.]';
export const seedMarker = (where) => `[Earlier in this chat, which ran ${where}. Background only; the owner's new message follows the marker.]`;

/** {where, seed, message} for a seeded owner message (nested seeds peeled to his last words), else null. Never throws. */
export function seededMessage(text) {
  const raw = String(text ?? '');
  const m = raw.match(SEED_OPEN);
  if (!m) return null;
  const end = raw.lastIndexOf(SEED_CLOSE);
  if (end < 0) return null;
  return { where: m[1], seed: raw.slice(m[0].length, raw.indexOf(SEED_CLOSE, m[0].length)).trim(), message: raw.slice(end + SEED_CLOSE.length).trim() };
}

/** A stored owner message without any seed wrapper. */
export function unseeded(text) {
  const s = seededMessage(text);
  return s ? s.message : String(text ?? '').trim();
}

const LABEL = /^\s*\[\s*Automated\s+(event|notice)\b([^\]]*)\]?/iu;
const FROM = /^\s*from\s+(?:the\s+)?(.*?)\s*(?:\(([^)]*)\))?\s*(?:[;,.]|$)/iu;

function oneLine(text) { return String(text ?? '').replace(/\s+/gu, ' ').trim(); }

function clamp(text, max) {
  const t = oneLine(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/u, '')}…`;
}

function sourceName(rest) {
  const m = String(rest).match(FROM);
  let who = oneLine(m?.[1] || '');
  if (!who) return 'System';
  if (/^push plane$/iu.test(who)) return 'Push';
  if (/^goal retry timer$/iu.test(who)) return 'Goal retry';
  if (/^a background turn$/iu.test(who)) return 'Background turn';
  if (/^another tophat agent$/iu.test(who)) return 'Agent';
  if (/^chat handoff$/iu.test(who)) return 'Chat handoff';
  who = who.replace(/[\s,;]+not a message from.*$/iu, '');
  return who[0].toUpperCase() + who.slice(1);
}

/** The text of a background turn's report, as the transcript shows it: an automated event, so it is the muted collapsed bubble on
 * the left, the result inside. Only a finished turn gets one; nothing is drawn while it runs. The first body line is the summary
 * the closed bubble shows.
 */
export function backgroundEventText({ gist = '', state = 'done', result = '' } = {}) {
  const what = oneLine(gist) || 'earlier turn';
  return `[Automated event from a background turn; this is not a message from the owner.]\n${clamp(what, 70)} (${state})\n${String(result ?? '').trim()}`.trimEnd();
}

/** True for a turn an automated sender wrote, not the owner. */
export function isAutomatedEvent(text) {
  return LABEL.test(String(text ?? ''));
}

/** {source, summary, label} for an automated-event text, else null. Never throws. */
export function automatedEvent(text) {
  const raw = String(text ?? '');
  const m = raw.match(LABEL);
  if (!m) return null;
  const source = sourceName(String(m[2]));
  // The label may sit on its own line or run into the body ("...the owner.] Izzy asks about ACH").
  const body = raw.slice(m[0].length).replace(/^\s*[,.;:-]?\s*/u, '');
  const lines = body.split('\n').map(oneLine).filter(Boolean);
  let summary = '';
  try {
    if (source === 'Push') {
      summary = arrivalTitle(raw);
      if (!summary && /settled outside the chat/iu.test(body)) {
        const arrival = body.match(/^\s*\d+\.\s+Arrival:\s*[^"\n]*?"(.*?)"/mu)?.[1] || '';
        summary = `Settled outside the chat${arrival ? `: ${arrival}` : ''}`;
      }
    } else if (source === 'Chat handoff') {
      // The sending chat's title sits in the label's parentheses: "Sender title: first line of the handoff".
      const sender = oneLine(String(m[2]).match(FROM)?.[2] || '');
      summary = sender ? `${sender}: ${lines[0] || ''}`.replace(/:\s*$/u, '') : '';
    } else if (source === 'Goal retry') {
      const goal = body.match(/retry for goal\s+(\S+?):\s*(.*)$/mu);
      summary = goal ? goal[2] || `goal ${goal[1]}` : '';
    }
  } catch { summary = ''; }
  if (!summary) summary = lines[0] || '';
  summary = clamp(summary, SUMMARY_MAX);
  return { source, summary, label: summary ? `Automated event: ${source}: ${summary}` : `Automated event: ${source}` };
}
