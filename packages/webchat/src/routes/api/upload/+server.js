import { json } from '@sveltejs/kit';
import { MAX_BYTES, saveUpload, transportRejection } from '$lib/server/uploads.js';

export async function POST({ request }) {
  let form;
  try {
    form = await request.formData();
  } catch (cause) {
    const refused = transportRejection(cause);
    if (refused) {
      return json({
        error: `Too large for the server to accept: ${refused}. The limit on a single file is ${MAX_BYTES / 1048576} MB.`,
        kind: 'too-large'
      }, { status: 413 });
    }
    return json({ error: `Could not read the upload: ${cause.message}`, kind: 'bad-request' }, { status: 400 });
  }
  const files = form.getAll('file').filter((entry) => typeof entry === 'object' && entry);
  if (!files.length) return json({ error: 'No file in the request', kind: 'bad-request' }, { status: 400 });
  
  
  
  const paths = form.getAll('path').map((value) => String(value));
  try {
    const saved = [];
    for (const [index, file] of files.entries()) {
      saved.push(await saveUpload({ name: file.name, bytes: Buffer.from(await file.arrayBuffer()), path: paths[index] || null }));
    }
    return json({ files: saved }, { headers: { 'cache-control': 'no-store' } });
  } catch (cause) {
    
    
    if (!cause.status || cause.status >= 500) console.error('[webchat] upload failed:', cause);
    return json({ error: cause.message, kind: cause.kind || 'error' }, { status: cause.status || 500 });
  }
}
