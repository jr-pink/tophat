// Canonical JSON, the byte form conformance vectors compare: object keys sorted by UTF-16 code units, no whitespace,
// numbers and strings exactly as JSON.stringify writes them (shortest round-trip numbers, non-ASCII left raw, -0 as 0).
// Another implementation (Python, a Worker) matches the vectors byte for byte by writing this same form.
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}
