// Loaded by `npm test` (node --import) before the test runner spawns any file: the suite never sees the TOPHAT_*
// configuration of whatever instance launched it. A shell or agent running inside a live instance carries that
// instance's hub, scope, store and state paths (TOPHAT_HUB_URL without its token file made every store/cli.mjs child
// exit 1), and a test that spreads process.env into a child would otherwise read or write the live instance.
// Kept: the *_NODE_MODULES pointers a run is told to use (release builds pass them) and TOPHAT_TEST_* switches.
const keep = (name) => /_NODE_MODULES$/.test(name) || name.startsWith('TOPHAT_TEST_');
for (const name of Object.keys(process.env)) if (name.startsWith('TOPHAT_') && !keep(name)) delete process.env[name];
