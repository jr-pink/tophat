// Model families, client-safe (no verb table): a chat on auto is on a family, which resolves to its newest model, so
// an older Opus (claude-opus-5) moves to claude-opus-5-5 by itself. The newest model per family is the one line to
// edit when 6 ships.

export const FAMILY_LATEST = Object.freeze({
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5'
});
export const FAMILY_EFFORT = Object.freeze({ opus: 'medium', sonnet: 'medium', haiku: 'medium' });

export function familyOf(model) {
  const match = /^claude-(opus|sonnet|haiku)-/.exec(String(model || ''));
  return match ? match[1] : null;
}

/** The newest model of this model's family; a model with no family (fable, gpt) is returned as it is. */
export function latestOf(model) {
  const family = familyOf(model);
  return family ? FAMILY_LATEST[family] : model;
}

