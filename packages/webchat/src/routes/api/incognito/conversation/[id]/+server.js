import { json, error } from '@sveltejs/kit';
import { incognito } from '$lib/server/incognito.js';

const MAX_LIMIT = 20000;
const bounded = (raw, fallback) => {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), MAX_LIMIT);
};

export async function GET({ params, url }) {
  const beforeParam = url.searchParams.get('before');
  const before = beforeParam == null ? null : Math.max(0, Number(beforeParam) || 0);
  const found = (await incognito()).conversation(params.id, {
    after: Math.max(0, Number(url.searchParams.get('after') || 0)),
    before,
    limit: bounded(url.searchParams.get('limit'), MAX_LIMIT),
    newest: url.searchParams.get('newest') === '1' || before != null
  });
  if (!found) error(404, 'Unknown conversation');
  return json(found, { headers: { 'cache-control': 'no-store' } });
}
