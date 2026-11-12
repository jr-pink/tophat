import { describe, expect, it } from 'vitest';
import { clipHead, clipTail, plainText, sections, summarize } from './summary.js';

const closing = `- **Last** — webchat chats now name themselves.
- **Next** — automatic on the next server restart.
- **Blocked** — nothing.`;

describe('summarize', () => {
  it('never shows the next step', () => {
    expect(summarize(closing)).not.toMatch(/next/iu);
  });

  it('prefers what is blocked on User', () => {
    const text = closing.replace('**Blocked** — nothing.', '**Blocked** — sign the DocuSign from Steve Hall.');
    expect(summarize(text)).toBe('Blocked: sign the DocuSign from Steve…');
  });

  it('falls back to what was done when nothing is blocked', () => {
    expect(summarize(closing)).toBe('webchat chats now name themselves');
  });

  it('uses the opening prose for an ordinary message', () => {
    expect(summarize('Found it: the title was set from the first message.')).toBe('Found it: the title was set…');
  });

  it('never runs past six words', () => {
    const long = 'Last — ' + Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    expect(summarize(long).split(' ').length).toBeLessThanOrEqual(7);
  });

  it('reads sections written without bullets or bold', () => {
    expect(sections('Last — shipped it\nBlocked — needs your signature').blocked).toBe('needs your signature');
  });
});

describe('plainText', () => {
  it('drops details and summary tags, emphasis and heading markers from the opener row', () => {
    const raw = '</details>\n<details>\n<summary>**6. Reader** and *notes*</summary>\n\n## Heading\n- `code` and __bold__ ~~gone~~';
    expect(plainText(raw)).toBe('6. Reader and notes Heading - code and bold gone');
  });

  it('drops tags cut at either end and collapses whitespace', () => {
    expect(plainText('ails> <details> <summary>**6. x')).toBe('6. x');
    expect(plainText('a   b\n\n c <summary')).toBe('a b c');
  });

  it('keeps links text, snake_case and comparisons', () => {
    expect(plainText('see [the doc](https://x.y/z) in snake_case_name, 2 < 3 and 5 > 4')).toBe('see the doc in snake_case_name, 2 < 3 and 5 > 4');
  });

  it('feeds summarize', () => {
    expect(summarize('<details><summary>**Done** the thing now</summary></details>')).toBe('Done the thing now');
  });
});

describe('plainText on a streamed tail', () => {
  it('a tail taken after stripping never starts inside a link or tag', () => {
    const text = 'intro ([technical post](/Users/x/.local/share/widgets/memory-bench.html) How it works: a graph that ingests facts. ' + 'word '.repeat(12);
    const tail = plainText(text).slice(-180);
    expect(tail).not.toMatch(/[\][<>]|\.html/u);
  });
});

describe('preview clips', () => {
  const words = 'Comparing research memory systems and production assistants with a long list of other words '.repeat(5).trim();
  it('a tail cut backs off to a word boundary and leads with …', () => {
    const out = clipTail(words, 180);
    expect(out.startsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(181);
    expect(out.slice(1)).toMatch(/^(Comparing|research|memory|systems|and|production|assistants|with|a|long|list|of|other|words)\b/u);
    expect(words.endsWith(out.slice(1))).toBe(true);
  });
  it('a head cut backs off to a word boundary and ends with …', () => {
    const out = clipHead(words, 180);
    expect(out.endsWith('…')).toBe(true);
    expect(words.startsWith(out.slice(0, -1))).toBe(true);
    expect(words[out.length - 1]).toBe(' ');
  });
  it('text that fits is untouched, with no …', () => {
    expect(clipHead('short one', 180)).toBe('short one');
    expect(clipTail('short one', 180)).toBe('short one');
  });
  it('a cut landing exactly on a boundary keeps every word', () => {
    expect(clipHead('abc def ghi', 7)).toBe('abc def…');
    expect(clipTail('abc def ghi', 7)).toBe('…def ghi');
  });
});
