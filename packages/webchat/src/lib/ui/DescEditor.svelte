<script>
  import { isMod } from '$lib/core/keys.js';
  // A description editor that folds down under its row: a textarea, Save and Cancel. Nothing is written until Save
  // (Cmd/Ctrl-Enter); Cancel and Esc drop the draft. The draft and which row is open live in the sidebar store
  // (core/sidebar-state.js descAt/descDraft); this component only draws them.
  let { value = '', oninput = () => {}, onsave = () => {}, oncancel = () => {}, label = 'Description', placeholder = 'Describe what goes here', testid = 'description-editor', texttestid = 'description-text', savetestid = 'description-save', canceltestid = 'description-cancel' } = $props();

  const focus = (node) => { node.focus(); node.setSelectionRange?.(node.value.length, node.value.length); };
</script>

<form class="desceditor" data-testid={testid} onsubmit={(event) => { event.preventDefault(); onsave(value); }}>
  <textarea rows="3" maxlength="300" {placeholder} aria-label={label} data-testid={texttestid} use:focus
    {value}
    oninput={(event) => oninput(event.currentTarget.value)}
    onkeydown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); oncancel(); }
      else if (event.key === 'Enter' && isMod(event)) { event.preventDefault(); onsave(event.currentTarget.value); }
    }}></textarea>
  <div class="btns">
    <button type="button" class="press" onclick={oncancel} data-testid={canceltestid}>Cancel</button>
    <button type="submit" class="press primary" data-testid={savetestid}>Save</button>
  </div>
</form>

<style>
  .desceditor { display: flex; flex-direction: column; gap: 6px; padding: 6px; border: 1px solid var(--line); border-radius: 9px; background: var(--bg-raised); }
  textarea {
    resize: vertical; min-height: 58px; padding: 6px 8px; border: 1px solid var(--line-soft, var(--line)); border-radius: 6px;
    background: var(--bg-sunken, var(--bg)); color: var(--ink); font: inherit; font-size: 12.5px; line-height: 1.4; outline: none;
  }
  textarea:focus { border-color: color-mix(in srgb, var(--ink) 30%, var(--line)); }
  textarea::placeholder { color: var(--ink-faint); }
  .btns { display: flex; justify-content: flex-end; gap: 4px; }
  button { padding: 4px 10px; border-radius: 6px; border: 0; background: none; color: var(--ink-dim); font: inherit; font-size: 12px; cursor: pointer; }
  button:hover { color: var(--ink); background: color-mix(in srgb, var(--ink) 7%, transparent); }
  .primary { background: var(--accent-soft); color: var(--ink); }
  .primary:hover { background: color-mix(in srgb, var(--accent) 22%, transparent); }
</style>
