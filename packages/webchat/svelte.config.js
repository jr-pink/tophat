import adapter from '@sveltejs/adapter-node';

export default {
  kit: {
    
    
    
    
    
    adapter: adapter({ out: process.env.WEBCHAT_BUILD_OUT || 'build' }),
    
    
    
    
    
    
    
    outDir: process.env.WEBCHAT_KIT_OUT || '.svelte-kit',
    
    
    
    version: { pollInterval: 60_000 },
    // The app registers the worker itself, at a URL carrying the build version; see
    // src/lib/core/sw-register.js.
    serviceWorker: { register: false },
    csrf: { trustedOrigins: [] }
  }
};
