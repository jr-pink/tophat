import { describe, expect, it } from 'vitest';
import { compileMarkdown, createMarkdownCache, escapeHtml, renderBlock, splitBlocks } from './markdown.js';

describe('streaming markdown', () => {
  it('escapes anything that could be markup', () => {
    expect(renderBlock('<img src=x onerror=alert(1)>')).not.toContain('<img');
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
  });

  it('renders an unterminated fence as a code block still filling', () => {
    const html = renderBlock('```js\nconst a = 1;');
    expect(html).toContain('md-code-open');
    
    
    expect(html.replace(/<[^>]*>/gu, '')).toContain('const a = 1;');
  });

  it('highlights a fence that names its language, and leaves an unlabelled one alone', () => {
    expect(renderBlock('```js\nconst a = 1;\n```')).toContain('tok-keyword');
    expect(renderBlock('```\nconst a = 1;\n```')).not.toContain('tok-');
    
    expect(renderBlock('```js\nconst a = "<img>";\n```')).not.toContain('<img>');
  });

  it('puts a copy button in every fenced block', () => {
    expect(renderBlock('```js\nconst a = 1;\n```')).toContain('data-copy');
    expect(renderBlock('```\nls\n```')).toContain('class="md-copy"');
  });

  it('closes the block once the fence arrives', () => {
    expect(renderBlock('```js\nconst a = 1;\n```')).not.toContain('md-code-open');
  });

  it('keeps a fence as one block even with blank lines inside it', () => {
    expect(splitBlocks('```\na\n\nb\n```\n\nafter')).toEqual(['```\na\n\nb\n```', 'after']);
  });

  it('turns a path into a clickable span', () => {
    expect(renderBlock('see src/a.js')).toContain('data-path="src/a.js"');
  });

  it('leaves a path inside a code span clickable but unformatted', () => {
    const html = renderBlock('run `src/a.js` please');
    expect(html).toContain('<code>');
    expect(html).toContain('data-path="src/a.js"');
  });

  it('renders headings, lists, quotes and tables', () => {
    expect(renderBlock('## Heading')).toBe('<h2>Heading</h2>');
    expect(renderBlock('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
    expect(renderBlock('> quoted')).toContain('<blockquote>');
    expect(renderBlock('| a | b |\n| - | - |\n| 1 | 2 |')).toContain('<table>');
  });

  it('reuses cached blocks so a stream recompiles only its tail', () => {
    const cache = new Map();
    compileMarkdown('First paragraph.\n\nSecond par', cache);
    const sizeAfterFirst = cache.size;
    compileMarkdown('First paragraph.\n\nSecond paragraph.', cache);
    
    expect(cache.size).toBe(sizeAfterFirst + 1);
    expect(cache.has('First paragraph.')).toBe(true);
  });

  it('produces the same output whether streamed or delivered whole', () => {
    const text = '# Title\n\nA paragraph with `code` and src/a.js.\n\n- item\n\n```sh\necho hi\n```';
    const streamed = createMarkdownCache();
    for (let index = 1; index <= text.length; index += 7) streamed.compile(text.slice(0, index));
    expect(streamed.compile(text).map((block) => block.html))
      .toEqual(compileMarkdown(text).map((block) => block.html));
  });

  
  
  it('splits a heading away from the body that follows it', () => {
    expect(splitBlocks('## Today\nclap at 11a\n- a\n- b')).toEqual(['## Today', 'clap at 11a', '- a\n- b']);
    const html = compileMarkdown('## Today\nclap at 11a').map((b) => b.html).join('');
    expect(html).toBe('<h2>Today</h2><p>clap at 11a</p>');
  });

  it('nests an indented list under its parent item', () => {
    expect(renderBlock('- Banking:\n  - wire')).toBe('<ul><li>Banking:<ul><li>wire</li></ul></li></ul>');
  });

  
  
  
  
  
  
  describe('a single newline inside a paragraph', () => {
    // An email draft ended "Thank you so much,\nSam": the sign-off has to land on its own line.
    it('renders as a line break instead of collapsing into the line above', () => {
      expect(renderBlock('Thank you so much,\nSam')).toBe('<p>Thank you so much,<br />Sam</p>');
    });

    it('keeps inline markup that crosses the break intact', () => {
      expect(renderBlock('**Thanks,\nSam**')).toBe('<p><strong>Thanks,<br />Sam</strong></p>');
    });

    it('does not touch code blocks or blank-line paragraph separation', () => {
      expect(renderBlock('```\na\nb\n```')).not.toContain('<br />');
      expect(compileMarkdown('Thanks,\n\nSam').map((b) => b.html)).toEqual(['<p>Thanks,</p>', '<p>Sam</p>']);
    });
  });

  describe('a quote holds blocks, not one line of prose', () => {
    const draft = [
      '> **Subject:** Duplicate sample withholding, 2025',
      '>',
      '> Hi Jane,',
      '>',
      '> **Ask:** please confirm the refund lands on the 2025 return. Two things on hand:',
      '>',
      '> - both W-2s, with the `withheld` figures',
      '> - the paystub showing the start date',
      '>',
      '> Thanks,',
      '> User'
    ].join('\n');

    it('keeps the whole quote in one block and renders its paragraphs apart', () => {
      expect(splitBlocks(draft)).toHaveLength(1);
      const html = renderBlock(draft);
      expect(html.match(/<p>/gu) || []).toHaveLength(4);
      
      
      expect(html).not.toContain('2025  Hi Jane,');
    });

    it('renders a nested list as a list rather than as literal dashes', () => {
      const html = renderBlock(draft);
      expect(html).toContain('<ul><li>both W-2s,');
      expect(html).not.toContain('> - both');
      expect(html.replace(/<[^>]*>/gu, '')).not.toContain('- both W-2s');
    });

    it('leaves bold and inline code inline', () => {
      const html = renderBlock(draft);
      expect(html).toContain('<p><strong>Subject:</strong> Duplicate sample');
      expect(html).toContain('<code>withheld</code>');
    });

    it('treats a soft line break inside a quote exactly as it does outside one', () => {
      
      
      
      const quoted = renderBlock('> Thanks,\n> User');
      const plain = renderBlock('Thanks,\nUser');
      expect(quoted).toBe(`<blockquote>${plain}</blockquote>`);
    });

    it('nests a quote inside a quote, tight or with a blank line', () => {
      expect(renderBlock('> outer\n> > inner'))
        .toBe('<blockquote><p>outer</p><blockquote><p>inner</p></blockquote></blockquote>');
      expect(renderBlock('> outer\n>\n> > inner'))
        .toBe('<blockquote><p>outer</p><blockquote><p>inner</p></blockquote></blockquote>');
      expect(renderBlock('> > deep')).toBe('<blockquote><blockquote><p>deep</p></blockquote></blockquote>');
    });

    it('renders a heading, a fence and a table inside a quote', () => {
      expect(renderBlock('> ## Subject\n>\n> body')).toContain('<h2>Subject</h2>');
      expect(renderBlock('> ```js\n> const a = 1;\n> ```')).toContain('md-code');
      expect(renderBlock('> | a | b |\n> | - | - |\n> | 1 | 2 |')).toContain('<table>');
    });

    it('still escapes markup inside a quote, and survives an empty one', () => {
      expect(renderBlock('> <img src=x onerror=alert(1)>')).not.toContain('<img');
      expect(renderBlock('>')).toBe('<blockquote></blockquote>');
    });

    it('breaks a quote away from the paragraph above it', () => {
      expect(splitBlocks('some prose\n> quoted')).toEqual(['some prose', '> quoted']);
    });

    it('renders identically whether the draft streamed in or arrived whole', () => {
      const streamed = createMarkdownCache();
      for (let index = 1; index <= draft.length; index += 11) streamed.compile(draft.slice(0, index));
      expect(streamed.compile(draft).map((block) => block.html))
        .toEqual(compileMarkdown(draft).map((block) => block.html));
    });
  });

  it('renders task checkboxes rather than the literal brackets', () => {
    const html = renderBlock('- [ ] open\n- [x] done');
    expect(html).toContain('class="md-task"');
    expect(html).toContain('md-done');
    expect(html).not.toContain('[ ]');
  });
});

describe('links and images inside a line', () => {
  it('links a bare URL wrapped in bold or italics', () => {
    const html = renderBlock('live: **https://example.com/fellowship/5_pcMIArnGFf0RfyX9LDTOo0**');
    expect(html).toContain('<strong><a href="https://example.com/fellowship/5_pcMIArnGFf0RfyX9LDTOo0" target="_blank"');
    expect(renderBlock('*https://example.com/a*')).toContain('<em><a href="https://example.com/a"');
  });

  it('does not nest a link when a markdown link or path sits inside bold', () => {
    for (const src of ['**[https://example.com/a](https://example.com/a)**', '**[site](https://example.com/a)**', '*see `webchat/src/lib/core/markdown.js`*', '**https://example.com/a** and **https://example.com/b**']) {
      const html = renderBlock(src);
      expect(html).not.toMatch(/<a\b[^>]*>(?:(?!<\/a>).)*<a\b/su);
      expect(html).not.toMatch(/<button\b[^>]*>(?:(?!<\/button>).)*<a\b/su);
      expect(html).not.toMatch(/href="[^"]*</u);
    }
    expect((renderBlock('**[site](https://example.com/a)**').match(/<a\b/gu) || []).length).toBe(1);
  });

  it('links a backtick path with spaces whole, not its last fragment', () => {
    const html = renderBlock('see `archive/projects/acme/reports/amazon.csv` for it');
    expect(html).toContain('data-path="archive/projects/acme/reports/amazon.csv"');
    expect(html.match(/md-path/gu)).toHaveLength(1);
  });

  it('opens a markdown link to a file in quicklook, spaces and angle brackets included', () => {
    expect(renderBlock('the [floor plan](workspace/jobs/acme-floorplan/main-st-A211-first-floor-plan.png) is ready'))
      .toContain('<button type="button" class="md-path md-named" data-path="workspace/jobs/acme-floorplan/main-st-A211-first-floor-plan.png">floor plan</button>');
    expect(renderBlock('[plan](</Users/me/My Drive/plan one.md>)')).toContain('data-path="/Users/me/My Drive/plan one.md"');
    expect(renderBlock('[x](src/a.js:42)')).toContain('data-path="src/a.js" data-line="42"');
  });

  it('shows an inline web image through the proxy, not only one on a line of its own', () => {
    const html = renderBlock('Here it is ![bench](https://cdn.example.com/b.jpg?v=2) mid-sentence.');
    expect(html).toContain('<img src="/api/remote-image?u=https%3A%2F%2Fcdn.example.com%2Fb.jpg%3Fv%3D2"');
    expect(html).toContain('data-path="https://cdn.example.com/b.jpg?v=2"');
    expect(renderBlock('x ![no extension](https://cdn.example.com/render?id=4) y')).toContain('/api/remote-image?u=');
  });

  it('shows an inline local image through /api/file', () => {
    expect(renderBlock('plan: ![p](/tmp/a b.png) done')).toContain('src="/api/file?path=%2Ftmp%2Fa%20b.png&amp;raw=1"');
  });

  it('opens a link to a web image in quicklook, and leaves other web links as links', () => {
    const image = renderBlock('photo: https://m.media-amazon.com/images/I/71abc.jpg.');
    expect(image).toContain('class="md-path md-named" data-path="https://m.media-amazon.com/images/I/71abc.jpg"');
    expect(image).toMatch(/<\/a>\.<\/p>$/u);
    expect(renderBlock('[pic](https://x.com/a.png)')).toContain('md-path');
    const page = renderBlock('[docs](https://example.com/page) and https://example.com/other');
    expect(page).not.toContain('md-path');
    expect(page).toContain('<a href="https://example.com/page"');
  });

  it('keeps bold around a link and refuses script links', () => {
    expect(renderBlock('**[x](https://example.com)**')).toContain('<strong><a href="https://example.com"');
    expect(renderBlock('[x](javascript:alert(1))')).not.toContain('href="javascript');
    expect(renderBlock('![x](javascript:alert(1))')).not.toContain('<img');
  });
});


describe('details blocks', () => {
  it('folds a details section into a collapsible node with its body compiled as blocks', () => {
    const out = compileMarkdown('intro\n\n<details>\n<summary>**1. Memory**</summary>\n\nbody one\n\n![fig](https://x.test/a.png)\n\n</details>\n\nafter');
    expect(out).toHaveLength(3);
    expect(out[1].details).toBe(true);
    expect(out[1].open).toBe(false);
    expect(out[1].summary).toContain('<strong>');
    expect(out[1].children.map((c) => c.html || c.rich?.kind)).toHaveLength(2);
    expect(out[2].html).toContain('after');
  });
  it('nests, honours open, and shows an unclosed section while streaming', () => {
    const out = compileMarkdown('<details open>\n<summary>a</summary>\n\nx\n\n<details>\n<summary>b</summary>\n\ny');
    expect(out[0].open).toBe(true);
    expect(out[0].children[1].details).toBe(true);
    expect(out[0].children[1].children[0].html).toContain('y');
  });
  it('leaves a details tag inside a code fence alone', () => {
    const out = compileMarkdown('```html\n<details>\n<summary>s</summary>\n</details>\n```');
    expect(out).toHaveLength(1);
    expect(out[0].details).toBeUndefined();
  });
});
