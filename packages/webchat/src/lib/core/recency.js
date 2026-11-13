// The pin-then-recency chat order has ONE owner: core/frecency.js `rankByRecency`.
//
// This module held a second implementation of it, exported under the name `rankConversations`,
// which is also the name of frecency.js's own and very different order (pinned, then live, then
// the decayed score). Two exported symbols of one name with two orders is not a preference a
// surface can state: which order a pane got depended on which of the two modules it happened to
// import, and a reader of either file could not tell that the other existed. The sort itself is
// unchanged, keys computed once per chat, and every importer of this path keeps working, because
// `rankConversations` here is now an alias for the one implementation.
//
// Renaming the call sites to `rankByRecency` and retiring this file is the rest of the merge;
// rank-one-owner.test.js pins the two modules to one function in the meantime.
export { rankByRecency as rankConversations, groupForks, trayCounts } from './frecency.js';
