import { loadConfig } from '../../../../../../runner/src/config.mjs';
import { findBinary } from '../../../../../../runner/src/core/find-binary.mjs';
import { recognitionSettings } from '../../../../../../runner/src/speech/recognition.mjs';

// Homebrew is not on the PATH launchd hands a service, so an absolute default
// is what makes recognition work in the installed webchat. WHERE a tool is
// installed is src/core/find-binary.mjs's question (Homebrew, /usr/local,
// /usr/bin, MacPorts, then ~/.local/bin); this file decides only that the
// owner's `recognition` configuration, and an explicit environment path, still
// win over the search. An explicit path is taken as given even when it does not
// exist, because `recognitionSettings` validates it and names it back, which is
// a better failure than quietly transcribing with a different binary.
function located(name, override) {
  return override || findBinary(name);
}

// The vocabulary this product's transcripts are full of. It biases the decoder
// and nothing else. It belongs to the webchat rather than to the recognizer,
// which is why it is passed as configuration. The words the fast preview gets
// wrong are names, which is what a decoder prompt is for.
const PROMPT = process.env.TOPHAT_WHISPER_PROMPT || null;

/**
 * The configuration this webchat transcribes under: the owner's `recognition`
 * block, with the webchat's own defaults and the environment overrides that
 * predate it folded in.
 *
 * It is one function because everything that decides which decoder runs and
 * which weights it loads has to agree: the two request paths in `voice.js`,
 * the readiness the engines route reports, and the warm-up that spawns the
 * resident server at boot. Two answers means warming one model and decoding
 * with another.
 */
export function recognitionConfig({ env = process.env } = {}) {
  let config;
  try {
    config = loadConfig();
  } catch (cause) {
    // A configuration this process cannot read is not a configuration full of
    // defaults. Say so, rather than transcribing under settings the owner did
    // not choose.
    throw Object.assign(new Error(`tophat configuration could not be read: ${cause.message}`), { status: 503 });
  }
  const recognition = { ...(config.recognition ?? {}) };
  recognition.binary ??= located('whisper-cli', env.TOPHAT_WHISPER_BIN);
  recognition.converter ??= located('ffmpeg', env.TOPHAT_FFMPEG_BIN);
  if (recognition.modelDir === undefined && env.TOPHAT_WHISPER_MODELS) recognition.modelDir = env.TOPHAT_WHISPER_MODELS;
  recognition.prompt ??= PROMPT;
  recognition.suppressNst ??= true;
  return { ...config, recognition };
}

/** The validated settings, or a throw naming which setting is wrong. */
export function recognitionSettingsNow(options) {
  return recognitionSettings(recognitionConfig(options));
}
