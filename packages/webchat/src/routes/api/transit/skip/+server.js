import { skip } from '$lib/server/transit-skip.js';

const page = (title, body) => new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font:18px ui-monospace,monospace;background:#f3ecd9;color:#111;padding:2em"><h1 style="font-size:20px">${title}</h1><p>${body}</p></body>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

// Public by capability: see src/lib/server/transit-skip.js and public-paths.js.
export function GET({ url }) {
  const r = skip(url.searchParams.get('e') || '', url.searchParams.get('s') || '');
  if (!r.ok) return new Response('not found', { status: 404 });
  return page('Auto-call skipped', 'No car will be requested for this event. The reminders still come; call one yourself when you are ready.');
}
