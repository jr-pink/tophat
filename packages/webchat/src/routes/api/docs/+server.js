// The owner's list of public documents and the minting of a new one. hooks.server.js keeps this
// path behind his session; the handlers check again (src/lib/server/docs-routes.js).
import { createPOST, listGET } from '$lib/server/docs-routes.js';
export const GET = listGET;
export const POST = createPOST;
