#!/usr/bin/env node
// tophat setup | chat | graph: the first-run path of a local instance.
//   tophat setup [--name me] [--branch NAME | --no-branch] [--owner LABEL] [--email ADDR] [--port 4178] [--key-file PATH | --key-env NAME]
//                [--model ID] [--base-url URL] [--workspace-id-file PATH] [--config FILE] [--no-confine]
//                [--no-install] [--no-start] [--rebuild] [--force]
//       npm install and the webchat build when missing, the instance file (default ~/.config/tophat/<name>/tophat.instance.json),
//       the model key copied 0600 into the instance's keyring (from --key-file, else $ANTHROPIC_API_KEY or --key-env),
//       then the instance started in the background and its health checked. Re-runnable; prints JSON with next steps.
//   tophat chat --config FILE [--conversation ID] [--timeout S] TEXT
//       one chat turn through the running instance, as its owner; prints the replies and the tools the agent used
//   tophat graph --config FILE [--port 4179]
//       the memory graph of the instance's own replica, on http://localhost:4179/graph (foreground; Ctrl-C stops it)
import path from 'node:path';
import { chat, defaultConfigFile, graph, setup } from '../src/setup.mjs';

const args = process.argv.slice(2);
const cmd = args.shift();
const flag = (n) => { const i = args.indexOf(n); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const has = (n) => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true; };
const out = (v) => console.log(JSON.stringify(v, null, 1));
const die = (m, code = 2) => { console.error(`tophat ${cmd || ''}: ${m}`); process.exit(code); };

try {
  if (cmd === 'setup') {
    const o = { name: flag('--name'), owner: flag('--owner'), email: flag('--email'), port: flag('--port'), keyFile: flag('--key-file'), keyEnv: flag('--key-env'),
      model: flag('--model'), baseUrl: flag('--base-url'), workspaceIdFile: flag('--workspace-id-file'), config: flag('--config'),
      confine: !has('--no-confine'), install: !has('--no-install'), start: !has('--no-start'), rebuild: has('--rebuild'), force: has('--force'), branch: has('--no-branch') ? false : flag('--branch') };
    if (args.length) die(`unknown arguments: ${args.join(' ')}`);
    const r = await setup(o);
    out(r);
    process.exit(r.ok ? 0 : 3);
  } else if (cmd === 'chat') {
    const configFile = path.resolve(flag('--config') || defaultConfigFile('me'));
    const conversation = flag('--conversation');
    const timeout = Number(flag('--timeout') || 300);
    const text = args.join(' ').trim();
    if (!text) die('usage: tophat chat --config FILE TEXT');
    const r = await chat({ configFile, text, conversation, timeoutMs: timeout * 1000 });
    out(r);
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'graph') {
    const configFile = path.resolve(flag('--config') || defaultConfigFile('me'));
    const { url } = await graph({ configFile, port: Number(flag('--port') || 4179) });
    console.log(`memory graph: ${url}   (loopback only; Ctrl-C stops it)`);
  } else die('usage: tophat setup|chat|graph ... (see the header of packages/deploy/bin/tophat-setup.mjs)');
} catch (e) { die(e.message, 1); }
