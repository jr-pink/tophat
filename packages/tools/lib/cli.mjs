// CLI plumbing shared by the tophat tools: one error type carrying an exit code.
// Exit codes are per tool and documented in each tool's README; the cdp table is the one agents branch on.
export const EXIT_CODES = {
  default: { ok: 0, error: 1, usage: 2, unavailable: 3, timeout: 4, refused: 5, auth_required: 6, blocked: 7, verify_failed: 8 },
  cdp: { ok: 0, usage: 1, endpoint_down: 2, target_not_found: 3, timeout: 4, refused: 5, hijack: 6, hittest: 7, verify_failed: 8 },
};
const table = (tool) => EXIT_CODES[tool] || EXIT_CODES.default;

/** The number for a kind in a tool's table; an unknown kind is the generic error (1). */
export function exitCode(tool, kind) {
  const t = table(tool);
  return Object.hasOwn(t, kind) ? t[kind] : 1;
}

export class CliError extends Error {
  constructor(message, { tool = 'default', kind = 'error', code, detail = {} } = {}) {
    super(message);
    this.name = 'CliError';
    this.tool = tool;
    this.kind = kind;
    this.code = code ?? exitCode(tool, kind);
    this.detail = detail;
  }
}
