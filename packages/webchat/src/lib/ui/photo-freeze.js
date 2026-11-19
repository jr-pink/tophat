// Photos during a pane divider drag. A photo laid out at a new width every frame is re-rastered (and
// its decoded bitmap resampled) every frame. At drag start each live photo is pinned to its current
// pixel box on its own compositor layer, and each frame only its transform changes: scale(target /
// pinned width) from the top left, so the bitmap is never re-rastered or re-decoded during the drag.
// Margins carry the layout: margin-left keeps it centred in its figure, margin-bottom makes the row as
// tall as the scaled photo, so the text below follows live. On release the inline styles are restored
// and the photo lays out once at its final size.

// Where a pinned photo of `width` x `height` px draws when its figure is `avail` px wide and the
// stylesheet would cap it at `cap` px wide (natural width, or the max-height times its aspect).
export function frozenFrame({ width, height, cap, avail }) {
  const target = Math.max(1, Math.min(cap, avail));
  const scale = target / width;
  return { scale, marginLeft: Math.max(0, (avail - target) / 2), marginBottom: height * (scale - 1) };
}

function apply(photo, avail) {
  const { scale, marginLeft, marginBottom } = frozenFrame({ ...photo, avail });
  const s = photo.img.style;
  s.marginLeft = `${marginLeft}px`;
  s.marginBottom = `${marginBottom}px`;
  s.transform = `scale(${scale})`;
}

// Pins every loaded photo in `root` whose row passes `live(img)`; returns the release function.
export function freezePhotos(root, live = () => true) {
  const photos = [];
  for (const img of root.querySelectorAll('figure img')) {
    if (!img.complete || !img.naturalWidth || !live(img)) continue;
    const figure = img.closest('figure');
    const rect = img.getBoundingClientRect();
    if (!figure || rect.width < 1 || rect.height < 1) continue;
    const maxHeight = parseFloat(getComputedStyle(img).maxHeight);
    const byHeight = Number.isFinite(maxHeight) ? maxHeight * img.naturalWidth / img.naturalHeight : Infinity;
    photos.push({ img, figure, width: rect.width, height: rect.height, cap: Math.min(img.naturalWidth, byHeight), saved: img.getAttribute('style') });
  }
  if (!photos.length) return () => {};
  const byFigure = new Map();
  for (const photo of photos) {
    const s = photo.img.style;
    s.width = `${photo.width}px`;
    s.height = `${photo.height}px`;
    s.maxWidth = 'none';
    s.maxHeight = 'none';
    s.marginTop = '0';
    s.marginRight = '0';
    s.transformOrigin = '0 0';
    s.willChange = 'transform';
    apply(photo, photo.figure.clientWidth);
    if (!byFigure.has(photo.figure)) byFigure.set(photo.figure, []);
    byFigure.get(photo.figure).push(photo);
  }
  // A ResizeObserver runs after layout and before paint, so the new transform lands in the same
  // frame as the pane width that caused it.
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) for (const photo of byFigure.get(entry.target) || []) apply(photo, entry.target.clientWidth);
  });
  for (const figure of byFigure.keys()) observer.observe(figure);
  return () => {
    observer.disconnect();
    for (const { img, saved } of photos) {
      if (saved === null) img.removeAttribute('style');
      else img.setAttribute('style', saved);
    }
  };
}
