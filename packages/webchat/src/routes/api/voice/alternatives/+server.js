import { json } from '@sveltejs/kit';
import { readFile } from 'node:fs/promises';
import { averageLogprob, cutSpan, planSpan, rankReadings } from '$lib/core/alternatives.js';
import { clipRecord, readWavHeader } from '$lib/server/dictation.js';
import { FINAL_PORT, LIVE_PORT, modelFor, probe, transcribeBuffer } from '$lib/server/whisper-service.js';

// What else that word could have been.
//
// whisper-server has no n-best list and no alternative tokens: one reading per
// request, and per word only `{word, start, end, probability}`. So the only
// honest answer to "what else could that have been" is to decode the span
// again -- once on large-v3-turbo, which is the reading worth switching to,
// and a few times on base.en at temperatures above zero, where the sampler
// takes tokens the greedy pass would not. The distinct readings are the
// alternatives.
//
// The cost is bounded on purpose, because this is a popup under his thumb:
// one turbo decode, at most four base decodes, a span no longer than eight
// seconds, and a hard deadline after which whatever has arrived is the answer.

const MAX_BASE_DECODES = 4;

// Measured on this Mac against a stored clip of his, warm servers: base.en
// reads a 1.8 s span in about 130 ms, large-v3-turbo in about 1.8 s, and the
// two run against different servers. The deadline is roughly twice the whole
// job, so a slow decode is dropped rather than the request hanging.
const TURBO_MS = 6_000;
const BASE_MS = 3_000;
const WHOLE_MS = 9_000;

// Temperature zero is the same greedy decode the transcript already had, so
// the first fast decode is there to score the current reading; the rest are
// sampled, which is where a second reading comes from at all.
const TEMPERATURES = [0, 0.3, 0.6, 0.9];

const MAX_CLIP_BYTES = 64 * 1024 * 1024;

function asNumber(value) {
  const number = typeof value === 'string' ? Number(value.trim()) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
}

export async function POST({ request }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'that request had no JSON body', kind: 'bad-request' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return json({ error: 'that request had no JSON body', kind: 'bad-request' }, { status: 400 });
  }

  const clipId = typeof body.clip_id === 'string' ? body.clip_id : (typeof body.clipId === 'string' ? body.clipId : '');
  const startSec = asNumber(body.start ?? body.start_sec ?? body.startSec);
  const endSec = asNumber(body.end ?? body.end_sec ?? body.endSec);
  const current = typeof body.text === 'string' ? body.text.slice(0, 400) : '';

  if (!clipId) return json({ error: 'name a clip', kind: 'bad-request' }, { status: 400 });
  if (startSec === null || endSec === null) {
    return json({ error: 'a span needs a start and an end, in seconds', kind: 'bad-request' }, { status: 400 });
  }

  // A clip id from a browser is not trusted: `clipRecord` validates the token,
  // reads the manifest this machine wrote, and refuses a path that resolves
  // outside the dictation directory. Anything it does not recognise is a 404.
  let record;
  try {
    record = clipRecord(clipId);
  } catch {
    record = null;
  }
  if (!record) return json({ error: 'no clip by that name', kind: 'unknown-clip' }, { status: 404 });

  let bytes;
  try {
    bytes = await readFile(record.path);
  } catch {
    return json({ error: 'the audio for that clip is not on this machine', kind: 'unknown-clip' }, { status: 404 });
  }
  if (bytes.length > MAX_CLIP_BYTES) {
    return json({ error: 'that clip is too large to re-decode', kind: 'too-large' }, { status: 413 });
  }
  const header = readWavHeader(bytes);
  if (!header || header.format !== 1 || header.bitsPerSample !== 16) {
    return json({ error: 'that clip is not 16-bit PCM', kind: 'unsupported' }, { status: 415 });
  }

  const plan = planSpan({
    startSec,
    endSec,
    durationSec: Number.isFinite(record.durationSec) && record.durationSec > 0
      ? record.durationSec
      : header.durationSec
  });
  if (!plan.ok) return json({ error: plan.error, kind: 'bad-span' }, { status: plan.status });

  const span = cutSpan(bytes, header, plan);
  if (!span) return json({ error: 'that span holds no audio', kind: 'bad-span' }, { status: 400 });

  const clock = AbortSignal.timeout(WHOLE_MS);
  const signal = AbortSignal.any([clock, request.signal]);
  const started = Date.now();

  const turboModel = modelFor('final');
  const baseModel = modelFor('live');
  // An alternatives popup never boots a decoder. It asks who is already
  // answering, and a server that is not up costs the list one reading rather
  // than costing him twelve seconds of model loading under his thumb.
  const [turboUp, baseUp] = await Promise.all([
    probe(FINAL_PORT).catch(() => false),
    probe(LIVE_PORT).catch(() => false)
  ]);

  const decodes = [];
  const failures = [];

  const name = (model) => (model ? model.split('/').pop().replace(/^ggml-|\.bin$/gu, '') : 'unknown');

  // The accurate reading runs against its own server while the fast ones run
  // against theirs, so the wait is the slower of the two rather than the sum.
  const turbo = turboUp
    ? transcribeBuffer(FINAL_PORT, span.bytes, { scores: true, deadlineMs: TURBO_MS, signal })
      .then((heard) => ({
        text: heard.text,
        model: name(turboModel),
        avgLogprob: averageLogprob(heard.segments),
        primary: true
      }))
      .catch((cause) => { failures.push(`${name(turboModel)}: ${cause.message}`); return null; })
    : Promise.resolve(null);

  if (baseUp) {
    for (const temperature of TEMPERATURES.slice(0, MAX_BASE_DECODES)) {
      if (signal.aborted) break;
      try {
        const heard = await transcribeBuffer(LIVE_PORT, span.bytes, {
          scores: true,
          temperature,
          // Sampling is the point above zero, and a beam search on top of it
          // costs time for a reading the greedy pass already gave.
          beamSize: temperature > 0 ? 1 : 5,
          bestOf: 5,
          deadlineMs: BASE_MS,
          signal
        });
        decodes.push({
          text: heard.text,
          model: name(baseModel),
          avgLogprob: averageLogprob(heard.segments),
          temperature
        });
      } catch (cause) {
        failures.push(`${name(baseModel)} at ${temperature}: ${cause.message}`);
      }
    }
  }

  const accurate = await turbo;
  const readings = rankReadings({
    current,
    decodes: [...(accurate ? [accurate] : []), ...decodes]
  });

  return json({
    clip_id: record.clipId,
    span: {
      start: Number(plan.wordStartSec.toFixed(3)),
      end: Number(plan.wordEndSec.toFixed(3)),
      decoded_start: Number(span.startSec.toFixed(3)),
      decoded_end: Number(span.endSec.toFixed(3))
    },
    current,
    alternatives: readings,
    decodes: decodes.length + (accurate ? 1 : 0),
    latency_ms: Date.now() - started,
    ...(failures.length ? { failures } : {}),
    ...(readings.length ? {} : { note: turboUp || baseUp ? 'nothing else was heard there' : 'no decoder is running' })
  }, { headers: { 'cache-control': 'no-store' } });
}
