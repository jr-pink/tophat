import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { codeShape, codeShapeDetail, HANDOVER_ROOTS } from './src/lib/server/code-shape.js';

export default {
  plugins: [tailwindcss(), sveltekit()],
  
  
  
  
  
  
  
  define: { __WEBCHAT_CODE_SHAPE__: JSON.stringify(codeShapeDetail()), __WEBCHAT_HANDOVER_SHAPE__: JSON.stringify(codeShape(HANDOVER_ROOTS)) },
  server: { fs: { allow: ['..'] } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.js'],
    // node 22.23's TurboFan crashes ("unreachable code" in the Deoptimizer) on Automerge-heavy loops
    // such as the notes model check after a couple of thousand runs; inlining off avoids it.
    poolOptions: { forks: { execArgv: ['--no-turbo-inlining'] } },
    include: ['src/**/*.test.js'],
    // The exhaustive walks run in their own project: `npm run test:model` (vitest.model.config.js).
    exclude: ['**/node_modules/**', 'src/**/*.model.test.js'],
    
    
    
    
    
    
    
    
    environmentMatchGlobs: [['src/lib/server/**', 'node']]
  }
};
