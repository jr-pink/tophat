<script>
  // One public document at /docs/<token>: the notes editor over its own store, editable by anyone
  // with the link (src/lib/server/docs.js). hooks.server.js answers 404 for a token that was never
  // minted before this page is served, and every endpoint under /api/docs/<token>/ checks again.
  import { page } from '$app/state';
  import DocPage from '$lib/ui/DocPage.svelte';
</script>

{#key page.params.token}
  <DocPage token={page.params.token} />
{/key}
