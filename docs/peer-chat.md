# Peer chat: every chat lives on one host

Created 2026-11-10. Updated 2026-11-10.

Tophat instances that sync through the same hub are peers. A chat has exactly one host, the peer whose runner answers it. Every
peer shows every chat: the instance you are looking at stays the front end, attaches to the host's live event stream, and writes
what arrives into its own log, so tokens stream, tool cards and interrupts behave as for a local chat, and the transcript reads
offline. Nothing in the engine names a machine.

## Hosts

The list is the hub's device list: each instance's replica holds a `mc_devices` row per registered peer (read from
`TOPHAT_RUNNER_DB`). The entry whose id equals this instance's own device id (`TOPHAT_DEVICE`) is "this machine"; every other
peer is a candidate host. A peer can host chats once this instance has an address and a service token for it.

`<webchat state>/hosts.json`, one entry per hub device id:

```json
{
  "<device id>": {
    "label": "optional display name",
    "url": "http://127.0.0.1:14191",
    "tokenFile": "/absolute/path/to/that/peer's/webchat-service-token",
    "description": "what to route there, in the owner's words",
    "auto": true
  }
}
```

- `url` and `tokenFile` are written once per peer. `url` is the peer's webchat machine surface (`/api/agent`), which answers
  only loopback callers that present the service token, so a remote peer is reached through a supervised port forward
  (for example `ssh -N -L 127.0.0.1:PORT:127.0.0.1:WEBCHAT_PORT peer`). A peer without both shows in the lists as "no address"
  and cannot be chosen.
- `description` and `auto` are edited from the host menu (server icon beside the folder button in the sidebar): a checkbox
  "consider for auto-routing" and a free-text description of what to route there. Written text is the definition, like a folder
  description. The menu is offline first (`core/host-notes.js`: persisted outbox, newest edit per host wins on replay).

## Choosing a host

- By hand: the host dropdown in the chat header (`conversation.set_host`, event `conversation.host { host }`; null is this
  machine). A host chosen by hand is never overridden.
- By the router (`server/autoroute.js`, `routeHost`): for a chat with no host, the fast model sees the descriptions of the hosts
  that are reachable, opted in and described, and names one or none. A pick stands only if a second call says yes: the chat is
  clearly the work the description covers and contains nothing personal. The event carries `auto: true`; every decision that
  reached a model is one line in `<webchat state>/remote-routing.jsonl`. No candidate means no model call.
- A chat mid-turn is not moved mid-turn; the next send follows the host. Moving in either direction seeds the receiving
  runner with the transcript it has not seen.

## How a chat runs on a peer

1. A send to a chat hosted on a peer writes the owner's message into the local log, then calls the peer's `/api/agent`
   (`spawn` for the first message, `send` after).
2. The peer's `op: "events"` (server/conversation-stream.js) holds a stream open: the frames `/api/events` sends a browser
   (`{events}`, `{hello}`, `{resync}`, `{ping}`) narrowed to that conversation, resumable by `after` = the peer's store cursor.
3. `server/remote-runtime.js` appends each delta, thinking block, tool call and run event to the local log as it arrives. The
   cursor is stored in `remote-twins.json`; a dropped connection or a restart reconnects from it, so nothing repeats.
4. Stop sends `op: "interrupt"`; the peer's own `run.cancelled` settles the chat. An unreachable peer keeps the message, shows
   "Waiting for <host>: offline", and re-sends when it returns. A host with no address fails the send loudly and never runs
   the chat locally.

Rollback: set a chat's host back to this machine; remove `hosts.json` entries to make a peer unreachable (chats hosted there
then fail loudly instead of running elsewhere).
