// Images the owner attaches, as images.
//
// Until today an attached photo reached the model as a path in the text and nothing
// else: the webchat writes the bytes under its upload directory and appends an
// "Attached files:" block (webchat/src/lib/core/attachments.js), and rev5/pull.mjs
// intake() turned that whole message into text blocks.
//
// What this module does, and nothing else:
//   1. finds the image paths named in an owner message (the same attachment
//      block src/setup/migrate-webchat.mjs and webchat dictation.js parse),
//   2. makes a vision copy of each one that needs it -- long edge at most
//      1568 px, JPEG quality 85, via `sips`, cached so it is done once,
//   3. returns a small *reference* block per image for the ledger, and
//      materialises the base64 image block only when a request is built
//      (hydrateImageBlocks, called from rev5/model.mjs).
//
// The ledger keeps the reference, never the base64: a turn replays its whole
// history on every request, compaction reads those rows, and the push hand-off
// walks them, so megabytes of base64 in a row would be paid for again and
// again. A reference whose file has since gone degrades to a text block that
// says so; it never corrupts the history.
//
// The numbers come from the provider's own vision page: JPEG, PNG, GIF and WebP; at
// most 8000x8000 px; 10 MB base64 per image on the Claude API direct (5 MB on
// Bedrock and Google Cloud, which is the ceiling used here); a long edge over 1568
// px is downscaled by the API anyway on the standard tier, so sending more than
// that buys nothing but bytes; and more than 20 image blocks in one request puts
// every image in it under a stricter 2000 px rule, which is the reason the cap here
// is 20.
//
//   TOPHAT_RUNNER_VISION=0        no image block is ever built; paths stay text
//   TOPHAT_RUNNER_VISION_DIR      where vision copies are cached; default
//                              <TOPHAT_STATE_DIR|~/.local/state/tophat>/rev5/vision
//   TOPHAT_RUNNER_VISION_MAX      images per message, default 20
//   TOPHAT_RUNNER_VISION_EDGE     long edge of a vision copy, default 1568
//   TOPHAT_RUNNER_VISION_QUALITY  JPEG quality of a vision copy, default 85
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';

/** The four formats the Messages API accepts, by file extension. */
export const IMAGE_MEDIA_TYPES = Object.freeze({
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jpe': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp'
});

export const VISION = Object.freeze({
  maxImages: 20,
  longEdge: 1568,
  quality: 85,
  // 5 MB of base64 is the smaller of the provider's two documented per-image ceilings.
  maxBase64Bytes: 5 * 1024 * 1024,
  maxPixels: 8000
});

/** The block type the ledger stores. Not an API block: rev5/model.mjs turns it into one on the way out. */
export const IMAGE_REF = 'tophat_image';

export function visionConfigured(env = process.env) {
  return env.TOPHAT_RUNNER_VISION !== '0';
}

function setting(env, name, fallback) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function visionLimits(env = process.env) {
  return {
    maxImages: Math.min(setting(env, 'TOPHAT_RUNNER_VISION_MAX', VISION.maxImages), 100),
    longEdge: Math.min(setting(env, 'TOPHAT_RUNNER_VISION_EDGE', VISION.longEdge), VISION.maxPixels),
    quality: Math.min(setting(env, 'TOPHAT_RUNNER_VISION_QUALITY', VISION.quality), 100),
    maxBase64Bytes: setting(env, 'TOPHAT_RUNNER_VISION_MAX_BYTES', VISION.maxBase64Bytes)
  };
}

/** Where vision copies live: owner-only state, never the upload directory the owner sees and syncs. */
export function visionDir(env = process.env) {
  const dir = resolve(env.TOPHAT_RUNNER_VISION_DIR
    || join(env.TOPHAT_STATE_DIR || join(env.HOME || homedir(), '.local', 'state', 'tophat'), 'rev5', 'vision'));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** The media type of a path by extension, or null when it is not one of the four. */
export function imageMediaType(path) {
  return IMAGE_MEDIA_TYPES[extname(String(path || '')).toLowerCase()] || null;
}

const base64Bytes = (bytes) => Math.ceil(bytes / 3) * 4;

// The same attachment block the webchat writes (webchat/src/lib/core/attachments.js describeAttachments)
// and two other readers already parse: src/setup/migrate-webchat.mjs ATTACHMENT_BLOCK and
// webchat/src/lib/core/dictation.js stripAttachmentBlock. Kept identical to those on purpose.
const ATTACHMENT_BLOCK = /\n\nAttached files?:\n((?:- [^\n]*\n?)+)/gu;

/**
 * Every path named in the attachment block(s) of one owner message, in the order he attached them.
 * Only the block: a path the model or a tool mentioned in prose is not an attachment.
 */
export function attachedPaths(text) {
  const out = [];
  for (const match of String(text || '').matchAll(ATTACHMENT_BLOCK)) {
    for (const line of match[1].split('\n')) {
      const named = line.startsWith('- ') ? line.slice(2).trim() : '';
      if (named && !out.includes(named)) out.push(named);
    }
  }
  return out;
}

/** The attached paths whose extension is one of the four image types, with that media type. */
export function attachedImages(text) {
  return attachedPaths(text).map((path) => ({ path, mediaType: imageMediaType(path) })).filter((a) => a.mediaType);
}

/** `sips -g pixelWidth -g pixelHeight`, parsed; null when sips cannot read the file. */
export function imageSize(path, { run = sips } = {}) {
  try {
    const out = run(['-g', 'pixelWidth', '-g', 'pixelHeight', path]);
    const width = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1]);
    const height = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1]);
    return width > 0 && height > 0 ? { width, height } : null;
  } catch { return null; }
}

function sips(args) {
  return execFileSync('sips', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

/** A stable name for the derived copy of one original: its path and mtime, so an edited file is re-derived. */
function derivedName(abs, stat) {
  const key = createHash('sha256').update(`${abs}\u0000${stat.mtimeMs}\u0000${stat.size}`).digest('hex').slice(0, 16);
  return `${basename(abs).replace(/[^\w.-]/gu, '_').slice(0, 60)}.${key}.vision.jpg`;
}

/**
 * What to send for one image path: the file itself when it is already small enough, else a cached
 * downscaled JPEG copy beside the other vision copies. Never throws; a failure is a `reason`.
 *
 * { path, media_type, width, height, bytes, derived, source_path } on success,
 * { reason } when this image has to fall back to path-only behaviour.
 */
export function visionCopy(path, { env = process.env, run = sips, dir = null } = {}) {
  const limits = visionLimits(env);
  const abs = isAbsolute(path) ? path : resolve(path);
  const mediaType = imageMediaType(abs);
  if (!mediaType) return { reason: 'not one of the image types the API accepts (jpeg, png, gif, webp)' };
  let stat;
  try { stat = statSync(abs); } catch (error) { return { reason: `unreadable (${error.code || 'error'})` }; }
  if (!stat.isFile()) return { reason: 'not a regular file' };
  const size = imageSize(abs, { run });
  if (!size) return { reason: 'sips could not read this file as an image' };
  const longEdge = Math.max(size.width, size.height);
  if (longEdge <= limits.longEdge && base64Bytes(stat.size) <= limits.maxBase64Bytes) {
    return { path: abs, media_type: mediaType, width: size.width, height: size.height, bytes: stat.size, derived: false, source_path: abs };
  }
  let out;
  try {
    out = join(dir || visionDir(env), derivedName(abs, stat));
    if (!existsSync(out)) {
      run(['-Z', String(limits.longEdge), '-s', 'format', 'jpeg', '-s', 'formatOptions', String(limits.quality), abs, '--out', out]);
    }
  } catch (error) { return { reason: `could not be downscaled for the model (${String(error.message || error).split('\n')[0].slice(0, 120)})` }; }
  let derivedStat;
  try { derivedStat = statSync(out); } catch { return { reason: 'the downscaled copy was not written' }; }
  const derivedSize = imageSize(out, { run }) || { width: null, height: null };
  if (base64Bytes(derivedStat.size) > limits.maxBase64Bytes) {
    return { reason: `still ${Math.round(base64Bytes(derivedStat.size) / 1048576)} MB base64 after downscaling to ${limits.longEdge} px, over the ${Math.round(limits.maxBase64Bytes / 1048576)} MB per-image ceiling` };
  }
  return { path: out, media_type: mediaType === 'image/png' || mediaType === 'image/gif' || mediaType === 'image/webp' ? 'image/jpeg' : mediaType,
    width: derivedSize.width, height: derivedSize.height, bytes: derivedStat.size, derived: true, source_path: abs,
    original: { width: size.width, height: size.height, bytes: stat.size } };
}

/**
 * The image part of one owner message: reference blocks for the ledger and the note that goes in the
 * text beside them. `text` keeps its own attachment block untouched -- tools address files by path, and
 * the model is told which path is which image.
 *
 * { blocks, notes, images, skipped }
 */
export function imageBlocksFor(text, { env = process.env, run = sips, dir = null } = {}) {
  if (!visionConfigured(env)) return { blocks: [], notes: [], images: [], skipped: [] };
  const limits = visionLimits(env);
  const found = attachedImages(text);
  if (!found.length) return { blocks: [], notes: [], images: [], skipped: [] };
  const taken = found.slice(0, limits.maxImages);
  const overflow = found.slice(limits.maxImages);
  const blocks = [], images = [], skipped = [];
  for (const { path } of taken) {
    const copy = visionCopy(path, { env, run, dir });
    if (copy.reason) { skipped.push({ path, reason: copy.reason }); continue; }
    // `path` stays the original: that is the name the owner and the tools use. The derived copy is an artefact.
    images.push({ ...copy, path, vision_path: copy.path });
    blocks.push({ type: IMAGE_REF, path: copy.path, media_type: copy.media_type, source_path: copy.source_path,
      width: copy.width, height: copy.height, bytes: copy.bytes, derived: copy.derived });
  }
  for (const { path } of overflow) skipped.push({ path, reason: `over the ${limits.maxImages} image per message cap` });
  const notes = [];
  if (images.length === 1) {
    notes.push(`[The attached image below is one you can see: ${images[0].path} (downscaled to at most ${limits.longEdge} px for the API where it was larger). read_document reads the same file as text.]`);
  } else if (images.length) {
    notes.push(`[The ${images.length} attached images below are ones you can see, in this order: ${images.map((i, n) => `${n + 1}. ${i.path}`).join(', ')}. Each is the file at that path (downscaled to at most ${limits.longEdge} px for the API where it was larger). read_document reads the same files as text.]`);
  }
  if (skipped.length) {
    notes.push(`[${skipped.length} attached image${skipped.length === 1 ? '' : 's'} could not be sent as ${skipped.length === 1 ? 'an image' : 'images'}; ${skipped.length === 1 ? 'its path is' : 'their paths are'} in this message and read_document can still read ${skipped.length === 1 ? 'it' : 'them'}: ${skipped.map((s) => `${s.path} (${s.reason})`).join('; ')}]`);
  }
  return { blocks, notes, images, skipped };
}

/** Is this a reference block this module wrote? */
export const isImageRef = (block) => block?.type === IMAGE_REF && typeof block.path === 'string';

/**
 * Reference blocks to real API image blocks, at the moment a request is built. A file that has gone
 * missing becomes a text block saying so: the model is told, the request stays valid, and the ledger
 * row is not touched. Pure with respect to its input; returns new arrays only where it changed something.
 */
export function hydrateImageBlocks(messages, { read = readFileSync, limits = null, env = process.env } = {}) {
  const lim = limits || visionLimits(env);
  if (!Array.isArray(messages)) return messages;
  let touched = false;
  const out = messages.map((message) => {
    const original = message?.content;
    const content = Array.isArray(original) ? original.map(block => {
      if (block?.type !== 'tool_result' || !Array.isArray(block.content)) return block;
      const nested = hydrateImageBlocks([{ role: 'user', content: block.content }], { read, limits: lim, env })[0].content;
      if (nested !== block.content) touched = true;
      return { ...block, content: nested };
    }) : original;
    if (!Array.isArray(content) || !content.some(isImageRef)) return content === original ? message : { ...message, content };
    touched = true;
    const blocks = content.map((block) => {
      if (!isImageRef(block)) return block;
      let bytes;
      try { bytes = read(block.path); } catch (error) {
        return { type: 'text', text: `[the image at ${block.source_path || block.path} is no longer readable on this machine (${error?.code || 'error'}), so it is not in this message as an image]` };
      }
      if (base64Bytes(bytes.length) > lim.maxBase64Bytes) {
        return { type: 'text', text: `[the image at ${block.source_path || block.path} is too large to send (${Math.round(base64Bytes(bytes.length) / 1048576)} MB base64), so it is not in this message as an image]` };
      }
      return { type: 'image', source: { type: 'base64', media_type: block.media_type || 'image/jpeg', data: Buffer.from(bytes).toString('base64') } };
    });
    return { ...message, content: blocks };
  });
  return touched ? out : messages;
}

/** Base64 image bytes carried by a built request, so a ceiling can leave room for them. */
export function imageBytesIn(messages) {
  let total = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type === 'image' && typeof block.source?.data === 'string') total += block.source.data.length;
      if (block?.type === 'tool_result' && Array.isArray(block.content)) total += imageBytesIn([{ content: block.content }]);
    }
  }
  return total;
}
