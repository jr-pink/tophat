<script>
  // One share control for both surfaces. A chat and a reader document are different things on the
  // way in and the same thing on the way out: a page someone outside can open.
  //
  // The two URLs come from the server as an independent pair; this component never derives one
  // from the other, and never shows the notes link inside the clean one's page.
  let { kind = 'doc', targetId = '', label = 'Share', compact = false } = $props();

  let open = $state(false);
  let busy = $state(false);
  let links = $state(null);          // { url, notes_url, views }
  let failed = $state('');
  let copied = $state('');
  // The askable link (chats only): a third, separate token that lets a visitor put questions to the
  // transcript. It is minted and revoked on its own and never listed inside the clean or notes links.
  let askState = $state(null);       // { asked, url, count, questions: [...] }
  let askBusy = $state(false);
  let showAsks = $state(false);

  async function ask(method, body) {
    busy = true; failed = '';
    try {
      const response = method === 'GET'
        ? await fetch(`/api/share?kind=${encodeURIComponent(kind)}&target_id=${encodeURIComponent(targetId)}`)
        : await fetch('/api/share', {
          method, headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind, target_id: targetId, ...body })
        });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || `share failed (${response.status})`);
      links = data.shared ? data : null;
    } catch (cause) {
      failed = cause.message || 'share failed';
    } finally {
      busy = false;
    }
  }

  async function askCall(method) {
    askBusy = true; failed = '';
    try {
      const response = method === 'GET'
        ? await fetch(`/api/share/ask?target_id=${encodeURIComponent(targetId)}`)
        : await fetch('/api/share/ask', {
          method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target_id: targetId })
        });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || `askable link failed (${response.status})`);
      askState = data;
    } catch (cause) {
      failed = cause.message || 'askable link failed';
    } finally {
      askBusy = false;
    }
  }

  async function toggle() {
    open = !open;
    if (open && !links) await ask('GET');
    if (open && kind === 'chat') await askCall('GET');
  }

  // Unsharing a chat withdraws the askable link too (the server does it); mirror that here.
  async function unshare() {
    await ask('DELETE');
    if (kind === 'chat') await askCall('GET');
  }

  const absolute = (url) => (url?.startsWith('http') ? url : `${location.origin}${url || ''}`);

  async function copy(url, which) {
    try {
      await navigator.clipboard.writeText(absolute(url));
      copied = which;
      setTimeout(() => { if (copied === which) copied = ''; }, 1600);
    } catch { failed = 'could not reach the clipboard'; }
  }

  // The OS sheet, where there is one: sharing a link is usually the step after copying it.
  async function sendTo(url) {
    if (!navigator.share) return copy(url, 'plain');
    try { await navigator.share({ url: absolute(url) }); } catch { /* dismissed */ }
  }
</script>

<div class="share">
  <button
    class="trigger press focus-ring"
    class:compact
    class:on={open}
    onclick={toggle}
    aria-label={label}
    title={label}
    data-testid="share-button"
  >{compact ? '🔗' : label}</button>

  {#if open}
    <div class="panel" data-testid="share-panel">
      {#if kind === 'chat'}
        <div class="row ask" data-testid="share-ask">
          <div class="meta"><span class="what">Askable</span><span class="muted">reader can ask questions about this chat</span></div>
          {#if askState?.asked}
            <code>{absolute(askState.url)}</code>
            <div class="acts">
              <button onclick={() => copy(askState.url, 'ask')} data-testid="share-copy-ask">{copied === 'ask' ? 'Copied' : 'Copy'}</button>
              <button onclick={() => sendTo(askState.url)}>Send</button>
              <button onclick={() => (showAsks = !showAsks)} data-testid="share-asks-toggle">{askState.count} asked</button>
              <button class="danger" onclick={() => askCall('DELETE')} disabled={askBusy} data-testid="share-ask-revoke">Revoke</button>
            </div>
            {#if showAsks}
              <div class="asks">
                {#each askState.questions as q (q.id)}
                  <div class="q"><span class="what">{q.asker || 'anonymous'}</span> <span class="muted">{q.asked_at?.slice(0, 16).replace('T', ' ')}Z</span>
                    <p>{q.question}</p>
                    {#if q.answer}<p class="muted">{q.answer.slice(0, 280)}{q.answer.length > 280 ? '…' : ''}</p>{/if}
                  </div>
                {:else}<span class="muted">Nobody has asked yet.</span>{/each}
              </div>
            {/if}
          {:else}
            <button class="primary" onclick={() => askCall('POST')} disabled={askBusy} data-testid="share-ask-create">
              {askBusy ? 'Making link…' : 'Make askable link'}
            </button>
          {/if}
        </div>
      {/if}
      {#if busy && !links}
        <p class="muted">Checking…</p>
      {:else if !links}
        <p class="muted">Nobody can open this yet.</p>
        <button class="primary" onclick={() => ask('POST')} disabled={busy} data-testid="share-create">
          {busy ? 'Making links…' : 'Make public links'}
        </button>
      {:else}
        <div class="row">
          <div class="meta"><span class="what">Clean</span><span class="muted">no notes</span></div>
          <code>{absolute(links.url)}</code>
          <div class="acts">
            <button onclick={() => copy(links.url, 'plain')} data-testid="share-copy-plain">{copied === 'plain' ? 'Copied' : 'Copy'}</button>
            <button onclick={() => sendTo(links.url)}>Send</button>
          </div>
        </div>
        <div class="row notes">
          <div class="meta"><span class="what">With notes</span><span class="muted">your highlights</span></div>
          <code>{absolute(links.notes_url)}</code>
          <div class="acts">
            <button onclick={() => copy(links.notes_url, 'notes')} data-testid="share-copy-notes">{copied === 'notes' ? 'Copied' : 'Copy'}</button>
            <button onclick={() => sendTo(links.notes_url)}>Send</button>
          </div>
        </div>
        <div class="foot">
          <span class="muted">Anyone with a link can read it; no sign-in. The two links are separate.</span>
          <button class="danger" onclick={unshare} disabled={busy} data-testid="share-revoke">Unshare</button>
        </div>
      {/if}
      {#if failed}<p class="failed" data-testid="share-error">{failed}</p>{/if}
    </div>
  {/if}
</div>

<style>
  /* The app's own palette (src/app.css): --bg-raised, --line, --ink, --ink-dim, --ink-faint,
     --accent, --warn. An earlier draft invented --surface, which does not exist, so the panel
     rendered with no background at all over the transcript. */
  .share { position: relative; display: inline-flex; }
  .trigger {
    font: inherit; font-size: 0.82rem; color: var(--ink-dim);
    background: none; border: 1px solid var(--line); border-radius: 7px; padding: 2px 8px;
    cursor: pointer;
  }
  .trigger.compact { border: none; padding: 2px 4px; font-size: 0.95rem; }
  .trigger:hover { color: var(--ink); }
  .trigger.on { color: var(--ink); border-color: var(--accent); }
  .panel {
    position: absolute; top: calc(100% + 6px); right: 0; z-index: 40; width: min(26rem, 80vw);
    background: var(--bg-raised); color: var(--ink);
    border: 1px solid var(--line); border-radius: var(--radius);
    padding: 11px 12px; box-shadow: 0 14px 38px rgb(0 0 0 / 0.35);
    display: flex; flex-direction: column; gap: 11px; text-align: left;
  }
  .row { display: flex; flex-direction: column; gap: 4px; }
  .meta { display: flex; gap: 8px; align-items: baseline; }
  .what { font-size: 0.78rem; font-weight: 600; letter-spacing: 0.02em; color: var(--ink); }
  .muted { font-size: 0.74rem; color: var(--ink-faint); }
  code {
    font-family: var(--mono); font-size: 0.71rem; word-break: break-all; color: var(--ink-dim);
    background: var(--bg-sunken); border: 1px solid var(--line-soft); border-radius: 6px; padding: 4px 6px;
  }
  .acts { display: flex; gap: 6px; }
  .acts button, .primary, .danger {
    font: inherit; font-size: 0.76rem; padding: 3px 9px; border-radius: 6px; cursor: pointer;
    border: 1px solid var(--line); background: var(--bg-sunken); color: var(--ink-dim);
  }
  .acts button:hover, .primary:hover { color: var(--ink); border-color: var(--accent); }
  .primary { align-self: flex-start; background: var(--accent-soft); color: var(--ink); }
  .danger { background: none; color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); }
  .foot { display: flex; align-items: center; justify-content: space-between; gap: 10px;
          border-top: 1px solid var(--line-soft); padding-top: 9px; }
  .failed { margin: 0; font-size: 0.74rem; color: var(--warn); }
  .notes .what { color: var(--accent); }
  .ask .what { color: var(--accent); }
  .asks { max-height: 14rem; overflow: auto; display: flex; flex-direction: column; gap: 8px; }
  .q p { margin: 2px 0 0; font-size: 0.78rem; }
</style>
