#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// linknotes CLI. Config: --config FILE, else $LINKNOTES_CONFIG, else ~/.config/linknotes/config.json.
// Secrets come from files, never argv or stdout.
//   tophat-linknotes init sqlite --user U [--device D] [--dir DIR] [--hub URL --hub-token-file F]
//   tophat-linknotes whoami | sync | scopes
//   tophat-linknotes scope create S | scope add S USER read|write|admin|none
//   tophat-linknotes note --entity NAME [--type person] [--scopes a,b] "text"
//   tophat-linknotes apply FILE|- [--scopes a,b]               (JSON {entities, notes, work})
//   tophat-linknotes search QUERY [--kind note] [--limit N] | entity ID | page ID | read KIND ID
//   tophat-linknotes share KIND ID a,b | retract KIND ID | link ID ID
//   tophat-linknotes push                                      (one poll cycle: sources -> derive -> sync; config.push)
//   tophat-linknotes hub serve --db F --secret-file F [--port 8791] | hub token --secret-file F --device D --user U --out FILE
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open, Hub, issueToken } from '../src/index.mjs';

const argv = process.argv.slice(2);
const flags = {}, pos = [];
for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) { const k = argv[i].slice(2); flags[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; } else pos.push(argv[i]); }
const out = (x) => console.log(JSON.stringify(x, null, 2));
const die = (m, code = 2) => { console.error(m); process.exit(code); };
const need = (k) => flags[k] ?? die(`missing --${k}`);
const expand = (p) => (p ? String(p).replace(/^~(?=\/|$)/, os.homedir()) : p);
const configPath = expand(flags.config || process.env.LINKNOTES_CONFIG || '~/.config/linknotes/config.json');
const list = (s) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : undefined);
const writeSecretFile = (file, value) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, value + '\n', { mode: 0o600 }); chmodSync(file, 0o600); };
const loadConfig = () => { if (!existsSync(configPath)) die(`no config at ${configPath}; run tophat-linknotes init`); return JSON.parse(readFileSync(configPath, 'utf8')); };

const [cmd, sub] = pos;
try {
  if (cmd === 'init') {
    if (existsSync(configPath) && !flags.force) die(`${configPath} exists (--force to overwrite)`);
    let cfg;
    if (sub === 'sqlite') {
      const user = need('user'), dir = expand(flags.dir || '~/.local/state/linknotes');
      cfg = { backend: 'sqlite', file: path.join(dir, 'memory.sqlite'), keyFile: path.join(dir, 'device-key.json'), user, device: flags.device || `${user}-${os.hostname().split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-')}`, writeScopes: [flags.scope || user],
        ...(flags.hub ? { hub: { url: flags.hub, tokenFile: expand(need('hub-token-file')) } } : {}) };
    } else die('init sqlite');
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(cfg, null, 1) + '\n', { mode: 0o600 });
    const m = await open(cfg);
    let scope = null;
    if (!(await m.scopes()).length) { scope = await m.createScope(cfg.writeScopes[0]); }
    out({ ok: true, config: configPath, whoami: await m.whoami(), created_scope: scope });
    await m.close();
  } else if (cmd === 'hub') {
    const secret = () => readFileSync(expand(need('secret-file')), 'utf8').trim();
    if (sub === 'serve') { const hub = new Hub(expand(need('db')), { secret: secret() }); await hub.listen(Number(flags.port || 8791), flags.host || '127.0.0.1'); console.log(`tophat-linknotes hub on ${flags.host || '127.0.0.1'}:${flags.port || 8791}`); }
    else if (sub === 'token') { writeSecretFile(expand(need('out')), issueToken(secret(), { device: need('device'), user: need('user'), expiresAt: Math.floor(Date.now() / 1000) + Number(flags.days || 90) * 86400 })); out({ ok: true, wrote: expand(flags.out), device: flags.device, user: flags.user }); }
    else die('hub serve|token');
  } else {
    const cfg = loadConfig();
    const m = await open(cfg);
    try {
      if (cmd === 'whoami') out(await m.whoami());
      else if (cmd === 'sync') out(await m.sync());
      else if (cmd === 'scopes' || (cmd === 'scope' && (!sub || sub === 'list'))) out(await m.scopes());
      else if (cmd === 'scope' && sub === 'create') out(await m.createScope(pos[2] ?? die('scope create NAME')));
      else if (cmd === 'scope' && sub === 'add') out(await m.addMember(pos[2], pos[3], pos[4] || 'read'));
      else if (cmd === 'note') {
        const text = pos.slice(1).join(' ') || die('note TEXT'), name = need('entity');
        const hit = (await m.search(name, { kind: 'entity', limit: 5 })).hits.find((h) => h.name?.toLowerCase() === String(name).toLowerCase());
        const changes = hit ? { notes: [{ body: text, entities: [hit.id] }] } : { entities: [{ id: '$e', name, type: flags.type || 'topic' }], notes: [{ body: text, entities: ['$e'] }] };
        out(await m.apply(changes, { scopes: list(flags.scopes) }));
      } else if (cmd === 'apply') out(await m.apply(JSON.parse(readFileSync(sub === '-' || !sub ? 0 : sub, 'utf8')), { scopes: list(flags.scopes) }));
      else if (cmd === 'search') out(await m.search(pos.slice(1).join(' '), { kind: flags.kind, limit: Number(flags.limit || 20) }));
      else if (cmd === 'entity') out(await m.entity(sub));
      else if (cmd === 'page') { const p = await m.page(sub); if (flags.json) out(p); else console.log(p.outline); }
      else if (cmd === 'read') out(await m.read(sub, pos[2]));
      else if (cmd === 'share') out(await m.share(sub, pos[2], list(pos[3])));
      else if (cmd === 'retract') out(await m.retract(sub, pos[2]));
      else if (cmd === 'link') out(await m.link(sub, pos[2]));
      else if (cmd === 'push') {
        if (!cfg.push) die('config.push is missing (see README: push)');
        let mod; try { mod = await import('@tophat-md/push'); } catch { die('install @tophat-md/push for `tophat-linknotes push`'); }
        out(await mod.pollOnce(m, { syncAfter: Boolean(cfg.hub), ...cfg.push, stateDir: expand(cfg.push.stateDir || '~/.local/state/linknotes/push') }));
      } else die('unknown command; see the header of bin/tophat-linknotes.mjs or the README');
    } finally { await m.close(); }
  }
} catch (e) { die(`${e.constructor.name}: ${e.message}`, 1); }
