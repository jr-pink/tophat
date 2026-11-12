// The sanctioned way to send a request that is NOT a durable write: presence, a session-open (boot) POST, any POST whose
// loss costs nothing (DOCSTORE3-DESIGN section 11 presence row 53 and section 15 "Embeds": presence is never stored, never in
// the op log, never in the outbox; the next heartbeat replaces a lost one). The quicklook-lint rule
// durable-write-outside-outbox exempts lib/engine/, so the exemption lives here once instead of as an allowance per app;
// anything that carries what he made still goes through a `scope: 'cloud'` declaration and the outbox (DOCSTORE3 A7).
//
//   const post = createEphemeralPost()                              // global fetch, or pass any (url, init) => Promise<Response>
//   post('/api/docs/x/presence', { body: { sel }, keepalive: true }) // JSON body; rejects with DeadlineError past the class bound
//   const r = await post('/api/boot?doc=x', { klass: 'read' })       // resolves the Response; the caller reads status and body
//
// Every call carries a deadline class (default 'telemetry', 10 s; 'read' for a session open), so no ephemeral send is an unbounded
// wait (lint fetch-without-deadline). There is deliberately no retry and no queue: a lost send is lost.
import { createDeadlineFetch } from './deadline.js'

export function createEphemeralPost(fetchImpl, opts = {}) {
  const net = createDeadlineFetch(fetchImpl, opts)
  /** post(url, { body, klass = 'telemetry', key, keepalive, headers, credentials = 'same-origin', cache }) -> Promise<Response> */
  return function post(url, { body, klass = 'telemetry', key, keepalive, headers, credentials = 'same-origin', cache } = {}) {
    const init = { method: 'POST', credentials }
    if (cache) init.cache = cache
    if (keepalive) init.keepalive = true
    if (body !== undefined) { init.headers = { 'content-type': 'application/json', ...headers }; init.body = typeof body === 'string' ? body : JSON.stringify(body) }
    else if (headers) init.headers = headers
    return net.fetchWithin(klass, url, init, key ? { key } : {})
  }
}
