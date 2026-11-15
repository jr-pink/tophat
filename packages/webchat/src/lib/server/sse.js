// The event stream to one browser tab.
//
// A reader that falls behind used to have its stream closed: 591 lines of "[sse] dropped a
// stream: the client stopped reading with 65 messages queued" in today's log, every one of them
// a chat that stopped updating until it reconnected. A browser painting a fast token stream
// falls 64 messages behind constantly, so this was firing in normal use, which is what "things
// being cut" looked like from the outside.
//
// Nothing is dropped for being slow now. Events for a reader that is not draining are held here,
// written out in pages as soon as it pulls again, and if it stays away long enough for the held
// events to pass SSE_MAX_PENDING they collapse into a single `resync` marker: the client already
// knows that frame (it refetches from the store cursor), the stream stays open, and memory stays
// bounded. The only teardowns left are the real ones: the client cancelled, or the enqueue threw
// because the socket is gone.

export const SSE_HEARTBEAT_MS = 20_000;

/** How far ahead of a reader we are willing to enqueue before holding events here instead. */
export const SSE_MAX_QUEUED = 64;

/** Events held for a stalled reader before they collapse into one resync marker. */
export const SSE_MAX_PENDING = 5_000;

export const SSE_BACKLOG_PAGE = 2000;

export const SSE_MAX_BACKLOG = 10_000;

export function eventStream({
  store,
  after = 0,
  heartbeatMs = SSE_HEARTBEAT_MS,
  maxQueued = SSE_MAX_QUEUED,
  maxPending = SSE_MAX_PENDING,
  maxBacklog = SSE_MAX_BACKLOG,
  setTimer = setInterval,
  clearTimer = clearInterval,
  log = console.warn
}) {
  let unsubscribe = () => {};
  let heartbeat = null;
  let closed = false;
  let reason = null;
  let resyncs = 0;

  const teardown = (controller, why) => {
    if (closed) return;
    closed = true;
    reason = why;
    try { unsubscribe(); } catch {  }
    unsubscribe = () => {};
    if (heartbeat !== null) clearTimer(heartbeat);
    heartbeat = null;
    if (why !== 'the client went away') log(`[sse] dropped a stream: ${why}`);
    try { controller.close(); } catch {  }
  };

  let flush = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      // The one place bytes go out. A throw here means the socket is gone; nothing else ends a stream.
      const write = (payload) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          teardown(controller, 'the client vanished mid-write');
        }
      };
      // desiredSize is null for a stream with no reader attached yet; that is room, not backpressure.
      const room = () => (typeof controller.desiredSize === 'number' ? controller.desiredSize : maxQueued);

      let delivered = after;
      let pending = [];

      flush = () => {
        while (!closed && pending.length && room() > -maxQueued) write({ events: pending.splice(0, SSE_BACKLOG_PAGE) });
        if (closed || pending.length <= maxPending) return;
        // The reader has been away too long to keep its detail: it is told where the present is and
        // catches up from the store itself, which is cheaper than the events and never loses one.
        const behind = pending.length;
        const cursor = pending[behind - 1].cursor;
        pending = [];
        resyncs += 1;
        log(`[sse] a reader fell ${behind} events behind; it was asked to resync at ${cursor} rather than dropped`);
        write({ resync: true, cursor, behind });
      };

      const offer = (event) => {
        if (closed || event.cursor <= delivered) return;
        delivered = event.cursor;
        pending.push(event);
        flush();
      };

      // A store that can count what one reader is behind by (one chat's view of the store) says so; the whole store's head minus the cursor
      // is only right when the reader follows the whole store.
      const behind = typeof store.behind === 'function' ? store.behind(after, maxBacklog + 1) : store.cursor() - after;
      if (behind > maxBacklog) {
        delivered = store.cursor();
        write({ resync: true, cursor: delivered, behind });
        if (closed) return;
      }
      for (;;) {
        const page = store.since(delivered, SSE_BACKLOG_PAGE);
        if (!page.length) break;
        write({ events: page });
        if (closed) return;
        delivered = page[page.length - 1].cursor;
        if (page.length < SSE_BACKLOG_PAGE) break;
      }
      write({ hello: true, cursor: store.cursor() });
      if (closed) return;
      unsubscribe = store.subscribe(offer);
      // The heartbeat doubles as the retry for a reader that drained without pulling.
      heartbeat = setTimer(() => { flush(); write({ ping: Date.now() }); }, heartbeatMs);

      heartbeat?.unref?.();
    },
    // The consumer asking for more is the signal that it drained: whatever was held goes now.
    pull() { flush(); },
    cancel(controller) { teardown(controller ?? { close() {} }, 'the client went away'); }
  });

  return { stream, status: () => ({ closed, reason, resyncs }) };
}
