// The notes HTTP surface, written once and served twice: /api/notes over his own notes store, and
// /api/docs/<token> over one public document's store (src/lib/server/docs.js). Both are the same
// lines model in the same store code (notes-store.js); what differs is passed in.
//
// `store()` names the store this request may touch, and nothing else is reachable from here: this
// module imports no store of its own. `hooks` carries what only his notes have (the task CLI drain,
// the reply scan, the owner task observer); a document passes none, so a public request can never
// start the task CLI or read the replies. `zoneOps: false` refuses the operations that only mean
// something on his chronological notes (archive to the past, promote, rollover) and keeps writes
// out of the state zone.
import { json } from '@sveltejs/kit';

// Opening the app is a paint, not a sync. `view=present` answers from sqlite alone: the window
// around the present, one page of the past above it and one page of the future below it, with the
// cursors to page further in either direction. Nothing here spawns the task CLI or scans the
// reply drop, because those cost hundreds of milliseconds each and the page must not wait for
// them to show him his writing. `view=sync` is the other half: the slow reconciliation the page
// asks for once it is on screen.
const PRESENT = { timeline: 200, past: 120, future: 120 };
const size = (url, key, fallback) => {
  const raw = Number(url.searchParams.get(key));
  return Number.isFinite(raw) && raw > 0 ? Math.min(2000, Math.floor(raw)) : fallback;
};
const cursorOf = (blocks, edge) => {
  const block = edge === 'first' ? blocks[0] : blocks.at(-1);
  if (!block) return null;
  const line = edge === 'first' ? block.lines?.[0] : block.lines?.at(-1);
  return (line?.ord ?? block.ord) ?? null;
};

const NO_HOOKS = {
  quiet() {},
  observe() {},
  afterWrite() {},
  async taskSync() { return null; },
  refreshTasks() {},
  replies() { return { available: false }; },
  decorate: (blocks) => blocks
};

/**
 * @param {{ store: (event: any) => any, hooks?: Partial<typeof NO_HOOKS>, zoneOps?: boolean,
 *   onWrite?: (event: any, answer: any) => void, guard?: (event: any, body: any) => Response | null }} options
 */
export function notesRoutes({ store: storeOf, hooks = {}, zoneOps = true, onWrite = () => {}, guard = () => null }) {
  const h = { ...NO_HOOKS, ...hooks };
  const out = (store, blocks) => h.decorate(store.withDocs(blocks), store);

  function presentView(store, url) {
    if (zoneOps && url.searchParams.get('rollover') === '1') store.rollover();
    const timeline = store.page('timeline', { limit: size(url, 'limit', PRESENT.timeline) });
    const past = store.page('past', { limit: size(url, 'past', PRESENT.past) });
    const future = store.page('future', { limit: size(url, 'future', PRESENT.future), fromStart: true });
    const pastBefore = cursorOf(past, 'first');
    const futureAfter = cursorOf(future, 'last');
    return json({
      view: 'present',
      blocks: out(store, timeline),
      past: out(store, past),
      future: out(store, future),
      state: out(store, store.state()),
      earlier: store.lineCount('past', pastBefore === null ? {} : { before: pastBefore }),
      later: futureAfter === null ? 0 : store.lineCount('future', { after: futureAfter }),
      cursors: { pastBefore, futureAfter }
    });
  }

  /** A page of one zone, for the backfill: the past above what is loaded, the future below it. */
  function zonePage(store, url, zone) {
    const before = url.searchParams.get('before');
    const after = url.searchParams.get('after');
    const blocks = store.page(zone, {
      limit: size(url, 'limit', 200),
      before: before === null || before === '' ? null : Number(before),
      after: after === null || after === '' ? null : Number(after)
    });
    const first = cursorOf(blocks, 'first');
    const last = cursorOf(blocks, 'last');
    return json({
      blocks: out(store, blocks), zone,
      earlier: zone === 'past' ? store.lineCount('past', first === null ? { before: Number(before) || 0 } : { before: first }) : 0,
      later: zone === 'future' ? store.lineCount('future', { after: last === null ? Number(after) || 0 : last }) : 0,
      cursors: { first, last }
    });
  }

  const wholeDocument = (store) => ({
    blocks: out(store, store.window({ limit: 1000 })), past: out(store, store.past()),
    earlier: store.pastCountBefore(store.past()[0]?.ord ?? Infinity),
    future: out(store, store.future()), state: out(store, store.state())
  });

  async function GET(event) {
    const { url } = event;
    const store = storeOf(event);
    h.quiet(store);
    const view = url.searchParams.get('view');
    if (view === 'present') return presentView(store, url);
    if (view === 'page') return zonePage(store, url, url.searchParams.get('zone') === 'future' ? 'future' : 'past');
    // Search is an interaction: it answers from sqlite and never waits on the task CLI.
    const query = (url.searchParams.get('q') || '').trim();
    if (query) return json({ blocks: out(store, store.search(query, { limit: 60 })), search: query });
    const taskSync = await h.taskSync(store);
    // The work store is read in the background: the answer carries the lines as they stand, and a
    // status that changed there reaches the page through the live feed once it is written.
    h.refreshTasks(store);
    const replies = h.replies();

    // The backfill's slow half: the task refresh and the reply scan have run above, so this answers
    // with what they changed -- the state area, the pending operations, the undo history -- and
    // leaves the timeline alone, because the page already has the present and pages the rest itself.
    if (view === 'sync') {
      return json({
        view: 'sync', replies, taskSync,
        state: out(store, store.state()),
        history: store.historyFor(url.searchParams.get('historyOwner') || 'document')
      });
    }

    const limit = Math.min(1000, Number(url.searchParams.get('limit') || 300) || 300);
    const beforeParam = url.searchParams.get('before');
    const before = beforeParam === null || beforeParam === '' ? null : Number(beforeParam);
    if (url.searchParams.has('past')) {
      const blocks = out(store, store.past({ limit, before }));
      return json({ blocks, earlier: blocks.length ? store.pastCountBefore(blocks[0].ord) : 0 });
    }
    const blocks = out(store, store.window({ limit, before }));
    // The state area rides along with the first page and not with the ones above it: it sits at the
    // bottom of the document, so paging further back is never a reason to send it again.
    return json({
      blocks,
      history: store.historyFor(url.searchParams.get('historyOwner') || 'document'),
      replies, taskSync,
      past: [],
      earlier: store.pastCountBefore(),
      future: before === null ? out(store, store.future()) : [],
      state: before === null ? out(store, store.state()) : []
    });
  }

  /**
   * A write that came through the browser is a person's hands, so it never carries the `system`
   * source: the state area is generated text he is allowed to take over, and a line he types into a
   * generated section has to stop being the builder's or the next rebuild would write over his
   * words. The builder and the subagents reach the store the other way, through /api/state and
   * scripts/state.mjs. A document has no state area, so a block aimed at it lands in the body.
   */
  const asTyped = (block) => {
    if (!block || typeof block !== 'object') return block;
    let next = block.source === 'system' ? { ...block, source: 'type' } : block;
    if (!zoneOps && next.zone === 'state') next = { ...next, zone: 'timeline' };
    // A document's line never binds one of his chats or work items: a stranger could otherwise name
    // a conversation of his and have his own page open it as a chip.
    if (!zoneOps && (next.chatId || next.taskId)) next = { ...next, chatId: null, taskId: null };
    return next;
  };

  async function POST(event) {
    const { request } = event;
    const store = storeOf(event);
    h.quiet(store);
    const body = await request.json().catch(() => ({}));
    const refused = guard(event, body);
    if (refused) return refused;
    const historyOwner = typeof body.historyOwner === 'string' && body.historyOwner ? body.historyOwner.slice(0, 80) : 'document';
    if (body.historyAction) {
      const redo = body.historyAction.redo === true;
      h.observe(store);
      try { store.travelHistory(body.historyAction.token, redo, historyOwner); store.adoptDocs(body.docs); }
      catch (cause) { return json({ error: cause.message }, { status: 409 }); }
      finally { store.observeTaskEdits(null); }
      store.observeTaskEdits(null);
      h.afterWrite(store);
      const answer = wholeDocument(store);
      onWrite(event, answer);
      return json(answer);
    }
    h.observe(store);
    let action;
    // `recordHistory: false` means the page is tidying after itself, not writing: the empty tail
    // block it keeps under the document, the scratch block under today. Recording those as undo
    // steps put an invisible action on top of the stack, so his next ⌘Z appeared to do nothing and
    // the archive or the edit he actually meant to undo needed a second press. The flag was sent
    // from the page all along and ignored here.
    try {
      action = body.recordHistory === false
        ? { result: applyPost(store, body), token: null }
        : store.recordAction(() => applyPost(store, body), historyOwner);
    }
    finally { store.observeTaskEdits(null); }
    const { result: response, token } = action;
    store.observeTaskEdits(null);
    // Delivering task ops spawns the task CLI per op (1.4s for ten): after the answer, not before it.
    h.afterWrite(store);
    if (!response.ok) return response;
    const answer = await response.json();
    if (token) answer.historyToken = token;
    onWrite(event, answer);
    return json(answer);
  }

  function applyPost(store, body) {
    // A document archives to a line of its own ("@@archive"), not to the past, so this one is open
    // where the zone operations are refused.
    if (body.archiveToMarker) {
      const archived = store.archiveToMarker(Array.isArray(body.archiveToMarker) ? body.archiveToMarker : [body.archiveToMarker]);
      return json({ archived, ...wholeDocument(store) });
    }
    if (body.archiveTree || body.promoteTree || body.rollover) {
      if (!zoneOps) return json({ error: 'not available in a document' }, { status: 400 });
      let archived = null;
      let promoted = null;
      if (body.archiveTree) archived = store.archiveTrees(Array.isArray(body.archiveTree) ? body.archiveTree : [body.archiveTree]);
      if (body.promoteTree) promoted = store.promoteTrees(Array.isArray(body.promoteTree) ? body.promoteTree : [body.promoteTree]);
      if (body.rollover) store.rollover();
      return json({ archived, promoted, ...wholeDocument(store) });
    }

    // Moving one line is its own write: the page names the line by the block it is in and where it
    // sits inside it, and gets the document back, because a line that crosses a block boundary
    // changes the shape of two blocks at once.
    if (body.moveTree || body.moveLine) {
      const { block = null, index = 0, line = null, direction = -1 } = body.moveLine || {};
      const moved = body.moveTree
        ? store.reorderTree(body.moveTree.line, body.moveTree.target, body.moveTree.after === true,
          body.moveTree.whole === true)
        : line ? store.moveLine(line, direction) : store.moveLineAt(block, Number(index), direction);
      return json({
        moved: moved ? { id: moved.id, ord: moved.ord, updatedAt: moved.updatedAt } : null,
        blocks: out(store, store.window({ limit: 1000 })),
        past: out(store, store.past()),
        future: out(store, store.future()),
        state: out(store, store.state())
      });
    }

    const blocks = (Array.isArray(body.blocks) ? body.blocks : body.block ? [body.block] : []).map(asTyped);
    const remove = Array.isArray(body.remove) ? body.remove : [];
    if (blocks.length === 0 && remove.length === 0) return json({ error: 'a block is required' }, { status: 400 });
    const applied = store.apply({ blocks, remove });
    return json({ blocks: h.decorate(applied.blocks, store), removed: applied.removed });
  }

  async function DELETE(event) {
    const { url, request } = event;
    const store = storeOf(event);
    const body = await request.json().catch(() => ({}));
    const id = url.searchParams.get('id') || body.id;
    if (!id) return json({ error: 'id is required' }, { status: 400 });
    const answer = body.restore ? { block: store.restore(id) } : { ok: store.remove(id) };
    onWrite(event, answer);
    return json(answer);
  }

  return { GET, POST, DELETE };
}
