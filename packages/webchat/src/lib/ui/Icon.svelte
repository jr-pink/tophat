<script>
  let { name, size = 15 } = $props();

  const PATHS = {
    search: 'M10.5 10.5 14 14M12 7a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z',
    menu: 'M2 4h12M2 8h12M2 12h12',
    close: 'M4 4l8 8M12 4l-8 8',
    fork: 'M5 3v4a3 3 0 0 0 3 3h3M5 3a1.5 1.5 0 1 0 0-.001M5 13a1.5 1.5 0 1 0 0-.001M5 7v6M12.5 10a1.5 1.5 0 1 0 0-.001',
    split: 'M2.5 3h11v10h-11zM8 3v10',
    // A thumbtack seen side on: cap, shaft, the collar it presses flat against, and the needle.
    pin: 'M5.5 2.5h5M7 2.5v4L4.4 8.9h7.2L9 6.5v-4M8 8.9V14',
    // Set aside is Spark's gesture: an arrow leaving the list down and to the left.
    aside: 'M12.5 3.5 5 11M5 6.5V11.5H10',
    'aside-back': 'M3.5 12.5 11 5M11 9.5V4.5H6',
    tray: 'M2.5 9.5h3l1 1.5h3l1-1.5h3M4 3.5h8l1.5 6v3.5h-11V9.5z',
    archive: 'M2 4h12v3H2zM3.5 7v6h9V7M6.5 9.5h3',
    read: 'M3 2.5h7l3 3v8H3zM10 2.5v3h3',
    // Lines of text under a heading: a folder's description.
    note: 'M2.5 3.5h11M2.5 7h11M2.5 10.5h7',
    write: 'M11.5 2.5 13.5 4.5 6 12H4v-2z',
    bash: 'M3 4.5 6.5 8 3 11.5M8 12h5',
    grep: 'M10.5 10.5 14 14M12 7a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z',
    web: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM1.5 8h13M8 1.5c3 3.5 3 9.5 0 13M8 1.5c-3 3.5-3 9.5 0 13',
    agent: 'M8 2.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4ZM3.5 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4',
    tool: 'M2.5 8h11M8 2.5v11',
    // A thought bubble, for the thinking card beside the tool cards.
    thinking: 'M5 11a3 3 0 0 1-.6-5.9 3.6 3.6 0 0 1 7-.4A2.7 2.7 0 0 1 11.3 11zM4.3 13.3h.01M2.6 14.6h.01',
    memory: 'M4.5 4.5h7v7h-7zM6.5 2.5v2M9.5 2.5v2M6.5 11.5v2M9.5 11.5v2M2.5 6.5h2M2.5 9.5h2M11.5 6.5h2M11.5 9.5h2',
    mail: 'M2 4h12v8H2zM2.5 4.5 8 8.5l5.5-4',
    message: 'M2.5 3.5h11v7h-6L4.5 13v-2.5h-2z',
    clock: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM8 5v3.2l2.2 1.6',
    folder: 'M2 4.5h4l1.5 2h6.5v6.5H2z',
    // A rack of two units with their indicator lights: the host menu (the machines a chat can run on).
    server: 'M2.5 2.5h11v4.5h-11zM2.5 9h11v4.5h-11zM4.8 4.75h.01M4.8 11.25h.01M8 4.75h4M8 11.25h4',
    key: 'M6 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM7.9 7.1 13.5 1.5M11.2 3.8l1.6 1.6',
    chevron: 'M6 3.5 10.5 8 6 12.5',
    'quote-in': 'M12 3v4.5A2.5 2.5 0 0 1 9.5 10H4M6.5 7.5 4 10l2.5 2.5',
    'side-thread': 'M4.5 11.5 11.5 4.5M6.5 4.5h5v5',
    down: 'M8 3v9M4.5 8.5 8 12l3.5-3.5',
    up: 'M8 13V4M4.5 7.5 8 4l3.5 3.5',
    check: 'M3.5 8.5 6.5 11.5 12.5 4.5',
    circle: 'M8 3.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z',
    star: 'M8 2.6l1.68 3.46 3.82.52-2.77 2.66.67 3.76L8 11.2 4.6 13l.67-3.76L2.5 6.58l3.82-.52z',
    'star-on': 'M8 2.6l1.68 3.46 3.82.52-2.77 2.66.67 3.76L8 11.2 4.6 13l.67-3.76L2.5 6.58l3.82-.52z'
  };

  // The only icons drawn solid: a starred row says so at a glance, not by a shade of grey.
  const FILLED = new Set(['star-on']);
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 16 16"
  fill={FILLED.has(name) ? 'currentColor' : 'none'}
  stroke="currentColor"
  stroke-width="1.4"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  <path d={PATHS[name] || PATHS.tool} />
</svg>
