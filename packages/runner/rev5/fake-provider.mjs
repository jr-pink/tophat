// A local stand-in for the Messages API, for tests and the synthetic browser
// flow. It speaks the real wire shape (POST /v1/messages, SSE frames in the
// documented order) so the client under test is the one that talks to the
// real service. What it says is decided by `reply(body, n)`, a function of
// the request body and the request ordinal, returning
// {content:[blocks], stop_reason?, status?, usage?} or {status, error}.
import { createServer } from 'node:http';

export function textReply(text, extra = {}) {
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn', ...extra };
}

export function toolReply(name, input, id = `toolu_${Math.random().toString(36).slice(2, 10)}`) {
  return { content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' };
}

/** The last user message's tool_result blocks, so a script can answer what the tools said. */
export function toolResultsOf(body) {
  // A Responses body carries tool results as function_call_output items; answer them in the Messages shape the scripts read.
  if (Array.isArray(body.input)) {
    return body.input.filter((item) => item.type === 'function_call_output')
      .map((item) => ({ type: 'tool_result', tool_use_id: item.call_id, content: item.output, is_error: /\[this tool call failed\]$/.test(item.output) }));
  }
  const last = body.messages[body.messages.length - 1];
  return Array.isArray(last?.content) ? last.content.filter((part) => part.type === 'tool_result') : [];
}

export function lastUserText(body) {
  if (Array.isArray(body.input)) {
    for (let i = body.input.length - 1; i >= 0; i--) {
      const item = body.input[i];
      if (item.role !== 'user') continue;
      const text = typeof item.content === 'string' ? item.content : (item.content || []).filter((p) => p.type === 'input_text').map((p) => p.text).join('\n');
      if (text) return text;
    }
    return '';
  }
  if (typeof body.input === 'string') return body.input;
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const m = body.messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    const text = m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    if (text) return text;
  }
  return '';
}

function frames(reply, model) {
  const usage = reply.usage || { input_tokens: 12, output_tokens: 7 };
  const out = [['message_start', { type: 'message_start', message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: usage.input_tokens, output_tokens: 0 } } }]];
  reply.content.forEach((block, index) => {
    if (block.type === 'text') {
      out.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
      for (const piece of block.text.match(/.{1,9}/gsu) || []) out.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } }]);
    } else if (block.type === 'thinking') {
      // The Messages API streams thinking as its own block: start, thinking_delta pieces, a signature_delta, stop.
      out.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } }]);
      for (const piece of block.thinking.match(/.{1,9}/gsu) || []) out.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: piece } }]);
      out.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature || 'fake-signature' } }]);
    } else if (block.type === 'tool_use') {
      out.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }]);
      // A block may carry `partial_json` instead of `input`: the arguments as far as they got before the output
      // ceiling ended the message, '' for a call whose arguments never started. `cut: true` also withholds
      // content_block_stop, which is what a stream that stops mid block looks like.
      const json = block.partial_json !== undefined ? block.partial_json : JSON.stringify(block.input);
      for (const piece of json.match(/.{1,11}/gsu) || []) out.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: piece } }]);
    }
    if (!block.cut) out.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  out.push(['message_delta', { type: 'message_delta', delta: { stop_reason: reply.stop_reason || 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }]);
  out.push(['message_stop', { type: 'message_stop' }]);
  return out;
}

/** The same reply, as Responses API stream events: reasoning item (when asked for and a tool is called), messages, function calls, completion with usage. */
function responsesFrames(reply, body, n) {
  const id = `resp_${Date.now()}_${n}`;
  const usage = reply.usage || { input_tokens: 12, output_tokens: 7 };
  const out = [['response.created', { type: 'response.created', response: { id, model: body.model, status: 'in_progress' } }]];
  let index = 0;
  const reasoning = (body.include || []).includes('reasoning.encrypted_content') && reply.content.some((b) => b.type === 'tool_use');
  if (reasoning) {
    out.push(['response.output_item.added', { type: 'response.output_item.added', output_index: index, item: { type: 'reasoning', id: `rs_${n}`, summary: [] } }]);
    out.push(['response.output_item.done', { type: 'response.output_item.done', output_index: index, item: { type: 'reasoning', id: `rs_${n}`, summary: [], encrypted_content: `enc_${n}` } }]);
    index += 1;
  }
  for (const block of reply.content) {
    if (block.type === 'text') {
      const itemId = `msg_${n}_${index}`;
      out.push(['response.output_item.added', { type: 'response.output_item.added', output_index: index, item: { type: 'message', id: itemId, role: 'assistant', status: 'in_progress', content: [] } }]);
      for (const piece of block.text.match(/.{1,9}/gsu) || []) out.push(['response.output_text.delta', { type: 'response.output_text.delta', item_id: itemId, output_index: index, content_index: 0, delta: piece }]);
      out.push(['response.output_text.done', { type: 'response.output_text.done', item_id: itemId, output_index: index, content_index: 0, text: block.text }]);
      out.push(['response.output_item.done', { type: 'response.output_item.done', output_index: index, item: { type: 'message', id: itemId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: block.text, annotations: [] }] } }]);
    } else if (block.type === 'tool_use') {
      const itemId = `fc_${n}_${index}`, args = JSON.stringify(block.input);
      out.push(['response.output_item.added', { type: 'response.output_item.added', output_index: index, item: { type: 'function_call', id: itemId, call_id: block.id, name: block.name, arguments: '', status: 'in_progress' } }]);
      for (const piece of args.match(/.{1,11}/gsu) || []) out.push(['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: itemId, output_index: index, delta: piece }]);
      out.push(['response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: itemId, output_index: index, arguments: args }]);
      out.push(['response.output_item.done', { type: 'response.output_item.done', output_index: index, item: { type: 'function_call', id: itemId, call_id: block.id, name: block.name, arguments: args, status: 'completed' } }]);
    }
    index += 1;
  }
  const finalUsage = { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, input_tokens_details: { cached_tokens: usage.cache_read_input_tokens || 0 }, output_tokens_details: { reasoning_tokens: reasoning ? 3 : 0 } };
  if (reply.stop_reason === 'max_tokens') out.push(['response.incomplete', { type: 'response.incomplete', response: { id, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: finalUsage } }]);
  else out.push(['response.completed', { type: 'response.completed', response: { id, status: 'completed', usage: finalUsage } }]);
  return out;
}

/**
 * Start the fake on a loopback port. Returns {url, requests, close, delayMs}.
 * `requests` holds every parsed body in order; a script may also set
 * `state.delayMs` so a test can interrupt mid-stream.
 */
export async function startFakeProvider({ reply = () => textReply('ok'), key = null } = {}) {
  const requests = [];
  const state = { delayMs: 0, open: new Set() };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'fake-model', type: 'model' }] }));
        return;
      }
      const responses = req.url === '/v1/responses';
      if (req.method !== 'POST' || (req.url !== '/v1/messages' && !responses)) { res.writeHead(404); res.end('{}'); return; }
      if (key && (responses ? req.headers.authorization !== `Bearer ${key}` : req.headers['x-api-key'] !== key)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
        return;
      }
      let body;
      try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end('{}'); return; }
      requests.push(body);
      const answer = await reply(body, requests.length);
      if (answer.status) {
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(responses ? { error: answer.error || { type: 'server_error', code: 'synthetic', message: 'synthetic failure' } }
          : { type: 'error', error: answer.error || { type: 'api_error', message: 'synthetic failure' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      state.open.add(res);
      for (const [name, event] of (responses ? responsesFrames(answer, body, requests.length) : frames(answer, body.model))) {
        if (res.destroyed) break;
        res.write(`event: ${name}\ndata: ${JSON.stringify(event)}\n\n`);
        if (state.delayMs && (name === 'content_block_delta' || name === 'response.output_text.delta')) await new Promise((r) => setTimeout(r, state.delayMs));
      }
      state.open.delete(res);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, requests, state,
    close: () => new Promise((resolve) => { for (const r of state.open) r.destroy(); server.close(() => resolve()); })
  };
}

// `node rev5/fake-provider.mjs` runs one on a fixed port for a manual or browser run.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const fake = await startFakeProvider({
    reply: (body) => {
      const results = toolResultsOf(body);
      if (results.length) return textReply(`The tool said: ${String(results[0].content).slice(0, 200)}`);
      const text = lastUserText(body);
      const wants = /write (?:a )?file (\S+)/i.exec(text);
      if (wants) return toolReply('write_file', { path: wants[1], content: `written by the fake model for: ${text}\n` });
      return textReply(`Fake reply to: ${text.slice(0, 120)}`);
    }
  });
  process.stdout.write(`${fake.url}\n`);
}
