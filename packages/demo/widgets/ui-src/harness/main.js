import { mount } from 'svelte';
import '$webchat/app.css';
import Transcript from '$lib/ui/Transcript.svelte';
import SideThread from '$lib/ui/SideThread.svelte';
import { fixtures } from './fixtures.js';
const q = new URLSearchParams(location.search).get('f') || 'auto';
const f = fixtures[q];
const el = document.getElementById('app');
if (f.kind === 'side') {
  el.style.cssText = 'width:340px;padding:12px';
  const state = { items: { side1: f.items }, conversations: {} };
  mount(SideThread, { target: el, props: { session: {}, chatState: state, thread: { id: 'side1', sidechat: { quote: f.quote }, runState: 'idle' }, focused: true } });
} else {
  el.style.cssText = 'height:100vh;display:flex;flex-direction:column';
  mount(Transcript, { target: el, props: { items: f.items, conversationId: 'fx-' + q, running: !!f.running } });
}
