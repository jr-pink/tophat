// The one sentence every automated event carries into a chat, so no producer has to remember it.
import { owner, ownerPossessive } from '../../owner.mjs';
// the projects-watch, goal-retry and relay events did not, and tophat-projects force-unarchived the Projects chat before
// every event, so info-only events left chats in the sidebar. Now the webchat's inbound path (webchat/src/lib/server/ff.js
// settle) appends this to the wire text of every external event, and the rev6 runner appends it to subagent wakes in a
// chat an automated event started. Producers do not add it themselves; withInboxRule() strips an older copy.

// So not noise like ramp or bullshit, obligations. An unarchived chat is a ping, so only his own obligations may stay;
// tophat's health and vendor noise end archived even when unresolved (fixed by us, or logged).
export const INBOX_RULE = `[Inbox rule] ${owner()} uses the chat sidebar as his inbox, and an event leaves an archived chat archived. `
  + 'An unarchived chat is a ping, and he wants pings only for his own obligations: something he owes or promised (an appointment, '
  + 'a deadline, a reply owed to a person, a payment he must make, a reminder he set, a blocker only he can clear on a task he asked for). '
  + `If this event needs nothing new from ${owner()} (filed, verified false alarm, already-reported blocker), or it is tophat's own health `
  + '(a job, store, poller, disk, RAM, deploy, TophatMic or iMessage problem) or vendor noise (Ramp, receipts, refunds, a declined charge '
  + 'on an agent card we fix ourselves), end the turn with chat_archive, fixed or not; '
  + 'only if it needs him to do or decide something of his own, chat_archive archived=false and chat_rename to say what. '
  + 'A chat this event opened gets a "Who: what" title (chat_rename) before it is archived.';

// text written then still ends with it.
export const PRIOR_INBOX_RULE = `[Inbox rule] ${owner()} uses the chat sidebar as his inbox, and an event leaves an archived chat archived. `
  + `If this event needs nothing new from ${owner()} (filed, verified false alarm, already-reported blocker), end the turn with chat_archive; `
  + 'if it needs him to do or decide something new, chat_archive archived=false and chat_rename to say what. '
  + 'A chat this event opened gets a "Who: what" title (chat_rename) before it is archived.';

// a producer still running old code may send it.
const OLD_RULE = /\n?the owner uses the chat sidebar as his inbox\. Before ending the turn: if this is resolved, or nothing is needed,[^\n]*/gu;

/** The text with exactly one copy of the current rule at its end. */
export function withInboxRule(text) {
  const body = String(text ?? '').replace(OLD_RULE, '').split(INBOX_RULE).join('').split(PRIOR_INBOX_RULE).join('').replace(/\s+$/u, '');
  return `${body}\n\n${INBOX_RULE}`;
}

/** Whether text ends with the inbox rule, current or the one before it, which is how an automated event is told apart. */
export const endsWithInboxRule = (text) => { const t = String(text ?? '').trimEnd(); return t.endsWith(INBOX_RULE) || t.endsWith(PRIOR_INBOX_RULE); };
