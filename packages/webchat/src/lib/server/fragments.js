// Streaming fragments are not data; what they say is.
//
// assistant.delta, thinking.delta and tool.input_delta arrive by the hundred per second and exist only
// in flight (memory and the live tail). The log holds committed turns. Fragment text that has no
// committed form of its own would be lost if dropped, so what each kind becomes is:
//   * thinking: nothing settles it (there is no thinking.message event), so every finished block is
//     committed once as a coalesced `thinking.delta` carrying the whole joined text;
//   * tool input: committed once, joined, when the call has its input or completes (the card header
//     reads the raw text, core/toolsummary.js, and renders differently from the parsed input alone);
//   * assistant text: an assistant.message whose text starts with the joined fragments holds all of it,
//     so the block keeps only its first fragment (a small committed event: the reducer places a
//     streamed row at that fragment's cursor and time, and history must keep that); text that no
//     message settled (a run cut off mid-sentence) is committed joined.
// The settle test for assistant text is the one scripts/purge-stream-deltas.py applies to stored rows,
// so a live write and the treatment of history agree on what is redundant.
// A coalesced event keeps the kind, content shape, run id and timestamp of the block's FIRST fragment
// and takes that fragment's cursor: core/reducer.js places a streamed row at the earliest cursor it saw
// and joins chunks by cursor, so one event with the joined text renders exactly what the fragments did
// (the same argument runner.js makes for its tool.input_delta coalescing, which this subsumes).
//
// This class decides when a block commits; it appends nothing itself. `commit(convId, event)` is told
// to write one coalesced event. It never throws into the caller: a failing commit is reported through
// `onError` and the block stays held so the next trigger retries it.

export const FRAGMENT_KINDS = new Set(['assistant.delta', 'thinking.delta', 'tool.input_delta']);
export const TERMINAL_KINDS = new Set(['run.completed', 'run.error', 'run.cancelled']);

export const THINKING_FLUSH_MS = Number(process.env.WEBCHAT_THINKING_FLUSH_MS || 5_000);
export const CHUNK_BYTES = 64 * 1024;
export const MAX_BLOCK_BYTES = 1024 * 1024;

const keyOf = (content) => `${content?.agentId || ''}\u0000${content?.itemId || ''}`;

const emptyInput = (input) => input == null || input === '' || (Array.isArray(input) && !input.length)
  || (typeof input === 'object' && !Array.isArray(input) && !Object.keys(input).length);

export class FragmentCommitter {
  constructor({ commit, onError = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, thinkingFlushMs = THINKING_FLUSH_MS,
    chunkBytes = CHUNK_BYTES, maxBlockBytes = MAX_BLOCK_BYTES } = {}) {
    this.commit = commit;
    this.onError = onError;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.thinkingFlushMs = thinkingFlushMs;
    this.chunkBytes = chunkBytes;
    this.maxBlockBytes = maxBlockBytes;
    this.byConv = new Map();     // conversation id -> Map(kind + key -> block)
  }

  blocksOf(convId) { return this.byConv.get(convId) || new Map(); }

  /** Blocks of a conversation that are open (uncommitted, unsettled): what a cold read still shows live. */
  open(convId) { return [...this.blocksOf(convId).values()]; }

  /** A fragment arrived (it has already been given its cursor). Returns the block it belongs to. */
  fragment(convId, event) {
    let blocks = this.byConv.get(convId);
    if (!blocks) { blocks = new Map(); this.byConv.set(convId, blocks); }
    const content = event.content || {};
    const key = `${event.kind}\u0000${keyOf(content)}`;
    if (event.kind !== 'thinking.delta') this.commitKind(convId, 'thinking.delta');
    else this.commitOtherThinking(convId, key);
    let block = blocks.get(key);
    const piece = String(event.kind === 'tool.input_delta' ? content.partial ?? '' : content.text ?? '');
    if (!block) {
      block = { kind: event.kind, key, agentId: content.agentId ?? null, itemId: content.itemId, tool: content.tool, runId: event.run_id ?? null,
        firstCursor: event.cursor, firstAt: event.at, parts: [], bytes: 0, timer: null, token: { committed: false, first: event.cursor } };
      blocks.set(key, block);
    }
    block.parts.push(piece);
    block.bytes += piece.length;
    block.last = event.cursor;
    if (event.kind === 'thinking.delta') {
      if (block.bytes >= this.chunkBytes) this.commitBlock(convId, block);
      else if (!block.timer) {
        block.timer = this.setTimer(() => { block.timer = null; if (this.blocksOf(convId).get(key) === block) this.commitBlock(convId, block); }, this.thinkingFlushMs);
        block.timer?.unref?.();
      }
    } else if (block.bytes >= this.maxBlockBytes) this.commitBlock(convId, block);
    return block;
  }

  /** A committed event is about to be appended to the conversation: settle or commit what it ends. */
  committed(convId, event) {
    const blocks = this.byConv.get(convId);
    if (!blocks || !blocks.size) return;
    this.commitKind(convId, 'thinking.delta');
    const content = event.content || {};
    const key = keyOf(content);
    if (event.kind === 'assistant.message') {
      const block = blocks.get(`assistant.delta\u0000${key}`);
      if (block) {
        const joined = block.parts.join('');
        const text = typeof content.text === 'string' ? content.text : '';
        // Settled: the message holds the text. The block's first fragment is kept (a few bytes) because the
        // reducer places a streamed row at that fragment's cursor and time, and history must keep that.
        if (text.trim() && text.startsWith(joined)) this.commitBlock(convId, block, { head: true });
        else this.commitBlock(convId, block);
      }
    } else if (event.kind === 'tool.started' || event.kind === 'tool.completed') {
      // A tool call's streamed input is kept, joined, once its call has its input or has completed: the card's
      // header reads the raw text (core/toolsummary.js) and renders differently from the parsed input alone.
      // It costs the joined text once per call (about 90 MB across the whole history), not a row per fragment.
      const block = blocks.get(`tool.input_delta\u0000${key}`);
      if (block && (event.kind === 'tool.completed' || !emptyInput(content.input))) this.commitBlock(convId, block);
    } else if (TERMINAL_KINDS.has(event.kind)) {
      for (const block of [...blocks.values()]) this.commitBlock(convId, block);
    }
  }

  commitKind(convId, kind) {
    const blocks = this.byConv.get(convId);
    if (!blocks) return;
    for (const block of [...blocks.values()]) if (block.kind === kind) this.commitBlock(convId, block);
  }

  commitOtherThinking(convId, key) {
    const blocks = this.byConv.get(convId);
    if (!blocks) return;
    for (const block of [...blocks.values()]) if (block.kind === 'thinking.delta' && block.key !== key) this.commitBlock(convId, block);
  }

  drop(convId, block) {
    block.token.closed = true;
    if (block.timer) { this.clearTimer(block.timer); block.timer = null; }
    const blocks = this.byConv.get(convId);
    blocks?.delete(block.key);
  }

  /**
   * Write the block's joined text as one event and close the block. A long block commits in chunks:
   * the next fragment opens a fresh block whose first cursor starts the next chunk.
   */
  commitBlock(convId, block, { head = false } = {}) {
    if (block.timer) { this.clearTimer(block.timer); block.timer = null; }
    if (!block.parts.length) { this.drop(convId, block); return; }
    const joined = head ? block.parts[0] : block.parts.join('');
    const content = block.kind === 'tool.input_delta'
      ? { itemId: block.itemId, tool: block.tool, partial: joined, agentId: block.agentId }
      : { itemId: block.itemId, text: joined, agentId: block.agentId };
    try {
      this.commit(convId, { kind: block.kind, content, runId: block.runId, at: block.firstAt, cursor: block.firstCursor, last: block.last, token: block.token });
    } catch (error) {
      this.onError(error, convId, block);
      return;                 // held: the next trigger retries
    }
    block.token.committed = true;
    this.drop(convId, block);
  }

  /** Commit everything held (shutdown, a test's flush). */
  flushAll() {
    for (const [convId, blocks] of [...this.byConv]) for (const block of [...blocks.values()]) this.commitBlock(convId, block);
  }

  /** Forget a conversation's blocks without committing (the conversation was deleted). */
  forget(convId) {
    for (const block of this.blocksOf(convId).values()) if (block.timer) this.clearTimer(block.timer);
    this.byConv.delete(convId);
  }
}
