# tophat-timer

Source `packages/tools/timer/tophat-timer.mjs`, logic `packages/runner/rev5/waits.mjs` + `wait-sweeper.mjs`. State: `$TOPHAT_RUNNER_WAITS_DIR`, else the `waits` directory beside the goals directory.

goal_wait retry timers seen from outside the webchat server: `list`, `check` (exit 1 on overdue > 5 min, fired-unacknowledged, escalated, dead sweeper), `fire SESSION[:waitid]`, `log [N]`.
`check` suits a health job. Durable record of every delivery, ack and escalation: `<waits dir>/fire-log.jsonl`. A wake counts as fired only after the chat ran a turn after it.
