import { commentsDELETE, commentsGET, commentsPATCH, commentsPOST } from '$lib/server/docs-routes.js';
export const GET = commentsGET;
export const POST = commentsPOST;
export const PATCH = commentsPATCH;
export const DELETE = commentsDELETE;
