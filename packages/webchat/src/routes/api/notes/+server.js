import { drainTaskOps, observeOwnerTaskEdits, refreshTaskLinesSoon } from '$lib/server/notes-tasks.js';
import { cachedReplies } from '$lib/server/replies.js';
import { notesStore } from '$lib/server/notes-store.js';
import { notesRoutes } from '$lib/server/notes-routes.js';
import { withoutOrigin } from '$lib/server/live-feed.js';

// The notes document: a timeline of what happened, a future area under it whose first block is the
// today block, and the system state area under both. What is stored is lines; a block is the run
// of lines the page types in, derived from their gap flags and named by its first line, and every
// block here carries its lines with their own ids and their own created_at. GET pages backwards
// through the timeline and always returns the whole future area and, on the first page, the state
// area; POST writes blocks and moves single lines; DELETE is a soft delete. Every write reaches
// the append-only journal before the row. Opening the app is a paint, not a sync. `view=present`
// answers from sqlite alone: the window around the present, one page of the past above it and one
// page of the future below it, with the cursors to page further in either direction. Nothing here
// spawns the task CLI or scans the reply drop, because those cost hundreds of milliseconds each
// and the page must not wait for them to show him his writing. `view=sync` is the other half: the
// slow reconciliation the page asks for once it is on screen. The handlers themselves are
// src/lib/server/notes-routes.js, shared with the public documents (/api/docs/<token>), which run
// the same code over their own store and none of the hooks below.

// Delivering owed task ops is a spawnSync of the task CLI per op, which stops the server's one
// thread. It waits until notes has been quiet for DRAIN_IDLE_MS, so a run of drags, archives or
// ⌘. presses never queues behind it; every notes request pushes it back.
const DRAIN_IDLE_MS = 3000;
let drainTimer = null;
function scheduleDrain(store) {
  clearTimeout(drainTimer);
  // Outside the request's attribution: what the drain writes was not made by the tab that
  // happened to be the last one to save, so that tab must not skip it as its own echo.
  drainTimer = withoutOrigin(() => setTimeout(() => { drainTimer = null; drainTaskOps(store).catch(() => {}); }, DRAIN_IDLE_MS));
  drainTimer.unref?.();
}

const routes = notesRoutes({
  store: () => notesStore(),
  hooks: {
    quiet: (store) => { if (drainTimer) scheduleDrain(store); },
    observe: (store) => observeOwnerTaskEdits(store),
    afterWrite: (store) => scheduleDrain(store),
    taskSync: (store) => drainTaskOps(store),
    refreshTasks: (store) => refreshTaskLinesSoon(store),
    replies: () => cachedReplies()
  }
});
export const GET = routes.GET;
export const POST = routes.POST;
export const DELETE = routes.DELETE;
