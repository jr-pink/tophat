#!/usr/bin/env node
// tophat-redeploy: the one command that ships an instance: run the preparation hook, then `tophat instance ship`.
//
//   tophat-redeploy                 ship (phases vendor, refresh, release through the hook, then the deploy tool)
//   tophat-redeploy refresh         run the hook's refresh phase, then ship
//   tophat-redeploy status          instance status, then health
//   tophat-redeploy VERB ARGS...    any other `tophat instance` verb (env|unit|jobs|health|release|ship|sync|intake)
//
//   TOPHAT_INSTANCE_CONFIG     the instance file (default ~/.config/tophat/instance.json)
//   TOPHAT_DEPLOY_BIN          the deploy tool (default packages/deploy/bin/tophat-deploy.mjs beside this package)
//   TOPHAT_REDEPLOY_HOOK       optional executable called as `HOOK PHASE` with PHASE = vendor | refresh | release before a ship;
//                              a non-zero exit stops the ship ("nothing shipped"). Without it, ship is the deploy tool alone.
//   TOPHAT_NODE                node binary for the deploy tool (default: the one running this script)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envGet, expandHome, homeOf } from '../lib/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function settings(env = process.env) {
  const config = expandHome(envGet(env, 'TOPHAT_INSTANCE_CONFIG') || path.join(homeOf(env), '.config/tophat/instance.json'));
  const deploy = expandHome(envGet(env, 'TOPHAT_DEPLOY_BIN') || path.join(HERE, '../../deploy/bin/tophat-deploy.mjs'));
  const node = envGet(env, 'TOPHAT_NODE') || process.execPath;
  const hook = envGet(env, 'TOPHAT_REDEPLOY_HOOK') ? expandHome(envGet(env, 'TOPHAT_REDEPLOY_HOOK')) : null;
  return { config, deploy, node, hook };
}

/** The commands a verb runs, in order: [{ argv, phase }]. Pure, so it can be tested without deploying. */
export function plan(verb, rest, s) {
  const instance = (v, extra = []) => ({ argv: [s.node, s.deploy, 'instance', v, '--config', s.config, ...extra] });
  const phases = (...names) => (s.hook ? names.map((phase) => ({ phase, argv: [s.hook, phase] })) : []);
  switch (verb || 'ship') {
    case 'status': return [instance('status'), instance('health')];
    case 'refresh': return [...phases('refresh'), ...plan('ship', rest, s)];
    case '--restart':
    case 'ship': return [...phases('vendor', 'refresh', 'release'), instance('ship', rest)];
    default: return [instance(verb, rest)];
  }
}

export function main(argv, env = process.env) {
  const s = settings(env);
  const [first, ...rest] = argv;
  const steps = plan(first?.startsWith('--') && first !== '--restart' ? 'ship' : first, first?.startsWith('--') && first !== '--restart' ? argv : rest, s);
  for (const step of steps) {
    const r = spawnSync(step.argv[0], step.argv.slice(1), { stdio: [step.phase ? 'ignore' : 'inherit', step.phase ? 'ignore' : 'inherit', 'inherit'], env });
    if (r.status !== 0) {
      if (step.phase) process.stderr.write(`tophat-redeploy: ${step.phase} failed; nothing shipped\n`);
      return r.status ?? 1;
    }
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exitCode = main(process.argv.slice(2));
