// This browser's webchat device id, minted ONCE for every surface: reading positions (client/reading.js), the reader
// replica's ops (client/reader-offline.js) and the reading chat's actions all name the same device. Before, two
// modules each held their own read-or-mint of `webchat.device` (two formats). Now the kit's `onceId` recipe: durable,
// the first tab to mint wins, the existing `webchat.device` value is adopted and that key left in place (rollback).
import { createReplica } from '../../../../runner/tools/docstore-kit/lib/model.js';
import { onceId, idOf } from '../../../../runner/tools/docstore-kit/lib/recipes.js';

export const deviceDecl = onceId('webchat-device', { legacyKey: 'webchat.device' });
const mintDevice = () => `dev-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

export function webchatDeviceId(storage = globalThis.localStorage) {
  try {
    if (!storage) return 'dev-anonymous';
    return idOf(createReplica(deviceDecl, { storage, device: 'device-id' }), mintDevice);
  } catch {
    return 'dev-anonymous';
  }
}
