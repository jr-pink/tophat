<script>
  import { tick, setContext } from 'svelte';
  import { slide } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import Activity from './Activity.svelte';
  import CompactionCard from './CompactionCard.svelte';
  import PaceCard from './PaceCard.svelte';
  import HookCard from './HookCard.svelte';
  import Message from './Message.svelte';
  import ToolRun from './ToolRun.svelte';
  import { isOpen, toggleOpen, useChat } from './disclosure.svelte.js';
  import { groupHooks } from '$lib/core/hooks.js';
  import { groupToolRuns } from '$lib/core/toolruns.js';
  import { COLLAPSE_ABOVE, backgroundedRunning, tickDeadline } from '$lib/core/toolpatience.js';
  import { AT_END, followBand, leftEndWhileFollowing } from '$lib/core/follow.js';
  import { traceReading } from './reading-trace.svelte.js';

  let {
    items = [],
    viewerParticipantId = undefined,
    conversationId = null,
    onpath = () => {},
    onfork = null,
    highlightItemId = null,
    scrollToItemId = null,
    running = false,
    loading = false,
    rail = null,
    railOpen = false,
    railWidth = 320,
    onAtBottom = () => {},
    canLoadEarlier = null,
    onLoadEarlier = null,
    activity = null
  } = $props();
  setContext('artifact-conversation', () => conversationId);

  // Reading trace, line by line, over the transcript: each paragraph is attributed to the message
  // it sits in (Message.svelte puts data-item on the row), so a long reply is measured in parts
  // rather than as one lump.
  $effect(() => {
    const node = column;
    const id = conversationId;
    if (!node || !id) return;
    return traceReading(() => node, { surface: 'chat', ref: () => id });
  });

  // A fold is a decision he made about this chat, so what he had open is read back for
  // it. Once here at setup, so the first paint is already his rather than a default that
  // flips a frame later, and again before every later update in case the chat changed.
  useChat(conversationId);
  $effect.pre(() => useChat(conversationId));

  let scroller = $state(null);
  let column = $state(null);
  let bottom = $state(null);
  let atBottom = $state(true);
  // Whether the view is following the end of the transcript. This is the reader's
  // intent, not a measurement: nothing but his own scroll reaching the end may turn
  // it back on, so a layout change (a phone's URL bar collapsing, the keyboard, the
  // composer growing a line) can never hand him back to the stream.
  let following = $state(true);
  let observer;
  let toldAtBottom = null;
  $effect(() => {
    if (atBottom === toldAtBottom) return;
    toldAtBottom = atBottom;
    onAtBottom(atBottom);
  });

  const byAgent = $derived.by(() => {
    const map = new Map();
    for (const item of items) {
      if (!item.agentId) continue;
      const list = map.get(item.agentId);
      if (list) list.push(item);
      else map.set(item.agentId, [item]);
    }
    return map;
  });

  const visible = $derived(items.filter((item) => !item.agentId));

  let clock = $state(Date.now());
  const anyRunning = $derived(visible.some((item) => item.type === 'tool' && item.state === 'running'));
  const tickUntil = $derived(tickDeadline(visible));
  $effect(() => {
    if (!anyRunning || tickUntil === null) return;
    clock = Date.now();
    if (clock >= tickUntil) return;
    const timer = setInterval(() => {
      clock = Date.now();
      if (clock >= tickUntil) clearInterval(timer);
    }, 500);
    return () => clearInterval(timer);
  });
  const stillRunning = $derived(backgroundedRunning(visible, clock));
  const stillRunningIds = $derived(new Set(stillRunning.map((item) => item.id)));
  let backgroundOpen = $state(false);
  const flowing = $derived(stillRunningIds.size
    ? visible.filter((item) => !stillRunningIds.has(item.id))
    : visible);
  const baseRows = $derived(groupToolRuns(flowing));
  const foldedIds = $derived.by(() => {
    const ids = new Set();
    for (const row of baseRows) {
      if (row.type === 'toolrun') for (const card of row.items || row.tools) ids.add(card.id);
    }
    return ids;
  });

  const rows = $derived.by(() => {
    const kept = [highlightItemId, streamingItemId, scrollToItemId].filter((id) => id && foldedIds.has(id));
    return groupHooks(kept.length ? groupToolRuns(flowing, { keep: new Set(kept) }) : baseRows);
  });

  let pinned = $state(true);
  $effect(() => {
    if (!bottom || !scroller) return;
    const watch = new IntersectionObserver(([entry]) => { pinned = entry.isIntersecting; }, { root: scroller });
    watch.observe(bottom);
    return () => watch.disconnect();
  });

  const streamingItemId = $derived.by(() => {
    const last = visible.at(-1);
    return running && last?.type === 'assistant' && last.streaming ? last.id : null;
  });

  $effect(() => {
    if (!bottom || !scroller) return;
    observer?.disconnect();
    observer = new IntersectionObserver(
      // Proximity only: it drives the "↓ latest" button and the unread mark. It used
      // to clear the release flag as the end left the screen, which meant the follow
      // re-armed itself the moment anything brought the end back within the band --
      // on a phone that is every toolbar and keyboard change, not a scroll at all.
      ([entry]) => { atBottom = entry.isIntersecting; },
      { root: scroller, rootMargin: '0px 0px 120px 0px' }
    );
    observer.observe(bottom);
    return () => observer?.disconnect();
  });

  // While his finger is on the glass, or the view is still moving from a flick of his,
  // the transcript is frozen: the rows rendered stay exactly the rows that were
  // rendered when the gesture began, no intrinsic size is rewritten under him, and
  // nothing writes scrollTop. Whatever arrived meanwhile lands in one piece once
  // everything is still.
  const HOLD_MS = 240;
  const HOLD_CAP_MS = 1200;
  let heldRows = $state(null);
  let holdTimer = 0;
  let fingerDown = false;
  // When a gesture of his was last seen. Momentum arrives as scroll events with no touch
  // behind them, so those count as his for a moment afterwards; a scroll that is merely
  // the consequence of the page growing does not, or hydrating a long chat would freeze
  // itself out of ever finishing. No gesture yet is minus infinity, not 0: with 0, every
  // scroll the page made in its first 1.2 s (a pane mounting, the composer shrinking after
  // a send) counted as his and froze the rows for 240 ms, so his own message, sent in that
  // window, painted 240 ms late.
  let gestureAt = -Infinity;
  const shown = $derived(heldRows ?? rows);
  function holdLayout(fromGesture = false) {
    if (fromGesture) {
      gestureAt = performance.now();
      if (!following) captureAnchor();
    }
    else if (performance.now() - gestureAt > 1200) return;
    if (!heldRows) heldRows = rows;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(releaseLayout, HOLD_MS);
  }
  function releaseLayout() {
    clearTimeout(holdTimer);
    holdTimer = 0;
    // A finger resting on the screen after a drag is still a gesture: iOS resumes the
    // scroll from where it is the moment he moves again. But a pointerup that never
    // arrives (a selection drag that ends outside the scroller, a cancelled gesture)
    // must not freeze the transcript for good, so the hold expires on its own.
    if (fingerDown && performance.now() - gestureAt < HOLD_CAP_MS) {
      holdTimer = setTimeout(releaseLayout, HOLD_MS);
      return;
    }
    fingerDown = false;
    heldRows = null;
  }

  let landedFor = $state(null);
  $effect(() => {
    const count = visible.length;
    if (conversationId !== landedFor) {
      // A hold belongs to the gesture that started it, in the chat it started in.
      // Carrying one across a chat switch kept the old rows on screen for up to a
      // quarter of a second, which the paint budget caught.
      clearTimeout(holdTimer);
      holdTimer = 0;
      fingerDown = false;
      heldRows = null;
      landedFor = null;
      atBottom = false;
      loadingEarlier = false;
    }
    if (!count || landedFor === conversationId) return;
    landedFor = conversationId;
    setSlack(0);
    anchor = null;
    const token = ++pinToken;
    tick().then(() => {
      if (!scroller) return;
      if (token !== pinToken) {
        lastScrollHeight = scroller.scrollHeight;
        return;
      }
      pin();
      landing = true;
      clearTimeout(landingTimer);
      landingTimer = setTimeout(endLanding, LANDING_MS);
    });
  });

  const LANDING_MS = 1500;
  let landing = $state(false);
  let landingTimer = 0;
  let pinToken = 0;
  function pin() {
    setSlack(0);
    scroller.scrollTop = scroller.scrollHeight; selfTop = scroller.scrollTop;
    lastScrollHeight = scroller.scrollHeight;
    wrote = scroller.scrollTop;
    following = true;
    atBottom = true;
  }

  let spacer = $state(null);
  let slack = 0;
  function setSlack(px) {
    slack = Math.max(0, Math.round(px));
    if (spacer) spacer.style.height = `${slack}px`;
  }
  function endLanding() {
    clearTimeout(landingTimer);
    pinToken += 1;
    if (!landing) return;
    landing = false;
    if (scroller) lastScrollHeight = scroller.scrollHeight;
  }

  $effect(() => {
    if (typeof document === 'undefined') return;
    let countWhenHidden = 0;
    let followingWhenHidden = true;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        countWhenHidden = visible.length;
        followingWhenHidden = following;
        return;
      }
      if (followingWhenHidden && visible.length > countWhenHidden && scroller) {
        tick().then(() => {
          if (scroller) { scroller.scrollTop = scroller.scrollHeight; wrote = scroller.scrollTop; selfTop = scroller.scrollTop; }
          atBottom = true;
        });
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  });

  let wrote = -1;
  let selfTop = -1;
  $effect(() => {
    const signature = `${shown.length}:${shown.at(-1)?.text?.length ?? 0}`;
    if (signature === lastSignature) return;
    lastSignature = signature;
    // a page may hold the view where it is while an answer streams (the tophat.md intro: html[data-hold-scroll]); growth is then the reader's to catch up with
    const held = typeof document !== 'undefined' && document.documentElement.hasAttribute('data-hold-scroll');
    if (following && scroller && !held) {
      requestAnimationFrame(() => {
        if (!scroller || !following) return;
        // The view is above where we put it: he moved it himself between the last
        // token and this one, and a phone can deliver that scroll late. Give it up
        // rather than write over him. A move down is the page's (scroll anchoring),
        // not his: he cannot leave the end by going further toward it.
        if (leftEndWhileFollowing({ scrollTop: scroller.scrollTop, wrote })) {
          wrote = -1;
          following = false;
          return;
        }
        if (scroller.scrollHeight > lastScrollHeight) {
          scroller.scrollTop = scroller.scrollHeight; selfTop = scroller.scrollTop;
          wrote = scroller.scrollTop;
        }
        lastScrollHeight = scroller.scrollHeight;
      });
    } else if (scroller) {
      // Not following: the growth is his to catch up with, but remember it, or the
      // first token after he comes back would look like a jump of the whole backlog.
      lastScrollHeight = scroller.scrollHeight;
    }
  });

  let lastScrollHeight = 0;
  let lastSignature = '';

  let sentTo = null;
  $effect(() => {
    visible.length;
    if (!scrollToItemId || !scroller) return;
    if (sentTo === scrollToItemId) return;
    const target = scroller.querySelector(`[data-item="${CSS.escape(scrollToItemId)}"]`);
    if (!target) return;
    sentTo = scrollToItemId;
    const wasLanding = landing;
    endLanding();
    following = false;
    atBottom = false;
    target.scrollIntoView({ block: 'center', behavior: wasLanding ? 'auto' : 'smooth' });
    tick().then(() => {
      if (!scroller || sentTo !== scrollToItemId) return;
      const again = scroller.querySelector(`[data-item="${CSS.escape(scrollToItemId)}"]`);
      if (!again) return;
      again.scrollIntoView({ block: 'center', behavior: 'auto' });
      lastScrollHeight = scroller.scrollHeight;
      wrote = scroller.scrollTop;
    });
  });

  const buckets = new Map();

  function bucketKey(item) {
    const length = (item.text || item.output || '').length;
    return `${item.type}:${length ? Math.round(Math.log2(length + 1)) : 0}`;
  }

  function estimate(item) {
    const learned = buckets.get(bucketKey(item));
    if (learned) return Math.round(learned.sum / learned.count);
    const length = (item.text || item.output || '').length;
    if (item.type === 'user') return 56 + Math.ceil(length / 60) * 21;
    if (item.type === 'assistant') return 34 + Math.ceil(length / 80) * 23;
    if (item.type === 'thinking') return 44;
    if (item.type === 'agent') return 74;
    if (item.type === 'error') return 54;
    if (item.type === 'toolrun') return 34;
    if (item.type === 'hook') return 36;
    if (item.type === 'compaction') return 24;
    if (item.type === 'pace') return 42;
    return 50; 
  }

  const taught = new WeakSet();
  const BAND = 2000; 

  function sweep() {
    if (!scroller || !column) return;
    // Writing contain-intrinsic-size changes the height of every skipped row it
    // touches. That is a reflow, and it is never allowed to happen mid-gesture.
    if (heldRows) return;
    const top = scroller.scrollTop - BAND;
    const bottom = scroller.scrollTop + scroller.clientHeight + BAND;
    const children = column.children;
    for (let index = 0; index < children.length; index += 1) {
      const node = children[index];
      if (!node.classList?.contains('vrow')) continue;
      const nodeTop = node.offsetTop;
      if (nodeTop + node.offsetHeight < top) continue;
      if (nodeTop > bottom) break; 
      const height = node.offsetHeight;
      if (height <= 0) continue;
      node.style.containIntrinsicSize = `auto ${Math.round(height)}px`;
      if (taught.has(node)) continue;
      taught.add(node);
      const item = itemAt(loading ? index - 1 : index);
      if (!item) continue;
      const key = bucketKey(item);
      const bucket = buckets.get(key) || { sum: 0, count: 0 };
      bucket.sum += height; bucket.count += 1;
      buckets.set(key, bucket);
    }
  }

  function itemAt(index) {
    return loading ? null : shown[index] || null;
  }

  let anchor = $state(null);

  let scrollSeen = false;

  function captureAnchor() {
    scrollSeen = false;
    if (!scroller) { anchor = null; return; }
    const room = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight - slack;
    if (pinned && room < AT_END) { anchor = null; return; }
    const children = column?.children;
    if (!children?.length) return;
    let low = 0; let high = children.length - 1; let found = children[0];
    while (low <= high) {
      const mid = (low + high) >> 1;
      const node = children[mid];
      if (node.offsetTop + node.offsetHeight <= scroller.scrollTop) low = mid + 1;
      else { found = node; high = mid - 1; }
    }
    anchor = {
      node: found,
      // Where the row sits on screen, and where it sits in the column. The second one
      // is what the correction below works from: it moves the view by however far the
      // row itself moved, never to an absolute position remembered from before, so a
      // scroll that happened since -- a phone's momentum, mid-flight -- is not undone.
      offset: found.offsetTop - scroller.scrollTop,
      nodeTop: found.offsetTop,
      cursor: Number(found.dataset?.cursor) || null
    };
  }

  function rowAtCursor(cursor) {
    const children = column?.children;
    if (!children?.length || !cursor) return null;
    for (let index = 0; index < children.length; index += 1) {
      const node = children[index];
      const at = Number(node.dataset?.cursor);
      if (Number.isFinite(at) && at >= cursor) return node;
    }
    return null;
  }

  const EARLIER_BAND = 400; 
  let loadingEarlier = $state(false);

  function maybeLoadEarlier() {
    if (!onLoadEarlier || loadingEarlier || !scroller) return;
    if (landing || landedFor !== conversationId) return;
    if (scroller.scrollHeight <= scroller.clientHeight) return;
    if (scroller.scrollTop > EARLIER_BAND) return;
    if (canLoadEarlier && !canLoadEarlier()) return;
    loadingEarlier = true;
    Promise.resolve()
      .then(onLoadEarlier)
      .catch(() => {})
      .finally(() => { loadingEarlier = false; });
  }

  const SETTLE_MS = 140;

  $effect(() => {
    if (!column || !scroller) return;
    let frame = 0;
    let lastTop = scroller.scrollTop;
    let lastHeight = scroller.scrollHeight;
    let lastAt = performance.now();
    let settleTimer = 0;
    // How far this gesture has carried him in total, so that "he was heading for the
    // end and the text grew out from under him" is judged on the whole flick rather
    // than on one momentum frame of it. A phone delivers a fling as a handful of
    // 100-300px scroll events; judging each one on its own is what used to re-arm the
    // follow hundreds of pixels short of the end and yank him down.
    let gestureMoved = 0;
    let gestureRate = 0;

    const roomNow = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;

    // Called once the scrolling has actually stopped. Coming back to the end is the
    // only way the follow is re-armed, apart from the ↓ latest button and a send.
    const settled = () => {
      if (!scroller || following) return;
      const room = roomNow();
      if (room < AT_END) { arriveAtEnd(); return; }
      if (gestureMoved > 1 && gestureMoved >= room && room < followBand(gestureRate, scroller.clientHeight)) {
        arriveAtEnd();
      }
    };

    function arriveAtEnd() {
      following = true;
      anchor = null;
      wrote = -1;
      lastScrollHeight = scroller.scrollHeight;
    }

    const onScroll = () => {
      const now = performance.now();
      const rate = Math.max(0, scroller.scrollHeight - lastHeight) / Math.max(1, now - lastAt);
      lastHeight = scroller.scrollHeight;
      lastAt = now;
      const room = roomNow();
      const moved = scroller.scrollTop - lastTop;
      const wentUp = leftEndWhileFollowing({ scrollTop: scroller.scrollTop, wrote: lastTop });
      lastTop = scroller.scrollTop;
      const ours = selfTop >= 0 && Math.abs(scroller.scrollTop - selfTop) < 1.5;
      if (!ours) selfTop = -1;
      if (!ours) {
        // Momentum on a phone arrives as scroll events with no touch event behind
        // them: a scroll we did not write is a gesture of his, and freezes the layout
        // for as long as it keeps arriving.
        holdLayout();
        // Set here, cleared in captureAnchor: between the two, the anchor predates a
        // move of his that nobody has looked at yet. A phone scrolls on the compositor
        // and starves requestAnimationFrame during a fling, so that gap is a fifth of a
        // second wide there and one frame wide on a desktop. Our own writes are not
        // marked: the corrections below make them, and re-reading the anchor from one
        // of those would defeat the correction that is being made.
        scrollSeen = true;
        gestureMoved = moved > 0 ? gestureMoved + moved : 0;
        gestureRate = Math.max(gestureRate, rate);
        // He is at the end: follow again. Anywhere else he is reading, unless the view
        // went down: a parked view that Chrome's scroll anchoring moved toward the end
        // (a row above took its real height) while the stream grew 24 px or more below
        // is still following; his own wheel or touch drops the follow in letGo anyway.
        if (room < AT_END) arriveAtEnd();
        else if (following && wentUp) { following = false; wrote = -1; }
      }
      clearTimeout(settleTimer);
      settleTimer = setTimeout(settled, SETTLE_MS);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (slack) {
          setSlack(Math.min(slack, scroller.scrollHeight - slack - scroller.scrollTop - scroller.clientHeight));
        }
        if (following) anchor = null;
        else if (!ours) captureAnchor();
        sweep();
        maybeLoadEarlier();
      });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });

    // A gesture is evidence on its own. iOS delivers scroll events late during a
    // fling and can withhold them altogether while the finger is down, so waiting for
    // one before letting go of the end is how tokens end up fighting the drag. A
    // touchmove or a wheel drops the follow there and then; only settling at the end
    // brings it back.
    const letGo = () => {
      endLanding();
      gestureMoved = 0;
      gestureRate = 0;
      if (!scroller) return;
      if (following && roomNow() >= AT_END) { following = false; wrote = -1; }
      clearTimeout(settleTimer);
      settleTimer = setTimeout(settled, SETTLE_MS);
    };
    const onGesture = (event) => {
      const down = event.type === 'touchstart' || event.type === 'pointerdown';
      if (down) fingerDown = true;
      // A tap is not a scroll. Freezing on touch-down cost a tap its paint (the
      // latency spec caught it); the freeze belongs to movement, which is when a
      // reflow could actually take the text out from under him.
      if (!down) holdLayout(true);
      if (down) endLanding();
      else letGo();
    };
    const onFingerUp = () => {
      fingerDown = false;
      // Only extend a hold that a movement already started.
      if (heldRows) holdLayout(true);
    };
    const gestures = ['wheel', 'touchmove', 'touchstart', 'pointerdown'];
    for (const type of gestures) scroller.addEventListener(type, onGesture, { passive: true });
    // On the window, not the scroller: a drag that ends over the composer or off the
    // edge of the screen still ends the gesture.
    const releases = ['touchend', 'touchcancel', 'pointerup', 'pointercancel'];
    for (const type of releases) window.addEventListener(type, onFingerUp, { passive: true, capture: true });
    window.addEventListener('keydown', endLanding);
    const settle = setTimeout(sweep, 250);

    // (A per-frame anchored correction lived here. It never fired: the anchor is
    // re-read in the same frame the height changes, so the drift it looks for is
    // always zero, and it fought any programmatic scroll. The rows are laid out for
    // real now instead, which is what stops the jump.)


    // A row that has never been laid out stands in at a guessed height, and the
    // moment it is scrolled into view it takes its real one: on WebKit nothing
    // compensates for that, so the text above jumps by the difference. Correcting it
    // afterwards cannot work (the correction and the change land in the same frame),
    // so the guesses are settled in advance instead: while he is parked at the end,
    // where the view is pinned to the bottom and moving it costs nothing, the nearest
    // unmeasured rows are laid out a slice at a time and their measured height is
    // written in as their placeholder. While he is reading, nothing is measured and
    // nothing is written.
    const MEASURE_BAND = 20_000;
    const SLICE = 12;
    const measured = new WeakSet();
    let idleTimer = 0;
    const idleLater = () => { idleTimer = setTimeout(() => { idleTimer = 0; idle(); }, 600); };
    const measureSlice = () => {
      idleTimer = 0;
      if (!scroller || !column || heldRows) return;
      if (loading || document.visibilityState !== 'visible') { idleLater(); return; }
      // Only at the end. Anywhere else the measurement would move the text he is
      // reading, which is the whole thing we are trying to stop.
      if (!following) { idleLater(); return; }
      const children = column.children;
      const top = scroller.scrollTop - MEASURE_BAND;
      let done = 0;
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const node = children[index];
        if (!node.classList?.contains('vrow') || measured.has(node)) continue;
        if (node.offsetTop + node.offsetHeight < top) break;
        node.style.contentVisibility = 'visible';
        const real = node.offsetHeight;
        node.style.contentVisibility = '';
        node.style.containIntrinsicSize = `auto ${Math.round(real)}px`;
        measured.add(node);
        done += 1;
        if (done >= SLICE) break;
      }
      if (following && scroller) {
        scroller.scrollTop = scroller.scrollHeight;
        selfTop = scroller.scrollTop;
        wrote = scroller.scrollTop;
        lastScrollHeight = scroller.scrollHeight;
      }
      if (done) idle();
      else idleLater();
    };
    const idle = () => {
      if (idleTimer) return;
      // No deadline: opportunistic work must never take a frame from him.
      idleTimer = (typeof requestIdleCallback === 'function'
        ? requestIdleCallback(measureSlice)
        : setTimeout(measureSlice, 200));
    };
    const idleSoon = setTimeout(idle, 600);
    let contentHeight = 0;
    const observer = new ResizeObserver(() => {
      if (landing) {
        pin();
        return;
      }
      // He has scrolled and the handler's frame has not run yet: the anchor still
      // describes where he was before the gesture. Re-read it from the live scroll
      // position first, or the correction below is not holding his place, it is
      // putting the view back where it was -- which is the jump he reported, once per
      // token, for as long as a fling lasts.
      if (scrollSeen) captureAnchor();
      const height = column.offsetHeight;
      const delta = height - contentHeight;
      contentHeight = height;
      if (!anchor) { if (slack) setSlack(0); return; }
      if (delta > 0 && following) return;
      if (delta) setSlack(slack - delta);
      const node = anchor.node?.isConnected ? anchor.node : rowAtCursor(anchor.cursor);
      if (!node) return;
      const target = Math.max(0, node.offsetTop - anchor.offset);
      if (Math.abs(target - scroller.scrollTop) > 0.5) { scroller.scrollTop = target; selfTop = scroller.scrollTop; }
      if (node !== anchor.node) {
        anchor = { node, offset: node.offsetTop - scroller.scrollTop, nodeTop: node.offsetTop, cursor: Number(node.dataset?.cursor) || anchor.cursor };
      }
    });
    observer.observe(column);

    // The scroller's own size changes when the phone's URL bar slides away, when the
    // keyboard opens, when the composer grows a line -- and its width changes when a
    // pane is split, closed or dragged, which re-wraps every line and so changes the
    // height of the whole column. None of that is him scrolling: while he is reading,
    // the view stays exactly where it is, and the heights it is compared against are
    // re-read so the next token is not mistaken for a page of new text. While he is
    // parked at the end, the end is where he stays: a re-wrap leaves the view a few
    // pixels short of the bottom, and until this pinned the width too that was picked
    // up by the next idle measurement instead -- half a second later, as a jump.
    let viewportHeight = scroller.clientHeight;
    let viewportWidth = scroller.clientWidth;
    const onViewport = new ResizeObserver(() => {
      if (!scroller) return;
      const height = scroller.clientHeight;
      const width = scroller.clientWidth;
      if (height === viewportHeight && width === viewportWidth) return;
      viewportHeight = height;
      viewportWidth = width;
      if (landing || following) { pin(); return; }
      lastScrollHeight = scroller.scrollHeight;
      lastHeight = scroller.scrollHeight;
      lastTop = scroller.scrollTop;
      captureAnchor();
    });
    onViewport.observe(scroller);

    return () => {
      scroller.removeEventListener('scroll', onScroll);
      for (const type of gestures) scroller.removeEventListener(type, onGesture);
      for (const type of releases) window.removeEventListener(type, onFingerUp, { capture: true });
      clearTimeout(holdTimer);
      heldRows = null;
      window.removeEventListener('keydown', endLanding);
      clearTimeout(landingTimer);
      clearTimeout(settleTimer);
      observer.disconnect();
      onViewport.disconnect();
      cancelAnimationFrame(frame);
      clearTimeout(settle);
      clearTimeout(idleSoon);
      if (idleTimer) {
        if (typeof cancelIdleCallback === 'function') cancelIdleCallback(idleTimer);
        clearTimeout(idleTimer);
      }

    };
  });

  export function jumpToBottom() {
    if (!scroller) return;
    endLanding();
    anchor = null;
    pin();
    landing = true;
    clearTimeout(landingTimer);
    landingTimer = setTimeout(endLanding, LANDING_MS);
  }
</script>


<div
  class="scroller transcript"
  class:railed={railOpen}
  style:--rail-pad="{railWidth + 24}px"
  bind:this={scroller}
  data-testid="transcript"
  data-rows={visible.length}
>
  {@render rail?.()}
  <div class="column" bind:this={column}>
    {#if loading}
      <div class="loading" data-testid="loading-history">loading history…</div>
    {/if}
    {#each shown as item (item.id)}
      <!-- The placeholder height a skipped row stands in at. The blanket 200px in
           app.css is wrong for most rows, and a row that renders for the first time
           at its real height changes the column under him: flying up through history
           that had never been painted moved the column by hundreds of pixels a frame.
           estimate() learns from what sweep() measures, per type and length. -->
      <div class="row vrow" data-cursor={item.cursor ?? ''} style="contain-intrinsic-size: auto {estimate(item)}px">
        {#if item.type === 'hook'}
          <HookCard
            hook={item}
            open={isOpen(conversationId, 'hook', item.id)}
            ontoggle={() => toggleOpen(conversationId, 'hook', item.id)}
          >
            {#snippet body()}
              {#each item.children as child (child.id)}
                {#if child.type === 'toolrun'}
                  <ToolRun run={child} {onpath} />
                {:else}
                  <Message
          {viewerParticipantId}
                    item={child}
                    agentChildren={child.type === 'agent' ? byAgent.get(child.id) || [] : []}
                    {onpath}
                    {onfork}
                    highlight={highlightItemId === child.id}
                  />
                {/if}
              {/each}
            {/snippet}
          </HookCard>
        {:else if item.type === 'compaction'}
          <CompactionCard
            {item}
            open={isOpen(conversationId, 'compaction', item.id)}
            ontoggle={() => toggleOpen(conversationId, 'compaction', item.id)}
            {onpath}
          />
        {:else if item.type === 'pace'}
          <PaceCard
            {item}
            open={isOpen(conversationId, 'pace', item.id)}
            ontoggle={() => toggleOpen(conversationId, 'pace', item.id)}
          />
        {:else if item.type === 'toolrun'}
          <ToolRun run={item} {onpath} />
        {:else}
        <Message
          {viewerParticipantId}
          {item}
          agentChildren={item.type === 'agent' ? byAgent.get(item.id) || [] : []}
          {onpath}
          {onfork}
          highlight={highlightItemId === item.id}
        />
        {/if}
      </div>
    {/each}
    
    {#if stillRunning.length}
      <div class="bg-live" data-testid="background-live">
        {#if stillRunning.length > COLLAPSE_ABOVE}
          <button
            class="bg-toggle press focus-ring"
            data-testid="background-toggle"
            onclick={() => (backgroundOpen = !backgroundOpen)}
            aria-expanded={backgroundOpen}
          >
            <span class="chev" class:open={backgroundOpen}>›</span>
            <span class="pulse"></span>
            <span>{stillRunning.length} background tasks</span>
          </button>
          {#if backgroundOpen}
            <div class="bg-list" transition:slide={{ duration: 150, easing: cubicOut }}>
              {#each stillRunning as item (item.id)}
                <div class="row vrow"><Message {viewerParticipantId} {item} {onpath} /></div>
              {/each}
            </div>
          {/if}
        {:else}
          {#each stillRunning as item (item.id)}
            <div class="row vrow"><Message {viewerParticipantId} {item} {onpath} /></div>
          {/each}
        {/if}
      </div>
    {/if}

    
    <div class="working" data-testid="working">
      {#if activity}
        <Activity {...activity} />
      {/if}
    </div>
  </div>
  
  <div bind:this={bottom} class="sentinel"></div>
  <div bind:this={spacer} class="slack" aria-hidden="true"></div>
</div>

{#if loadingEarlier}
  <div class="earlier rise" data-testid="loading-earlier" role="status" aria-live="polite">
    <span class="pulse"></span>
    <span>loading earlier messages…</span>
  </div>
{/if}

{#if !atBottom}
  <button class="jump press focus-ring rise" onclick={jumpToBottom} aria-label="Jump to latest">↓ latest</button>
{/if}

<style>
  .transcript { flex: 1; min-height: 0; padding: 8px 0 4px; position: relative; }
  
  .transcript.railed { padding-right: var(--rail-pad, 344px); }
  @media (prefers-reduced-motion: no-preference) {
    .transcript { transition: padding-right var(--panel) var(--ease); }
  }
  .column {
    max-width: calc(var(--column) + 2 * var(--column-gutter));
    margin: 0 auto;
    padding: 0 var(--column-gutter) 24px;
  }
  /* Outside the column on purpose: the column carries slack at its foot on a phone
     so the floating buttons do not cover the last line, and a sentinel above that
     slack reports "he is at the end" while he is still 82px of it short. */
  .sentinel { height: 1px; flex: none; }
  .slack { height: 0; flex: none; pointer-events: none; }
  .loading { text-align: center; font-size: 11.5px; color: var(--ink-faint); padding: 10px 0; }
  .working { height: 20px; padding: 2px 0; }
  
  .earlier {
    position: absolute;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 7px;
    background: var(--bg-raised);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 5px 13px;
    font-size: 12px;
    color: var(--ink-dim);
    box-shadow: 0 4px 16px rgb(0 0 0 / 0.28);
    pointer-events: none;
    z-index: 5;
  }
  .earlier .pulse {
    width: 6px; height: 6px; border-radius: 50%; flex: none;
    background: var(--accent);
    animation: bg-pulse 1.8s ease-in-out infinite;
  }
  @media (prefers-reduced-motion: reduce) { .earlier .pulse { animation: none; } }

  .jump {
    position: absolute;
    bottom: 92px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg-raised);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 6px 14px;
    font-size: 12px;
    color: var(--ink-dim);
    box-shadow: 0 4px 16px rgb(0 0 0 / 0.28);
    z-index: 5;
  }


  
  .bg-live { display: flex; flex-direction: column; }
  .bg-toggle {
    display: flex; align-items: center; gap: 7px;
    align-self: flex-start;
    padding: 3px 8px 3px 4px;
    border: 0; background: none;
    color: var(--ink-faint); font: inherit; font-size: 11.5px;
    cursor: pointer; border-radius: 7px;
  }
  .bg-toggle:hover { background: color-mix(in srgb, var(--ink) 4%, transparent); }
  .bg-toggle .chev { transition: transform var(--tap) var(--ease); display: inline-block; }
  .bg-toggle .chev.open { transform: rotate(90deg); }
  .bg-toggle .pulse {
    width: 6px; height: 6px; border-radius: 50%; flex: none;
    background: var(--accent);
    animation: bg-pulse 1.8s ease-in-out infinite;
  }
  @keyframes bg-pulse { 0%, 100% { opacity: 0.25; } 50% { opacity: 0.8; } }
  @media (prefers-reduced-motion: reduce) { .bg-toggle .pulse { animation: none; } }

  /* On a phone the new-chat button, the nav pill and the stop button float over the last
     58px of the transcript. The column carries that much extra slack at its foot so the
     scroll can carry the newest line out from under them instead of parking it there. */
  @media (max-width: 860px) {
    .column { padding-bottom: 82px; }
    .jump { bottom: 78px; }
  }
  
</style>
