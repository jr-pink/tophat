// The permission rules, one copy, used by the replica (offline, before a write lands) and by the
// hub (before a part is accepted and before one is delivered). Roles: read < write < admin.
export const ROLES = ['none', 'read', 'write', 'admin'];
export const rank = (role) => Math.max(0, ROLES.indexOf(role));
export const GROUP_ID = /^[a-z][a-z0-9-]{1,47}$/;
export const USER_ID = /^[a-z][a-z0-9.-]{1,63}$/;
const isId = (re, x) => typeof x === 'string' && re.test(x);
export const CONTROL_TABLES = ['mc_groups', 'mc_members', 'mc_devices', 'mc_keys'];

export class PolicyError extends Error {}

/** Canonical ACL: sorted unique group ids, at least one. */
export function normAcl(acl) {
  if (!Array.isArray(acl) || !acl.length || acl.some((g) => typeof g !== 'string' || !GROUP_ID.test(g))) throw new PolicyError(`acl must be a non-empty list of group ids, got ${JSON.stringify(acl)}`);
  return [...new Set(acl)].sort();
}

/** A CNF with every clause normalized, duplicates and clauses implied by a smaller one removed. */
export function minimizeCnf(clauses) {
  const norm = [...new Map(clauses.map((c) => normAcl(c)).map((c) => [c.join(','), c])).values()];
  return norm.filter((c) => !norm.some((d) => d !== c && d.length < c.length && d.every((g) => c.includes(g))))
    .sort((a, b) => a.join(',').localeCompare(b.join(',')));
}

/** `roleOf(group)` -> role of the acting user. Read access: any one group of the ACL. */
export const canRead = (roleOf, acl) => acl.some((g) => rank(roleOf(g)) >= 1);
export const canWrite = (roleOf, acl) => acl.length > 0 && acl.every((g) => rank(roleOf(g)) >= 2);
export const satisfies = (roleOf, cnf) => cnf.length > 0 && cnf.every((clause) => canRead(roleOf, clause));

/**
 * Whether `actor` may apply one control row, given `state` = { groupExists(g), roleOf(user, g) }.
 * Membership is itself a row in the log: creating a group makes its creator admin; only an admin
 * changes membership or publishes a key; a user registers only their own devices.
 */
export function authorizeControl(state, actor, row) {
  const { t, img } = row;
  if (t === 'mc_groups') {
    if (!isId(GROUP_ID, img.grp)) throw new PolicyError('bad group id');
    if (state.groupExists(img.grp) && rank(state.roleOf(actor, img.grp)) < 3) throw new PolicyError(`group ${img.grp} exists and ${actor} is not its admin`);
    return;
  }
  if (t === 'mc_members') {
    if (!isId(GROUP_ID, img.grp) || !isId(USER_ID, img.user) || !ROLES.includes(img.role)) throw new PolicyError('bad membership row');
    if (!state.groupExists(img.grp)) throw new PolicyError(`no group ${img.grp}`);
    if (rank(state.roleOf(actor, img.grp)) < 3) throw new PolicyError(`${actor} is not an admin of ${img.grp}`);
    return;
  }
  if (t === 'mc_devices') {
    if (img.user !== actor || typeof img.public_key !== 'string' || typeof img.device !== 'string' || !img.device) throw new PolicyError('a user registers only their own devices');
    return;
  }
  if (t === 'mc_keys') {
    if (!state.groupExists(img.grp) || rank(state.roleOf(actor, img.grp)) < 3) throw new PolicyError(`${actor} cannot publish keys for ${img.grp}`);
    if (!Number.isSafeInteger(img.epoch) || img.epoch < 1 || typeof img.device !== 'string' || !img.device || typeof img.wrapped !== 'object' || !img.wrapped) throw new PolicyError('bad key row');
    return;
  }
  throw new PolicyError(`unknown control table ${t}`);
}

/** Who may receive a control row: members of its group (and the member it names); key rows only their device. */
export function controlVisible(row, { user, device, roleOf, sharesGroupWith }) {
  const { t, img } = row;
  if (t === 'mc_keys') return img.device === device;
  if (t === 'mc_devices') return true; // public keys are public; device and user ids are metadata
  if (t === 'mc_members') return img.user === user || rank(roleOf(img.grp)) >= 1;
  if (t === 'mc_groups') return rank(roleOf(img.grp)) >= 1;
  return false;
}
