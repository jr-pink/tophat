// An unreadable vault is told apart from a vault that is merely offline: the store is there but
// its records do not open (sealed under another AAD prefix, wrong key), and no retry fixes that.
export function unavailable(cause) {
  if (/integrity/i.test(cause?.message || '') || /catalog unavailable/i.test(cause?.message || ''))
    return { error: 'Credential catalog unavailable', reason: 'unreadable',
      hint: 'The vault records do not open. If the store was sealed under an older prefix, set TOPHAT_VAULT_LEGACY_AAD_PREFIX to it and restart.' };
  return { error: 'Credential catalog unavailable' };
}
