// Share pages and their error page are plain server-rendered HTML: no client bundle, so a
// stranger's browser never runs the app's boot script, which is what redirected a mistyped share
// link to /login and asked for a passkey.
export const ssr = true;
export const csr = false;
export const prerender = false;
