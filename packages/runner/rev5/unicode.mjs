// The unicode-cutting rule has ONE owner: src/core/unicode.mjs.
//
// rev6/base/text.mjs held a third, with the same bodies and no cross-reference
// in either direction. A wire-encoding rule with three implementations drifts,
// and the half that loosens is the half nobody notices until a turn dies on a
// smiley again.
//
// Why the owner sits in src/core and not in either runner tree: rev5 is the
// documented rollback, so it must not depend on rev6; rev6 supersedes rev5, so
// it must not depend on rev5. src is the tree both already import. rev5 is not
// self-contained with respect to it and has not been for some time:
// rev5/context.mjs imports ../src/core/retrieval.mjs,
// ../src/core/corpora/terms.mjs, ../src/core/corpora/config.mjs and
// ../src/core/context-output.mjs; rev5/tasks.mjs imports
// ../src/vault/scrub-store.mjs; rev5/browser.mjs and rev5/credentials.mjs import
// ../src/vault/manager.mjs.
//
// The module path and every name this file exported are unchanged, so no caller
// changes. tests/unicode-one-owner.test.mjs pins the three modules to one
// function each.
export { cut, cutEnd, hasLoneSurrogate, repairLoneSurrogates, toWireJSON } from '../src/core/unicode.mjs';
