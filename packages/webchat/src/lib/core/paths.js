

const CODE_EXT = 'js|mjs|cjs|ts|tsx|jsx|svelte|json|jsonl|md|markdown|txt|py|sh|zsh|yml|yaml|toml|css|html|sql|csv|pdf|png|jpg|jpeg|svg|webp|gif|heic|mov|mp4|webm|wav|mp3|m4a|lock|env|ini|conf|xml|rs|go|c|h|cpp|java|rb|php|swift|plist|log|sqlite|db|epub|zip|docx|xlsx|pptx|stl|step|dxf';

const CANDIDATE = new RegExp(
  "(?:^|[\\s(\\[<'\"`])((?:~|\\.{1,2})?/?(?:[\\w.@+-]+/)*[\\w.@+-]+/?)(:\\d+)?(:\\d+)?(?=$|[\\s)\\]>'\"`,;!?:]|\\.\\s|\\.$)",
  'gu'
);

const BARE_DOCUMENT = /\.(?:md|markdown|pdf|csv|txt|jsonl)$/iu;
const HAS_EXT = new RegExp(`\\.(?:${CODE_EXT})$`, 'iu');

// An absolute path is only a file path when it starts where files live on this machine. "/api/notes",
// "/landing", "/gp/cart", "/v1/messages" in a reply are routes and URL paths, and a link that 404s
// every time is worse than no link.
const FILE_TOPS = /^\/(?:Users|Volumes|tmp|private|var|etc|opt|usr|bin|sbin|Library|System|Applications|dev|home|nix|cores)(?:\/|$)/u;

// "store.husarion.com/products.json", "nytimes.com/wirecutter/..." are web addresses written without
// a scheme, not relative paths.
const HOSTNAME = /^(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|co|me|ai|app|edu|gov|sh|xyz|us|uk|de|fr|jp|so|gg|tv|fm|ly|to|info|biz|page|site|tech|cloud|link|center|news|blog|store|shop|health|science)$/iu;

function plausible(path) {
  if (path.startsWith('/') && !FILE_TOPS.test(path)) return false;
  const first = path.split('/')[0];
  if (path.includes('/') && HOSTNAME.test(first)) return false;
  const rooted = path.startsWith('/') || path.startsWith('~/') || path.startsWith('./') || path.startsWith('../');
  if (path.endsWith('/')) {
    const name = path.replace(/\/+$/u, '');
    return rooted ? name.length > 1 : name.length >= 3;
  }
  if (rooted) return path.length > 2;
  if (path.includes('/')) return HAS_EXT.test(path);
  return BARE_DOCUMENT.test(path);
}


function trimTail(raw) {
  return raw.replace(/[.,;:!?)\]}'"]+$/u, '');
}

const COMMANDS = new Set('cat ls cd open rg grep node python python3 git npm npx pnpm yarn bun deno sed awk head tail vim nvim code cp mv rm mkdir touch curl wget uv bash sh zsh sudo echo find less more chmod chown wc du diff scp ssh rsync make tar unzip zip launchctl pdftotext sqlite3 jq kill pkill tee xargs env export source run test'.split(' '));
const STOPWORDS = new Set('a an and or to in on the of for from with at is are was were be been then vs via into onto by as if but not no it its this that these those see run open check use uses used lives live now also still here there because so which where when under over inside plus has have had do does did can will would should could may might per'.split(' '));

/**
 * The whole of a backtick span, an angle-bracketed target or a markdown link target taken as one
 * path when it is one, spaces included: `contracts-stage/work/rose matter/organisation analysis/x.csv`
 * links the file, not "matter/organisation". A command line (`scripts/test.sh rev6/x.test.mjs`,
 * `cat notes/a.md`), a flag, a pipe or a quote means it is not a path.
 */
export function wholePath(body) {
  const raw = String(body ?? '').trim();
  if (!raw || raw.length > 600 || !raw.includes('/') || /[\n|&;$=<>"'`*{}\\]/u.test(raw)) return null;
  const located = raw.match(/^(.*?)((?::\d+){1,2})?$/u);
  const path = located[1];
  if (/\s-{1,2}\w/u.test(` ${path}`) || /\s\//u.test(path) || /\/\s/u.test(path) || /\s{2,}/u.test(path)) return null;
  const words = path.split(' ');
  if (COMMANDS.has(words[0]) || /^tophat-/u.test(words[0])) return null;
  // A word ending in an extension followed by another word is two paths or a command, not one name.
  for (let index = 0; index < words.length - 1; index += 1) if (HAS_EXT.test(words[index])) return null;
  // "tools/tophat-amazon tools/README.md": a later word starting again from the first folder is a
  // second path, and so is one starting from ~ or /.
  const first = words[0].split('/')[0];
  if (words.slice(1).some((word) => word.startsWith('~/') || (first && word.startsWith(`${first}/`)))) return null;
  const rooted = /^(?:~|\.{1,2})?\//u.test(path);
  if (path.startsWith('/') && !FILE_TOPS.test(path)) return null;
  if (!rooted && HOSTNAME.test(path.split('/')[0])) return null;
  if (!(rooted || HAS_EXT.test(path) || path.endsWith('/'))) return null;
  const parts = (located[2] || '').split(':').filter(Boolean);
  return { path, line: parts[0] ? Number(parts[0]) : null, column: parts[1] ? Number(parts[1]) : null, text: raw };
}

// A rooted path in prose stops at its first space. When the words after it carry the path on
// ("~/Library/Application Support/BeeperTexts/index.db", ".../work/rose matter/organisation analysis/x.csv"),
// take them in: at most two words per gap, never a stop-word, and only up to a word that contains
// a slash, so "~/notes and src/a.js" stays two links.
const CONTINUATION = /^((?: [\w.@+()-]+){1,2}\/(?:[\w.@+()-]+(?: [\w.@+()-]+){0,2}\/)*[\w.@+-]*)/u;
function extendAcrossSpaces(text, end, path) {
  if (!/^(?:~|\/)/u.test(path) || HAS_EXT.test(path) || path.endsWith('/')) return null;
  const rest = text.slice(end);
  const more = rest.match(CONTINUATION);
  if (!more) return null;
  let tail = more[1].replace(/[.,;:!?)]+$/u, '');
  const words = tail.split(/[ /]/u).filter(Boolean);
  if (words.some((word) => STOPWORDS.has(word.toLowerCase()))) return null;
  // The joined path has to end like a path: an extension, a folder slash, or a further segment.
  const segments = tail.split('/');
  const last = segments.at(-1);
  if (last && !HAS_EXT.test(last) && last.includes(' ')) return null;
  if (last && last.includes(' ')) {
    const lastWords = last.split(' ');
    if (lastWords.slice(0, -1).some((word) => HAS_EXT.test(word))) return null;
  }
  return tail;
}

export function extractPaths(text, { unique = true } = {}) {
  if (typeof text !== 'string' || !text) return [];
  const found = [];
  const seen = new Set();
  const covered = [];
  const push = (entry) => {
    if (unique && seen.has(entry.text)) return;
    seen.add(entry.text);
    found.push(entry);
    covered.push([entry.start, entry.end]);
  };
  // Angle brackets mark the whole target, spaces and all: </Users/x/My File.pdf>.
  for (const match of text.matchAll(/<([^<>\n]+)>/gu)) {
    const whole = wholePath(match[1]);
    if (!whole || whole.text !== match[1]) continue;
    const start = match.index + 1;
    push({ ...whole, start, end: start + whole.text.length });
  }
  for (const match of text.matchAll(CANDIDATE)) {
    const start = match.index + match[0].length - match[1].length - (match[2] || '').length - (match[3] || '').length;
    if (covered.some(([from, to]) => start >= from && start < to)) continue;
    let path = trimTail(match[1]);
    let end = start + path.length;
    let suffix = `${match[2] || ''}${match[3] || ''}`;
    if (path.length === match[1].length && !suffix) {
      const tail = extendAcrossSpaces(text, end, path);
      if (tail) {
        path += tail;
        end += tail.length;
        const after = text.slice(end).match(/^((?::\d+){1,2})/u);
        suffix = after ? after[1] : '';
      }
    }
    if (!plausible(path)) continue;
    const whole = `${path}${suffix}`;
    if (covered.some(([from, to]) => start < to && start + whole.length > from)) continue;
    const parts = suffix.split(':').filter(Boolean);
    push({
      path,
      line: parts[0] ? Number(parts[0]) : null,
      column: parts[1] ? Number(parts[1]) : null,
      text: whole,
      start,
      end: start + whole.length
    });
  }
  return found.sort((a, b) => a.start - b.start);
}

export function segmentPaths(text) {
  const paths = extractPaths(text, { unique: false });
  if (!paths.length) return [{ type: 'text', text }];
  const out = [];
  let at = 0;
  for (const found of paths) {
    const start = text.slice(found.start, found.end) === found.text ? found.start : text.indexOf(found.text, at);
    if (start === -1 || start < at) continue;
    if (start > at) out.push({ type: 'text', text: text.slice(at, start) });
    const { start: _s, end: _e, ...rest } = found;
    out.push({ type: 'path', ...rest });
    at = start + found.text.length;
  }
  if (at < text.length) out.push({ type: 'text', text: text.slice(at) });
  return out;
}

const QUICKLOOK = new Set(['md', 'markdown', 'txt', 'json', 'jsonl', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'svelte', 'py', 'sh', 'zsh', 'yml', 'yaml', 'toml', 'css', 'html', 'sql', 'csv', 'png', 'jpg', 'jpeg', 'svg', 'webp', 'gif', 'avif', 'pdf']);

export function extensionOf(path) {
  const base = String(path).split(/[?#]/u)[0].split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

export function quicklookable(path) {
  return QUICKLOOK.has(extensionOf(path));
}

export function isImage(path) {
  return ['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif', 'avif'].includes(extensionOf(path));
}

/** An http(s) URL whose path ends in an image extension: opens in quicklook through the image proxy. */
export function isRemoteImage(url) {
  return /^https?:\/\//iu.test(String(url || '')) && isImage(String(url).split(/[?#]/u)[0]);
}
