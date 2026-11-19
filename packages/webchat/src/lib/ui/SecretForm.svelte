<script>
  // The credential form (new and edit) on /secrets. It owns nothing: every value is read from the draft handle
  // (lib/ui/secret-drafts.svelte.js, backed by core/secret-draft-state.js) and every keystroke is written back to it, so
  // unmounting, re-rendering, a list refresh or a Tab can lose nothing. Saving and discarding are the page's.
  import { KINDS, FORMS, FIELDS } from '$lib/core/secret-form.js';
  import { isMod } from '$lib/core/keys.js';

  let { draft, mode = 'new', title = 'New credential', errors = {}, warnings = [], busy = false, dirty = false,
    onsave, onclose, ondiscard, hint = '' } = $props();

  let reveal = $state({});           // field key -> shown in clear (never saved anywhere)
  let confirming = $state(false);    // the inline "discard this draft?" step
  let formEl;

  let kind = $derived(draft.data.kind || 'login');
  let items = $derived(FORMS[kind] || FORMS.secret);
  const value = (key) => draft.data[key] ?? '';

  // Cmd/Ctrl+Enter saves from any field; plain Enter in a multi-line field is a newline and in a single-line field does nothing
  // (a form that submits on Enter loses a half-typed card the moment a number is pasted with a trailing newline).
  function onkeydown(event) {
    if (event.key === 'Enter' && isMod(event) && !event.isComposing) { event.preventDefault(); onsave?.(); }
    else if (event.key === 'Enter' && event.target?.tagName === 'INPUT' && !event.isComposing) event.preventDefault();
  }

  export function focusFirst() { formEl?.querySelector('input, textarea')?.focus(); }

  export function focusFirstInvalid() {
    const first = formEl?.querySelector('[aria-invalid="true"]') || formEl?.querySelector('input, textarea');
    first?.focus();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<form class="secret-form" bind:this={formEl} data-testid="secret-form" data-mode={mode} novalidate
  onsubmit={(event) => { event.preventDefault(); onsave?.(); }} {onkeydown}>
  <div class="formhead">
    <h2>{title}</h2>
    {#if mode === 'new'}
      <label class="kindpick"><span class="sr">Type</span>
        <select value={kind} data-testid="kind" onchange={(e) => draft.patch({ kind: e.currentTarget.value })}>
          {#each KINDS as k (k.id)}<option value={k.id}>{k.label}</option>{/each}
        </select>
      </label>
    {:else}
      <span class="kindfixed">{KINDS.find((k) => k.id === kind)?.label}</span>
    {/if}
  </div>
  {#if hint}<p class="why small">{hint}</p>{/if}

  <div class="fields">
    {#each items as item, index (typeof item === 'string' ? item : `title-${index}`)}
      {#if typeof item !== 'string'}
        <h3 class="fieldgroup">{item.title}</h3>
      {:else}
        {@const spec = FIELDS[item]}
        {@const bad = errors[item]}
        <div class="field half-{['city', 'state', 'postal_code', 'country', 'exp', 'cvc'].includes(item)}" data-field={item}>
          <label for={`f-${item}`}>
            <span class="lab">{spec.label}</span>
            {#if spec.secret}
              <button type="button" class="link toggle" tabindex="-1" aria-pressed={Boolean(reveal[item])}
                onclick={() => (reveal[item] = !reveal[item])}>{reveal[item] ? 'Hide' : 'Show'}</button>
            {/if}
          </label>
          {#if spec.multiline}
            <textarea id={`f-${item}`} rows={spec.rows || 3} class:masked={spec.secret && !reveal[item]} class:mono={spec.mono}
              spellcheck="false" autocomplete="off" autocapitalize="off" placeholder={spec.placeholder || ''}
              aria-invalid={bad ? 'true' : undefined} data-testid={`field-${item}`}
              value={value(item)} oninput={(e) => draft.patch({ [item]: e.currentTarget.value })}></textarea>
          {:else}
            <input id={`f-${item}`} type={spec.secret && !reveal[item] ? 'password' : 'text'} spellcheck="false"
              autocomplete={spec.autocomplete || 'off'} autocapitalize="off" autocorrect="off"
              inputmode={spec.inputmode} maxlength={spec.maxlength} placeholder={spec.placeholder || ''}
              aria-invalid={bad ? 'true' : undefined} data-testid={`field-${item}`}
              value={value(item)} oninput={(e) => draft.patch({ [item]: e.currentTarget.value })} />
          {/if}
          {#if bad}<p class="fielderror" role="alert">{bad}</p>{/if}
        </div>
      {/if}
    {/each}
  </div>

  {#each warnings as warning (warning)}<p class="why small warn">{warning}</p>{/each}

  <div class="formfoot">
    <button type="submit" class="primary" data-testid="save-form" disabled={busy}>
      {busy ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Save'}
    </button>
    <button type="button" class="secondary" data-testid="close-form" onclick={() => onclose?.()}>Close</button>
    {#if dirty}
      {#if confirming}
        <span class="confirm" role="alert">Discard what you typed?
          <button type="button" class="link danger" data-testid="discard-yes" onclick={() => { confirming = false; ondiscard?.(); }}>Discard</button>
          <button type="button" class="link" data-testid="discard-no" onclick={() => (confirming = false)}>Keep</button>
        </span>
      {:else}
        <button type="button" class="link danger" data-testid="discard" onclick={() => (confirming = true)}>Discard draft</button>
      {/if}
      <span class="unsaved" data-testid="unsaved">Unsaved · kept in this tab</span>
    {/if}
  </div>
</form>

<style>
  .secret-form { display: flex; flex-direction: column; gap: 10px; max-width: 620px; }
  .formhead { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .kindpick select { width: auto; font-family: inherit; font-size: 13px; padding: 6px 9px; background: var(--bg-raised); color: var(--ink-dim); }
  .kindfixed { font-size: 12px; color: var(--ink-faint); border: 1px solid var(--line); border-radius: 999px; padding: 2px 9px; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .fields { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px 10px; }
  .field { grid-column: span 6; display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  .field.half-true { grid-column: span 3; }
  .fieldgroup { grid-column: span 6; margin: 8px 0 -2px; }
  .field label { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--ink-faint); }
  .toggle { font-size: 11.5px; }
  input, textarea { background: var(--bg-sunken); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px;
    color: var(--ink); font-size: 14px; outline: none; width: 100%; box-sizing: border-box; resize: vertical;
    font-family: var(--mono, ui-monospace, monospace); }
  input:focus, textarea:focus { border-color: var(--accent); }
  [aria-invalid='true'] { border-color: var(--warn); }
  textarea.masked { -webkit-text-security: disc; text-security: disc; }
  textarea.mono { font-size: 12.5px; }
  .fielderror { margin: 0; font-size: 12px; color: var(--warn); }
  .formfoot { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 4px; }
  .unsaved { font-size: 12px; color: var(--ink-faint); margin-left: auto; }
  .confirm { font-size: 12.5px; color: var(--ink-dim); display: inline-flex; gap: 8px; align-items: baseline; }
  .warn { color: var(--warn); }
  h2 { font-size: 15px; margin: 0; font-weight: 600; overflow-wrap: anywhere; }
  h3 { font-size: 12px; margin: 14px 0 2px; font-weight: 600; color: var(--ink-faint); text-transform: uppercase; letter-spacing: .04em; }
  .why { margin: 0; color: var(--ink-dim); font-size: 13px; line-height: 1.5; }
  .why.small { font-size: 12px; color: var(--ink-faint); }
  .primary { background: var(--accent); color: #14100d; border-radius: 9px; padding: 9px 15px; font-size: 13.5px; font-weight: 600; border: none; cursor: pointer; }
  .primary:disabled { background: var(--line); color: var(--ink-faint); }
  .secondary { border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; font-size: 13px; background: var(--bg-raised); color: var(--ink); cursor: pointer; }
  .link { color: var(--ink-faint); font-size: 12.5px; background: none; border: none; cursor: pointer; padding: 0; }
  .link:hover { color: var(--ink-dim); }
  .link.danger:hover { color: var(--warn); }
  @media (max-width: 520px) { .field.half-true { grid-column: span 6; } .unsaved { margin-left: 0; width: 100%; } }
</style>
