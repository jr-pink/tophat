// The two owner config files: config.json (runtime) and retrieval.json (corpora).
// Unknown keys are refused, because a misspelled key reads exactly like a setting
// deliberately left off. Only the blocks rev6 keeps are defaulted and validated;
// the retired planes' blocks (RETIRED_KEYS) are accepted and passed through raw
// so the live file still loads, and nothing in rev6 reads them.
// Never: write a config file, read a secret, or name a secret value.
import fs from 'node:fs';
import path from 'node:path';
import { configDir as defaultConfigDir, configFile as defaultConfigFile, expandHome, homeOf, refuseLiveUnderTest,
  retrievalConfigFile, stateDir, underTest } from './paths.mjs';
import { validatePeople } from './privacy.mjs';
import { GMAIL_STREAMS_TOKEN, configBesideRetrieval, expandGmailToken, gmailStreamNames, readGmailAccounts } from '../../src/core/gmail-accounts.mjs';

export const SURVIVING_KEYS = ['version', 'profile', 'paths', 'install', 'ingress', 'heartbeat', 'mail', 'sources', 'speech', 'recognition', 'rev5'];
export const RETIRED_KEYS = ['models', 'evaluation', 'briefs', 'delivery', 'work', 'exobrain'];

const fail = (message) => { throw new Error(message); };
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const absOrNull = (v) => v === null || (typeof v === 'string' && path.isAbsolute(v));

/**
 * config.json, defaulted and validated. `home` names a temp home in tests; given
 * a home under test, TOPHAT_CONFIG and TOPHAT_CONFIG_DIR from the shell are ignored,
 * because the live file's absolute `paths` would replace the temp home's.
 */
export function loadConfig({ env = process.env, home, file, overrides = {} } = {}) {
  let e = env;
  if (home !== undefined) {
    e = { ...env, HOME: home };
    if (underTest(env)) { delete e.TOPHAT_CONFIG; delete e.TOPHAT_CONFIG_DIR; }
  }
  const configDir = defaultConfigDir(e);
  const source = file || defaultConfigFile(e);
  const user = fs.existsSync(source) ? JSON.parse(fs.readFileSync(source, 'utf8')) : {};
  return resolveConfig({ ...user, ...overrides }, { home: homeOf(e), configDir });
}

export function resolveConfig(raw, { home, configDir = path.join(home, '.config/tophat') }) {
  const unknown = Object.keys(raw).filter((k) => !SURVIVING_KEYS.includes(k) && !RETIRED_KEYS.includes(k));
  if (unknown.length) fail(`Unknown configuration key(s): ${unknown.sort().join(', ')}`);
  if (raw.version !== undefined && raw.version !== 1) fail('Unsupported config version');
  const config = {
    version: 1,
    profile: { name: 'User', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...raw.profile },
    paths: { configDir, dataDir: path.join(home, '.local/share/tophat'), stateDir: path.join(home, '.local/state/tophat'),
      workspaceDir: path.join(home, '.local/share/tophat/workspace'), ...raw.paths },
    install: { serviceLabelPrefix: 'io.tophat', webchatPort: 4178, productName: 'tophat', ...raw.install },
    rev5: { enabled: false, model: 'claude-opus-5-5', maxTokens: 16000, askRoot: null, searxngUrl: null,
      instructionsFile: null, instructionsMaxBytes: null, cuaConfig: null,
      // No default in code: the value lives only in config.json (rev6/pull/background.mjs backgroundMinGeneratingMs refuses without it).
      backgroundTurnMinGeneratingMs: null, ...raw.rev5 },
    ingress: raw.ingress === undefined ? null : raw.ingress,
    heartbeat: { intervalSeconds: 300, engine: 'understanding', calls: 60, mode: 'gated', maxRecords: 200, maxInputChars: 60000,
      // No default in code: the value lives only in config.json (same as src/config.mjs); the heartbeat refuses to push without it.
      pushTimeoutSeconds: null, ...raw.heartbeat,
      cadences: { day: 300, week: 86400, evergreen: 86400, ...raw.heartbeat?.cadences } },
    mail: { enabled: false, settingsFile: null, apply: false, schedule: { everySeconds: 900 }, ...raw.mail },
    sources: raw.sources || [],
    speech: raw.speech ?? {},
    recognition: raw.recognition ?? {},
  };
  for (const key of RETIRED_KEYS) if (raw[key] !== undefined) config[key] = raw[key];
  validateHeartbeat(config.heartbeat);
  for (const v of Object.values(config.paths)) if (!path.isAbsolute(v)) fail('All configured paths must be absolute');
  const prefix = config.install.serviceLabelPrefix;
  if (typeof prefix !== 'string' || prefix.length > 100 || !/^[a-z][a-z0-9]*([.-][a-z0-9]+)*$/i.test(prefix)) fail('install.serviceLabelPrefix must be a reverse-DNS style prefix');
  // Product display name is config.
  if (typeof config.install.productName !== 'string' || !/^[a-z][a-z0-9 _-]{0,39}$/i.test(config.install.productName)) fail('install.productName must be a short plain name');
  const port = config.install.webchatPort;
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) fail('install.webchatPort must be a port between 1024 and 65535');
  validateRev5(config.rev5);
  validateMail(config.mail);
  validateIngress(config.ingress);
  validateSources(config.sources);
  for (const key of ['stateDir', 'dataDir', 'workspaceDir']) refuseLiveUnderTest(config.paths[key], `loadConfig paths.${key}`);
  return config;
}

function validateHeartbeat(h) {
  if (!Number.isSafeInteger(h.intervalSeconds) || h.intervalSeconds < 10) fail('heartbeat.intervalSeconds must be an integer >= 10');
  if (!['understanding', 'legacy'].includes(h.engine)) fail('Invalid heartbeat.engine');
  if (!Number.isSafeInteger(h.calls) || h.calls < 0) fail('Invalid heartbeat.calls');
  if (h.pushTimeoutSeconds !== null && (!Number.isSafeInteger(h.pushTimeoutSeconds) || h.pushTimeoutSeconds < 30)) fail('heartbeat.pushTimeoutSeconds must be an integer >= 30 (seconds) or unset');
  for (const key of ['maxRecords', 'maxInputChars']) if (!Number.isSafeInteger(h[key]) || h[key] <= 0) fail(`Invalid heartbeat.${key}`);
  for (const [key, v] of Object.entries(h.cadences)) if (!Number.isSafeInteger(v) || v < 0) fail(`Invalid cadence ${key}`);
}

function validateSources(sources) {
  if (!Array.isArray(sources)) fail('sources must be an array');
  const ids = new Set();
  for (const s of sources) {
    if (!s || !/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(s.id || '') || ids.has(s.id)) fail('Source IDs must be unique safe identifiers');
    ids.add(s.id);
    if (!s.kind || typeof s.kind !== 'string') fail('Source kind required');
    s.enabled = s.enabled === true;
    s.config ||= {};
    s.policy = { model: 'deny', publish: 'none', ...s.policy };
    if (!['allow', 'deny'].includes(s.policy.model) || !['full', 'label-only', 'none'].includes(s.policy.publish)) fail('Invalid source privacy policy');
  }
}

export function validateRev5(r) {
  if (r.enabled !== true && r.enabled !== false) fail('rev5.enabled must be a boolean');
  if (typeof r.model !== 'string' || !r.model) fail('rev5.model must be a model name');
  if (!Number.isSafeInteger(r.maxTokens) || r.maxTokens < 1000) fail('rev5.maxTokens must be an integer >= 1000');
  for (const key of ['askRoot', 'instructionsFile', 'cuaConfig']) if (!absOrNull(r[key] ?? null)) fail(`rev5.${key} must be an absolute path or null`);
  if (r.backgroundTurnMinGeneratingMs !== null && (!Number.isSafeInteger(r.backgroundTurnMinGeneratingMs) || r.backgroundTurnMinGeneratingMs < 0)) fail('rev5.backgroundTurnMinGeneratingMs must be an integer (milliseconds) >= 0 or unset');
  if (r.searxngUrl !== null && !/^https?:\/\//.test(r.searxngUrl || '')) fail('rev5.searxngUrl must be an http(s) URL or null');
  // src/core/gmail-accounts.mjs derives the mail map.
  if (r.mailAccounts !== undefined && r.mailAccounts !== null) fail('rev5.mailAccounts is retired: the Gmail account list is config.json sources (kind "gmail", config.mailDir/email/stream)');
}

export function validateMail(mail) {
  if (mail === null || mail === undefined) return;
  if (!isObject(mail)) fail('mail must be an object');
  for (const key of Object.keys(mail)) if (!['enabled', 'settingsFile', 'apply', 'schedule', 'forward'].includes(key)) fail(`Unknown mail key: ${key}`);
  validateMailForward(mail.forward);
  for (const key of ['enabled', 'apply']) if (typeof mail[key] !== 'boolean') fail(`mail.${key} must be true or false`);
  if (!mail.enabled) return;
  if (typeof mail.settingsFile !== 'string' || !path.isAbsolute(mail.settingsFile)) fail('mail.settingsFile must be an absolute path');
  if (!isObject(mail.schedule)) fail('mail.schedule must be an object');
}

// A forward leaves the machine, so it is off unless enabled here and named twice.
export function validateMailForward(f) {
  if (f === null || f === undefined) return;
  if (!isObject(f)) fail('mail.forward must be an object');
  for (const key of Object.keys(f)) if (!['enabled', 'destination', 'senderAccount', 'stateDir', 'maxBytes'].includes(key)) fail(`Unknown mail.forward key: ${key}`);
  if (typeof f.enabled !== 'boolean') fail('mail.forward.enabled must be true or false');
  if (!f.enabled) return;
  for (const key of ['destination', 'senderAccount']) {
    if (typeof f[key] !== 'string' || !f[key].trim()) fail(`mail.forward.${key} must be a non-empty string when forwarding is enabled`);
  }
  if (!f.destination.includes('@')) fail('mail.forward.destination must be an address');
  if (f.stateDir !== undefined && (typeof f.stateDir !== 'string' || !path.isAbsolute(f.stateDir))) fail('mail.forward.stateDir must be an absolute path');
  if (f.maxBytes !== undefined && (!Number.isSafeInteger(f.maxBytes) || f.maxBytes < 1)) fail('mail.forward.maxBytes must be a positive integer');
}

const LABEL = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = new RegExp(`^${LABEL}(\\.${LABEL})+$`);

// Ingress publishes a loopback service through a Cloudflare tunnel; the tunnel
// credential is a path, never read here.
export function validateIngress(g) {
  if (g === null || g === undefined) return;
  if (!isObject(g)) fail('ingress must be an object');
  for (const key of Object.keys(g)) {
    if (!['provider', 'mode', 'tunnelId', 'credentialsFile', 'cloudflaredPath', 'currentConfigFile', 'routes'].includes(key)) fail(`Unknown ingress key: ${key}`);
  }
  if (g.provider !== 'cloudflare-tunnel') fail('ingress.provider must be cloudflare-tunnel');
  if (!['shared-tunnel', 'own-tunnel'].includes(g.mode)) fail('ingress.mode must be shared-tunnel or own-tunnel');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(g.tunnelId || '')) fail('ingress.tunnelId must be a tunnel UUID');
  for (const key of ['credentialsFile', 'cloudflaredPath', 'currentConfigFile']) {
    const v = g[key];
    if (v === undefined || v === null) { if (key === 'credentialsFile') fail('ingress.credentialsFile must be an absolute path'); continue; }
    if (typeof v !== 'string' || !path.isAbsolute(v) || v.length > 1024 || /[\x00-\x1f"']/.test(v)) fail(`ingress.${key} must be an absolute path`);
  }
  if (g.mode === 'own-tunnel' && !g.cloudflaredPath) fail('own-tunnel ingress requires ingress.cloudflaredPath');
  if (!Array.isArray(g.routes) || g.routes.length === 0 || g.routes.length > 50) fail('ingress.routes must be a non-empty array');
  const hostnames = new Set();
  for (const r of g.routes) {
    if (!r || typeof r !== 'object') fail('Each ingress route must be an object');
    for (const key of Object.keys(r)) if (!['hostname', 'service', 'port', 'path'].includes(key)) fail(`Unknown ingress route key: ${key}`);
    if (typeof r.hostname !== 'string' || r.hostname.length > 253 || !HOSTNAME.test(r.hostname)) fail('ingress route hostname must be a dotted lowercase hostname');
    if (hostnames.has(r.hostname)) fail(`Duplicate ingress hostname: ${r.hostname}`);
    hostnames.add(r.hostname);
    const named = r.service !== undefined, numbered = r.port !== undefined;
    if (named === numbered) fail('Each ingress route needs exactly one of service or port');
    if (named && r.service !== 'webchat') fail('ingress route service must be webchat');
    if (numbered && (!Number.isSafeInteger(r.port) || r.port < 1024 || r.port > 65535)) fail('ingress route port must be a port between 1024 and 65535');
    const badPath = typeof r.path !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(r.path) || /["']/.test(r.path);
    if (r.path !== undefined && badPath) fail('ingress route path must be a printable pattern');
  }
}

// ---- retrieval.json ----------------------------------------------------------
// Per-corpus env knobs override the file so a benchmark can point one corpus at
// a snapshot: ASK_ROOT, STREAM_INDEX_DIR, CHATS_INDEX, TOPHAT_JOURNAL_INDEX,
// DOCS_INDEX, TOPHAT_HEADSPACES_INDEX, TOPHAT_CONTRACTS_ROOT, TOPHAT_WEB_CACHE,
// TOPHAT_JOURNAL_BUILDER, DOCSTORE_STREAMS, CHATS_ARCHIVES, TOPHAT_HEADSPACE_DIR.

const RETRIEVAL_KEYS = ['indexDir', 'knowledgeRoot', 'docsPaths', 'codePaths', 'codeGlobs', 'claudeMemoryDir', 'chatDb', 'beeperIndex',
  'messageStreams', 'workDb', 'fileIndexRoots', 'fileIndexSkip', 'contractsRoot', 'filedRoots', 'documentRoots', 'spotlightSkip', 'streams',
  'communicationSources', 'fanin', 'webCacheDir', 'headspaces', 'journalBuilder', 'docstoreStreams', 'docstoreStreams', 'claudeArchives', 'contactsBackupDir',
  'ownerLabel', 'privatePeople', 'skipStreams'];
const DEFAULT_STREAMS = { email: [], 'beeper+calls+time+hevy+oura': [], 'agent-sessions': [] };

function refuse(message) { const error = new Error(message); error.retrievalConfig = true; throw error; }
function checkKeys(object, allowed, where) {
  if (!isObject(object)) refuse(`${where} must be an object`);
  for (const key of Object.keys(object)) if (!allowed.includes(key)) refuse(`Unknown ${where} key: ${key}`);
}
function stringList(value, name) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim())) refuse(`${name} must be a list of non-empty strings`);
  return value;
}

/** Validate parsed retrieval.json and resolve every path against `home`; env overrides last. */
/** `@gmail` in a stream list: every enabled Gmail account's config.stream in config.json (src/core/gmail-accounts.mjs); refused when it finds none. */
function gmailStreamsResolver(file, env, given) {
  let cached = given || null;
  return () => {
    if (cached) return cached;
    const from = configBesideRetrieval(file, env);
    let names;
    try { names = gmailStreamNames(readGmailAccounts({ file: from })); } catch (e) { refuse(`${GMAIL_STREAMS_TOKEN}: cannot read the Gmail accounts in ${from}: ${e.message}`); }
    if (!names.length) refuse(`${GMAIL_STREAMS_TOKEN}: no enabled gmail source with config.stream in ${from}`);
    return (cached = names);
  };
}

export function resolveRetrievalConfig(raw, { env = process.env, home = homeOf(env), file = null, gmailStreams = null } = {}) {
  checkKeys(raw, RETRIEVAL_KEYS, 'retrieval config');
  const abs = (value, name) => {
    if (typeof value !== 'string' || !value.trim()) refuse(`${name} must be a non-empty path`);
    const p = expandHome(value, home);
    if (!path.isAbsolute(p)) refuse(`${name} must be an absolute path (or start with ~/)`);
    return p;
  };
  const opt = (key, envKey) => (envKey && env[envKey] ? path.resolve(env[envKey]) : raw[key] !== undefined ? abs(raw[key], key) : null);
  const absList = (key) => stringList(raw[key], key).map((r) => abs(r, key));
  const knowledgeRoot = opt('knowledgeRoot', 'ASK_ROOT');
  const indexDir = raw.indexDir !== undefined ? abs(raw.indexDir, 'indexDir') : path.join(stateDir(env), 'retrieval', 'index');
  const gmail = gmailStreamsResolver(file, env, gmailStreams);
  const expand = (names) => (Array.isArray(names) && names.includes(GMAIL_STREAMS_TOKEN) ? expandGmailToken(names, gmail()) : names);
  const rawStreams = raw.streams === undefined ? DEFAULT_STREAMS : raw.streams;
  checkKeys(rawStreams, Object.keys(rawStreams), 'streams');
  const streams = {};
  for (const [label, names] of Object.entries(rawStreams)) {
    if (!/^[a-z][\w+.-]*$/i.test(label)) refuse(`streams label "${label}" must be a plain identifier`);
    stringList(names, `streams.${label}`);
    for (const n of names) if (n !== GMAIL_STREAMS_TOKEN && !/^[a-z0-9][a-z0-9-]*$/.test(n)) refuse(`stream name "${n}" must be a lowercase slug`);
    streams[label] = expand(names);
  }
  const fanin = raw.fanin === undefined ? null : raw.fanin;
  if (fanin) { checkKeys(fanin, ['stateDir', 'sources'], 'fanin'); stringList(fanin.sources, 'fanin.sources'); }
  const headspaces = raw.headspaces === undefined ? {} : raw.headspaces;
  checkKeys(headspaces, ['readCommand', 'entriesDir'], 'headspaces');
  if (headspaces.readCommand !== undefined && (typeof headspaces.readCommand !== 'string' || !headspaces.readCommand.trim())) refuse('headspaces.readCommand must be a non-empty string');
  if (raw.ownerLabel !== undefined && (typeof raw.ownerLabel !== 'string' || !raw.ownerLabel.trim() || /[\t\n]/.test(raw.ownerLabel))) refuse('ownerLabel must be a single-line string');
  const privatePeople = validatePeople(raw.privatePeople || []);
  const communication = new Set(stringList(raw.communicationSources, 'communicationSources') || []);
  const skipStreams = new Set(stringList(raw.skipStreams, 'skipStreams') || []);
  const contractsRoot = opt('contractsRoot', 'TOPHAT_CONTRACTS_ROOT');
  const filedRoots = raw.filedRoots !== undefined ? absList('filedRoots')
    : [contractsRoot, path.join(home, 'Library/Mobile Documents'), path.join(home, 'Documents'), path.join(home, 'Desktop'), path.join(home, 'Downloads')].filter(Boolean);
  const documentRoots = raw.documentRoots !== undefined ? absList('documentRoots')
    : [contractsRoot, path.join(home, 'Downloads'), path.join(home, 'Documents')].filter(Boolean);
  const under = (envKey, name) => (env[envKey] ? path.resolve(env[envKey]) : path.join(indexDir, name));
  return {
    file, home, indexDir,
    streamsDir: under('STREAM_INDEX_DIR', 'streams'),
    chatsIndex: under('CHATS_INDEX', 'chats.tsv'),
    journalIndex: under('TOPHAT_JOURNAL_INDEX', 'journal.tsv'),
    docsIndex: under('DOCS_INDEX', 'docs.tsv'),
    headspacesIndex: under('TOPHAT_HEADSPACES_INDEX', 'headspaces.tsv'),
    knowledgeRoot,
    docsPaths: stringList(raw.docsPaths, 'docsPaths') || ['AGENTS.md', 'README.md'],
    codePaths: stringList(raw.codePaths, 'codePaths') || ['src', 'scripts'],
    codeGlobs: stringList(raw.codeGlobs, 'codeGlobs') || ['*.mjs', '*.js', '*.cjs', '*.ts', '*.svelte', '*.sh'],
    claudeMemoryDir: opt('claudeMemoryDir'),
    chatDb: raw.chatDb !== undefined ? abs(raw.chatDb, 'chatDb') : null,
    beeperIndex: raw.beeperIndex !== undefined ? abs(raw.beeperIndex, 'beeperIndex') : null,
    messageStreams: stringList(raw.messageStreams, 'messageStreams') || ['beeper'],
    contractsRoot, filedRoots, documentRoots,
    workDb: opt('workDb'),
    fileIndexRoots: raw.fileIndexRoots !== undefined ? absList('fileIndexRoots') : documentRoots,
    fileIndexSkip: stringList(raw.fileIndexSkip, 'fileIndexSkip') || null,
    spotlightSkip: (stringList(raw.spotlightSkip, 'spotlightSkip') || []).map((r) => expandHome(r, home)),
    streams, skipStreams, communicationSources: communication,
    fanin: fanin ? { stateDir: abs(fanin.stateDir, 'fanin.stateDir'), sources: expand(fanin.sources || []) } : null,
    webCacheDir: opt('webCacheDir', 'TOPHAT_WEB_CACHE'),
    headspaces: {
      readCommand: headspaces.readCommand || 'headspace day',
      entriesDir: env.TOPHAT_HEADSPACE_DIR ? path.resolve(env.TOPHAT_HEADSPACE_DIR) : headspaces.entriesDir !== undefined ? abs(headspaces.entriesDir, 'headspaces.entriesDir') : null,
    },
    journalBuilder: opt('journalBuilder', 'TOPHAT_JOURNAL_BUILDER'),
    // docstoreStreams is tophat's name for the same key.
    docstoreStreams: opt('docstoreStreams', 'DOCSTORE_STREAMS') ?? opt('docstoreStreams', 'DOCSTORE_STREAMS'),
    claudeArchives: opt('claudeArchives', 'CHATS_ARCHIVES'),
    contactsBackupDir: opt('contactsBackupDir'),
    ownerLabel: raw.ownerLabel || 'me',
    privatePeople,
  };
}

/** retrieval.json resolved, or null when absent. Unreadable, group/world-readable or invalid throws. */
export function loadRetrievalConfig(env = process.env, { file = retrievalConfigFile(env) } = {}) {
  let stat;
  try { stat = fs.statSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile()) refuse(`${file} is not a regular file`);
  if (stat.mode & 0o077) refuse(`${file} must be owner-only (chmod 600); it names private corpora`);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { refuse(`${file}: ${error.message}`); }
  return resolveRetrievalConfig(raw, { env, file });
}
