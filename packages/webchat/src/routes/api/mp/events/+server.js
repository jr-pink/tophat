import { eventsGET } from '$lib/server/mp-routes.js';
import { eventsV2GET } from '$lib/server/mp-sync-routes.js';

// v=2 is the app's own framing ({hello}, {events:[...]} batches), which the room client's session
// reads (src/lib/client/mp-session.js); without it, the original one-event-per-frame feed.
export const GET = (event) => (event.url.searchParams.get('v') === '2' ? eventsV2GET(event) : eventsGET(event));
