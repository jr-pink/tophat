// The model budget: an append-only spend ledger (<stateDir>/spend.jsonl, one line per model call: at, provider, model,
// input/output tokens, usd) and a daily cap from config (budget.dailyUsd). A call is made only when today's spend plus
// the call's worst-case estimate (prompt tokens in + maxTokens out, at the configured prices) stays under the cap; the
// actual cost is then recorded from the provider's usage. No price or cap is a code default: config names them.
import fs from 'node:fs';
import path from 'node:path';

export class BudgetError extends Error { constructor(m) { super(m); this.code = 'budget-exhausted'; } }
const day = (iso) => iso.slice(0, 10);
export const ledgerFile = (stateDir) => path.join(stateDir, 'spend.jsonl');
export function spentOn(stateDir, date) {
  let text = ''; try { text = fs.readFileSync(ledgerFile(stateDir), 'utf8'); } catch { return 0; }
  let usd = 0;
  for (const line of text.split('\n')) { if (!line) continue; try { const r = JSON.parse(line); if (day(r.at) === date) usd += Number(r.usd) || 0; } catch { /* torn line */ } }
  return usd;
}
export const cost = (price, inTok, outTok) => ((inTok * price.inputPerMTok) + (outTok * price.outputPerMTok)) / 1e6;
/** budget: { dailyUsd }, price: { inputPerMTok, outputPerMTok } (both required unless the provider is free, e.g. stub). */
export function check({ stateDir, budget, price, now, inTok, maxOut }) {
  if (!price) return { estimate: 0, spent: 0 };
  if (!budget || !Number.isFinite(budget.dailyUsd)) throw new BudgetError('config.budget.dailyUsd is required for a priced model');
  const spent = spentOn(stateDir, day(now)), estimate = cost(price, inTok, maxOut);
  if (spent + estimate > budget.dailyUsd) throw new BudgetError(`daily model budget ${budget.dailyUsd} USD: spent ${spent.toFixed(4)}, this call could cost ${estimate.toFixed(4)}`);
  return { estimate, spent };
}
export function record({ stateDir, now, provider, model, usage, price }) {
  const inTok = usage?.input_tokens ?? 0, outTok = usage?.output_tokens ?? 0;
  const usd = price ? cost(price, inTok, outTok) : 0;
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(ledgerFile(stateDir), JSON.stringify({ at: now, provider, model, input_tokens: inTok, output_tokens: outTok, usd }) + '\n', { mode: 0o600 });
  return usd;
}
