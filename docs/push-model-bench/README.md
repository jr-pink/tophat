# Push model benchmark: gpt-6.1-terra with a tuned appendix

Which model should turn newly arrived records (messages, mail, chat transcripts, documents) into memory notes? This
benchmark replays real push packets through candidate models and has an independent judge score each output against
the source records, not against another model's output. Result: **gpt-6.1-terra with its tuned appendix kept 97.5% of
source facts (98.1% per-packet mean) against 81.3% / 81.5% for claude-opus-5-5, at about a quarter of the cost per
packet**, with 0.03 unsupported claims per packet. That is why `gpt-6.1-terra` is the recommended intake model
(`packages/push/presets.mjs`) and why `packages/push/prompts/appendix/gpt-6.1-terra.txt` exists.

No packet content, model output or personal data is in this directory: the packets are one person's real records and
stay private. What is here is the method, the aggregate numbers, the rule text and the scripts.

## Method

- **Packets.** 152 interpret calls recorded from a live push deployment (each one: the system prompt, the packet the
  model read, and the output the production model, claude-opus-5-5, wrote). A 40-packet subset was scored by the
  judge: 21 large and 19 medium packets, median 4 new records and about 91,000 characters each (the packet also carries
  history and the existing memory the model sees); sources were chat transcripts (16), text and chat messages (13),
  email (7) and other (4).
- **Candidates.** Each model read the identical packet. `runner.py` calls OpenRouter Chat Completions with temperature 0
  and no reasoning parameter (or a local model bridge); one result file per packet, resumable, with a hard spend cap.
  The Opus row is the recorded production output, scored the same way as every other label.
- **Prompts.** `-p` is the base push prompt plus a generic "be exhaustive" paragraph. `-r1`/`-r2` add shared audit rules
  found by reading failures (threads stay separate, read history before saying something is owed, quote what is unclear,
  receipts are facts, contact cards, wake hygiene, output exactness) plus model-specific rules. `-live` is the current
  production prompt plus the shared rules and the model-specific rules: the configuration that ships.
  `mkpk.py` composes the system prompt from a base and appendix files; the record part is never changed.
- **Judge** (`judge2.py`, judge google/gemini-4-argon, two stages). Stage K: the judge reads only the raw packet and
  writes an answer key of at most 20 key facts from the new records, plus the records that need action. Stage S: the
  same judge reads packet, rubric and the fixed key list, then one anonymous candidate's rendered notes, and returns the
  key facts covered and any claim the packet does not support. The packet is a cached prefix, so every candidate is
  scored against byte-identical context.
- **Scores** (`judge2_score.py`). Coverage = covered key facts / key facts (micro over packets, and macro, the per-packet
  mean). Unsupported = judge-listed unsupported claims per packet. Wake precision and recall compare the records a
  candidate woke a chat for with the judge's action list (recall over the 13 records the judge marked certain).
  Parse-invalid and underqualified-name counts come from the production validator. `judge2_paired.py` is a 10,000-draw
  paired bootstrap of per-packet macro coverage, candidate minus Opus.

## Results (judge gemini-4-argon, 40 packets)

| label | cov micro/macro | unsup/pkt | parse-invalid/underqual (of 40) | raw wakes | eligible wakes | elig prec / rec(certain, n=13) | notes/pkt | $/pkt | paired vs opus (macro pts, 95% CI) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| opus | 81.3/81.5 | 0.12 | 0/0 | 32 | 11 | 91% / 69% (9/13) | 3.12 | 0.2125 | - |
| terra-p | 70.7/75.2 | 0.25 | 0/1 | 15 | 13 | 92% / 85% (11/13) | 3.52 | 0.098 | -6.3 [-12.7,+1.5] |
| sol-p | 78.8/84.2 | 0.07 | 0/0 | 68 | 19 | 79% / 92% (12/13) | 4.1 | 0.0801 | +2.8 [-4.0,+11.3] |
| sol61-p | 93.9/91.6 | 0.03 | 1/2 | 42 | 21 | 81% / 92% (12/13) | 5.33 | 0.0851 | +10.1 [+2.4,+19.5] |
| sol61-r1 | 96.5/97.7 | 0.0 | 0/0 | 13 | 13 | 92% / 85% (11/13) | 5.88 | 0.0847 | +16.2 [+6.4,+27.4] |
| sol61-live | 96.0/96.4 | 0.03 | 0/2 | 20 | 20 | 90% / 77% (10/13) | 9.9 | 0.0894 | +14.9 [+5.4,+26.0] |
| terra61-p | 81.8/86.1 | 0.03 | 0/0 | 36 | 14 | 86% / 77% (10/13) | 4.45 | 0.0442 | +4.7 [-2.2,+13.3] |
| terra61-r1 | 97.0/97.4 | 0.03 | 0/1 | 11 | 11 | 91% / 69% (9/13) | 5.6 | 0.045 | +15.9 [+6.5,+27.0] |
| terra61-live | 97.5/98.1 | 0.03 | 0/23 | 19 | 19 | 95% / 77% (10/13) | 10.1 | 0.0492 | +16.6 [+6.5,+27.9] |
| luna-orig | 64.1/67.2 | 0.25 | 1/1 | 69 | 19 | 74% / 69% (9/13) | 2.23 | 0.0059 | -14.3 [-24.3,-4.2] |
| luna-p3 | 86.9/83.8 | 0.33 | 0/1 | 51 | 13 | 92% / 69% (9/13) | 4.7 | 0.0061 | +2.3 [-4.2,+10.8] |
| luna-r1 | 91.9/91.4 | 0.4 | 0/0 | 10 | 10 | 90% / 54% (7/13) | 5.62 | 0.0062 | +10.0 [+0.9,+20.6] |
| luna-r2 | 88.9/89.6 | 0.28 | 0/0 | 12 | 12 | 92% / 69% (9/13) | 5.78 | 0.0061 | +8.1 [-3.1,+20.8] |
| haiku-p2 | 77.3/78.9 | 0.3 | 0/0 | 37 | 13 | 85% / 69% (9/13) | 2.98 | 0.0075 | -2.6 [-5.4,-0.2] |
| haiku-r1 | 89.4/85.1 | 0.35 | 0/0 | 10 | 10 | 100% / 62% (8/13) | 4.22 | 0.0073 | +3.6 [-6.4,+14.5] |
| haiku-r2 | 83.3/84.5 | 0.25 | 1/0 | 12 | 12 | 92% / 62% (8/13) | 3.45 | 0.0073 | +3.0 [-6.0,+12.7] |
| carbon-p | 99.0/99.5 | 0.03 | 0/0 | 10 | 10 | 100% / 62% (8/13) | 5.05 | 0.1777 | +18.1 [+8.3,+29.1] |
| kimi31-p | 88.4/90.3 | 0.03 | 2/1 | 44 | 13 | 100% / 69% (9/13) | 5.55 | 0.1831 | +8.9 [-3.0,+21.4] |
| sonnet | 77.8/78.4 | 0.25 | 0/0 | 31 | 10 | 100% / 77% (10/13) | 2.8 | 0.118 | -3.1 [-11.0,+5.0] |

Labels (OpenRouter ids): `terra` openai/gpt-5.6-terra, `terra61` openai/gpt-6.1-terra, `sol` openai/gpt-6-sol,
`sol61` openai/gpt-6.1-sol, `luna` openai/gpt-6-luna, `haiku` anthropic/claude-haiku-5.5, `sonnet`
anthropic/claude-sonnet-5.5, `carbon` google/gemini-4-carbon, `kimi31` moonshotai/kimi-k3.1-pro. $/pkt is the
billed OpenRouter cost per packet (Opus: Anthropic list price on the recorded usage).

- **Second judge.** On 10 packets, gemini-4-argon and claude-haiku-5-5 as judges ranked the five models compared
  (Opus, carbon-p, sol61-p, terra61-p, kimi31-p) in the same order.
- **Name rule.** terra61-live needed a retry for underqualified entity names on 23 of 40 packets. The model-specific
  name rule (second bullet of the terra section below) cut that to 0 of 20 on the 20 packets that had needed it, with
  0 parse failures; its coverage was not judged.

## Caveats

- The rules were found on these same 40 packets, so the -r1 and -live rows are fitted to them; a fresh packet set is the
  real test.
- Opus was not run with the appendix; its row is the production prompt only.
- One judge family scored everything (with the 10-packet second-judge check above).
- carbon-p scored highest (99.0 / 99.5) at 3.6 times terra's cost per packet; terra61-live is the cost and quality
  choice.

## The appendix as benchmarked

`appendix-gpt-6.1-terra-as-benchmarked.txt` is the text appended to the production push prompt for the -live run
(examples in quotes replaced with neutral ones). It refers to that prompt's packet format (HISTORY, wake lists,
`mentions`, `skipped`). `packages/push/prompts/appendix/gpt-6.1-terra.txt` is the same set of rules adapted to this
repository's intake prompt (`packages/push/prompts/derive.txt`: records, candidates, notes); the adaptation itself has
not been benchmarked.

## Using it

```json
"intake": { "model": { "preset": "gpt-6.1-terra-openrouter", "credential": { "keyring": "openrouter-api-key" } } }
```

`gpt-6.1-terra-openrouter` routes through OpenRouter with `provider: { data_collection: "deny", zdr: true }` (only
zero-data-retention endpoints, none that train on prompts); `gpt-6.1-terra-openai` calls OpenAI directly with
`store: false` (a new API organisation's rate limit, for example 10,000 tokens per minute, is below one large packet, so
check it first). Keys of the
instance entry override the preset's (`maxTokens`, `body`, `price`, `appendix: false` for no appendix).

## Scripts

`scripts/` holds the runner, the judge, the scorer, the paired bootstrap and the packet composer. They expect a private
packets file (`frozen-v2.json`: a list of `{id, system, user, max_tokens, ref_text, ref_cost}`, where `ref_text` is the
production output) beside them, and read the OpenRouter key from `OPENROUTER_API_KEY`.

    python3 scripts/runner.py terra61-live openai/gpt-6.1-terra openrouter ids.json --packets packets-live.json
    python3 scripts/judge2.py argon google/gemini-4-argon ids.json opus,terra61-live
    python3 scripts/judge2_score.py argon ids.json opus,terra61-live
    python3 scripts/judge2_paired.py argon ids.json terra61-live
