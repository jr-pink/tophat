

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const secretsDir = () => process.env.TOPHAT_SECRETS_DIR || join(homedir(), '.config', 'tophat', 'secrets');
export const requestsFile = () => process.env.TOPHAT_SECRET_REQUESTS
  || join(homedir(), '.config', 'tophat', 'secret-requests.json');

const DEFAULT_TTL_MINUTES = 120;
const MAX_VALUE_BYTES = 64 * 1024;

export function validName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9-]{1,62}$/.test(name);
}

export function secretPresent(name) {
  if (!validName(name)) return false;
  try { return statSync(join(secretsDir(), name)).isFile(); } catch { return false; }
}

export function secretBytes(name) {
  if (!validName(name)) return null;
  try { return statSync(join(secretsDir(), name)).size; } catch { return null; }
}

export function writeSecret(name, value, { overwrite = false } = {}) {
  if (!validName(name)) throw new Error('name must be lowercase letters, digits and dashes (2-63 chars)');
  if (typeof value !== 'string' || !value.trim()) throw new Error('value is empty');
  if (Buffer.byteLength(value) > MAX_VALUE_BYTES) throw new Error('value is too large for a secret');
  const target = join(secretsDir(), name);
  let superseded = null;
  if (existsSync(target)) {
    if (!overwrite) throw new Error(`"${name}" already exists; tick replace to supersede it`);
    superseded = `${name}.superseded-${new Date().toISOString().slice(0, 10)}`;
    let bump = 1;
    while (existsSync(join(secretsDir(), superseded))) superseded = `${name}.superseded-${new Date().toISOString().slice(0, 10)}-${++bump}`;
    renameSync(target, join(secretsDir(), superseded));
  }
  mkdirSync(secretsDir(), { recursive: true, mode: 0o700 });
  
  
  
  const tmp = join(secretsDir(), `.tmp-${randomBytes(8).toString('hex')}`);
  writeFileSync(tmp, value.endsWith('\n') ? value : `${value}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, target);
  return { name, bytes: statSync(target).size, superseded };
}

function normalizeFields(fields) {
  if (!Array.isArray(fields) || !fields.length) return [{ key: 'value', label: 'Value', multiline: false }];
  return fields.slice(0, 24).map((field, index) => {
    const key = String(field?.key ?? `field${index + 1}`).trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(key)) throw new Error(`bad field key: ${key}`);
    return {
      key,
      label: String(field?.label ?? key).slice(0, 80),
      multiline: Boolean(field?.multiline),
      optional: Boolean(field?.optional)
    };
  });
}

function readAll() {
  try {
    const parsed = JSON.parse(readFileSync(requestsFile(), 'utf8'));
    return Array.isArray(parsed?.requests) ? parsed.requests : [];
  } catch { return []; }
}

function writeAll(requests) {
  mkdirSync(join(requestsFile(), '..'), { recursive: true, mode: 0o700 });
  const tmp = `${requestsFile()}.tmp-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmp, `${JSON.stringify({ requests }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, requestsFile());
}

function withExpiry(request) {
  if (request.status === 'pending' && Date.parse(request.expires) <= Date.now()) {
    return { ...request, status: 'expired' };
  }
  return request;
}

export function listRequests() {
  return readAll().map(withExpiry);
}

export function getRequest(id) {
  return listRequests().find((request) => request.id === id) || null;
}

export function createRequest({ name, why = '', fields, ttlMinutes = DEFAULT_TTL_MINUTES }) {
  if (!validName(name)) throw new Error('name must be lowercase letters, digits and dashes (2-63 chars)');
  const now = Date.now();
  const request = {
    id: randomBytes(9).toString('base64url'),
    name,
    why: String(why).slice(0, 500),
    fields: normalizeFields(fields),
    exists: secretPresent(name),
    status: 'pending',
    created: new Date(now).toISOString(),
    expires: new Date(now + Math.min(24 * 60, Math.max(1, Number(ttlMinutes) || DEFAULT_TTL_MINUTES)) * 60_000).toISOString(),
    filled_at: null
  };
  
  
  const week = now - 7 * 86_400_000;
  const kept = readAll().filter((existing) => !(existing.name === name && existing.status === 'pending'))
    .filter((existing) => Date.parse(existing.created) > week);
  writeAll([...kept, request]);
  return request;
}

export function cancelRequest(id) {
  const requests = readAll().map(withExpiry);
  const found = requests.find((request) => request.id === id);
  if (!found) throw new Error('no such request');
  if (found.status === 'pending') found.status = 'cancelled';
  writeAll(requests);
  return found;
}

export function fulfillRequest(id, values, { overwrite = false } = {}) {
  const requests = readAll().map(withExpiry);
  const request = requests.find((entry) => entry.id === id);
  if (!request) throw new Error('no such request');
  if (request.status === 'expired') throw new Error('that request expired; ask the agent for a new link');
  if (request.status !== 'pending') throw new Error(`that request is already ${request.status}`);

  const collected = {};
  for (const field of request.fields) {
    const raw = values?.[field.key];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
      if (field.optional) continue;
      throw new Error(`${field.label} is required`);
    }
    collected[field.key] = value;
  }
  if (!Object.keys(collected).length) throw new Error('nothing to save');

  
  
  
  
  
  const body = request.fields.length === 1 && request.fields[0].key === 'value'
    ? collected.value
    : JSON.stringify(collected, null, 2);

  const result = writeSecret(request.name, body, { overwrite: overwrite || request.allowOverwrite });
  request.status = 'filled';
  request.filled_at = new Date().toISOString();
  request.bytes = result.bytes;
  request.superseded = result.superseded;
  writeAll(requests);
  return { name: request.name, bytes: result.bytes, superseded: result.superseded };
}
