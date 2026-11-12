// Carrying a chat on in codex when the claude provider stops at the account's usage limit.
//
// translate.js marks the run.error of a turn the claude CLI ended on the limit `limit`. With WEBCHAT_CLAUDE_FALLBACK=codex
// the chat then moves to codex the way a switch in the header moves it (settings, conversation.meta, runner.applySettings,
// and the transcript the runner carries across a provider change), and the owner's unanswered message is asked again
// there as a recovery, which writes no message.user. Off by default: it sends the conversation to another organisation's model.
//
// Only a claude child of this process moves (a peer's chat is the peer's), never an incognito chat (incognito.js keeps
// those on the direct provider because the codex CLI keeps session files on disk), and only when codex is installed and
// signed in. A turn moves once: the fallback note ends it and the recovery writes nothing of the owner's, so a limit after
// it finds nothing left to ask. The chat stays on codex, as after any switch; the owner switches it back.
import { execFile } from 'node:child_process';
import { newId } from '../core/contract.js';
import { isIncognito } from '../core/incognito.js';
import { DEFAULT_MODEL } from '../core/providers.js';

export const CLAUDE_FALLBACK = process.env.WEBCHAT_CLAUDE_FALLBACK === 'codex';

const CODEX_BIN = process.env.WEBCHAT_CODEX_BIN || 'codex';
const ENDINGS = new Set(['run.completed', 'run.error', 'run.cancelled']);
const PAGE = 2000;
const WORK_LINES = 40;

/** Whether codex is installed and signed in here: `codex login status` exits 0 for a ChatGPT sign-in or an API key. */
export function codexSignedIn(bin = CODEX_BIN) {
  return new Promise((resolve) => {
    execFile(bin, ['login', 'status'], { timeout: 10_000 }, (error) => resolve(!error));
  });
}

const isFallback = (event) => event.kind === 'run.status' && Boolean(event.content?.fallback);

/** The cursor the turn ending at `cursor` started after: the last run ending (or fallback note) before it, else 0. */
function turnStart(store, id, cursor) {
  for (let before = cursor; ;) {
    const page = store.conversationEvents(id, { before, newest: true, limit: PAGE });
    const ending = page.findLast((event) => ENDINGS.has(event.kind) || isFallback(event));
    if (ending) return ending.cursor;
    if (page.length < PAGE) return 0;
    before = page[0].cursor;
  }
}

/** The tool calls claude made in the turn, one line each, so codex can check them instead of repeating them. */
function workOf(events) {
  const calls = new Map();
  for (const { kind, content = {} } of events) {
    if (content.agentId || (kind !== 'tool.started' && kind !== 'tool.completed')) continue;
    const call = calls.get(content.itemId) || { tool: content.tool, input: null, state: 'no result' };
    if (kind === 'tool.started') call.input = content.input ?? call.input;
    else call.state = content.isError ? 'failed' : 'done';
    calls.set(content.itemId, call);
  }
  return [...calls.values()].slice(-WORK_LINES)
    .map(({ tool, input, state }) => `${tool} ${JSON.stringify(input).slice(0, 300)} (${state})`);
}

/** What codex is asked in place of the message claude never answered. */
function fallbackText({ model, asked, work }) {
  return [
    `Claude stopped at its usage limit before it answered, so this chat has moved to you (${model}).`
      + ' Nothing new has been asked of you: answer the owner\'s message below.'
      + (work.length ? ' Claude had started on it; the tool calls it made follow the message, so check what they did before doing any of it again.' : ''),
    '',
    ...asked,
    ...(work.length ? ['', '<claude-tool-calls>', ...work, '</claude-tool-calls>'] : [])
  ].join('\n');
}

export function installClaudeFallback({ store, runner, enabled = CLAUDE_FALLBACK, model = DEFAULT_MODEL.codex,
  codexReady = codexSignedIn, now = () => new Date().toISOString() } = {}) {
  if (!enabled) return () => {};
  const moving = new Set();
  const onClaude = (id) => store.conversation(id)?.settings?.provider === 'claude';

  function move(id, failed) {
    // Switched by hand while codex was asked.
    if (!onClaude(id)) return;
    const turn = store.conversationEvents(id, { after: turnStart(store, id, failed.cursor) });
    // The owner stopped it, or something answered after all.
    if (turn.some((event) => event.cursor > failed.cursor
      && (event.kind === 'run.completed' || event.kind === 'run.cancelled' || (event.kind === 'run.error' && !event.content?.limit)))) return;
    const asked = turn.filter((event) => event.kind === 'message.user' && event.content?.text).map((event) => event.content.text);
    if (!asked.length) return;
    const errors = turn.filter((event) => event.kind === 'run.error' && event.content?.limit).map((event) => ({ id: event.event_id, cursor: event.cursor }));
    const before = store.conversation(id).settings;
    const settings = store.setSettings(id, { provider: 'codex', model });
    const at = now();
    store.append(id, 'conversation.meta', { settings }, { at });
    // A provider change retires the claude child. A turn it began at the result boundary (a message sent meanwhile)
    // meets the same limit, so it is stopped rather than waited for; its message is among those asked again.
    if (runner.applySettings(id, before, settings) === 'deferred') runner.stop(id);
    store.append(id, 'run.status', {
      state: 'starting',
      note: `Claude is at its usage limit, so this chat moved to Codex (${model}).`,
      fallback: { from: 'claude', to: 'codex', model, errors }
    }, { at });
    runner.send(id, fallbackText({ model, asked, work: workOf(turn) }), { itemId: newId(), recovery: true });
  }

  return store.subscribe((event) => {
    const id = event.conversation_id;
    if (event.kind !== 'run.error' || !event.content?.limit || moving.has(id) || isIncognito(id)) return;
    if (!onClaude(id) || runner.live.get(id)?.provider?.id !== 'claude') return;
    moving.add(id);
    // Store subscribers run inside runner.handle, before the result's turn_completed reaches the session machine;
    // nothing moves until the turn has ended.
    Promise.resolve().then(() => codexReady()).then((ready) => {
      if (ready) move(id, event);
      else console.error(`[webchat] ${id} is at the claude usage limit; codex is not signed in here, so it stays on claude`);
    }).catch((cause) => {
      console.error(`[webchat] could not move ${id} to codex: ${cause.message}`);
      try { store.append(id, 'run.error', { message: `This chat could not move to Codex: ${cause.message}` }, { at: now() }); } catch {  }
    }).finally(() => moving.delete(id));
  });
}
