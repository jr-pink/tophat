// One public document's notes surface: the /api/notes handlers over this token's store alone.
import { notesDELETE, notesGET, notesPOST } from '$lib/server/docs-routes.js';
export const GET = notesGET;
export const POST = notesPOST;
export const DELETE = notesDELETE;
