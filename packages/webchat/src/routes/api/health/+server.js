import { createHash } from 'node:crypto';
import { json } from '@sveltejs/kit';
import { localRefusal } from '$lib/server/local-gate.js';
import { threadpoolState } from '$lib/server/threadpool-watch.js';
import { interactionStats } from '$lib/server/interaction.js';
import { readingTraceStats } from '$lib/server/reading-trace-store.js';
import { handoverShape } from '$lib/server/code-shape.js';
import { bootCodeShape, busyConversations, liveConversations, runnerShape, storeHealth, storeShape } from '$lib/server/app.js';
import { deliverySummary } from '$lib/server/client-lag.js';
import { healthOf } from '$lib/server/extensions.js';
import { extensions } from '$lib/server/extensions-boot.js';

const instance = `${process.pid}:${Date.now()}`;
let handover = null;

function telemetryState() {
  try { return { interaction: interactionStats(), readingTrace: readingTraceStats() }; } catch (error) { return { error: String(error?.message || error) }; }
}

export async function GET(event) {
  // Loopback, and not through the tunnel. Cloudflared delivers a remote request as a local socket,
  // so a forwarding header is the tell however local the peer looks, and an address the adapter
  // cannot give is never local.
  //
  // That rule has ONE owner, $lib/server/local-gate.js, which /api/inbound and
  // /api/replies/projection already ask. four copies of an authorization rule are four places for
  // it to drift, and the half that loosens is the half nobody notices. The behaviour is unchanged
  // to the byte: no service token here, because health is the deploy guard's probe and reveals
  // nothing private, so loopback alone is the whole gate, and every refusal is a 404 rather than a
  // 401, because a machine surface does not tell a stranger it is there.
  if (localRefusal(event)) return json({ error: 'not found' }, { status: 404 });

  // Health is what the chat path really does, measured: the store's own synthetic probe (a real durable append, a read back through the read-only
  // index connection and a stream round trip, on a timer), its writer's queue and age, and the libuv threadpool the file routes ride on. A writer
  // thread that hung, a disk that stopped accepting writes or a wedged threadpool each turn `ok` false. What tabs report about their own sends
  // (client-lag.js deliverySummary): a server-only check could say "nothing wrong" while a message was lost.
  const clientDelivery = await deliverySummary().catch((error) => ({ ok: true, error: String(error?.message || error) }));
  const chat = storeHealth();
  const pool = threadpoolState();
  const poolOk = !pool || (!pool.wedged && (pool.misses || 0) < 2);
  // In the shadow phase the legacy store serves and the mirror only has to stay alive; its numbers are shown, not gated, until it stalls.
  // A store that is not ok because the disk is full (`restartHelps: false`) is up and holding events in memory: a restart
  // (the deploy guard's rollback, the watchdog's kickstart) would only throw them away. It is reported as `degraded` with
  // its reason and `chat.ok: false`, and does not turn the server's own `ok` false.
  const chatOk = chat.mode === 'shadow' ? (chat.queue?.inflightMs ?? 0) < 30_000 && (chat.queue?.oldestMs ?? 0) < 30_000 : (chat.ok !== false || chat.restartHelps === false);
  return json({
    ok: chatOk && poolOk,
    ...(chat.ok === false && chat.reason ? { degraded: chat.reason } : {}),
    // Not part of `ok` (a restart cannot fix a browser): the deploy guard's verdict is unchanged, and a person or agent reading health sees the warning.
    ...(clientDelivery.ok === false ? { warning: `client delivery: ${clientDelivery.open.length} send(s) stuck or failed in the last ${Math.round((clientDelivery.windowMs || 0) / 60000)} min (see clientDelivery)` } : {}),
    clientDelivery,
    product: process.env.PRODUCT_NAME || 'tophat',
    instance,
    uptimeSeconds: process.uptime(),
    build: process.env.WEBCHAT_BUILD_ID || 'unknown',
    busy: busyConversations().length,
    live: liveConversations().length,
    store: createHash('sha256').update(storeShape()).digest('hex').slice(0, 12),
    runner: createHash('sha256').update(runnerShape()).digest('hex').slice(0, 12),
    code: bootCodeShape(),
    // The instance's extensions (EXTENSIONS-V1 slot health.fields): what loaded, at which version, what was refused and why.
    ...(process.env.TOPHAT_EXTENSIONS_FILE ? { extensions: await healthOf(await extensions()) } : {}),
    // The shape of the handover record this process writes (code-shape.js handoverShape): deploy.sh compares it with the
    // one the build it is about to restart into accepts, and refuses a restart that would end the live children.
    handover: (handover ??= handoverShape()),
    // Async fs/dns liveness (threadpool-watch.js): null where no watch runs.
    threadpool: pool,
    chat,
    // Telemetry day files (telemetry-log.js): queue depth, rows dropped when the queue was full, last write, files on disk.
    telemetry: telemetryState()
  }, { headers: { 'cache-control': 'no-store' } });
}
