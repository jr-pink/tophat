#!/usr/bin/env node
import { retrieveTurnContext } from '../src/lib/server/providers/turn-context.js';
let input = '';
for await (const part of process.stdin) input += part;
let event;
try { event = JSON.parse(input || '{}'); } catch { event = {}; }
const context = await retrieveTurnContext(String(event.prompt || ''), { cwd: event.cwd || process.cwd() });
if (context) process.stdout.write(context);
