import { json } from '@sveltejs/kit';
import { readerStore } from '$lib/server/reader-store.js';
import { ingestEpub, ingestStatus, receiveUpload } from '$lib/server/reader-ingest.js';

// A book arrives as raw bytes and is streamed straight to disk, whatever its size: nothing here
// holds the file, and nothing parses the chapters inside the request. The answer carries the
// chapter list, so the contents rail and the pager work at once; the text is read behind it.
export async function POST({ request, url }) {
  if (!request.body) return json({ error: 'no bytes received' }, { status: 400 });
  const name = url.searchParams.get('name') || '';

  let upload;
  try {
    upload = await receiveUpload(request.body);
  } catch (cause) {
    return json({ error: `could not receive that file: ${cause.message}` }, { status: 500 });
  }
  if (!upload.bytes) return json({ error: 'no bytes received' }, { status: 400 });

  const store = readerStore();
  try {
    const { id, status } = ingestEpub({ store, uploadPath: upload.path, name, bytes: upload.bytes });
    return json({ id, doc: store.doc(id), sections: store.sectionList(id), status });
  } catch (cause) {
    return json({ error: `could not read that EPUB: ${cause.message}` }, { status: 415 });
  }
}

// How far the background read has got, for the progress line in the library.
export function GET({ url }) {
  const id = url.searchParams.get('id') || '';
  return json({ id, status: ingestStatus(id) });
}
