// Apple's own stores on macOS. Set `kind` on the source:
//   apple-contacts, apple-calendar, apple-notes   through the signed helper app that owns the TCC grants (config.helperApp;
//                                                 build it once with buildHelper, see README "Apple helper"); notes need
//                                                 config.folderIds, calendar a window (config.windowMode 'rolling' = -90/+30 days)
//   apple-headspaces                              dated entries split out of a notes folder (stamp YYMD.HM, base64 digits)
//   apple-call-history                            config.databases: [CallHistory.storedata paths] (copies, read-only)
//   apple-photos                                  config.library(ies): metadata only, never pixels, filenames or recognition tables
//   contacts-backup, photos-export                copies kept outside the store (WAL-safe AddressBook backup; osxphotos export)
// A denied grant fails by name (full-disk-access-required), never as an empty source.
// Ported from an upstream adapter (VENDOR.json `ported`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync, backup } from 'node:sqlite';
import { FULL_DISK_ACCESS_STEP, appleIso, columnsOf, fail, hashJson, isoOrFail, mtimeIso, readUnits, result, sha, withCopy } from '../lib/common.mjs';

const exec = promisify(execFile);
export const LIVE_CALLS = path.join(os.homedir(), 'Library/Application Support/CallHistoryDB/CallHistory.storedata');
export const LIVE_PHOTOS = path.join(os.homedir(), 'Pictures/Photos Library.photoslibrary');
const HERE = path.dirname(new URL(import.meta.url).pathname);

// ---- helper app: contacts, calendar, notes ----
/** Compile and ad-hoc sign the helper (its bundle identity owns the TCC grants). Not run by poll: `tophat-sources build-apple-helper DIR`. */
export async function buildHelper({ directory, run = exec, bundleId = 'io.linknotes.source-reader', appName = 'Linknotes Source Reader' }) {
  if (!path.isAbsolute(directory || '')) fail('absolute-private-directory-required');
  const app = path.join(directory, `${appName}.app`), macos = path.join(app, 'Contents/MacOS');
  fs.mkdirSync(macos, { recursive: true, mode: 0o700 });
  for (const f of ['SourceReader.swift', 'notes-reader.js']) fs.copyFileSync(path.join(HERE, '..', 'native', f), path.join(directory, f));
  const usage = (k, v) => `<key>${k}</key><string>${v}</string>`;
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
${usage('CFBundleIdentifier', bundleId)}${usage('CFBundleExecutable', 'SourceReader')}${usage('CFBundleName', appName)}${usage('CFBundleVersion', '1')}<key>LSUIElement</key><true/>
${usage('NSContactsUsageDescription', 'Read contacts into your private assistant.')}${usage('NSCalendarsFullAccessUsageDescription', 'Read calendar events into your private assistant.')}
${usage('NSCalendarsUsageDescription', 'Read calendar events into your private assistant.')}${usage('NSAppleEventsUsageDescription', 'Read selected Notes folders into your private assistant.')}
</dict></plist>`, { mode: 0o600 });
  await run('xcrun', ['swiftc', path.join(directory, 'SourceReader.swift'), '-o', path.join(macos, 'SourceReader')], { timeout: 120000, maxBuffer: 100000 });
  await run('/usr/bin/codesign', ['--force', '--sign', '-', app], { timeout: 30000, maxBuffer: 100000 });
  return { helperApp: app, readerScript: path.join(directory, 'notes-reader.js') };
}

/** One helper run: config in a 0600 temp file, structured answer out; the helper's own result is authoritative. */
export async function helper(source, operation, { run = exec, platform = process.platform } = {}) {
  if (platform !== 'darwin') fail('macos-required');
  const c = source.config || {};
  if (!c.helperApp) fail('native-helper-required');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linknotes-source-')); fs.chmodSync(dir, 0o700);
  const input = path.join(dir, 'input.json'), output = path.join(dir, 'output.json');
  try {
    fs.writeFileSync(input, JSON.stringify(c), { mode: 0o600 });
    try { await run('/usr/bin/open', ['-W', '-n', c.helperApp, '--args', source.kind, operation, input, output], { timeout: 120000, maxBuffer: 100000 }); } catch { /* output decides */ }
    let data; try { data = JSON.parse(fs.readFileSync(output, 'utf8')); } catch { fail('native-helper-unavailable'); }
    if (data.status === 'unavailable') fail(data.code || 'permission-required');
    return data;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const notesText = (html) => String(html || '').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(div|p|li)>/gi, '\n').replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

export async function pollHelper(source, { now = new Date(), run, platform } = {}) {
  let c = source.config || {};
  if (source.kind === 'apple-calendar' && c.windowMode === 'rolling') {
    const t = new Date(now).getTime(); if (!Number.isFinite(t)) fail('invalid-calendar-clock');
    c = { ...c, start: new Date(t - 90 * 86400000).toISOString(), end: new Date(t + 30 * 86400000).toISOString() };
  }
  if (!['apple-contacts', 'apple-calendar', 'apple-notes'].includes(source.kind)) fail('unsupported-native-kind');
  if (source.kind === 'apple-notes' && (!Array.isArray(c.folderIds) || !c.folderIds.length)) fail('notes-folders-required');
  if (source.kind === 'apple-calendar' && (!c.start || !c.end)) fail('calendar-window-required');
  const data = await helper({ ...source, config: c }, 'read', { run, platform });
  if (data.status !== 'ok' || !Array.isArray(data.records)) fail('invalid-native-response');
  const records = data.records.map((row) => {
    if (typeof row.id !== 'string') fail('invalid-source-id');
    if (source.kind === 'apple-contacts') return { id: row.id, revision: hashJson(row), occurredAt: isoOrFail(now), text: JSON.stringify(row), metadata: { snapshot: true } };
    if (source.kind === 'apple-notes') return { id: row.id, revision: hashJson(row), occurredAt: isoOrFail(row.modified), text: `${row.title}\n${notesText(row.body)}`, metadata: { folderId: row.folderId } };
    return { id: `${row.calendarId}:${row.id}:${row.start}`, revision: hashJson(row), occurredAt: isoOrFail(row.modified), text: JSON.stringify(row), threadId: row.externalId || row.id,
      metadata: { start: row.start, end: row.end, allDay: row.allDay, timezone: row.timezone, recurring: row.recurring } };
  });
  return { records, cursor: { observedAt: isoOrFail(now) }, complete: false, health: { status: 'ok', coverage: data.coverage } };
}

// ---- headspaces: one record per dated entry of an appended note ----
// Stamp `YYMD.HM`, each field one base64 digit: `26DH.Kr` is 2026-03-07 10:43
// local. A header is a BARE line (a stamp inside a bullet is a mention, scar 1);
// entities appear without semicolons and &amp goes last (scar 2). Port of
// a Python reader, held equal to it by a fuzz test upstream.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const JS_WS = '[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]';
const BULLET = new RegExp(`^${JS_WS}*[-*\\u2022\\u2013\\u2014]+${JS_WS}+`);
const FIRST = new RegExp(`${JS_WS}+`);
export function decodeStamp(tag) {
  const m = /^(\d{2})([A-Za-z0-9+/])([A-Za-z0-9+/])\.([A-Za-z0-9+/])([A-Za-z0-9+/])$/.exec(String(tag ?? ''));
  if (!m) return null;
  const [mo, d, h, mi] = m.slice(2).map((ch) => B64.indexOf(ch));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const date = `${2000 + Number(m[1])}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { tag, date, iso: `${date}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` };
}
export function splitEntries(body) {
  const out = []; let stamp = null, heading = null, held = [], mentions = [];
  const flush = () => out.push({ tag: stamp?.tag ?? null, date: stamp?.date ?? null, iso: stamp?.iso ?? null, heading, mentions,
    text: held.join('\n').replace(/\n{3,}/g, '\n\n').trim() });
  for (const line of String(body ?? '').split(/[\n\u2028\u2029]/)) {
    const bulleted = BULLET.test(line), trimmed = line.trim(), first = trimmed.split(FIRST)[0];
    const found = bulleted ? null : decodeStamp(first);
    if (found) { if (held.length || stamp) flush(); stamp = found; heading = trimmed.slice(first.length).trim() || null; held = []; mentions = []; continue; }
    if (bulleted) { const cited = decodeStamp(line.replace(BULLET, '').split(FIRST)[0]); if (cited) mentions.push(cited.iso); }
    held.push(line);
  }
  if (held.length || stamp) flush();
  return out;
}
export const unescapeEntities = (t) => String(t ?? '').replace(/&gt;?/g, '>').replace(/&lt;?/g, '<').replace(/&quot;?/g, '"').replace(/&#39;?/g, "'").replace(/&nbsp;?/g, ' ').replace(/&amp;?/g, '&');
/** Local wall time in a zone to UTC ISO (two-pass offset; DST-safe outside the skipped hour). */
export function zonedIso(local, zone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const guess = Date.parse(`${local}:00Z`); if (!Number.isFinite(guess) || new Date(guess).toISOString().slice(0, 16) !== local) return null; // 02-31 is not a day (Python refuses it too)
  const off = (t) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(t).map((x) => [x.type, x.value]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t; };
  const first = guess - off(guess), t = guess - off(first);
  // In the skipped spring-forward hour no instant renders as `local`; Python (fold=0) then keeps the pre-gap offset, which is `first`.
  return new Date(new Date(t + off(t)).toISOString().slice(0, 16) === local ? t : first).toISOString();
}
/** Note records -> entry records (id = stamp tag; revision = sha of heading+text). Undated head text longer than 200 chars is one preamble record per note. */
export function headspaceEntries(noteRecords, { zone } = {}) {
  const out = [];
  for (const note of noteRecords) for (const e of splitEntries(note.text)) {
    const occurred = e.iso ? zonedIso(e.iso, zone) : null;
    if (!occurred || !((e.text || '').trim() || (e.heading || '').trim())) {
      const body = unescapeEntities(e.text).trim();
      if (body.length > 200) out.push({ id: `${note.id}#preamble`, revision: sha(body), occurredAt: note.occurredAt, text: body, metadata: { type: 'headspace-preamble', documentId: note.id } });
      continue;
    }
    const heading = e.heading ? unescapeEntities(e.heading) : null, full = heading ? `${heading}\n${unescapeEntities(e.text)}` : unescapeEntities(e.text);
    out.push({ id: e.tag, revision: sha(full), occurredAt: occurred, text: full, metadata: { type: 'headspace-entry', entryTag: e.tag, localIso: e.iso, mentions: e.mentions, documentId: note.id } });
  }
  return out;
}

// ---- call history ----
const CALL_COLS = ['ZUNIQUE_ID', 'ZDATE', 'ZDURATION', 'ZORIGINATED', 'ZANSWERED', 'ZCALLTYPE', 'ZADDRESS', 'ZNAME', 'ZSERVICE_PROVIDER', 'ZISO_COUNTRY_CODE'];
export function callRecord(row, unit) {
  if (typeof row.unique_id !== 'string' || !row.unique_id) fail('invalid-call-identity');
  if (!Number.isFinite(Number(row.date))) fail('invalid-call-timestamp');
  const direction = row.originated == null ? 'unknown' : (row.originated ? 'outgoing' : 'incoming');
  const answered = row.answered == null ? null : Boolean(row.answered), duration = row.duration == null ? null : Math.round(Number(row.duration));
  const handle = row.address == null ? null : String(row.address), name = row.name == null ? null : String(row.name);
  const words = [`${direction} call`, name || handle ? `with ${name || handle}` : 'with an unrecorded handle', answered === false ? 'not answered' : null,
    duration === null ? null : `${duration}s`, row.service_provider ? `via ${row.service_provider}` : null].filter(Boolean);
  return { id: `call:${row.unique_id}`, revision: hashJson(row), occurredAt: appleIso(Number(row.date), 'invalid-call-timestamp'), text: words.join('; '),
    metadata: { type: 'call', readMode: unit.mode, unitId: unit.id, capturedAt: unit.capturedAt, direction, answered, durationSeconds: duration, handle,
      displayName: name, serviceProvider: row.service_provider ?? null, countryCode: row.iso_country_code ?? null,
      callType: row.calltype == null ? null : Number(row.calltype), currentAsOf: unit.mode === 'live' ? 'read-instant' : unit.capturedAt } };
}
export async function pollCalls(source, { cursor = null, copyFile = fs.copyFileSync } = {}) {
  const c = source.config ?? {}, batch = c.batchSize ?? 500;
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > 20000) fail('invalid-call-batch-size');
  if (!Array.isArray(c.databases) || !c.databases.length) fail('call-databases-required');
  const live = c.liveDatabase ?? LIVE_CALLS;
  const units = c.databases.map((e) => {
    const file = typeof e === 'string' ? e : e?.path;
    if (!file || !path.isAbsolute(file)) fail('absolute-call-database-path-required');
    return { id: typeof e === 'string' ? path.basename(e) : (e.id ?? path.basename(file)), path: file, mode: file === live ? 'live' : 'extract', capturedAt: mtimeIso(file) };
  });
  const previous = cursor?.version === 1 ? (cursor.units ?? {}) : {}, next = {}, drained = {};
  const { records, health } = await readUnits(units.map((unit) => ({ id: unit.id, read: () => withCopy(unit.path, 'calls.storedata', (db) => {
    const present = columnsOf(db, 'ZCALLRECORD');
    if (!present.has('ZUNIQUE_ID') || !present.has('ZDATE')) fail('unsupported-call-schema');
    const after = previous[unit.id] ?? { date: -Infinity, id: '' }, start = { date: Number.isFinite(after.date) ? after.date : -1e12, id: after.id ?? '' };
    const cols = CALL_COLS.map((n) => `${present.has(n) ? n : 'NULL'} AS ${n.slice(1).toLowerCase()}`).join(', ');
    const rows = db.prepare(`SELECT ${cols} FROM ZCALLRECORD WHERE ZUNIQUE_ID IS NOT NULL AND (ZDATE > ? OR (ZDATE = ? AND ZUNIQUE_ID > ?)) ORDER BY ZDATE, ZUNIQUE_ID LIMIT ?`)
      .all(start.date, start.date, start.id, batch);
    const last = rows.at(-1); next[unit.id] = last ? { date: Number(last.date), id: String(last.unique_id) } : after; drained[unit.id] = rows.length < batch;
    return rows.map((r) => callRecord(r, unit));
  }, { copyFile, prefix: 'linknotes-calls-', what: 'call-database' }) })), { deadlineMs: c.deadlineMs ?? 20000 });
  const modes = new Set(units.map((u) => u.mode));
  return { records, cursor: { version: 1, units: { ...previous, ...next } }, complete: units.every((u) => drained[u.id] === true), health: { ...health,
    coverage: modes.size > 1 ? 'mixed-live-and-extract' : modes.has('live') ? 'live-database-snapshot' : 'backup-extract-as-of-capture',
    readModes: units.map((u) => ({ unit: u.id, mode: u.mode, capturedAt: u.capturedAt })),
    ownerStep: health.unreadable.some((u) => u.code === 'full-disk-access-required') ? FULL_DISK_ACCESS_STEP : null } };
}

// ---- photos metadata ----
const pick = (present, ...names) => names.find((n) => present.has(n)) ?? null;
const sel = (present, alias, ...names) => { const f = pick(present, ...names); return f ? `${f} AS ${alias}` : `NULL AS ${alias}`; };
function albums(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Z\\_%ASSETS' ESCAPE '\\'").all().map((r) => r.name);
  let join = null;
  for (const table of tables) { const p = [...columnsOf(db, table)]; const asset = p.find((n) => /ASSETS$/.test(n)), album = p.find((n) => /ALBUMS$/.test(n)); if (asset && album) { join = { table, asset, album }; break; } }
  if (!join) return { memberships: new Map(), count: 0, recognized: false };
  const rows = db.prepare(`SELECT j.${join.asset} AS asset, ${sel(columnsOf(db, 'ZGENERICALBUM'), 'title', 'ZTITLE')} FROM ${join.table} j JOIN ZGENERICALBUM ON ZGENERICALBUM.Z_PK = j.${join.album}`).all();
  const memberships = new Map();
  for (const r of rows) if (r.title) memberships.set(r.asset, [...(memberships.get(r.asset) ?? []), String(r.title)]);
  return { memberships, count: Number(db.prepare(`SELECT COUNT(DISTINCT ${join.album}) AS n FROM ${join.table}`).get()?.n ?? 0), recognized: true };
}
export function photoRecord(row, list, unit) {
  if (typeof row.uuid !== 'string' || !row.uuid) fail('invalid-photo-identity');
  const taken = appleIso(row.taken, 'invalid-photo-timestamp');
  const lat = row.latitude == null ? null : Number(row.latitude), lon = row.longitude == null ? null : Number(row.longitude);
  const located = lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && !(lat === -180 || lon === -180);
  const mediaType = row.kind === 0 ? 'photo' : row.kind === 1 ? 'video' : 'unknown', label = mediaType === 'unknown' ? 'media asset (unknown kind)' : mediaType;
  return { id: `photo:${row.uuid}`, revision: hashJson({ version: 3, row, albums: list }), occurredAt: taken,
    text: [row.favorite ? `favorite ${label}` : label, `taken ${taken}`, located ? `at ${lat.toFixed(4)},${lon.toFixed(4)}` : 'with no recorded location',
      list.length ? `in ${list.join(', ')}` : 'in no album'].join('; '),
    metadata: { type: 'photo-metadata', mediaType, captureTimeBasis: 'library-supplied-apple-reference-seconds', rawCaptureTimestamp: row.taken, captureVerified: false,
      unitId: unit.id, content: 'metadata-only', latitude: located ? lat : null, longitude: located ? lon : null, albums: list,
      favorite: row.favorite == null ? null : Boolean(row.favorite), kind: row.kind == null ? null : Number(row.kind), addedAt: row.added == null ? null : appleIso(row.added, 'invalid-photo-timestamp') } };
}
export async function pollPhotos(source, { cursor = null, copyFile = fs.copyFileSync } = {}) {
  const c = source.config ?? {}, batch = c.batchSize ?? 500;
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > 20000) fail('invalid-photo-batch-size');
  const list = c.libraries ?? (c.library ? [c.library] : []);
  if (!Array.isArray(list) || !list.length) fail('photo-libraries-required');
  const units = list.map((e) => {
    const root = typeof e === 'string' ? e : e?.path;
    if (!root || !path.isAbsolute(root)) fail('absolute-photo-library-path-required');
    return { id: typeof e === 'string' ? path.basename(root) : (e.id ?? path.basename(root)), path: root.endsWith('.sqlite') ? root : path.join(root, 'database/Photos.sqlite') };
  });
  const previous = cursor?.version === 1 ? (cursor.units ?? {}) : {}, next = {}, drained = {}, counts = {};
  const { records, health } = await readUnits(units.map((unit) => ({ id: unit.id, read: () => withCopy(unit.path, 'Photos.sqlite', (db) => {
    const p = columnsOf(db, 'ZASSET');
    if (!p.has('Z_PK') || !p.has('ZUUID') || !p.has('ZDATECREATED')) fail('unsupported-photo-schema');
    const fields = ['Z_PK AS pk', 'ZUUID AS uuid', 'ZDATECREATED AS taken', sel(p, 'latitude', 'ZLATITUDE'), sel(p, 'longitude', 'ZLONGITUDE'), sel(p, 'favorite', 'ZFAVORITE'), sel(p, 'kind', 'ZKIND'), sel(p, 'added', 'ZADDEDDATE')].join(', ');
    const total = Number(db.prepare('SELECT COUNT(*) AS n FROM ZASSET').get()?.n ?? 0), a = albums(db);
    const after = previous[unit.id] ?? { taken: -1e12, pk: 0 };
    const rows = db.prepare(`SELECT ${fields} FROM ZASSET WHERE ZDATECREATED IS NOT NULL AND (ZDATECREATED > ? OR (ZDATECREATED = ? AND Z_PK > ?)) ORDER BY ZDATECREATED, Z_PK LIMIT ?`).all(after.taken, after.taken, after.pk, batch);
    const last = rows.at(-1); next[unit.id] = last ? { taken: Number(last.taken), pk: Number(last.pk) } : after; drained[unit.id] = rows.length < batch;
    counts[unit.id] = { assets: total, albums: a.count, albumsRecognized: a.recognized };
    return rows.map((r) => photoRecord(r, a.memberships.get(r.pk) ?? [], unit));
  }, { copyFile, prefix: 'linknotes-photos-', what: 'photo-library' }) })), { deadlineMs: c.deadlineMs ?? 20000 });
  return { records, cursor: { version: 1, units: { ...previous, ...next } }, complete: units.every((u) => drained[u.id] === true),
    health: { ...health, coverage: 'photo-metadata-only', counts, ownerStep: health.unreadable.some((u) => u.code === 'full-disk-access-required') ? FULL_DISK_ACCESS_STEP : null } };
}

// ---- copies kept outside plane A (store: 'own') ----
/** Daily `.backup` of every AddressBook database (WAL-safe, unlike a file copy) into dest/contacts-backup-YYYYMMDD. */
export async function backupContacts(source, { now = new Date() } = {}) {
  const c = source.config ?? {}, root = c.addressBook ?? path.join(os.homedir(), 'Library/Application Support/AddressBook');
  const day = isoOrFail(now).slice(0, 10).replace(/-/g, ''), dest = path.join(c.dest, `contacts-backup-${day}`);
  if (fs.existsSync(dest)) return result([], { lastSnapshot: day }, true, { coverage: 'snapshot-exists' });
  const files = [path.join(root, 'AddressBook-v22.abcddb'), ...(() => { try { return fs.readdirSync(path.join(root, 'Sources')).map((d) => path.join(root, 'Sources', d, 'AddressBook-v22.abcddb')); } catch { return []; } })()].filter((f) => fs.existsSync(f));
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const f of files) {
    const db = new DatabaseSync(f, { readOnly: true });
    try { await backup(db, path.join(dest, path.relative(root, f).replace(/\//g, '__'))); } finally { db.close(); }
  }
  return result([], { lastSnapshot: day }, true, { coverage: 'snapshot-written', files: files.length });
}
/** osxphotos originals export (incremental; CATCHUP downloads). Kept a subprocess: osxphotos is Python. */
export async function exportPhotos(source, { run = exec } = {}) {
  const c = source.config ?? {};
  if (!fs.existsSync(c.exportRoot)) return result([], null, false, { status: 'skipped', coverage: 'export-root-missing' });
  const args = ['export', c.exportRoot, '--library', c.library ?? LIVE_PHOTOS, ...(c.catchup ? ['--download-missing', '--use-photokit'] : []), '--update', '--deleted', '--export-aae',
    '--directory', '{created.year}/{created.mm}', '--filename', '{original_name}_{uuid}', '--sidecar', 'json', '--sidecar', 'xmp', '--favorite-rating',
    '--keyword-template', '{folder_album}', '--report', path.join(c.exportRoot, '.osxphotos-export-report.json'), '--exportdb', path.join(c.exportRoot, '.osxphotos_export.db')];
  await run(path.join(c.venv, 'bin/osxphotos'), args, { timeout: (c.maxRuntimeSeconds ?? 1800) * 1000, maxBuffer: 64 << 20, killSignal: 'SIGINT' });
  return result([], { exportedAt: isoOrFail(Date.now()) }, true, { coverage: 'originals-export' });
}

export async function poll(source, ctx = {}) {
  switch (source.kind) {
    case 'apple-contacts': case 'apple-calendar': case 'apple-notes': return pollHelper(source, ctx);
    case 'apple-headspaces': { const notes = await pollHelper({ ...source, kind: 'apple-notes' }, ctx); return { ...notes, records: headspaceEntries(notes.records, source.config) }; }
    case 'apple-call-history': return pollCalls(source, ctx);
    case 'apple-photos': return pollPhotos(source, ctx);
    case 'contacts-backup': return backupContacts(source, ctx);
    case 'photos-export': return exportPhotos(source, ctx);
    default: return fail('unsupported-apple-kind');
  }
}
