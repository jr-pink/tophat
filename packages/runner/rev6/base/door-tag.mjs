// The door grant a turn runs under, read from the door notice his home host puts in his message (webchat host-door.js; HOST-DESIGN.md item
// 5). The team host's runner tags each subagent, background turn and job a turn starts with that grant id (agents.door, jobs.door), so the
// home host can ask whether anything of that turn still runs and keep its door open until the last of it ends. '' is "started under no
// door"; NULL is a row written before the column existed.
//
// The notice names one fixed tool path per chat (~/.tophat-doors/<chat>/door) and carries the grant as `door grant <id>`: the runner reads
// it here for the tag; an agent never passes it anywhere (the tool identifies its caller by TOPHAT_AGENT_ID and the home host maps that
// to a grant). Notices written before 2026-11-18 named a per-grant path (.tophat-doors/<chat>/<grant>/door); both are read.
export const DOOR_TOOL_PATTERN = /\.tophat-doors\/[A-Za-z0-9._-]+\/([A-Za-z0-9]{1,64})\/door\b/u; // legacy per-grant path
const GRANT_WORDS = /\bdoor grant ([A-Za-z0-9]{1,64})\b/u;
const NOTICE = /\[Automated event from [^\]\n]*?(?:\bdoor grant [A-Za-z0-9]{1,64}\b|\.tophat-doors\/[A-Za-z0-9._-]+\/[A-Za-z0-9]{1,64}\/door\b)[^\]\n]*\]/u;

/** { grant, notice } for the door a text names, else null. `notice` is the whole bracketed line when present (what a subagent brief carries). */
export function doorOf(text) {
  const s = String(text ?? '');
  const notice = NOTICE.exec(s)?.[0] || null;
  const grant = (notice && GRANT_WORDS.exec(notice)?.[1]) || (notice ? DOOR_TOOL_PATTERN.exec(notice)?.[1] : DOOR_TOOL_PATTERN.exec(s)?.[1]);
  return grant ? { grant, notice } : null;
}

/** A subagent brief with the turn's door line added when the brief does not already carry a door line. */
export function withDoorNotice(prompt, door) {
  const p = String(prompt ?? '');
  if (!door?.notice || doorOf(p)) return p;
  return `${p}\n\n${door.notice}`;
}
