import { json } from '@sveltejs/kit';
import { lagReport } from '$lib/server/lag-guard.js';

// What the loop-stall guard has seen since boot: the loop's p50/p99/max, the stalls grouped by the
// route and synchronous call behind them, and the latest of each. Behind the session like the rest.
export function GET() {
  return json(lagReport(), { headers: { 'cache-control': 'no-store' } });
}
