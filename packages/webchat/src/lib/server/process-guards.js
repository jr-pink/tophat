

export const FATE = Object.freeze({ EXIT: 'exit', SURVIVE: 'survive' });

const EXIT_CODES = new Set([
  'ERR_INTERNAL_ASSERTION',
]);

export function classifyUncaught(err) {
  const code = err && typeof err === 'object' ? err.code : undefined;
  const syscall = err && typeof err === 'object' ? err.syscall : undefined;

  if (syscall === 'listen') {
    return {
      fate: FATE.EXIT,
      class: 'bind-failure',
      why: `the listening socket could not be bound (${code || 'listen failed'}), so there is nothing to serve`,
    };
  }
  if (code && EXIT_CODES.has(code)) {
    return {
      fate: FATE.EXIT,
      class: 'node-internal',
      why: `Node reports its own internal state as broken (${code})`,
    };
  }
  return {
    fate: FATE.SURVIVE,
    class: 'request-scoped',
    why: 'cannot have corrupted state shared between conversations; one request is lost, the rest keep running',
  };
}

export function installProcessGuards({
  proc = process,
  logger = console,
  expected = [],
  now = () => Date.now(),
  windowMs = 10_000,
  maxPerWindow = 25,
  exit = (code) => proc.exit(code),
} = {}) {
  const recent = [];

  function describe(err) {
    if (err instanceof Error) return err.stack || `${err.name}: ${err.message}`;
    
    
    try { return `non-Error value: ${JSON.stringify(err)}`; } catch { return `non-Error value: ${String(err)}`; }
  }

  const onRejection = (reason) => {
    
    
    
    logger.error(`[serve] survived an unhandled rejection: ${describe(reason)}`);
  };

  const onUncaught = (err) => {
    for (const klass of expected) {
      let matched = false;
      try { matched = Boolean(klass.match?.(err)); } catch { matched = false; }
      if (!matched) continue;
      
      
      const why = (() => { try { return klass.why?.(err); } catch { return null; } })();
      logger.error(`[serve] survived an uncaught exception (${klass.name}): ${why || describe(err)}`);
      return;
    }

    const verdict = classifyUncaught(err);
    if (verdict.fate === FATE.EXIT) {
      logger.error(`[serve] exiting on an uncaught exception (${verdict.class}): ${verdict.why}\n${describe(err)}`);
      exit(1);
      return;
    }

    const at = now();
    recent.push(at);
    while (recent.length && at - recent[0] > windowMs) recent.shift();
    if (recent.length > maxPerWindow) {
      logger.error(`[serve] exiting: ${recent.length} uncaught exceptions in ${windowMs}ms is a loop, not a bug`
        + ` -- the last was ${describe(err)}`);
      exit(1);
      return;
    }

    logger.error(`[serve] survived an uncaught exception (${verdict.class}): ${verdict.why}\n${describe(err)}`);
  };

  proc.on('uncaughtException', onUncaught);
  proc.on('unhandledRejection', onRejection);

  return {
    onUncaught,
    onRejection,
    uninstall() {
      proc.removeListener('uncaughtException', onUncaught);
      proc.removeListener('unhandledRejection', onRejection);
    },
  };
}
