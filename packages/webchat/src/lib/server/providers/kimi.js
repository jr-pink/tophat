

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { secretsDir } from '../secrets.js';
import { makeClaudeAdapter } from './claude.js';

export const KIMI_BASE_URL = process.env.WEBCHAT_KIMI_BASE_URL || 'https://api.moonshot.ai/anthropic';
const KEY_NAME = 'moonshot-api-key';

export function kimiKey(env = process.env) {
  if (env.MOONSHOT_API_KEY) return env.MOONSHOT_API_KEY;
  try {
    return readFileSync(join(secretsDir(), KEY_NAME), 'utf8').trim();
  } catch {
    return '';
  }
}

export function kimiAvailable(env = process.env) {
  return Boolean(kimiKey(env));
}

export function kimiEnv(env = process.env) {
  return {
    ANTHROPIC_BASE_URL: KIMI_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: kimiKey(env),
    ANTHROPIC_API_KEY: '',
    
    
    ANTHROPIC_DEFAULT_OPUS_MODEL: '',
    
    
    
    CLAUDE_CODE_DISABLE_FAST_MODE: '1'
  };
}

export const kimiAdapter = makeClaudeAdapter({
  id: 'kimi',
  envExtra: () => kimiEnv()
});
