
const held = new Map();
const opening = new Map();
const standalone = () => typeof window !== 'undefined'
  && (navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches);

function discard(key, entry) {
  for (const track of entry.stream.getTracks()) track.stop();
  if (held.get(key) === entry) held.delete(key);
}

export async function acquireMicrophone(constraints) {
  if (!standalone()) return navigator.mediaDevices.getUserMedia(constraints);
  const key = JSON.stringify(constraints);
  let entry = held.get(key);
  if (entry && entry.stream.getTracks().some(track => track.readyState === 'ended')) {
    discard(key, entry);
    entry = null;
  }
  if (!entry) {
    let request = opening.get(key);
    if (!request) {
      request = navigator.mediaDevices.getUserMedia(constraints).then(stream => {
        const created = { stream, users: 0 };
        held.set(key, created);
        return created;
      }).finally(() => opening.delete(key));
      opening.set(key, request);
    }
    entry = await request;
  }
  entry.users += 1;
  for (const track of entry.stream.getTracks()) track.enabled = true;
  return entry.stream;
}

export function releaseMicrophone(stream) {
  for (const [key, entry] of held) {
    if (entry.stream !== stream) continue;
    entry.users = Math.max(0, entry.users - 1);
    if (!entry.users) discard(key, entry);
    return;
  }
  for (const track of stream.getTracks()) track.stop();
}
