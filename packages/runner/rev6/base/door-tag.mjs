// The door grant a turn runs under, read from the door notice his home host puts in his message (webchat host-door.js; HOST-DESIGN.md
// item 5). The team host's runner tags each subagent, background turn and job a turn starts with that grant id (agents.door, jobs.door),
// so the home host can ask whether anything of that turn still runs and keep its door open until the last of it ends. '' is "started under no door"; NULL is a row
// written before the column existed.
export const DOOR_TOOL_PATTERN = /\.tophat-doors\/[A-Za-z0-9._-]+\/([A-Za-z0-9]{1,64})\/door\b/u;
const NOTICE = /\[Automated event from [^\]\n]*?\.tophat-doors\/[A-Za-z0-9._-]+\/[A-Za-z0-9]{1,64}\/door\b[^\]\n]*\]/u;

/** { grant, notice } for the door a text names, else null. `notice` is the whole bracketed line when present (what a subagent brief carries). */
export function doorOf(text) {
  const s = String(text ?? '');
  const m = DOOR_TOOL_PATTERN.exec(s);
  if (!m) return null;
  return { grant: m[1], notice: NOTICE.exec(s)?.[0] || null };
}

/** A subagent brief with the turn's door line added when the brief does not already name the tool. */
export function withDoorNotice(prompt, door) {
  const p = String(prompt ?? '');
  if (!door?.notice || DOOR_TOOL_PATTERN.test(p)) return p;
  return `${p}\n\n${door.notice}`;
}
