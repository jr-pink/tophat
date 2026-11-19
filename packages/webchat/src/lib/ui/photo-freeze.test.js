import { describe, expect, it } from 'vitest';
import { freezePhotos, frozenFrame } from './photo-freeze.js';

describe('frozenFrame', () => {
  it('scales a width-limited photo with its figure and keeps the row as tall as the drawn photo', () => {
    const f = frozenFrame({ width: 600, height: 450, cap: 4032, avail: 300 });
    expect(f.scale).toBe(0.5);
    expect(f.marginLeft).toBe(0);
    expect(f.marginBottom).toBe(-225);
  });
  it('never grows a height-capped photo past its cap, and centres it', () => {
    const f = frozenFrame({ width: 400, height: 675, cap: 400, avail: 900 });
    expect(f.scale).toBe(1);
    expect(f.marginLeft).toBe(250);
    expect(f.marginBottom).toBe(0);
  });
  it('never draws wider than its figure', () => {
    const f = frozenFrame({ width: 800, height: 600, cap: 4032, avail: 500 });
    expect(800 * f.scale + f.marginLeft).toBeLessThanOrEqual(500);
  });
});

describe('freezePhotos', () => {
  it('pins loaded photos and restores their original style attribute on release', () => {
    globalThis.ResizeObserver ||= class { observe() {} disconnect() {} };
    document.body.innerHTML = '<figure><a><img id="a" style="opacity: 0.5"></a></figure><figure><a><img id="b"></a></figure><figure><a><img id="c"></a></figure>';
    const [a, b, c] = ['a', 'b', 'c'].map((id) => document.getElementById(id));
    for (const img of [a, b]) {
      Object.defineProperty(img, 'complete', { value: true });
      Object.defineProperty(img, 'naturalWidth', { value: 4032 });
      Object.defineProperty(img, 'naturalHeight', { value: 3024 });
      img.getBoundingClientRect = () => ({ width: 600, height: 450 });
    }
    const release = freezePhotos(document.body);
    expect(a.style.width).toBe('600px');
    expect(a.style.willChange).toBe('transform');
    expect(b.style.transformOrigin).toBe('0 0');
    expect(c.getAttribute('style')).toBeNull();
    release();
    expect(a.getAttribute('style')).toBe('opacity: 0.5');
    expect(b.getAttribute('style')).toBeNull();
  });
});
