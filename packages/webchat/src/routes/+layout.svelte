<script>
  import '../app.css';
  import 'katex/dist/katex.min.css';
  import { flushSync, onMount } from 'svelte';
  import { beforeNavigate } from '$app/navigation';
  import { version } from '$app/environment';
  import { updated } from '$app/state';
  import { landingFor, landedDecl } from '$lib/core/landing.js';
  import { uiApp } from '$lib/client/ui-app.js';
  import { marked } from '../../../runner/tools/quicklook-kit/lib/recipes.js';
  import { registerServiceWorker } from '$lib/core/sw-register.js';
  import { installFreezeWatch } from '$lib/client/freeze-watch.js';
  import Lightbox from '$lib/ui/Lightbox.svelte';

  let { children } = $props();

  beforeNavigate((navigation) => {
    if (updated.current && navigation.to?.url) {
      navigation.cancel();
      location.href = navigation.to.url.href;
    }
  });

  function recoverFromMissingChunk(detail) {
    try { flushSync(); } catch {  }
    if (window.__tophatRecoverChunk) { window.__tophatRecoverChunk(detail, version); return; }
    location.reload();
  }

  // The worker is registered here rather than by SvelteKit, so its URL can carry the build version and
  // no cached copy of /service-worker.js can pin a client to an old build (svelte.config.js, serve.mjs).
  // Copying a rendered equation puts its LaTeX source on the clipboard ($...$ or $$...$$), not the
  // glyph soup of KaTeX's two layers. A plain copy listener; the chunk is in the precached shell.
  onMount(() => { import('katex/contrib/copy-tex'); });

  // The tab's freeze watchdog: long tasks over 1 s, main-thread gaps over 5 s and stretches the server
  // was unreachable land in client-lag.jsonl beside the server's lag.jsonl (src/lib/client/freeze-watch.js).
  onMount(() => { try { const watch = installFreezeWatch(); return () => watch.stop(); } catch (error) { console.warn('[freeze-watch]', error); } });

  onMount(() => {
    registerServiceWorker({
      navigator,
      version,
      onError: (error) => console.warn('[sw] registration failed', error)
    });
  });

  onMount(() => {
    const onPreloadError = (event) => {
      event.preventDefault();
      recoverFromMissingChunk(`preload failed for ${event.payload?.url || 'a chunk'}`);
    };
    const onRejection = (event) => {
      const text = String(event?.reason?.message || event?.reason || '');
      if (!/failed to fetch dynamically imported module|importing a module script failed|error loading dynamically imported module/iu.test(text)) return;
      event.preventDefault();
      recoverFromMissingChunk(`dynamic import failed: ${text.slice(0, 120)}`);
    };
    window.addEventListener('vite:preloadError', onPreloadError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('vite:preloadError', onPreloadError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  });

  onMount(() => {
    const onCopy = async (event) => {
      const button = event.target instanceof Element ? event.target.closest('button[data-copy]') : null;
      const code = button?.parentElement?.querySelector('code');
      if (!code) return;
      const text = code.textContent || '';
      try { await navigator.clipboard.writeText(text); } catch {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        try { document.execCommand('copy'); } finally { area.remove(); }
      }
      button.dataset.done = '1';
      setTimeout(() => { delete button.dataset.done; }, 1200);
    };
    document.addEventListener('click', onCopy);
    return () => document.removeEventListener('click', onCopy);
  });

  onMount(() => {
    const params = new URLSearchParams(location.search);
    const stay = params.has('stay');
    const chat = params.get('chat');
    const now = new Date();
    const today = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    let seen = null;
    try { seen = localStorage.getItem('tophat-brief-seen'); } catch {  }
    const landedTab = uiApp().use(landedDecl);
    const landed = marked(landedTab, today);

    const target = landingFor({ hour: now.getHours(), today, seen, path: location.pathname, stay, landed, chat });
    landedTab.dispatch('mark', { at: today });
    landedTab.flush(); // on disk before a redirect unloads the page
    if (target) location.replace(target);
  });
</script>

{@render children()}
<Lightbox />
