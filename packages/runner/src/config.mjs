import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {refuseLiveUnderTest, underTest} from './live-state-guard.mjs';
import {routeFor} from '../rev6/pull/routes.mjs';

const KNOWN_KEYS = ['version', 'profile', 'paths', 'install', 'ingress', 'heartbeat',
  'models', 'evaluation', 'briefs', 'delivery', 'mail', 'sources', 'speech', 'recognition', 'work',
  'exobrain', 'rev5', 'scopes'];

/**
 * Every model the runtime reads, declared once. `setup model` writes from this
 * list and `loadConfig` defaults from it, so a key can never be readable and
 * unwritable at the same time -- which is what `comprehension` was: read by
 * the heartbeat, defaulted to null here, and settable by nothing.
 */
export const MODEL_KEYS = ['gate', 'writer', 'comprehension'];

export function loadConfig({home, configFile, overrides = {}} = {}) {
  // A caller that names a home means that home. Outside tests TOPHAT_CONFIG still
  // fills in the file, as before; inside a test it never does when a home was
  // given, because the live config's absolute `paths` would replace the temp
  // home's.
  const explicitHome = home !== undefined;
  home ??= os.homedir();
  configFile ??= (explicitHome && underTest()) ? undefined : process.env.TOPHAT_CONFIG;
  const configDir = path.join(home, '.config/tophat');
  const file = configFile || path.join(configDir, 'config.json');
  const user = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const raw = {...user, ...overrides};
  // Everything loadConfig reads. An unrecognised key is a typo, or a setting
  // that lives in its own file -- retrieval corpora in retrieval.json, archive
  // jobs under the state directory -- and either way the object built below
  // would drop it without a word, so a job configured in the wrong place does
  // nothing and nothing says why.
  const unknown = Object.keys(raw).filter(key => !KNOWN_KEYS.includes(key));
  if (unknown.length) throw new Error(`Unknown configuration key(s): ${unknown.sort().join(', ')}`);
  const config = {
    version: 1,
    profile: {name: 'User', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...raw.profile},
    paths: {configDir, dataDir: path.join(home, '.local/share/tophat'), stateDir: path.join(home, '.local/state/tophat'), workspaceDir: path.join(home, '.local/share/tophat/workspace'), ...raw.paths},
    // Two owners on one machine share launchd and the loopback interface, so the
    // service label prefix and the local port are configured rather than fixed.
    install: {serviceLabelPrefix: 'io.tophat', webchatPort: 4178, productName: 'tophat', ...raw.install},
    // The rev5 runner is the same webchat process with its own stores, its own
    // model credential and its own instructions file. Only names and switches
    // live here: every path it uses is derived from `paths` at install time, so
    // an installed release stays immutable code and everything that changes
    // sits under the config, state and data directories.
    rev5: {enabled: false, model: 'claude-opus-5-5', maxTokens: 16000, askRoot: null,
      searxngUrl: null, instructionsFile: null, instructionsMaxBytes: null, cuaConfig: null,
      // No default in code: the value lives only in config.json (rev6/pull/background.mjs refuses without it).
      backgroundTurnMinGeneratingMs: null, ...raw.rev5},
    // Public ingress is absent until the owner declares it, so the default is
    // null rather than an empty object: nothing here guesses a hostname.
    ingress: raw.ingress === undefined ? null : raw.ingress,
    heartbeat: {intervalSeconds: 300, engine: 'understanding', calls: 60, mode: 'gated', maxRecords: 200, maxInputChars: 60000,
      // Seconds the rev5/rev6 push heartbeat's poll subprocess may run before it is killed ('intake timed out'). null here on
      // purpose: the value lives only in config.json (this key is validated, never defaulted), and rev5-heartbeat.mjs refuses to run without it.
      pushTimeoutSeconds: null, ...raw.heartbeat,
      cadences: {day: 300, week: 86400, evergreen: 86400, ...raw.heartbeat?.cadences}},
    models: {...Object.fromEntries(MODEL_KEYS.map(key => [key, null])), ...raw.models},
    evaluation: {codeCapture: null, nightly: null, ...raw.evaluation},
    briefs: raw.briefs || [],
    delivery: {destinations: [], defaultDestination: null, enabled: false, post: false, schedule: {everySeconds: 60}, ...raw.delivery},
    // Off until the owner turns it on, and reading-only even then: `apply` is a
    // second switch because filing writes into their document tree, and an
    // agent enabling that on a schedule is not the same decision as enabling
    // the diagnostic. The rules and the filing root are private, so they live
    // in `settingsFile` outside this repository rather than in the config.
    mail: {enabled: false, settingsFile: null, apply: false, schedule: {everySeconds: 900}, ...raw.mail},
    // Scoped accounts (src/scopes/). Off by default, so a single-owner install behaves as before.
    // authBase is the sign-in service, orgDomain the one email domain allowed in (no leading @),
    // registryFile the JSON registry.
    scopes: {enabled: false, registryFile: null, authBase: null, orgDomain: null, publicBase: null, ...raw.scopes},
    sources: raw.sources || [],
    // Speech validates itself in `speechSettings`, which owns the closed key
    // list for this block; passing it through is all loadConfig has to do, and
    // a second validator here would be two places to keep in step.
    speech: raw.speech ?? {},
    // Same for recognition, whose closed key list lives in
    // `recognitionSettings`.
    recognition: raw.recognition ?? {},
    work: {enabled: false, allowedEffects: ['private-artifact'], leaseSeconds: 60, ...raw.work},
    // The exobrain plane: owner-turn BIG, SMALL selections, effects and pages.
    // Off until the owner turns it on, because every tick of it can reach a
    // paid provider. Every default here is documented in docs/exobrain.md and
    // validated by `validateExobrain`, which refuses an unknown key for the
    // reason the nightly block gives: a misspelled `enabled` reads exactly
    // like a plane somebody deliberately left off.
    exobrain: {
      enabled: false,
      webchatStore: path.join(configDir, 'webchat/events.sqlite'),
      ownerConversations: '*',
      smallSources: ['owner', 'human', 'assistant'],
      callsPerTick: 60,
      maxUsdPerTick: 4,
      maxBigUsdPerDay: 12,
      maxPacketBytes: 400000,
      pageQuietMinutes: 30,
      quietSeconds: 120,
      arrivalsPerTick: 200,
      // Events-plane rows a live tick admits. The plane holds 4.9M rows and a
      // tick should land a few minutes of arrivals, not a history; the
      // backfill is what reads a window of the past.
      eventsPerTick: 500,
      ownerTurnsPerTick: 5,
      // The heartbeat's thread lane (thread-turn.mjs): one BIG call per thread
      // with new owner/human arrivals per tick. `threadLaneSince` is the ISO
      // instant the lane started; arrivals observed before it are history.
      threadTurnsPerTick: 5,
      threadBatchCap: 40,
      threadWindowLimit: null,
      threadLaneSince: null,
      threadTurnIntent: 'exobrain-thread-turn',
      threadRoles: null,
      pagesPerTick: 5,
      followupsPerTick: 2,
      ...raw.exobrain,
      caps: {BIG: 2400, FOLLOWUP: 2400, PAGE: 1200, SMALL: 180, ...raw.exobrain?.caps},
      // Empty by design: an unconfigured sink is what stops a backfill sending
      // a historical reminder to a real person. Nothing here holds a secret;
      // `tokenFile` names a file the owner already has.
      reminder: {channelId: '', ownerId: '', tokenFile: null, ...raw.exobrain?.reminder},
      // The read executor. Off by default, because a read leaves the machine:
      // `reads.mjs` fetches a URL, queries Gmail and reads a file, and a tick
      // that did that because nobody said not to is the wrong default for a
      // plane whose whole job is bounded. On, a settled read's result reaches
      // the next FOLLOWUP packet; off, the reads stay pending and the report
      // counts them, which is the visible gap docs/exobrain.md §5 describes.
      reads: {enabled: false, ...raw.exobrain?.reads},
      backfill: {
        sourcePath: path.join(home, '.config/tophat/old/webchat/events.sqlite'),
        windowDays: 14,
        bigBudgetUsd: 60,
        ...raw.exobrain?.backfill,
      },
    },
  };
  if (raw.version !== undefined && raw.version !== 1) throw new Error('Unsupported config version');
  if (!Number.isSafeInteger(config.heartbeat.intervalSeconds) || config.heartbeat.intervalSeconds < 10) throw new Error('heartbeat.intervalSeconds must be an integer >= 10');
  if (!['understanding', 'legacy'].includes(config.heartbeat.engine)) throw new Error('Invalid heartbeat.engine');
  if (!Number.isSafeInteger(config.heartbeat.calls) || config.heartbeat.calls < 0) throw new Error('Invalid heartbeat.calls');
  if (config.heartbeat.pushTimeoutSeconds !== null && (!Number.isSafeInteger(config.heartbeat.pushTimeoutSeconds) || config.heartbeat.pushTimeoutSeconds < 30)) throw new Error('heartbeat.pushTimeoutSeconds must be an integer >= 30 (seconds) or unset');
  for (const key of ['maxRecords','maxInputChars']) if (!Number.isSafeInteger(config.heartbeat[key]) || config.heartbeat[key] <= 0) throw new Error(`Invalid heartbeat.${key}`);
  for (const [key,value] of Object.entries(config.heartbeat.cadences)) if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid cadence ${key}`);
  for (const value of Object.values(config.paths)) if (!path.isAbsolute(value)) throw new Error('All configured paths must be absolute');
  const prefix = config.install.serviceLabelPrefix;
  if (typeof prefix !== 'string' || prefix.length > 100 || !/^[a-z][a-z0-9]*([.-][a-z0-9]+)*$/i.test(prefix)) throw new Error('install.serviceLabelPrefix must be a reverse-DNS style prefix');
  // The product's display name is configuration, so a second product built from this tree (tophat) is a
  // config value and an env var rather than a fork; every consumer reads it through src/product.mjs.
  if (typeof config.install.productName !== 'string' || !/^[a-z][a-z0-9 _-]{0,39}$/i.test(config.install.productName)) throw new Error('install.productName must be a short plain name');
  const port = config.install.webchatPort;
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('install.webchatPort must be a port between 1024 and 65535');
  validateRev5(config.rev5);
  validateNightly(config.evaluation.nightly);
  validateMail(config.mail);
  validateIngress(config.ingress);
  if (!Array.isArray(config.sources)) throw new Error('sources must be an array');
  const ids = new Set();
  for (const source of config.sources) {
    if (!source || !/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(source.id || '') || ids.has(source.id)) throw new Error('Source IDs must be unique safe identifiers');
    ids.add(source.id);
    if (!source.kind || typeof source.kind !== 'string') throw new Error('Source kind required');
    source.enabled = source.enabled === true;
    source.config ||= {};
    source.policy = {model:'deny', publish:'none', ...source.policy};
    if (!['allow','deny'].includes(source.policy.model) || !['full','label-only','none'].includes(source.policy.publish)) throw new Error('Invalid source privacy policy');
  }
  validateDelivery(config.delivery);
  validateExobrain(config.exobrain);
  for (const key of ['stateDir', 'dataDir', 'workspaceDir']) refuseLiveUnderTest(config.paths[key], `loadConfig paths.${key}`);
  return config;
}

export function initializePaths(config) {
  for (const dir of Object.values(config.paths)) { fs.mkdirSync(dir, {recursive:true, mode:0o700}); fs.chmodSync(dir,0o700); }
  for (const dir of ['workspaces','memory','context']) fs.mkdirSync(path.join(config.paths.workspaceDir,dir), {recursive:true,mode:0o700});
}

export function saveConfig(config, {configFile = path.join(config.paths.configDir,'config.json')} = {}) {
  fs.mkdirSync(path.dirname(configFile), {recursive:true,mode:0o700});
  const temporary = `${configFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(config,null,2)+'\n', {mode:0o600});
  fs.renameSync(temporary,configFile);
  fs.chmodSync(configFile,0o600);
  return configFile;
}

// Every key is listed, and an unlisted one is refused by name. A misspelled
// `enabled` or `post` would otherwise read exactly like a switch the owner
// deliberately left off, and a misspelled `credentialRef` exactly like a
// destination with no credential, so the two failures must not share a status.
const DELIVERY_KEYS = ['destinations', 'defaultDestination', 'enabled', 'post', 'schedule', 'webchat'];
const DESTINATION_KEYS = ['id', 'transport', 'accountId', 'channelId', 'allowedAuthorIds', 'credentialRef'];
const WEBCHAT_KEYS = ['url', 'credentialRef'];

function validateCredentialRef(ref, label) {
  if (ref === undefined) return;
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(ref)) if (!['file', 'vaultId'].includes(key)) throw new Error(`Unknown ${label} key: ${key}`);
  if (Boolean(ref.file) === Boolean(ref.vaultId)) throw new Error(`${label} needs exactly one of file or vaultId`);
  if (ref.file !== undefined && (typeof ref.file !== 'string' || !path.isAbsolute(ref.file))) {
    throw new Error(`${label}.file must be an absolute path`);
  }
}

export function validateDelivery(delivery) {
  if (!delivery || !Array.isArray(delivery.destinations)) throw new Error('Invalid delivery destinations');
  for (const key of Object.keys(delivery)) if (!DELIVERY_KEYS.includes(key)) throw new Error(`Unknown delivery key: ${key}`);
  for (const key of ['enabled', 'post']) {
    if (delivery[key] !== undefined && typeof delivery[key] !== 'boolean') throw new Error(`delivery.${key} must be true or false`);
  }
  if (delivery.schedule !== undefined && (!delivery.schedule || typeof delivery.schedule !== 'object' || Array.isArray(delivery.schedule))) {
    throw new Error('delivery.schedule must be an object');
  }
  if (delivery.webchat !== undefined) {
    if (!delivery.webchat || typeof delivery.webchat !== 'object' || Array.isArray(delivery.webchat)) throw new Error('delivery.webchat must be an object');
    for (const key of Object.keys(delivery.webchat)) if (!WEBCHAT_KEYS.includes(key)) throw new Error(`Unknown delivery.webchat key: ${key}`);
    if (delivery.webchat.url !== undefined && typeof delivery.webchat.url !== 'string') throw new Error('delivery.webchat.url must be a string');
    validateCredentialRef(delivery.webchat.credentialRef, 'delivery.webchat.credentialRef');
  }
  const ids = new Set();
  const opaque = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value);
  for (const d of delivery.destinations) {
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(d.id || '') || ids.has(d.id)) throw new Error('Invalid destination ID');
    ids.add(d.id);
    for (const key of Object.keys(d)) if (!DESTINATION_KEYS.includes(key)) throw new Error(`Unknown destination key: ${key}`);
    validateCredentialRef(d.credentialRef, `destination ${d.id} credentialRef`);
    const invalidDestination = !/^[a-z][a-z0-9-]{0,40}$/.test(d.transport || '')
      || !/^[a-zA-Z0-9_-]{1,100}$/.test(d.accountId || '')
      || !opaque(d.channelId)
      || !Array.isArray(d.allowedAuthorIds)
      || !d.allowedAuthorIds.length
      || !d.allowedAuthorIds.every(opaque);
    if (invalidDestination) {
      throw new Error('Destination requires transport, account, channel and allowed authors');
    }
  }
  if (delivery.defaultDestination !== null && !ids.has(delivery.defaultDestination)) throw new Error('Unknown default destination');
}

/** A mistyped nightly block reads exactly like a deliberately disabled one:
 * the runner checks `enabled` and returns `disabled` for ever, so a suite
 * nobody turned on and a suite nobody spelled right report the same status.
 * Unknown keys are refused for that reason, since `enable` or `casesFiles`
 * is the whole failure. */
// A rev5 block that is wrong must fail while the owner is configuring it, not
// at the first message of a conversation on a machine they walked away from.
export function validateRev5(rev5) {
  if (rev5.enabled !== true && rev5.enabled !== false) throw new Error('rev5.enabled must be a boolean');
  if (typeof rev5.model !== 'string' || !rev5.model) throw new Error('rev5.model must be a model name');
  if (!Number.isSafeInteger(rev5.maxTokens) || rev5.maxTokens < 1000) throw new Error('rev5.maxTokens must be an integer >= 1000');
  for (const key of ['askRoot', 'instructionsFile', 'cuaConfig']) {
    const value = rev5[key] ?? null;
    if (value !== null && (typeof value !== 'string' || !path.isAbsolute(value))) throw new Error(`rev5.${key} must be an absolute path or null`);
  }
  if (rev5.backgroundTurnMinGeneratingMs !== null && (!Number.isSafeInteger(rev5.backgroundTurnMinGeneratingMs) || rev5.backgroundTurnMinGeneratingMs < 0)) throw new Error('rev5.backgroundTurnMinGeneratingMs must be an integer (milliseconds) >= 0 or unset');
  if (rev5.searxngUrl !== null && !/^https?:\/\//.test(rev5.searxngUrl || '')) throw new Error('rev5.searxngUrl must be an http(s) URL or null');
  // Model routes (rev6/pull/routes.mjs): a malformed one fails here, at configuration time, by its key.
  if (rev5.modelRoutes !== undefined) {
    if (!rev5.modelRoutes || typeof rev5.modelRoutes !== 'object' || Array.isArray(rev5.modelRoutes)) throw new Error('rev5.modelRoutes must be an object keyed by model name');
    for (const name of Object.keys(rev5.modelRoutes)) routeFor(name, {}, rev5.modelRoutes);
  }
  if (rev5.mailAccounts !== undefined && rev5.mailAccounts !== null) throw new Error('rev5.mailAccounts is retired: the Gmail account list is config.json sources (kind "gmail", config.mailDir/email/stream)');
}

export function validateNightly(nightly) {
  if (nightly === null || nightly === undefined) return;
  if (typeof nightly !== 'object' || Array.isArray(nightly)) throw new Error('evaluation.nightly must be an object');
  const known = ['enabled', 'casesFile', 'variantsFile', 'holdoutAfter', 'intervalSeconds',
    'mailOracleCasesFile', 'memorySuiteFile'];
  for (const key of Object.keys(nightly)) if (!known.includes(key)) throw new Error(`Unknown evaluation.nightly key: ${key}`);
  if (typeof nightly.enabled !== 'boolean') throw new Error('evaluation.nightly.enabled must be true or false');
  if (!nightly.enabled) return;
  for (const key of ['casesFile', 'variantsFile']) {
    if (typeof nightly[key] !== 'string' || !path.isAbsolute(nightly[key])) throw new Error(`evaluation.nightly.${key} must be an absolute path`);
  }
  // The component suites fall back to a filename under the evaluation root, so
  // naming one of these is optional. It is also the only way to reach a case
  // file kept somewhere else, since an unknown key is refused above.
  for (const key of ['mailOracleCasesFile', 'memorySuiteFile']) {
    if (nightly[key] === undefined) continue;
    if (typeof nightly[key] !== 'string' || !path.isAbsolute(nightly[key])) throw new Error(`evaluation.nightly.${key} must be an absolute path`);
  }
  const {intervalSeconds, holdoutAfter} = nightly;
  if (intervalSeconds !== undefined && (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 60)) throw new Error('evaluation.nightly.intervalSeconds must be an integer >= 60');
  if (holdoutAfter !== undefined && !Number.isFinite(Date.parse(holdoutAfter))) throw new Error('evaluation.nightly.holdoutAfter must be a parseable date');
}

/** The scheduled mail cycle. Unknown keys are refused for the reason the
 * nightly block gives: a misspelled `enable` and a deliberately disabled cycle
 * would otherwise report the same status for ever. The schedule itself is left
 * to `isDue`, which is the one validator for every scheduled profile here. */
export function validateMail(mail) {
  if (mail === null || mail === undefined) return;
  if (typeof mail !== 'object' || Array.isArray(mail)) throw new Error('mail must be an object');
  const known = ['enabled', 'settingsFile', 'apply', 'schedule', 'forward'];
  for (const key of Object.keys(mail)) if (!known.includes(key)) throw new Error(`Unknown mail key: ${key}`);
  validateMailForward(mail.forward);
  for (const key of ['enabled', 'apply']) {
    if (typeof mail[key] !== 'boolean') throw new Error(`mail.${key} must be true or false`);
  }
  if (!mail.enabled) return;
  if (typeof mail.settingsFile !== 'string' || !path.isAbsolute(mail.settingsFile)) {
    throw new Error('mail.settingsFile must be an absolute path');
  }
  if (!mail.schedule || typeof mail.schedule !== 'object' || Array.isArray(mail.schedule)) {
    throw new Error('mail.schedule must be an object');
  }
}

/** The standing consent for unattended receipt forwarding. A send leaves the
 * machine and cannot be recalled, so the scheduled cycle carries no forward at
 * all unless this block says so in as many words: `enabled` is the switch, and
 * the destination and sender account are named here as well as in the owner's
 * private settings file, so a cycle cannot forward anywhere he did not write
 * down twice. Absent means off, which is what every machine gets by default. */
export function validateMailForward(forward) {
  if (forward === null || forward === undefined) return;
  if (typeof forward !== 'object' || Array.isArray(forward)) throw new Error('mail.forward must be an object');
  const known = ['enabled', 'destination', 'senderAccount', 'stateDir', 'maxBytes'];
  for (const key of Object.keys(forward)) {
    if (!known.includes(key)) throw new Error(`Unknown mail.forward key: ${key}`);
  }
  if (typeof forward.enabled !== 'boolean') throw new Error('mail.forward.enabled must be true or false');
  if (!forward.enabled) return;
  for (const key of ['destination', 'senderAccount']) {
    if (typeof forward[key] !== 'string' || !forward[key].trim()) {
      throw new Error(`mail.forward.${key} must be a non-empty string when forwarding is enabled`);
    }
  }
  if (!forward.destination.includes('@')) throw new Error('mail.forward.destination must be an address');
  if (forward.stateDir !== undefined && (typeof forward.stateDir !== 'string' || !path.isAbsolute(forward.stateDir))) {
    throw new Error('mail.forward.stateDir must be an absolute path');
  }
  if (forward.maxBytes !== undefined && (!Number.isSafeInteger(forward.maxBytes) || forward.maxBytes < 1)) {
    throw new Error('mail.forward.maxBytes must be a positive integer');
  }
}

/** Ingress publishes a loopback service on a public hostname through a
 * Cloudflare named tunnel. It is refused rather than defaulted, key by key,
 * for the same reason as the nightly block above: a hostname typed into the
 * wrong key publishes nothing and reads exactly like ingress nobody wanted.
 * Nothing here may name a secret. The tunnel credential is a file the owner
 * already has; its path is configured and its contents are never read. */
export function validateIngress(ingress) {
  if (ingress === null || ingress === undefined) return;
  if (typeof ingress !== 'object' || Array.isArray(ingress)) throw new Error('ingress must be an object');
  const known = ['provider', 'mode', 'tunnelId', 'credentialsFile', 'cloudflaredPath', 'currentConfigFile', 'routes'];
  for (const key of Object.keys(ingress)) if (!known.includes(key)) throw new Error(`Unknown ingress key: ${key}`);
  if (ingress.provider !== 'cloudflare-tunnel') throw new Error('ingress.provider must be cloudflare-tunnel');
  // shared-tunnel: the owner's existing connector carries these hostnames and
  // this runtime runs no cloudflared. own-tunnel: this runtime has a tunnel of
  // its own. The two cannot be merged, because two connectors registered for
  // one tunnel split that tunnel's requests between them.
  if (!['shared-tunnel', 'own-tunnel'].includes(ingress.mode)) throw new Error('ingress.mode must be shared-tunnel or own-tunnel');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ingress.tunnelId || '')) throw new Error('ingress.tunnelId must be a tunnel UUID');
  for (const key of ['credentialsFile', 'cloudflaredPath', 'currentConfigFile']) {
    const value = ingress[key];
    if (value === undefined || value === null) { if (key === 'credentialsFile') throw new Error('ingress.credentialsFile must be an absolute path'); continue; }
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 1024 || /[\x00-\x1f"']/.test(value)) throw new Error(`ingress.${key} must be an absolute path`);
  }
  if (ingress.mode === 'own-tunnel' && !ingress.cloudflaredPath) throw new Error('own-tunnel ingress requires ingress.cloudflaredPath');
  if (!Array.isArray(ingress.routes) || ingress.routes.length === 0 || ingress.routes.length > 50) throw new Error('ingress.routes must be a non-empty array');
  const hostnames = new Set();
  for (const route of ingress.routes) {
    if (!route || typeof route !== 'object') throw new Error('Each ingress route must be an object');
    for (const key of Object.keys(route)) if (!['hostname', 'service', 'port', 'path'].includes(key)) throw new Error(`Unknown ingress route key: ${key}`);
    const label = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
    const dotted = new RegExp(`^${label}(\\.${label})+$`);
    if (typeof route.hostname !== 'string' || route.hostname.length > 253 || !dotted.test(route.hostname)) throw new Error('ingress route hostname must be a dotted lowercase hostname');
    if (hostnames.has(route.hostname)) throw new Error(`Duplicate ingress hostname: ${route.hostname}`);
    hostnames.add(route.hostname);
    // A route names the local service by name or by port, never both: the
    // named service takes its port from install config, so a second number
    // beside it is two answers to one question.
    const named = route.service !== undefined, numbered = route.port !== undefined;
    if (named === numbered) throw new Error('Each ingress route needs exactly one of service or port');
    if (named && route.service !== 'webchat') throw new Error('ingress route service must be webchat');
    if (numbered && (!Number.isSafeInteger(route.port) || route.port < 1024 || route.port > 65535)) throw new Error('ingress route port must be a port between 1024 and 65535');
    const badPath = typeof route.path !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(route.path) || /["']/.test(route.path);
    if (route.path !== undefined && badPath) throw new Error('ingress route path must be a printable pattern');
  }
}

/** The exobrain plane's settings.
 *
 * `caps` is seconds per model call.
 */
const EXOBRAIN_KEYS = ['enabled', 'reads', 'webchatStore', 'ownerConversations', 'smallSources',
  'callsPerTick', 'maxUsdPerTick', 'maxBigUsdPerDay', 'maxPacketBytes', 'pageQuietMinutes',
  'quietSeconds', 'arrivalsPerTick', 'eventsPerTick', 'ownerTurnsPerTick', 'pagesPerTick', 'followupsPerTick',
  'threadTurnsPerTick', 'threadBatchCap', 'threadWindowLimit', 'threadLaneSince', 'threadTurnIntent', 'threadRoles',
  'caps', 'reminder', 'backfill'];
const EXOBRAIN_CAP_KINDS = ['BIG', 'FOLLOWUP', 'PAGE', 'SMALL'];
const EXOBRAIN_ROLES = ['owner', 'human', 'assistant', 'tool', 'system'];
const EXOBRAIN_REMINDER_KEYS = ['channelId', 'ownerId', 'tokenFile'];
const EXOBRAIN_BACKFILL_KEYS = ['sourcePath', 'windowDays', 'bigBudgetUsd'];

export function validateExobrain(exobrain) {
  if (exobrain === null || exobrain === undefined) return;
  if (typeof exobrain !== 'object' || Array.isArray(exobrain)) throw new Error('exobrain must be an object');
  for (const key of Object.keys(exobrain)) if (!EXOBRAIN_KEYS.includes(key)) throw new Error(`Unknown exobrain key: ${key}`);
  if (typeof exobrain.enabled !== 'boolean') throw new Error('exobrain.enabled must be true or false');
  const reads = exobrain.reads;
  if (!reads || typeof reads !== 'object' || Array.isArray(reads)) throw new Error('exobrain.reads must be an object');
  if (typeof reads.enabled !== 'boolean') throw new Error('exobrain.reads.enabled must be true or false');
  for (const key of ['webchatStore']) {
    if (typeof exobrain[key] !== 'string' || !path.isAbsolute(exobrain[key])) throw new Error(`exobrain.${key} must be an absolute path`);
  }
  const owners = exobrain.ownerConversations;
  const okOwners = owners === '*' || (Array.isArray(owners) && owners.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256));
  if (!okOwners) throw new Error("exobrain.ownerConversations must be '*' or an array of conversation ids");
  if (!Array.isArray(exobrain.smallSources) || !exobrain.smallSources.length
    || !exobrain.smallSources.every(role => EXOBRAIN_ROLES.includes(role))) {
    throw new Error(`exobrain.smallSources must be a non-empty subset of ${EXOBRAIN_ROLES.join(', ')}`);
  }
  for (const key of ['callsPerTick', 'maxPacketBytes', 'arrivalsPerTick', 'eventsPerTick', 'ownerTurnsPerTick', 'pagesPerTick', 'followupsPerTick', 'threadTurnsPerTick', 'threadBatchCap']) {
    if (!Number.isSafeInteger(exobrain[key]) || exobrain[key] < 0) throw new Error(`exobrain.${key} must be an integer >= 0`);
  }
  if (exobrain.threadWindowLimit != null && (!Number.isSafeInteger(exobrain.threadWindowLimit) || exobrain.threadWindowLimit < 0)) {
    throw new Error('exobrain.threadWindowLimit must be null or an integer >= 0');
  }
  if (exobrain.threadLaneSince != null && (typeof exobrain.threadLaneSince !== 'string' || Number.isNaN(Date.parse(exobrain.threadLaneSince)))) {
    throw new Error('exobrain.threadLaneSince must be null or an ISO 8601 instant');
  }
  if (typeof exobrain.threadTurnIntent !== 'string' || !exobrain.threadTurnIntent) throw new Error('exobrain.threadTurnIntent must be a non-empty string');
  if (exobrain.threadRoles != null && (!Array.isArray(exobrain.threadRoles) || !exobrain.threadRoles.length
    || !exobrain.threadRoles.every(role => EXOBRAIN_ROLES.includes(role)))) {
    throw new Error(`exobrain.threadRoles must be null or a non-empty subset of ${EXOBRAIN_ROLES.join(', ')}`);
  }
  for (const key of ['maxUsdPerTick', 'maxBigUsdPerDay']) {
    if (!Number.isFinite(exobrain[key]) || exobrain[key] < 0) throw new Error(`exobrain.${key} must be a number >= 0`);
  }
  for (const key of ['pageQuietMinutes', 'quietSeconds']) {
    if (!Number.isFinite(exobrain[key]) || exobrain[key] < 0) throw new Error(`exobrain.${key} must be a number >= 0`);
  }
  if (!exobrain.caps || typeof exobrain.caps !== 'object' || Array.isArray(exobrain.caps)) throw new Error('exobrain.caps must be an object');
  for (const [kind, seconds] of Object.entries(exobrain.caps)) {
    if (!EXOBRAIN_CAP_KINDS.includes(kind)) throw new Error(`Unknown exobrain.caps kind: ${kind}`);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`exobrain.caps.${kind} must be a number of seconds > 0`);
  }
  const reminder = exobrain.reminder;
  if (!reminder || typeof reminder !== 'object' || Array.isArray(reminder)) throw new Error('exobrain.reminder must be an object');
  for (const key of Object.keys(reminder)) if (!EXOBRAIN_REMINDER_KEYS.includes(key)) throw new Error(`Unknown exobrain.reminder key: ${key}`);
  for (const key of ['channelId', 'ownerId']) {
    if (typeof reminder[key] !== 'string' || reminder[key].length > 256) throw new Error(`exobrain.reminder.${key} must be a string`);
  }
  if (reminder.tokenFile !== null && (typeof reminder.tokenFile !== 'string' || !path.isAbsolute(reminder.tokenFile))) {
    throw new Error('exobrain.reminder.tokenFile must be null or an absolute path');
  }
  const backfill = exobrain.backfill;
  if (!backfill || typeof backfill !== 'object' || Array.isArray(backfill)) throw new Error('exobrain.backfill must be an object');
  for (const key of Object.keys(backfill)) if (!EXOBRAIN_BACKFILL_KEYS.includes(key)) throw new Error(`Unknown exobrain.backfill key: ${key}`);
  if (typeof backfill.sourcePath !== 'string' || !path.isAbsolute(backfill.sourcePath)) throw new Error('exobrain.backfill.sourcePath must be an absolute path');
  if (!Number.isSafeInteger(backfill.windowDays) || backfill.windowDays <= 0) throw new Error('exobrain.backfill.windowDays must be an integer >= 1');
  if (!Number.isFinite(backfill.bigBudgetUsd) || backfill.bigBudgetUsd < 0) throw new Error('exobrain.backfill.bigBudgetUsd must be a number >= 0');
}
