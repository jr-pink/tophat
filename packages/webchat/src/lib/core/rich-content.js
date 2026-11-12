
export function mediaUrl(value) {
  const source = String(value || '').trim().replace(/^<|>$/g, '');
  if (!source || /[\u0000-\u001f]/u.test(source) || source.startsWith('//')) return null;
  if (/^https?:\/\//i.test(source)) return source;
  if (/^[a-z][a-z\d+.-]*:/i.test(source)) return null;
  return `/api/file?path=${encodeURIComponent(source)}&raw=1`;
}

export function mediaKind(value) {
  const path = String(value).split(/[?#]/)[0].toLowerCase();
  if (/\.(png|jpe?g|webp|gif|svg|avif)$/.test(path)) return 'image';
  if (/\.(mp4|webm|mov|m4v|ogv|avi|mkv|wmv|flv|mpe?g|3gp|mts|m2ts)$/.test(path)) return 'video';
  if (/\.(mp3|wav|ogg|m4a)$/.test(path)) return 'audio';
  if (/\.html?$/.test(path)) return 'widget-file';
  return null;
}

// One image written on a line of its own: `![alt](path)` or `![alt](<path with spaces>)`. The same
// grammar serves the chat renderer (richBlock), the block splitter in markdown.js and the share page,
// so the three cannot disagree about what counts as an image line.
const MEDIA_LINE = /^!\[([^\]]*)\]\((<[^>]+>|[^)]+)\)$/u;

export const REMOTE_IMAGE_ROUTE = '/api/remote-image';

export function remoteImageUrl(source, route = REMOTE_IMAGE_ROUTE) {
  return `${route}?u=${encodeURIComponent(source)}`;
}

// `<video controls src="/abs/path.mp4"></video>` on a line of its own is the same inline player as
// `![caption](/abs/path.mp4)`.
const VIDEO_TAG = /^<video\b([^>]*)>\s*(?:<\/video>)?$/iu;
function videoTag(block) {
  const tag = block.trim().match(VIDEO_TAG);
  if (!tag) return null;
  const attr = (name) => tag[1].match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'iu'));
  const src = attr('src');
  const source = src && (src[1] ?? src[2]);
  const url = source && mediaUrl(source);
  if (!url) return null;
  const label = attr('title') || attr('aria-label');
  return { kind: 'video', title: (label && (label[1] ?? label[2])) || source.split('/').pop(), source, url };
}

/** Video files named in a user message's "Attached file(s):" list, in order. */
export function attachedVideos(text) {
  const list = String(text ?? '').match(/\n\nAttached files?:\n((?:- [^\n]*\n?)+)$/u);
  if (!list) return [];
  return list[1].split('\n').map((l) => l.replace(/^- /u, '').trim())
    .filter((p) => p.startsWith('/') && mediaKind(p) === 'video')
    .map((p) => ({ kind: 'video', title: p.split('/').pop().replace(/^[0-9a-f]{8}-/u, ''), source: p, url: mediaUrl(p) }));
}

// A gallery: one player over several videos. Written as a fence, one `path | caption` per line:
//   ```videos
//   /abs/a.mp4 | Capillaries, sm01
//   /abs/b.avi
//   ```
// or as consecutive single embeds, which compileMarkdown folds into one gallery.
function videoGallery(block) {
  const fence = block.match(/^\s*(```|~~~)videos[ \t]*\n([\s\S]*?)\n\1\s*$/u);
  if (!fence) return null;
  const seen = new Set();
  const items = [];
  for (const line of fence[2].split('\n')) {
    const [rawPath, ...caption] = line.split('|');
    const source = rawPath.trim().replace(/^<|>$/g, '');
    const url = source && mediaUrl(source);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    items.push({ kind: 'video', title: caption.join('|').trim() || source.split('/').pop(), source, url });
  }
  return items.length ? { kind: 'videos', title: 'Videos', items } : null;
}

/** Fold runs of adjacent single-video rich blocks into one gallery block (in place on a copy). */
export function foldVideoRuns(blocks) {
  const out = [];
  for (const block of blocks) {
    const prev = out[out.length - 1];
    if (block.rich?.kind === 'video' && (prev?.rich?.kind === 'video' || prev?.rich?.kind === 'videos') && !prev.fenced) {
      const items = prev.rich.kind === 'videos' ? prev.rich.items : [prev.rich];
      if (!items.some((i) => i.url === block.rich.url)) {
        out[out.length - 1] = { ...prev, rich: { kind: 'videos', title: 'Videos', items: [...items, block.rich] } };
      }
      continue;
    }
    out.push(block.rich?.kind === 'videos' ? { ...block, fenced: true } : block);
  }
  return out;
}

export function richBlock(block) {
  const gallery = videoGallery(block);
  if (gallery) return gallery;
  const video = videoTag(block);
  if (video) return video;
  const fence = block.match(/^\s*(```|~~~)(widget|html-widget)\s*([^\n]*)\n([\s\S]*?)\n\1\s*$/u);
  if (fence) return { kind: 'widget', title: fence[3].trim() || 'Interactive widget', source: fence[4] };
  const media = block.trim().match(MEDIA_LINE);
  if (!media) return null;
  const source = media[2].replace(/^<|>$/g, '');
  const url = mediaUrl(source);
  if (!url) return null;
  let kind = mediaKind(source);
  if (/^https?:\/\//iu.test(source)) {
    // A remote html page is never run as a widget. A remote image is fetched by the server, never by
    // the browser: the proxy is what lets a transcript seen once still show its pictures offline, and
    // it is where the private-address guard lives. `![alt](https://cdn/x?v=2)` carries no extension
    // and is still an image, because that is what the syntax says.
    if (kind === 'widget-file') return null;
    if (!kind) kind = 'image';
    if (kind === 'image') return { kind, title: media[1] || 'Media', source, url: remoteImageUrl(source), remote: source };
  }
  return kind ? { kind, title: media[1] || 'Media', source, url } : null;
}

/**
 * Split text into lines of prose and lines that are one image, for surfaces that do not run the
 * markdown compiler (the public share page). Image entries carry the alt text and the source as
 * written; the caller decides what a local path or a remote URL may become there.
 */
export function splitImageLines(text) {
  const out = [];
  let prose = [];
  const flush = () => {
    if (prose.length) out.push({ type: 'text', text: prose.join('\n') });
    prose = [];
  };
  for (const line of String(text ?? '').split('\n')) {
    const media = line.trim().match(MEDIA_LINE);
    const source = media?.[2].replace(/^<|>$/g, '');
    if (media && source && mediaUrl(source) && (mediaKind(source) === 'image' || /^https?:\/\//iu.test(source))) {
      flush();
      out.push({ type: 'image', alt: media[1], source, remote: /^https?:\/\//iu.test(source) });
    } else prose.push(line);
  }
  flush();
  return out;
}

/** Remote image URLs written on their own line in `text`, in order, without duplicates. */
export function remoteImageSources(text) {
  const seen = new Set();
  for (const part of splitImageLines(text)) if (part.type === 'image' && part.remote) seen.add(part.source);
  return [...seen];
}

// A widget frame swallows every pointer event, so a click on it never reaches the page. These small scripts run inside
// the frame (inline scripts are allowed by the policy below) and tell the page about two gestures only: `open`, a plain
// click on a part of the figure that is not itself a control, and `zoom`, the pinch / ctrl-wheel / double click of the
// figure viewer. Controls (links, buttons, inputs, canvases, anything marked data-no-figure) keep their click.
const BRIDGE_SKIP = "a,button,input,select,textarea,label,summary,canvas,video,audio,[role=button],[contenteditable],[data-no-figure]";
const BRIDGES = {
  open: `(function(){var skip=${JSON.stringify(BRIDGE_SKIP)},d=null;addEventListener('pointerdown',function(e){d={x:e.clientX,y:e.clientY}},true);addEventListener('click',function(e){if(e.defaultPrevented||e.button||!d)return;if(Math.hypot(e.clientX-d.x,e.clientY-d.y)>6)return;if(String(getSelection()).length)return;var t=e.target;if(t&&t.closest&&t.closest(skip))return;parent.postMessage({tophatFigure:'open'},'*')})})();`,
  zoom: `(function(){var skip=${JSON.stringify(BRIDGE_SKIP)},last=0;function send(m){parent.postMessage(m,'*')}addEventListener('wheel',function(e){if(!(e.ctrlKey||e.metaKey))return;e.preventDefault();send({tophatFigure:'wheel',dy:e.deltaY*(e.ctrlKey?1:0.15),x:e.clientX,y:e.clientY})},{passive:false});addEventListener('keydown',function(e){if(e.key==='Escape'||e.key==='0'||e.key==='1')send({tophatFigure:'key',key:e.key})});addEventListener('dblclick',function(e){var t=e.target;if(t&&t.closest&&t.closest(skip))return;send({tophatFigure:'dblclick',x:e.clientX,y:e.clientY})});function gap(t){return Math.hypot(t[0].clientX-t[1].clientX,t[0].clientY-t[1].clientY)}addEventListener('touchmove',function(e){if(e.touches.length!==2){last=0;return}e.preventDefault();var g=gap(e.touches);if(last)send({tophatFigure:'pinch',ratio:g/last,x:(e.touches[0].clientX+e.touches[1].clientX)/2,y:(e.touches[0].clientY+e.touches[1].clientY)/2});last=g},{passive:false});addEventListener('touchend',function(){last=0})})();`
};

/** The sandboxed document a widget runs in. `bridge`: 'open' (in the chat: a click opens the figure viewer) or 'zoom' (in the viewer: pinch, ctrl-wheel and double click zoom it); none by default. */
export function widgetDocument(source, { bridge = null } = {}) {
  // The one page a widget may frame is the app's own memory viewer (its /graph path, exact): the memory-graph widget is an iframe of it. A srcdoc frame is
  // sandboxed, so 'self' matches nothing there; the page's own origin is named instead (none outside a browser, so the policy stays closed).
  const frame = typeof location !== 'undefined' && /^https?:\/\//.test(location.origin) ? `${location.origin}/graph` : "'none'";
  const policy = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src ${frame}; object-src 'none'; base-uri 'none'; form-action 'none'`;
  const script = BRIDGES[bridge] ? `<script>${BRIDGES[bridge]}</script>` : '';
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html{color-scheme:light;background:#fff;color:#171717}body{margin:16px;font:15px system-ui,sans-serif}img,video,svg,canvas{max-width:100%}*{box-sizing:border-box}</style></head><body>${source}${script}</body></html>`;
}
