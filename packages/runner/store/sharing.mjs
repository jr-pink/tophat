// What the model is told when its instance has joined a shared memory group (scope.join; `tophat instance join`). Hand-written,
// beside the store: the product has one place where this rule lives. `tophat instance join` writes it into the instance's
// instructions file between two markers (the instance's own instructions, never an assembled prompt), so the owner can read, edit
// or delete it; a rule is judgment and sits in the prompt, while the content screens in memory.mjs are the mechanism that refuses
// secrets, home paths and the private-people roster.
//
// Only memory notes replicate. A customization or a bugfix is shared as a note that describes it (what it is, why, how to apply it);
// configuration, instructions, skills and code are never synced.

export const SHARING_BEGIN = (group) => `<!-- tophat:sharing ${group} begin (written by \`tophat instance join\`; delete the block to stop the guidance) -->`;
export const SHARING_END = (group) => `<!-- tophat:sharing ${group} end -->`;

/** The guidance text for one joined group. */
export function sharingGuidance({ group = 'tophat-users' } = {}) {
  return [
    `Sharing with ${group}. The owner has opted this instance in to the shared memory group \`${group}\`: other tophat users' instances, through a hub that holds ciphertext only. Only memory notes travel through it. Configuration, instructions, skills, code and files are never synced, so what you share is a note that describes the thing.`,
    `To share, write the note with memory_apply and set \`groups: ["${group}"]\` on it (on the note, or on the batch). A note without \`groups\` stays private to this instance, and that is the default. Until the group's admin has added this instance and the key has arrived by sync, a write into the group is refused with that reason: say so once and keep the note private; the group will take it later.`,
    'What to share, by your own judgment (a rule of thumb, not a filter):',
    `- Bugfixes, always. When you fix something in tophat itself or in how it runs (a crash, a wrong result, a broken setup step, a tool that failed), write a note: the symptom and the exact error text, the cause, the fix, and the version or setup it applies to. Another instance should be able to apply it from the note alone.`,
    '- Customizations the owner made, when they seem good, relevant, and something most tophat users would want (a prompt rule that works, a source or tool setup, a routine, a way of organizing memory). Write a note: what it is, why it helps, and how to apply it, step by step, with the exact text, setting or command. Leave out customizations that only make sense for this owner.',
    '- Cool things people built on tophat: a note on what it does, how it was built and what it needs.',
    'What never goes in a shared note: anything about a person, the owner\'s private life, messages, mail, calendar, health or money; credentials, tokens or keys; file paths under the home directory; names, addresses, account ids. Describe the technique in general terms ("a mail source", "a daily routine"), written so it makes sense to a stranger. If you are not sure a note is safe to share, keep it private. The store refuses text that matches its content screens (secrets, home paths, the private-people roster): reword the note in general terms and write it again, never work around a screen.',
    'Share when the work is done, as part of it, and tell the owner in one short line what you shared. If the owner says not to share something, do not.',
  ].join('\n');
}

/** `text` with the marked block for `group` replaced by `block` (appended when absent); the rest of the text untouched. */
export function withSharingBlock(text, group, block) {
  const begin = SHARING_BEGIN(group), end = SHARING_END(group);
  const body = `${begin}\n${block}\n${end}`;
  const s = String(text ?? '');
  const i = s.indexOf(begin), j = s.indexOf(end);
  if (i >= 0 && j > i) return `${s.slice(0, i)}${body}${s.slice(j + end.length)}`;
  return `${s}${s && !s.endsWith('\n') ? '\n' : ''}${s ? '\n' : ''}${body}\n`;
}
