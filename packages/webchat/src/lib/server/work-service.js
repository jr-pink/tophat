import { createHash } from 'node:crypto';

// A retry always reaches the same durable conversation and message. The message
// is the commit point; a crash before acceptance leaves a recoverable empty chat.
export function spawnDurableWork({ store, runner, body, settings, defaultCwd }) {
  const key = String(body.requestId);
  if (!/^work:[a-zA-Z0-9:-]{1,180}$/.test(key)) throw Error('Invalid work request ID');
  const id = createHash('sha256').update(key).digest('hex').slice(0, 32);
  const itemId = `work-${id}`;
  const prompt = String(body.prompt || '').trim();
  if (!prompt) throw Error('Missing work instruction');
  const existing = store.conversation(id);
  const accepted = store.acceptedMessage(id, itemId);
  if (accepted) {
    if (accepted.content?.text !== prompt) throw Error('Work request ID reused with different instruction');
    return { id, cursor: accepted.cursor, duplicate: true };
  }
  if (!existing) {
    const at = new Date().toISOString();
    const cwd = body.cwd || defaultCwd;
    const title = String(body.title || prompt).replace(/\s+/g, ' ').slice(0, 72);
    const parentId = body.parentId && store.conversation(body.parentId) ? body.parentId : null;
    store.ensureConversation(id, { at, cwd, settings, title, parentId, source: 'agent' });
    store.append(id, 'conversation.created', { title, settings, cwd }, { at });
  }
  const cursor = store.cursor();
  runner.send(id, prompt, { itemId, display: prompt,
    attribution: { actor: 'agent', basis: 'durable-owner-work', source: 'work-runner', authorVerified: false } });
  return { id, cursor, duplicate: false };
}

export function agentTranscript(store, id, after) {
  const events = store.conversationEvents(id, { after });
  const rows = [], inputs = new Map();
  for (const event of events) {
    const c = event.content || {}, base = { cursor: event.cursor, at: event.at };
    if (event.kind === 'assistant.message') rows.push({ ...base, role: 'assistant', text: c.text || '' });
    else if (event.kind === 'message.user') rows.push({ ...base, role: 'user', text: c.text || '' });
    else if (event.kind === 'tool.started') {
      inputs.set(c.itemId, c.input == null ? '' : JSON.stringify(c.input));
      rows.push({ ...base, role: 'tool', tool: c.tool || null });
    }
    else if (event.kind === 'tool.input_delta') inputs.set(c.itemId, (inputs.get(c.itemId) || '') + (c.partial || ''));
    else if (event.kind === 'tool.completed') rows.push({ ...base, role: 'observation', tool: c.tool || null, input: inputs.get(c.itemId) || null, output: c.output, isError: c.isError });
    else if (event.kind === 'run.completed') rows.push({ ...base, role: 'end', state: 'completed' });
    else if (event.kind === 'run.error') rows.push({ ...base, role: 'end', state: 'error', text: c.message || '' });
    else if (event.kind === 'run.cancelled') rows.push({ ...base, role: 'end', state: 'cancelled' });
  }
  return { rows, cursor: events.at(-1)?.cursor ?? after };
}

// Delivery is a visible owner-chat event, not a new model request or an outbound
// message. Its stable item ID is checked before append, including crash retries.
export function deliverWorkResult({store,body}) {
  const id=String(body.conversationId||''),key=String(body.requestId||'');
  if(!store.conversation(id))throw Error('Unknown owner delivery conversation');
  if(!/^work:[a-zA-Z0-9:-]{1,180}$/.test(key))throw Error('Invalid work delivery ID');
  const text=String(body.text||'').trim();if(!text)throw Error('Missing work result');
  const itemId=`work-delivery-${createHash('sha256').update(key).digest('hex')}`;
  let found,after=0;
  for(;;){
    const events=store.conversationEvents(id,{after});
    found=events.find(e=>e.kind==='assistant.message'&&e.content?.itemId===itemId);
    if(found||!events.length)break;
    const cursor=events.at(-1).cursor;if(cursor<=after)throw Error('Work delivery history did not advance');after=cursor;
  }
  if(found){if(found.content.text!==text)throw Error('Work delivery ID reused');return {id,cursor:found.cursor,duplicate:true};}
  store.append(id,'assistant.message',{itemId,text,workDelivery:true,sourceConversationId:body.sourceConversationId||null});
  return {id,cursor:store.cursor(),duplicate:false};
}
