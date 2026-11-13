import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const WC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../webchat');
export default {
  plugins: [tailwindcss(), svelte()],
  resolve: { alias: { $lib: path.join(WC, 'src/lib'), $webchat: path.join(WC, 'src') } },
  server: { fs: { allow: ['/'] }, port: 5199, host: '127.0.0.1' },
  define: { __WEBCHAT_CODE_SHAPE__: '"x"', __WEBCHAT_HANDOVER_SHAPE__: '"x"' }
};
