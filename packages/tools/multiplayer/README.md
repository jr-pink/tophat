# tophat-multiplayer

One chat room, many tabs, one agent.

    tophat-multiplayer            # http://localhost:29310
    TOPHAT_MULTIPLAYER_PORT=29311 tophat-multiplayer

- **Each tab is its own client.** Identity lives in `sessionStorage`, so three tabs on one machine are
  three people in the room. The first loopback tab is `owner`; every tab after it is
  `anonymous-xxxx`. A loopback tab can swap with the button beside the composer.
- **Everything streams** over one SSE channel to every tab: user messages, assistant text, tool
  calls as they are built (`action.start` / `action.input` / `action.end`), tool results, presence.
  A tab that joins late replays the whole room from seq 0.
- **The privacy gate is the point.** Nothing the model side produces is broadcast unclassified.
  Assistant text is released one sentence at a time and each sentence is classified by a small model
  before it goes out; tool results pass the same gate. A blocked span becomes
  `[redacted: reason]` inline and the stream continues. The gate fails closed: if the classifier
  call errors, the span is blocked.
- Tools: `calc`, `fetch_url` (public pages), `lookup` (runs the command in `TOPHAT_MULTIPLAYER_SEARCH_BIN` with the
  query as its argument, if set; the gate then redacts its output). No shell, no writes.
- Transcript of every room: `$TOPHAT_MULTIPLAYER_LOG_DIR` (default `<state dir>/multiplayer`)`/room-<time>.jsonl`.
- `node test/multiplayer-gate.manual.mjs` runs the gate against labelled cases (address, card, health blocked;
  arithmetic, public fact, refusal, code allowed). It calls a live model, so it is run by hand, not by the suite.

The owner's name in the prompts is `TOPHAT_OWNER_NAME` (default "the owner"). Models: `MP_MODEL` for the agent and
`MP_GATE_MODEL` for the gate; credentials resolve through the runner's model ladder.
