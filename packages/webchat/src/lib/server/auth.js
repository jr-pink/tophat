

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { secretsDir } from './secrets.js';
import { readNamedSecret } from '../../../../runner/src/vault/named-secret.mjs';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from '@simplewebauthn/server';

const SESSION_TTL_MS = 30 * 86_400_000; 
export const SESSION_COOKIE = 'tophat_webchat_session';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS credentials (
  id            TEXT PRIMARY KEY,
  public_key    BLOB NOT NULL,
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,
  label         TEXT,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS challenges (
  id            TEXT PRIMARY KEY,
  challenge     TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
`;

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export function createAuth({ db, rpId, origin, bootstrapToken, secret, disabled = false }) {
  db.exec(SCHEMA);

  const insertChallenge = db.prepare('INSERT OR REPLACE INTO challenges (id, challenge, created_at) VALUES (?, ?, ?)');
  const takeChallenge = db.prepare('SELECT challenge, created_at FROM challenges WHERE id = ?');
  const dropChallenge = db.prepare('DELETE FROM challenges WHERE id = ?');
  const allCredentials = db.prepare('SELECT * FROM credentials');
  const getCredential = db.prepare('SELECT * FROM credentials WHERE id = ?');
  const putCredential = db.prepare('INSERT OR REPLACE INTO credentials (id, public_key, counter, transports, label, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const bumpCounter = db.prepare('UPDATE credentials SET counter = ? WHERE id = ?');

  function remember(key, challenge) {
    insertChallenge.run(key, challenge, Date.now());
  }

  function recall(key) {
    const row = takeChallenge.get(key);
    dropChallenge.run(key);
    if (!row || Date.now() - row.created_at > CHALLENGE_TTL_MS) return null;
    return row.challenge;
  }

  function credentials() {
    return allCredentials.all().map((row) => ({
      id: row.id,
      publicKey: new Uint8Array(row.public_key),
      counter: row.counter,
      transports: row.transports ? JSON.parse(row.transports) : undefined
    }));
  }

  function sign(payload) {
    return createHmac('sha256', secret).update(payload).digest('base64url');
  }

  return {
    disabled,
    enrolled: () => allCredentials.all().length > 0,

    
    
    async registrationOptions({ token, authenticated }) {
      if (!authenticated) {
        if (!bootstrapToken || token !== bootstrapToken) throw new Error('Enrolment is closed');
      }
      const options = await generateRegistrationOptions({
        rpName: 'tophat chat',
        rpID: rpId,
        userName: process.env.TOPHAT_USER_NAME || 'owner',
        userDisplayName: process.env.TOPHAT_USER_NAME || 'Owner',
        attestationType: 'none',
        excludeCredentials: credentials().map((credential) => ({ id: credential.id, transports: credential.transports })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' }
      });
      remember('register', options.challenge);
      return options;
    },

    async verifyRegistration(response, label = 'passkey') {
      const expectedChallenge = recall('register');
      if (!expectedChallenge) throw new Error('Enrolment expired; start again');
      const result = await verifyRegistrationResponse({
        response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpId, requireUserVerification: false
      });
      if (!result.verified) throw new Error('Passkey could not be verified');
      const info = result.registrationInfo.credential;
      putCredential.run(info.id, Buffer.from(info.publicKey), info.counter || 0,
        JSON.stringify(response.response?.transports || []), label, new Date().toISOString());
      return { id: info.id };
    },

    async authenticationOptions() {
      const options = await generateAuthenticationOptions({
        rpID: rpId,
        userVerification: 'preferred',
        allowCredentials: credentials().map((credential) => ({ id: credential.id, transports: credential.transports }))
      });
      remember('authenticate', options.challenge);
      return options;
    },

    async verifyAuthentication(response) {
      const expectedChallenge = recall('authenticate');
      if (!expectedChallenge) throw new Error('Sign-in expired; try again');
      const row = getCredential.get(response.id);
      if (!row) throw new Error('Unknown passkey');
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        credential: {
          id: row.id,
          publicKey: new Uint8Array(row.public_key),
          counter: row.counter,
          transports: row.transports ? JSON.parse(row.transports) : undefined
        },
        requireUserVerification: false
      });
      if (!result.verified) throw new Error('Passkey rejected');
      bumpCounter.run(result.authenticationInfo.newCounter, row.id);
      return this.issueSession();
    },

    issueSession() {
      const expires = Date.now() + SESSION_TTL_MS;
      const payload = `${expires}.${randomBytes(9).toString('base64url')}`;
      return { value: `${payload}.${sign(payload)}`, expires: new Date(expires) };
    },

    valid(cookie) {
      if (disabled) return true;
      if (!cookie) return false;
      const at = cookie.lastIndexOf('.');
      if (at === -1) return false;
      const payload = cookie.slice(0, at);
      const provided = Buffer.from(cookie.slice(at + 1));
      const expected = Buffer.from(sign(payload));
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return false;
      return Number(payload.split('.')[0]) > Date.now();
    }
  };
}

// The webchat's own tokens used to be the one credential store nothing else knew
// about: ten plaintext files under ~/.config/tophat/secrets, read straight off disk
// here, while every other secret lived in the vault. They are in the vault now,
// under the same names; this reads from there.
//
// On security, since the obvious question is whether encrypting them changed
// anything: on its own, no. The vault's master key sits unwrapped beside the
// ciphertext, because he needs unattended access, so anything that can read files
// as this user can read both. What it buys is one store with one audit trail
// instead of a forgotten corner. The exposure that matters is FileVault being off,
// which is a disk-level fix, not a file-format one.
export function readSecret(name, fallbackEnv) {
  if (process.env[fallbackEnv]) return process.env[fallbackEnv];
  try {
    const value = readNamedSecret(name);
    if (value !== null && value !== undefined) return String(value).trim();
  } catch {
    // fall through: a locked or unreadable vault is reported as a missing
    // secret, exactly as a missing file was, so the caller's handling is unchanged
  }
  return null;
}
