const T = (s) => new Date(Date.UTC(2026,10,12,17,12,s)).toISOString();
const WAKE = `[Automated event from the push plane; this is not a message from the owner.]
1 new arrival looks like someone on the owner's side has to act:
1. Source: imessage, from a saved contact
   From: Dana, at 9:12 AM
   Needed, per push: Dana asks to walk the bathroom on Thursday at 2 and wants the latest plans
   Excerpt: "Hi, can I come by Thursday at 2 to walk the bathroom? Also, can you send me the latest building plans?"`;
export const fixtures = {
 auto: { items: [
  { id:'u1', type:'user', at:T(0), text:WAKE },
  { id:'t1', type:'tool', tool:'memory_search', state:'completed', at:T(1), endedAt:T(2), input:{query:'Dana contractor bathroom remodel plans'}, output:'3 results\n1. Dana (contractor), bathroom remodel\n2. bathroom-plans-v3.pdf, filed Oct 28, replaces v2\n3. Plumbing quote, Oct 19' },
  { id:'t2', type:'tool', tool:'memory_read', state:'completed', at:T(2), endedAt:T(3), input:{id:'bathroom-plans-v3'}, output:'bathroom-plans-v3.pdf\nFiled Oct 28. Current set; v2 is superseded.' },
  { id:'t3', type:'tool', tool:'messages_recent', state:'completed', at:T(3), endedAt:T(5), input:{contact:'Dana', limit:6}, output:'Dana: Hi, can I come by Thursday at 2 to walk the bathroom?\nDana: Also, can you send me the latest building plans?\nyou: Sure, will confirm soon' },
  { id:'a1', type:'assistant', text:'Dana wants to come by **Thursday at 2** and asks for the latest plans. The current set is **plans v3** (filed Oct 28).\n\nI left a draft in your thread with Dana. It is not sent:\n\n> Hi Dana, Thursday at 2 works if we can start by 2:30. Plans v3 are attached, the latest set.' }
 ]}
 ,
 'auto-chat': { items: [
  { id:'u1', type:'user', at:T(0), text:WAKE },
  { id:'t1', type:'tool', tool:'memory_search', state:'completed', at:T(1), endedAt:T(2), input:{query:'Dana contractor bathroom remodel plans'}, output:'3 results' },
  { id:'t2', type:'tool', tool:'memory_read', state:'completed', at:T(2), endedAt:T(3), input:{id:'bathroom-plans-v3'}, output:'bathroom-plans-v3.pdf, filed Oct 28' },
  { id:'t3', type:'tool', tool:'messages_recent', state:'completed', at:T(3), endedAt:T(5), input:{contact:'Dana', limit:6}, output:'12 messages' },
  { id:'a1', type:'assistant', text:'Dana wants **Thursday at 2** and the latest plans (v3). I left a draft reply in your thread with Dana. It is not sent.' }
 ]},
 'qol-a': { items: [
  { id:'u1', type:'user', at:T(0), text:'pull the Q3 revenue into the board deck' },
  { id:'c1', type:'compaction', at:T(8), messages:38, preTokens:182000, trigger:'auto' },
  { id:'a2', type:'assistant', at:T(9), text:'Carrying on with slide 4, the regional split.' }
 ]},
 'qol-b': { running:true, items: [
  { id:'t1', type:'tool', tool:'Bash', state:'running', at:new Date(Date.now()-45000).toISOString(), input:{command:'python3 scan_invoices.py --since 2026-10-01'} },
  { id:'u2', type:'user', at:new Date(Date.now()-5000).toISOString(), text:'also tag it for taxes, I need it in April', queued:true }
 ]},
 'qol-c': { items: [
  { id:'u1', type:'user', at:T(0), text:WAKE },
  { id:'a1', type:'assistant', text:'Dana wants **Thursday at 2** and the latest plans. I left a reply in your thread with Dana. It is not sent.' }
 ]},
 'qol-h': { items: [
  { id:'a1', type:'assistant', at:T(0), text:'**How a note reaches someone.** You write the note into a scope. The note is sealed with a fresh key. Your next sync pushes the ciphertext to the hub. The other person\'s replica syncs, receives the scope\'s key for its device and sees the note.' }
 ]},
 'qol-e': { items: [
  { id:'u1', type:'user', at:T(0), text:'move the invoice to Home' },
  { id:'a1', type:'assistant', at:T(3), text:'Done: Home / Plumbing / invoice-0412.pdf.' }
 ]},
 'qol-f': { items: [
  { id:'a1', type:'assistant', at:T(0), text:'Filed it under Home / Plumbing.' },
  { id:'h1', type:'hook', source:'stop', text:'The invoice is filed but not tagged for taxes yet.', at:T(2) },
  { id:'a2', type:'assistant', at:T(4), text:'Tagged it taxes 2026, then confirmed both.' }
 ]},
 side: { kind:'side', quote:'Your next sync pushes the ciphertext to the hub.', items: [
  { id:'su1', type:'user', at:T(0), text:'what does the hub do with it?' },
  { id:'sa1', type:'assistant', at:T(3), text:'It stores the ciphertext and routing metadata only. It never holds a scope key, so it cannot read the note.' }
 ]},
 turn: { items: [
  { id:'u1', type:'user', at:T(0), text:'find last month\'s plumber invoice and file it under Home' },
  { id:'a0', type:'assistant', at:T(1), text:'On it. Searching your mail and files first.' },
  { id:'t1', type:'tool', tool:'memory_search', state:'completed', at:T(2), endedAt:T(3), input:{query:'plumber invoice'}, output:'3 results' },
  { id:'t2', type:'tool', tool:'mail_search', state:'completed', at:T(3), endedAt:T(4), input:{query:'from:plumber newer_than:45d'}, output:'1 message' },
  { id:'u2', type:'user', at:T(4), text:'also tag it for taxes, I will need it in April' },
  { id:'t3', type:'tool', tool:'read_document', state:'completed', at:T(5), endedAt:T(6), input:{path:'invoice-0412.pdf'}, output:'Invoice 0412, $240.00, paid' },
  { id:'ag1', type:'agent', agentType:'subagent', description:'file it and add the tax tag', state:'completed', at:T(7) },
  { id:'t4', type:'tool', tool:'task_update', state:'completed', agentId:'ag1', at:T(8), endedAt:T(9), input:{title:'move to Home/Plumbing'}, output:'done' },
  { id:'t5', type:'tool', tool:'task_update', state:'completed', agentId:'ag1', at:T(9), endedAt:T(10), input:{title:'tag: taxes 2026'}, output:'done' },
  { id:'a1', type:'assistant', at:T(11), text:'Filed as **Home / Plumbing / invoice-0412.pdf** and tagged taxes 2026. The invoice was $240.00 and is marked paid.' }
 ]}
 ,
 ...Object.fromEntries([
  ['contacts', "what's Priya's number?", 'memory_search', {query:'Priya Raman phone'}, 'Priya Raman (Contacts)\nmobile ending 0142\nbirthday Mar 6', "Priya Raman's mobile ends in 0142 (from your Contacts)."],
  ['calendar', "what's on my calendar the next 3 days?", 'memory_search', {query:'calendar events Nov 13 to Nov 15'}, 'Thu 10:00 dentist\nFri 14:30 call with Sam\nSat: nothing', 'Thursday 10:00 dentist, Friday 14:30 call with Sam. Saturday is free.'],
  ['notes', 'which note mentions lisbon?', 'memory_search', {query:'lisbon'}, 'Lisbon trip (Notes), edited Nov 8\n14 lines', 'Your note **Lisbon trip**, last edited Nov 8.'],
  ['messages', 'did Sam say when he lands?', 'messages_recent', {contact:'Sam', limit:2}, 'Sam: landing at 4\nSam: can you grab the keys?', 'Sam lands at 4 and asks if you can grab the keys.'],
  ['browser', 'check flights to Lisbon on the 12th', 'browser_open', {url:'https://flights.example/lis?d=03-12'}, 'page text read, 14 results\nnothing clicked or submitted', 'Fourteen results; the cheapest is $412 direct. I have not booked anything.'],
  ['findmy', 'how far is Priya?', 'shell', {command:'tophat-findmy where Priya'}, 'Priya: 0.8 mi away, location 2 min old', 'Priya is 0.8 mi away; her location is 2 minutes old.'],
  ['shortcuts', 'run my evening lights shortcut', 'shell', {command:'shortcuts run "Evening lights"'}, 'finished in 1.2 s', 'Ran Evening lights; it finished in 1.2 seconds.'],
  ['home', 'turn on the desk lamp', 'shell', {command:'shortcuts run "Desk lamp on"'}, 'finished in 0.9 s', 'The desk lamp is on.']
 ].map(([k, q, tool, input, out, ans]) => ['app-' + k, { items: [
  { id:'u1', type:'user', at:T(0), text:q },
  { id:'t1', type:'tool', tool, state:'completed', at:T(1), endedAt:T(2), input, output: out },
  { id:'a1', type:'assistant', at:T(3), text:ans }
 ]}]))
};
// the same turn with every call still running and the mid-turn message still queued: the frame before each step finishes
fixtures['turn-run'] = { running: true, items: fixtures.turn.items.map((i) => (i.type === 'tool' ? { ...i, state: 'running', endedAt: undefined, output: undefined } : i.type === 'agent' ? { ...i, state: 'running' } : i.id === 'u2' ? { ...i, queued: true } : i)) };
