// The entities the demo memory links its notes to: the project, its packages and its main ideas. A note names an entity
// when its text (or a file it touches) matches the entity's pattern; every note names the project.
const pkg = (name, extra = null) => ({ id: `tophat-pkg-${name}`, name: `@tophat-md/${name}`, type: 'software',
  re: new RegExp(`@tophat-md/${name}\\b|packages/${name}\\b${extra ? '|' + extra : ''}`, 'i'), path: `packages/${name}/` });
const idea = (id, name, type, re) => ({ id: `tophat-${id}`, name, type, re });

export const PROJECT = { id: 'tophat-project', name: 'tophat', type: 'project' };
export const ENTITIES = [
  pkg('linknotes', '\\blinknotes\\b|TenantStore'),
  pkg('groups', 'derived page|pagewriters'),
  pkg('viewer', '\\bviewer\\b|memory graph|/graph\\b'),
  pkg('push', 'push plane'),
  pkg('pull', 'context assembly'),
  pkg('runner', '\\brunner\\b'),
  pkg('webchat', '\\bwebchat\\b|SvelteKit|sidebar'),
  pkg('deploy', 'tophat start|tophat instance|launchd'),
  pkg('retrieval', '\\bretrieval\\b'),
  pkg('sources', 'source adapters?|\\bsources\\b'),
  pkg('upkeep', '\\bupkeep\\b'),
  pkg('verify', '\\bfuzz|differential'),
  pkg('tools', null),
  idea('hub', 'hub (ciphertext relay)', 'service', /\bhub\b/i),
  idea('e2e', 'end-to-end encryption', 'concept', /end-to-end|\bE2E\b|ciphertext|AES-256|X25519|WebCrypto|sealed/i),
  idea('scopes', 'scopes and groups', 'concept', /\bscopes?\b|\bgroups?\b|\bmembers?\b/i),
  idea('instance', 'instance file', 'concept', /\binstances?\b|tophat\.instance\.json/i),
  idea('pages', 'derived pages', 'concept', /\bpages?\b/i),
  idea('notes', 'entities, notes and work items', 'concept', /\bnotes?\b|\bentit(?:y|ies)\b|work items?/i),
  idea('sync', 'replica sync', 'concept', /\bsync\b|\breplicas?\b/i),
  idea('intake', 'intake', 'concept', /\bintake\b/i),
  idea('shares', 'share links', 'feature', /share links?|\/s\/|\bshares?\b/i),
  idea('passkeys', 'passkeys', 'feature', /passkey/i),
  idea('sqlite', 'SQLite', 'software', /sqlite/i),
  idea('models', 'model providers', 'concept', /\bproviders?\b|\bmodels?\b|anthropic|openai/i),
  idea('tests', 'tests', 'concept', /\btests?\b|conformance/i),
  idea('release', 'release and assembly', 'concept', /assembl|\brelease\b|traceability|vendored/i),
  idea('budget', 'daily budget', 'concept', /\bbudget\b/i),
  idea('mcp', 'MCP server', 'software', /\bmcp\b/i),
  idea('privacy', 'privacy and blocklist', 'concept', /privacy|blocklist|private/i),
];

/** Entity ids a text (and the files it touches) names; always includes the project. */
export function entitiesOf(text, files = []) {
  const ids = new Set([PROJECT.id]);
  for (const e of ENTITIES) {
    if (e.re && e.re.test(text)) ids.add(e.id);
    if (e.path && files.some((f) => f.startsWith(e.path))) ids.add(e.id);
  }
  return [...ids];
}
