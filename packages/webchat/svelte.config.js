import adapter from '@sveltejs/adapter-node';

export default {
  kit: {
    
    
    
    
    
    adapter: adapter({ out: process.env.WEBCHAT_BUILD_OUT || 'build' }),
    
    
    
    
    
    
    
    outDir: process.env.WEBCHAT_KIT_OUT || '.svelte-kit',
    
    
    
    version: { pollInterval: 60_000 },
    // The app registers the worker itself, at a URL carrying the build version; see
    // src/lib/core/sw-register.js.
    serviceWorker: { register: false },
    // One JavaScript file for the whole client. With the default split, a cold open walks a chain of
    // dependent requests (entry, shared chunks, the route's node, its chunks), one round trip per
    // level, before the page can ask for anything. The client is 360 KB brotlied in total and the
    // service worker precaches it all anyway, so one file costs a warm start nothing and takes the
    // chain off a cold one.
    output: { bundleStrategy: 'single' },
    csrf: { trustedOrigins: [] }
  }
};
