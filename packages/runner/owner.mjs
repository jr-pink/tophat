// Who this instance serves. `owner.label` in the instance file reaches every child as TOPHAT_OWNER_NAME, and the
// prompts, rules and UI strings that used to name a person read it here instead. A group runner is an instance whose
// label is the group ("the lab"), so the same sentence serves both. The default is deliberately impersonal.
export const DEFAULT_OWNER = 'the owner';
/** The owner label, read at call time (a long-lived process may be re-execed with another instance's environment). */
export function owner(env = process.env) {
  const v = typeof env?.TOPHAT_OWNER_NAME === 'string' ? env.TOPHAT_OWNER_NAME.trim() : '';
  return v || DEFAULT_OWNER;
}
/** The possessive form: "Sam's", "the lab's", "the owner's". */
export function ownerPossessive(env = process.env) {
  const o = owner(env);
  return /s$/i.test(o) ? `${o}'` : `${o}'s`;
}
