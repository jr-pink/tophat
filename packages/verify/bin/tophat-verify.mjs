#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// tophat-verify [--seeds N] [--ops N]: run the multi-party fuzz (three users on sqlite replicas, one of them on two
// devices, through a local hub) and the origin-vs-replica differential on fresh temp stores; exits 1 on any failure.
import { world, settle } from '@tophat-md/linknotes/testing';
import { fuzzParties, differential, cast, replicaPair } from '../index.mjs';
const flag = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
let bad = 0;
for (let seed = 1; seed <= flag('seeds', 10); seed++) {
  const w = await world();
  const r = await fuzzParties({ seed, ops: flag('ops', 60), ...(await cast(w, seed, settle)) });
  const d = await differential({ seed, ops: 30, ...(await replicaPair(w, `d${seed}`, settle)) }).catch((e) => ({ ok: false, failures: [String(e.message)] }));
  console.log(JSON.stringify({ seed, fuzz: r.ok ? 'ok' : r.failures.slice(0, 5), fuzz_stats: r.stats, differential: d.ok ? 'ok' : d.failures.slice(0, 5), differential_stats: d.stats }));
  if (!r.ok || !d.ok) bad++;
  await w.close();
}
process.exit(bad ? 1 : 0);
