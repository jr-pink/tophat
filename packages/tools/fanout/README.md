# tophat-fanout

Send ONE brief to many different models in parallel, each allowed to search the web, and get every reply side by side for a merge that keeps the disagreements.

- Source: `packages/tools/fanout/tophat-fanout.mjs` (command `tophat-fanout`). Tests: `test/fanout.test.mjs` (no network).
- Why: one model family tends to converge on the same answers, so the default brief is a reframe template, not just answer-the-question.

```sh
tophat-fanout --prompt-file question.md --out research/<date>-<topic>/fanout
tophat-fanout --prompt-file q.md --models luna,kimi,grok --max-usd 1
tophat-fanout --prompt-file q.md --dry-run        # resolve ids and worst-case price, call nothing
tophat-fanout --show-template
```

Options: `--models a,b,c` (roster keys, any OpenRouter id `vendor/model`, or a `gpt-*` id), `--out DIR`, `--raw` (send the file as is, no template), `--max-usd` (default 5; refuses before calling if the worst case exceeds it), `--max-tokens` (default 16000 per model), `--effort` (reasoning effort, default medium), `--timeout` (seconds per model across all its routes, default 240; each reply is written to DIR the moment its model returns, so a slow model never blocks the rest), `--stdout-chars` (per-model cut in the printed merge input, default 7000; files are never cut).

## The default brief (reframe template)

Each model is told it is one of several, asked for diversity, and walks: (1) free-associate wildly, (2) which assumption in the question it would drop or flip, (3) diverge: what could be dropped entirely (requirement, step, metric); what this reminds it of (other fields, history, nature, games, industries); what could be done cheaply (cheaper proxy, smaller experiment, skip the build, ask someone, buy the answer); what it would do with one day or one dollar; the opposite approach; who has solved a structurally similar problem, (4) answer. It must search, name specific people, papers and dates, and mark found-by-search versus recalled. The text of `--prompt-file` is the question and context. Edit `REFRAME_TEMPLATE` in the source to change it.

## Roster and routes

Ids are resolved on every run from OpenRouter's `/models` list (key `openrouter-api-key`, read inside the process only). `or` ids are tried first; if one is gone the newest id in the model's family is used; a model with no id is reported and skipped.

| key | id on 2026-11-03 | route |
| --- | --- | --- |
| gemini-top | google/gemini-4-argon | Google generateContent with `google_search` grounding if `gemini-api-key` or `google-api-key` exists in the secrets dir; else OpenRouter `:online` |
| gemini-fast | google/gemini-3.8-flash | same |
| luna, sol, astra | gpt-6-luna, gpt-6-sol, gpt-6-astra | OpenAI Responses API with `web_search` via `rev5/openai.mjs` (platform key, else the Codex ChatGPT subscription, which is plan-metered; probed 2026-11-03); falls back to OpenRouter `openai/<id>:online` |
| kimi | moonshotai/kimi-k3.1-pro | OpenRouter `:online` |
| meta | meta/muse-spark-1.3 (also meta/muse-wonder, meta/muse-spark-open exist) | OpenRouter `:online` |
| grok | x-ai/grok-4.7 | OpenRouter `:online` |

Newer variants exist and are one `--models` away: `gpt-6.1-sol`, `gpt-6.1-terra`, `meta/muse-wonder`.

## Output

`DIR/<key>.md` per model (header: model id, route, cost, tokens, searches; then the reply; then the provider's sources), `DIR/<key>.FAILED.md` per failure, `_brief.md`, `_run.json` (resolved ids, per-model cost, seconds, route errors), `_merge-input.md` (also printed). Exit 0 if any model answered, 3 if none, 1 on usage error or the spend cap.

## Cost

OpenRouter reports real cost per call (`usage.cost`, includes the web-search fee: about $0.08 for a Gemini flash call that ran 6 searches). OpenAI calls on the subscription show cost 0 and an API-equivalent estimate from list prices. A full default fan-out is roughly $0.3 to $1.5.

## Notes

`rev5/model.mjs` and `rev5/openai.mjs` import each other; the tool loads `rev5/call.mjs` first, which is the only order that initialises (importing `openai.mjs` first throws a temporal-dead-zone error in `resilience.mjs`). Do not reorder.
