import { liveFeed, liveStream, LIVE_TOPICS } from '$lib/server/live-feed.js';

// The push for notes and the reader (see $lib/server/live-feed.js): a held-open event stream of
// "this store changed" signals, resumable from the last cursor through Last-Event-ID or ?after=.
// ?topics=notes,reader narrows it; a page refetches through its own merge path on each signal.
export function GET({ url, request }) {
  const after = request.headers.get('last-event-id') || url.searchParams.get('after') || null;
  const topics = (url.searchParams.get('topics') || '').split(',').map((topic) => topic.trim())
    .filter((topic) => LIVE_TOPICS.includes(topic));
  const { stream } = liveStream({ feed: liveFeed(), after, topics });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    }
  });
}
