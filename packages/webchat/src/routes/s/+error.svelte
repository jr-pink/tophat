<script>
  // A share link that does not resolve must stay a dead end, not a door into the app. Before this
  // existed, /s/<wrong token> fell through to the app shell, whose boot script sends an
  // unauthenticated visitor to /login, so a mistyped or truncated link asked a stranger for the
  // owner's passkey.
  import { page } from '$app/state';
</script>

<svelte:head>
  <title>Link not live</title>
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<main>
  <h1>This link is not live</h1>
  <p>It may have been withdrawn, or the address may have been cut short on the way here. Ask whoever sent it for a fresh one.</p>
  <p class="code">{page.status}</p>
</main>

<style>
  :global(html) { background: #0f1012; }
  @media (prefers-color-scheme: light) { :global(html) { background: #faf9f7; } }
  :global(body) { margin: 0; background: inherit; }
  main {
    max-width: 30rem; margin: 0 auto; padding: 6rem 1.4rem;
    font-family: ui-sans-serif, -apple-system, 'SF Pro Text', system-ui, sans-serif;
    color: #e8e6e3; background: #0f1012; min-height: 100vh;
  }
  @media (prefers-color-scheme: light) { main { color: #1b1a18; background: #faf9f7; } }
  h1 { font-size: 1.3rem; font-weight: 600; margin: 0 0 0.6rem; }
  p { margin: 0 0 0.8rem; line-height: 1.55; color: inherit; opacity: 0.8; }
  .code { font-size: 0.75rem; opacity: 0.45; }
</style>
