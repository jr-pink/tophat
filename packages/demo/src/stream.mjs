// How the scripted opener's answer is streamed: like a model's text deltas, and how it reaches the open page.
//
// Why this file exists. The shim writes the opener's events into the chat store from its own process; the webchat's live feed
// (/api/events) only announces events appended inside the webchat's process, so a page connected to it never hears them and
// finds the answer only on its slow liveness poll (first at 20 s). The shim therefore also puts each event it appends into the
// open /api/events streams of the guest that owns the chat (`createFeed`), in the frame the webchat itself writes.

/**
 * Token-sized pieces of a markdown text: a word (or a few letters of a long one) with its leading space, punctuation on its own,
 * the way a model's text deltas arrive. An image line or a code fence is never split (a half-written `![` would flash as text).
 * Concatenated, the pieces are the markdown exactly.
 */
export function tokenPieces(markdown) {
  const out = [];
  const blocks = markdown.split(/\n{2,}/);
  blocks.forEach((b, bi) => {
    const tail = bi < blocks.length - 1 ? '\n\n' : '';
    if (/^!\[|^```/.test(b)) { out.push(b + tail); return; }
    const toks = b.match(/\s*[\p{L}\p{N}']{1,6}|\s*[^\p{L}\p{N}'\s]|\s+/gu) || [b];
    toks.forEach((t, ti) => out.push(ti === toks.length - 1 ? t + tail : t));
  });
  return out;
}

/** Milliseconds to wait after a piece: about 80 pieces a second (a model's speed, 60 to 100 tokens a second), a beat longer after a paragraph, a figure's line a moment. */
export function pieceDelayMs(piece, random = Math.random) {
  if (/^!\[/.test(piece)) return 260;
  return (/\n\n$/.test(piece) ? 90 : 0) + 6 + random() * 8;
}

/**
 * The page's event streams, kept by the proxy: `attach(res, key)` for a /api/events response being piped, `chunk(entry, buf)` for each upstream
 * chunk, `publish(event, key)` for an event the shim appended. A frame is written only between two upstream frames (a chunk that ends
 * a frame), so the webchat's own frames are never cut in two.
 */
export function createFeed() {
  const streams = new Set();
  const frame = (events) => `data: ${JSON.stringify({ events })}\n\n`;
  const drain = (s) => { if (s.atBoundary && s.queue.length && !s.res.writableEnded) { const q = s.queue; s.queue = []; s.res.write(frame(q)); } };
  return {
    attach(res, key) {
      const s = { res, key, queue: [], atBoundary: true };
      streams.add(s);
      res.on('close', () => streams.delete(s));
      return s;
    },
    /** Forwards an upstream chunk and then any events waiting for a frame boundary. */
    chunk(s, buf) {
      if (s.res.writableEnded) return;
      s.res.write(buf);
      s.atBoundary = buf.length >= 2 && buf[buf.length - 1] === 10 && buf[buf.length - 2] === 10;
      drain(s);
    },
    publish(event, keyOf) {
      for (const s of streams) { if (keyOf(s.key, event)) { s.queue.push(event); drain(s); } }
    },
    size: () => streams.size,
  };
}
