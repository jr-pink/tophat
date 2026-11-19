<script>
  // The rendered card of an automated event: the thread as the messaging app shows it (owner's own messages on the right,
  // delivery and read state, tapbacks, images, attachments, replies, edits and unsent lines), or the mail thread. The messages
  // that arrived in this event are outlined; the rest are faded context. State: the one thing that opens (a mail message's
  // body) lives in the fold store like every other fold.
  import { useFolds } from './disclosure.svelte.js';
  import { showFigures } from './lightbox.svelte.js';
  import { clock, cardTitle, initials, shortName, sizeLabel, statusLabel, stripQuoted, systemText, withDays, dayLabel } from '../core/event-cards.js';

  let { cards = [], itemId = '', now = undefined } = $props();
  const folds = useFolds();
  const SOURCE = { imessage: 'iMessage', beeper: 'Beeper', wechat: 'WeChat' };
  const sourceLabel = (c) => SOURCE[c.source] || (c.kind === 'mail' ? (c.account || 'Mail') : c.source);

  const rows = (card) => withDays(card.messages, undefined);
  // A run is consecutive messages from one sender: the name shows on its first bubble.
  const firstOfRun = (list, i) => {
    const m = list[i], p = list[i - 1];
    return !p || p.divider || p.system || p.self !== m.self || p.from !== m.from;
  };
  const lastSelfIndex = (card) => { for (let i = card.messages.length - 1; i >= 0; i--) if (card.messages[i].self && card.messages[i].status?.state === "read") return card.messages[i].id; return null; };
  const keyOf = (ci, m) => `${itemId}:${ci}:${m.id}`;
  const open = (ci, m) => folds.isOpen('mailmsg', keyOf(ci, m)) !== Boolean(m.in_event);
  const toggle = (ci, m) => folds.toggle('mailmsg', keyOf(ci, m));
  const reactionTitle = (r) => `${r.emoji} ${r.from}`;
  const grouped = (reactions = []) => {
    const by = new Map();
    for (const r of reactions) { const g = by.get(r.emoji) || { emoji: r.emoji, who: [], self: false }; g.who.push(r.from); g.self ||= r.self; by.set(r.emoji, g); }
    return [...by.values()];
  };
  const zoom = (event, a, from) => { showFigures([{ kind: 'image', alt: a.name, el: event.currentTarget, src: a.url }], 0); void from; };
</script>

<div class="cards" data-testid="event-cards">
  {#each cards as card, ci (ci)}
    {#if card.kind === 'mail'}
      <section class="card mail" data-testid="event-card" data-kind="mail">
        <header class="head"><span class="src">{sourceLabel(card)}</span><span class="ttl">{card.subject || 'Email thread'}</span></header>
        <div class="mails">
          {#each card.messages as m (m.id + m.at)}
            {@const isOpen = open(ci, m)}
            {@const body = stripQuoted(m.text)}
            <article class="mail-msg" class:ev={m.in_event} class:ctx={!m.in_event} data-testid="card-message" data-in-event={m.in_event ? 'true' : 'false'}>
              <button type="button" class="mail-head focus-ring" aria-expanded={isOpen} onclick={() => toggle(ci, m)}>
                <span class="avatar" aria-hidden="true">{initials(m.from)}</span>
                <span class="mail-who">
                  <span class="mail-from">{shortName(m.from)}{#if m.in_event}<span class="tag">in this event</span>{/if}</span>
                  <span class="mail-to">{m.to ? `to ${m.to.replace(/<[^>]*>/gu, '').replace(/"/gu, '').trim()}` : ''}{m.cc ? `, cc ${m.cc.replace(/<[^>]*>/gu, '').replace(/"/gu, '').trim()}` : ''}</span>
                </span>
                <span class="mail-date">{m.at ? `${dayLabel(m.at, now)} ${clock(m.at)}` : ''}</span>
              </button>
              {#if isOpen}
                {#if m.subject && m.subject !== card.subject}<div class="mail-subject">{m.subject}</div>{/if}
                <div class="mail-body" data-testid="mail-body">{body.text}</div>
                {#if body.trimmed}<div class="quoted">quoted earlier messages hidden</div>{/if}
              {:else}
                <div class="mail-snippet">{body.text.replace(/\s+/gu, ' ').slice(0, 140)}</div>
              {/if}
              {#each m.attachments || [] as a}<span class="chip">{a.name}{a.size ? ` · ${sizeLabel(a.size)}` : ''}</span>{/each}
            </article>
          {/each}
        </div>
      </section>
    {:else}
      {@const list = rows(card)}
      {@const lastSelf = lastSelfIndex(card)}
      <section class="card chat" data-testid="event-card" data-kind="chat">
        <header class="head"><span class="src">{sourceLabel(card)}</span><span class="ttl">{cardTitle(card)}</span>{#if card.group}<span class="grp">group</span>{/if}</header>
        <div class="thread">
          {#each list as m, i (m.divider ? m.key : m.id + m.at)}
            {#if m.divider}
              <div class="day" role="separator">{dayLabel(m.at, now)}</div>
            {:else if m.system || (m.recalled && !m.text)}
              <div class="sys" class:ev={m.in_event} data-testid="card-message" data-in-event={m.in_event ? 'true' : 'false'}>{systemText(m)}</div>
            {:else}
              <div class="msg" class:self={m.self} class:ev={m.in_event} class:ctx={!m.in_event} data-testid="card-message" data-in-event={m.in_event ? 'true' : 'false'} data-self={m.self ? 'true' : 'false'}>
                {#if !m.self && card.group && firstOfRun(list, i)}<div class="name">{shortName(m.from)}</div>{/if}
                <div class="bubble-wrap">
                  <div class="bub" class:rx={m.reactions?.length}>
                    {#if m.reply_to}<div class="reply"><b>{shortName(m.reply_to.from)}</b> {m.reply_to.text}</div>{/if}
                    {#each m.attachments || [] as a}
                      {#if a.kind === 'image' && a.url}
                        <button type="button" class="img focus-ring" aria-label={`Open ${a.name}`} onclick={(e) => zoom(e, a)}><img src={a.url} alt={a.name} loading="lazy" /></button>
                      {:else}
                        <span class="chip" data-kind={a.kind}>{a.name}{a.size ? ` · ${sizeLabel(a.size)}` : ''}</span>
                      {/if}
                    {/each}
                    {#if m.text}<span class="txt">{m.text}</span>{/if}
                    {#if m.reactions?.length}
                      <span class="reacts" data-testid="card-reactions">{#each grouped(m.reactions) as g}<span class="react" class:mine={g.self} title={g.who.join(', ')}>{g.emoji}{#if g.who.length > 1}<i>{g.who.length}</i>{/if}</span>{/each}</span>
                    {/if}
                  </div>
                </div>
                <div class="meta" data-testid="card-meta">
                  {#if m.at}<span>{clock(m.at)}</span>{/if}
                  {#if m.edited}<span>Edited</span>{/if}
                  {#if m.self && m.status}<span class="st" data-state={m.status.state}>{statusLabel(m.status, { time: m.id === lastSelf })}</span>{/if}
                  {#if m.in_event}<span class="tag">in this event</span>{/if}
                </div>
              </div>
            {/if}
          {/each}
        </div>
        <footer class="legend">Outlined: arrived in this event. Faded: earlier messages, for context.</footer>
      </section>
    {/if}
  {/each}
</div>

<style>
  .cards { display: flex; flex-direction: column; gap: 8px; width: min(100%, max(380px, 66%)); margin: 2px 0 4px; }
  .card { border: 1px solid var(--line); border-radius: 12px; background: var(--bg-raised); overflow: hidden; }
  .head { display: flex; align-items: baseline; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--line-soft); font-size: 12.5px; min-width: 0; }
  .src { font-family: var(--mono); font-size: 10.5px; color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.04em; flex: none; }
  .ttl { color: var(--ink); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .grp { margin-left: auto; font-size: 10.5px; color: var(--ink-faint); }
  .thread { display: flex; flex-direction: column; padding: 8px 12px 6px; gap: 2px; background: var(--bg-sunken); }
  .day { align-self: center; margin: 8px 0 4px; font-size: 10.5px; color: var(--ink-faint); }
  .sys { align-self: center; max-width: 90%; margin: 6px 0; padding: 2px 10px; font-size: 11px; color: var(--ink-faint); text-align: center; font-style: italic; overflow-wrap: anywhere; }
  .sys:not(.ev) { opacity: 0.6; }
  .msg { display: flex; flex-direction: column; align-items: flex-start; max-width: 100%; margin-top: 4px; }
  .msg.self { align-items: flex-end; }
  .name { font-size: 10.5px; color: var(--ink-faint); margin: 4px 0 1px 10px; }
  .bubble-wrap { max-width: 82%; display: flex; }
  .bub {
    position: relative; display: flex; flex-direction: column; gap: 4px; padding: 7px 11px; border-radius: 16px 16px 16px 4px;
    background: var(--bg-raised); border: 1px solid var(--line); color: var(--ink); font-size: 13.5px; line-height: 1.38; overflow-wrap: anywhere; white-space: pre-wrap;
  }
  .self .bub { border-radius: 16px 16px 4px 16px; background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 30%, transparent); }
  .bub.rx { margin-bottom: 8px; }
  .ctx .bub, .ctx .meta, .ctx .name { opacity: 0.55; }
  .ev .bub { box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 75%, transparent); }
  .reply { font-size: 11.5px; color: var(--ink-dim); border-left: 2px solid var(--line); padding-left: 7px; white-space: normal; max-height: 3.2em; overflow: hidden; }
  .reply b { font-weight: 600; }
  .img { display: block; padding: 0; border-radius: 10px; overflow: hidden; cursor: zoom-in; line-height: 0; }
  .img img { display: block; max-width: 100%; max-height: 220px; width: auto; border-radius: 10px; }
  .chip { display: inline-block; align-self: flex-start; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--line); background: var(--bg-sunken); font-family: var(--mono); font-size: 11px; color: var(--ink-dim); white-space: normal; }
  .reacts { position: absolute; bottom: -11px; right: 8px; display: flex; gap: 2px; }
  .self .reacts { right: auto; left: 8px; }
  .react { display: inline-flex; align-items: center; gap: 2px; padding: 0 6px; height: 20px; border-radius: 10px; font-size: 12px; line-height: 20px; background: var(--bg-raised); border: 1px solid var(--line); white-space: nowrap; }
  .react.mine { border-color: color-mix(in srgb, var(--accent) 55%, transparent); }
  .react i { font-style: normal; font-size: 10px; color: var(--ink-dim); }
  .meta { display: flex; gap: 6px; margin: 2px 8px 0; font-size: 10.5px; color: var(--ink-faint); font-variant-numeric: tabular-nums; }
  .st[data-state='failed'] { color: var(--warn); }
  .st[data-state='read'] { color: var(--accent); }
  .tag { font-family: var(--mono); font-size: 9.5px; color: var(--accent); text-transform: uppercase; letter-spacing: 0.04em; }
  .legend { padding: 5px 12px 6px; font-size: 10.5px; color: var(--ink-faint); border-top: 1px solid var(--line-soft); }
  .mails { display: flex; flex-direction: column; }
  .mail-msg { padding: 6px 12px 8px; border-bottom: 1px solid var(--line-soft); }
  .mail-msg:last-child { border-bottom: 0; }
  .mail-msg.ev { box-shadow: inset 3px 0 0 color-mix(in srgb, var(--accent) 75%, transparent); background: color-mix(in srgb, var(--accent) 5%, transparent); }
  .mail-msg.ctx .mail-head, .mail-msg.ctx .mail-snippet { opacity: 0.6; }
  .mail-head { display: flex; align-items: center; gap: 9px; width: 100%; text-align: left; padding: 2px 0; cursor: pointer; min-width: 0; }
  .avatar { flex: none; width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; background: var(--bg-sunken); border: 1px solid var(--line); font-size: 10px; color: var(--ink-dim); }
  .mail-who { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .mail-from { font-size: 12.5px; color: var(--ink); font-weight: 600; display: flex; gap: 8px; align-items: baseline; white-space: nowrap; }
  .mail-to { font-size: 11px; color: var(--ink-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mail-date { flex: none; font-size: 10.5px; color: var(--ink-faint); font-variant-numeric: tabular-nums; }
  .mail-subject { margin: 6px 0 0 35px; font-size: 12px; color: var(--ink-dim); }
  .mail-body { margin: 6px 0 0 35px; font-size: 13px; line-height: 1.45; color: var(--ink); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 360px; overflow: auto; }
  .mail-snippet { margin: 1px 0 0 35px; font-size: 12px; color: var(--ink-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .quoted { margin: 4px 0 0 35px; font-size: 10.5px; color: var(--ink-faint); }
  .mail-msg .chip { margin: 6px 0 0 35px; }
</style>
