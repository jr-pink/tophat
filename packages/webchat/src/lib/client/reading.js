// This browser's device id, for the surfaces that name the device they are on.
//
// The nightly symbol scan reported it dead for several nights running -- 65 lines, named by no
// other file in the repository and by no test -- so it was not running on any surface, and a
// reader of this directory had no way to tell that from code that is merely quiet.
//
// What still works is a different module with a confusingly similar name: core/reading.js
// (positionFrom, scrollTopFor, shouldAdopt, samePlace) is the transcript's scroll geometry and is
// live. The server side it spoke to, /api/reading and the store methods behind it (store.reading,
// store.markReading), is now reachable from no client in this tree. It is deliberately left in
// place: deleting a route is a behaviour change for anything outside this tree that may still
// POST to it, and that has not been checked. Checking it, and then deleting the route and the two
// store methods together, is the rest of this cleanup.
//
// One live line is left, and it is an alias rather than an implementation: the device id has ONE
// owner, client/device-id.js (webchatDeviceId, which mints it once per browser and adopts the
// older `webchat.device` value), and callers that reach for it through this module keep working.
import { webchatDeviceId } from './device-id.js';

/** The one device id (client/device-id.js). */
export const deviceId = (storage = globalThis.localStorage) => webchatDeviceId(storage);
