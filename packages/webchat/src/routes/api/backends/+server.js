

import { json } from '@sveltejs/kit';
import { CAPABILITIES } from '$lib/server/app.js';

export function GET() {
  return json({ providers: CAPABILITIES.providers }, {
    
    
    headers: { 'cache-control': 'no-store' }
  });
}
