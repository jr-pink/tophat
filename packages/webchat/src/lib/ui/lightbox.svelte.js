// The figure viewer's state: whether it is open, which figures it holds, which one is showing, the zoom view
// and the motion phase. The component draws it and holds nothing but pointer gesture scratch (live pointers,
// a drag in progress), so a figure opened by an image click, a widget's expand button or a click inside a widget
// frame is the same one action and the same state.
//
// An item is { kind: 'image' | 'widget', alt, el, src | doc, aspect }: `alt` is the caption, `el` the figure it
// came from (the box the open and close motion travel to and from), `src` an image URL, `doc` a widget's srcdoc and
// `aspect` its width / height in the chat, kept in the viewer.

const REST = { s: 1, x: 0, y: 0 };

export const lightbox = $state({
  open: false,   // mounted
  phase: 'in',   // 'in' travelling from the figure, 'open' at rest in the centre, 'out' travelling back
  items: [],
  index: 0,
  view: { ...REST },
  dragY: 0
});

export function showFigures(items, index = 0) {
  if (!items.length) return;
  lightbox.items = items;
  lightbox.index = Math.min(Math.max(0, index), items.length - 1);
  lightbox.view = { ...REST };
  lightbox.dragY = 0;
  lightbox.phase = 'in';
  lightbox.open = true;
}

/** Start the way back to the figure; `finishClose` runs when the motion ends. */
export function hideFigures() {
  if (lightbox.open && lightbox.phase !== 'out') lightbox.phase = 'out';
}

export function finishClose() {
  lightbox.open = false;
  lightbox.phase = 'in';
  lightbox.view = { ...REST };
  lightbox.dragY = 0;
}

export function stepFigure(delta) {
  const n = lightbox.items.length;
  if (n < 2) return;
  lightbox.index = (lightbox.index + delta + n) % n;
  lightbox.view = { ...REST };
}

export function setFigureView(view) {
  lightbox.view = view;
}

/** A widget frame asks to be opened (RichContent): one item, no neighbours. */
export function openWidget({ title, doc, el }) {
  const box = el?.getBoundingClientRect();
  const aspect = box && box.width && box.height ? box.width / box.height : 16 / 10;
  showFigures([{ kind: 'widget', alt: title || '', doc, el, aspect }], 0);
}
