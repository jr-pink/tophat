// Pure parsing of the Find My accessibility tree (as printed by `tophat-ui ax tree`, a flat list of
// {path, role, desc, value, x, y, w, h}). No I/O here; unit tested in test/parse.test.mjs.
//
// Sidebar rows are AXStaticText under the list group, desc like
//   People:  "Lee Park, Springfield, IL , 5 min. ago, 0.2 mi"   "Me, Springfield, IL"
//            "Dana Okafor, <custom label> , Now, 8 mi"                        "Sam, No location found"
//   Devices: "tophat's Mac mini, This Mac, With You"   "the owner's Apple Watch, Elm St, Springfield , Now"
//            "iPhone, Lyon , Paused, 640 mi"        "old-tablet, Erase pending..."
// Status tokens are peeled from the end; whatever remains after the name is the place text.

export const LIST_PREFIX = '0/0/1/0/1/';
export const TAB_PATHS = { People: '0/0/1/0/0/0', Devices: '0/0/1/0/0/1', Items: '0/0/1/0/0/2' };

const NO_LOC = /^(No location found|Location not available|Offline|Unable to locate|Locating)/i;
const STATUS = /^(Paused|With You|This Mac|Erase pending.*|Lost Mode|Notify When Found|Sharing paused)$/i;

export function parseAge(tok) {
  if (/^Now$/i.test(tok)) return 0;
  const m = tok.match(/^(\d+)\s*(min|hr|hour|day|week)s?\.?\s*ago$/i);
  if (m) return Number(m[1]) * { min: 1, hr: 60, hour: 60, day: 1440, week: 10080 }[m[2].toLowerCase()];
  if (/^Yesterday$/i.test(tok)) return 1440;
  return undefined; // not an age token
}
export function parseDist(tok) {
  const m = tok.match(/^([\d.,]+)\s*(mi|ft|km|m)$/);
  if (!m) return undefined;
  const v = parseFloat(m[1].replace(/,/g, ''));
  return { mi: v, km: v * 0.621371, ft: v / 5280, m: v / 1609.344 }[m[2]];
}

export function parseRow(desc) {
  const parts = desc.split(/\s*,\s+/).map((x) => x.trim()).filter((x) => x !== '');
  const name = parts.shift() || '';
  const out = { name, place: '', age_min: null, dist_mi: null, status: null, located: false };
  for (;;) {
    const last = parts[parts.length - 1];
    if (last === undefined) break;
    const d = parseDist(last);
    if (d !== undefined && out.dist_mi === null) { out.dist_mi = d; parts.pop(); continue; }
    const a = parseAge(last);
    if (a !== undefined && out.age_min === null) { out.age_min = a; parts.pop(); continue; }
    if (STATUS.test(last)) { out.status = out.status ? `${last}; ${out.status}` : last; parts.pop(); continue; }
    break;
  }
  out.place = parts.join(', ').trim();
  if (NO_LOC.test(out.place)) { out.status = out.status || out.place; out.place = ''; }
  out.located = !!out.place || out.age_min !== null || out.dist_mi !== null;
  if (/^Paused$/i.test(out.status || '') && !out.place) out.located = false;
  return out;
}

// Sidebar rows in order; a heading ("Alexa's Devices") starts another person's section.
export function listRows(tree) {
  const rows = [];
  let section = 0, heading = null;
  for (const e of tree) {
    if (!e.path || !e.path.startsWith(LIST_PREFIX)) continue;
    const rest = e.path.slice(LIST_PREFIX.length).split('/');
    if (e.role === 'AXHeading' && rest.length === 1) { section++; heading = e.desc || e.title || ''; continue; }
    if (e.role === 'AXStaticText' && rest.length === 2 && rest[1] === '0' && e.desc) {
      rows.push({ ...parseRow(e.desc), path: e.path, section, heading, y: e.y, h: e.h, desc: e.desc });
    }
  }
  return rows;
}

// The sidebar tabs are AXRadioButtons labelled People / Devices / Items. Found by role and label, so a sheet
// or a re-laid-out window that shifts their path does not turn a tab switch into a stale press; TAB_PATHS is
// only the fallback for a tree that carries no labels.
export function tabElement(tree, name) {
  return (tree || []).find((x) => x.role === 'AXRadioButton' && x.desc === name) || (tree || []).find((x) => x.path === TAB_PATHS[name]) || null;
}
export function selectedTab(tree) {
  for (const name of Object.keys(TAB_PATHS)) {
    const e = tabElement(tree, name);
    if (e && String(e.value) === '1') return name;
  }
  return null;
}

export const center = (e) => ({ px: e.x + e.w / 2, py: e.y + e.h / 2 });
const finite = (e) => [e.x, e.y, e.w, e.h].every(Number.isFinite);

// The map: AXImage "Map". Its children are MapKit annotations with projected (fractional) frames:
// points of interest (labels) and Find My pins ("Name,Map pin"). Siblings of the map at depth 6 repeat the
// pins with integer 44x44 frames, plus "My Location" and the selected item's callout texts.
export function mapView(tree) {
  const map = tree.find((e) => e.role === 'AXImage' && e.desc === 'Map');
  if (!map) return null;
  const base = map.path + '/';
  const depth = map.path.split('/').length;
  const kids = tree.filter((e) => e.path.startsWith(base) && e.path.split('/').length === depth + 1 && e.role === 'AXGenericElement' && e.desc && finite(e));
  const pins = [], labels = [];
  for (const k of kids) {
    const m = k.desc.match(/^(.*),Map pin$/);
    if (m) pins.push({ name: m[1], ...center(k), exact: true });
    else if (k.desc !== 'My Location') labels.push({ name: k.desc, ...center(k) });
  }
  const parent = map.path.split('/').slice(0, -1).join('/') + '/';
  const sib = tree.filter((e) => e.path.startsWith(parent) && e.path.split('/').length === depth && finite(e));
  for (const s of sib) {
    const m = (s.desc || '').match(/^(.*),Map pin$/);
    if (m && !pins.some((p) => p.name === m[1])) pins.push({ name: m[1], ...center(s), exact: false });
  }
  const myLoc = sib.find((s) => s.desc === 'My Location');
  // Callout: a "<name>" static text followed by "<place> • <age>" (both at depth 6, consecutive paths).
  let callout = null;
  const texts = sib.filter((s) => s.role === 'AXStaticText' && s.desc);
  const detail = texts.find((s) => / • /.test(s.desc));
  if (detail) {
    const nameEl = texts.find((s) => s !== detail && !/ • /.test(s.desc) && Math.abs(s.x - detail.x) < 2 && s.y < detail.y && detail.y - s.y < 40);
    const [place, age] = detail.desc.split(' • ');
    callout = { name: nameEl ? nameEl.desc : null, place: place.replace(/\s+/g, ' ').trim(), age_min: parseAge((age || '').trim()) ?? null };
  }
  const compass = sib.find((s) => s.desc === 'Compass');
  const heading = compass && String(compass.value || '');
  return { frame: { x: map.x, y: map.y, w: map.w, h: map.h }, pins, labels, myLocation: myLoc ? center(myLoc) : null, callout, northUp: !heading || /Heading: 0 degrees/.test(heading) };
}

// Strip emoji and punctuation for matching names typed by a person ("dana") against "Dana 🦒 Okafor".
export function normName(s) {
  return String(s || '').normalize('NFKD').replace(/[\u2018\u2019]/g, "'").replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
// One key per person across capture glitches: a bad capture wrote "Sam \uFFFD\uFFFD\uFFFD Rivera" for "Sam 📈 Rivera".
export const foldName = (s) => normName(String(s || '').replace(/\uFFFD/gu, '')).replace(/\s+/g, ' ').trim();
export const nameMatches = (full, query) => { const a = normName(full), q = normName(query); return !!q && (a === q || a.includes(q)); };
