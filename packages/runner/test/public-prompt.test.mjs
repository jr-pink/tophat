// TOPHAT_RUNNER_PROMPT_MODE=public: the system prompt of an instance that serves strangers names the tools it has and no filesystem location.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselinePrompt, createInstructions, publicPrompt, rootSystem } from '../rev6/pull/context.mjs';
import { withoutHome } from '../rev6/pull/tools.mjs';

const home = mkdtempSync(join(tmpdir(), 'pub-'));
const cwd = join(home, '.local', 'state', 'inst', 'workspace');
mkdirSync(cwd, { recursive: true });
const instructionsFile = join(home, 'instructions.generated.md');
writeFileSync(instructionsFile, 'Answer questions about the project only.');
const stateDir = join(home, 'state'); mkdirSync(stateDir);
writeFileSync(join(stateDir, 'baseline.md'), 'A deployment note.');
const store = { installed: true, db: join(home, 'memory.sqlite') };
const tools = { confined: false, roots: ['/'], specs: [{ name: 'memory_search' }, { name: 'memory_read' }], computerPrompt: () => '', mail: null };
const build = (env) => rootSystem({ cwd, tools, store, goals: null, agents: null, env,
  baseline: baselinePrompt({ env }), instructions: createInstructions({ cwd, env: { ...env, TOPHAT_RUNNER_INSTRUCTIONS_FILE: instructionsFile } }).prompt() });

test('off by default: the owner prompt carries the working directory and the store file', () => {
  assert.equal(publicPrompt({}), false);
  const text = build({});
  assert.ok(text.includes(cwd) && text.includes(store.db));
});

test('public: the tools it has, no path under the home directory, no owner-machine rules', () => {
  const env = { TOPHAT_RUNNER_PROMPT_MODE: 'public', TOPHAT_RUNNER_BASELINE_FILE: join(stateDir, 'baseline.md'), TOPHAT_RUNNER_INSTRUCTIONS_FILE: instructionsFile };
  const instructions = createInstructions({ cwd, env });
  const text = rootSystem({ cwd, tools, store, goals: null, agents: null, env, baseline: baselinePrompt({ env }), instructions: instructions.prompt() });
  assert.ok(!text.includes(home), 'no home path');
  assert.ok(!text.includes('/Users/') && !/Working directory|Allowed file roots|Memory store/.test(text));
  assert.match(text, /Your tools: memory_search, memory_read\. You have no others/);
  assert.ok(text.includes('Answer questions about the project only.') && text.includes('A deployment note.'));
  assert.ok(!/read_document|messages_recent|mail_send|Dictated|shell/.test(text));
});

test('public: a tool result shows the home directory as ~', () => {
  assert.equal(withoutHome({ content: `Error in ${home}/a/b.mjs`, isError: true }, home).content, 'Error in ~/a/b.mjs');
  assert.deepEqual(withoutHome({ content: [{ type: 'text', text: `${home}/x` }, { type: 'image' }] }, home).content, [{ type: 'text', text: '~/x' }, { type: 'image' }]);
});
