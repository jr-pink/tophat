<script>
  // A minted room at /mp/<token>. hooks.server.js answers 404 for a token that was never minted,
  // before this page is served; the endpoints under /api/mp/<token>/ check again.
  import { page } from '$app/state';
  import MpRoom from '$lib/ui/MpRoom.svelte';
</script>

{#key page.params.token}
  <MpRoom token={page.params.token} />
{/key}
