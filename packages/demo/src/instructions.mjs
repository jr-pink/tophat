// The demo agent's standing context, generated from its sources so no text is copied by hand:
// seed/agent-policy.md (what it is and may do), content/agent-context.md (technical reference and FAQ), content/description.md
// (the description the opening answer is made from). The instance's `paths.instructions` points at the generated file.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(DEMO, p), 'utf8').trim();

export function instructionsText() {
  return `${read('seed/agent-policy.md')}\n\n# Technical reference\n\n${read('content/agent-context.md')}\n\n# The description\n\n${read('content/description.md')}\n`;
}

export function writeInstructions(c) {
  const out = path.join(path.dirname(c.file), 'instructions.generated.md');
  mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  const text = instructionsText();
  writeFileSync(tmp, text, { mode: 0o644 }); renameSync(tmp, out);
  return { out, bytes: text.length };
}
