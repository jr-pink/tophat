// A minimal MCP server over stdio (JSON-RPC 2.0, newline-delimited): initialize, tools/list, tools/call. Tool results are
// returned as one text content block holding the JSON result; a tool error is isError: true with the message.
import { createInterface } from 'node:readline';
import { listTools, callTool } from './index.mjs';

export function serve(ctx, { input = process.stdin, output = process.stdout } = {}) {
  const send = (m) => output.write(JSON.stringify(m) + '\n');
  const rl = createInterface({ input });
  rl.on('line', async (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
    const { id, method, params } = msg;
    if (id === undefined) return; // notification
    try {
      if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tophat', version: '0.1.0' } } });
      if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: listTools() } });
      if (method === 'tools/call') {
        try { const r = await callTool(ctx, params.name, params.arguments || {}); return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(r) }] } }); }
        catch (e) { return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: String(e.message) }] } }); }
      }
      if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
      return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } });
    } catch (e) { return send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message) } }); }
  });
  return rl;
}
