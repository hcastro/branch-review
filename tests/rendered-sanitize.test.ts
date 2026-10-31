import {afterEach, describe, expect, it} from 'vitest';
import {privateAttribute} from '../src/rendered/blockIds.js';
import {changeGroups} from '../src/rendered/changes.js';
import {renderMarkdown, type RenderInput} from '../src/rendered/markdown.js';
import {cleanupTempDirs} from './core-helpers.js';
import {diffFile} from './rendered-helpers.js';

afterEach(cleanupTempDirs);

// Repo markdown is untrusted. Whatever it holds, the rendered HTML must not
// run script, load anything, restyle the page, or forge one of our marks.

const lookups: Pick<RenderInput, 'asset' | 'link'> = {
  asset: async () => ({kind: 'skipped'}),
  link: () => ({kind: 'outside'}),
};

async function html(source: string) {
  return (await renderMarkdown({path: 'README.md', source, groups: [], ...lookups})).html;
}

const CORPUS: Array<[string, string]> = [
  ['an inline event handler', '<img src="x.png" onerror="alert(1)"><p onclick="alert(1)" onmouseover="alert(1)">hi</p>'],
  ['a javascript: link in markdown', '[click](javascript:alert(1))'],
  ['a javascript: link in HTML, with odd case and entities', '<a href="JaVaScRiPt:alert(1)">x</a><a href="jav&#x09;ascript:alert(1)">y</a>'],
  ['a script tag', '<script>alert(1)</script>after'],
  ['an SVG with script', '<svg onload="alert(1)"><script>alert(1)</script><text>svg text</text></svg>'],
  ['a base tag', '<base href="https://evil.example/">'],
  ['a meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example/">'],
  ['a template', '<template><img src=x onerror=alert(1)></template>'],
  ['CSS injection by style tag', '<style>body{background:url(https://evil.example/x)}</style>'],
  ['CSS injection by style attribute', '<p style="background:url(https://evil.example/x)">styled</p>'],
  ['an iframe', '<iframe src="https://evil.example/"></iframe>'],
  ['object and embed', '<object data="x.swf"></object><embed src="x.swf">'],
  ['a form', '<form action="https://evil.example/"><input type="text" name="q"><button>go</button></form>'],
  ['a data: link', '<a href="data:text/html,<script>alert(1)</script>">x</a>'],
  ['a vbscript: link', '[x](vbscript:msgbox)'],
  ['a link to a protocol GitHub allows but we do not', '[irc](irc://example.com/channel)'],
];

describe('sanitizer', () => {
  it.each(CORPUS)('removes %s', async (_name, source) => {
    const out = await html(source);
    expect(out).not.toMatch(/\son[a-z]+=/i);
    expect(out).not.toMatch(/javascript:|vbscript:|data:text|irc:/i);
    expect(out).not.toMatch(/<(script|base|meta|style|template|iframe|object|embed|form|button|svg)\b/i);
    expect(out).not.toMatch(/<input(?![^>]*type="checkbox")/);
    expect(out).not.toMatch(/\sstyle=/);
    expect(out).not.toContain('evil.example');
    expect(out).not.toContain('alert(1)');
  });

  it('drops the text inside stripped elements instead of showing it as prose', async () => {
    const out = await html('<style>.x{color:red}</style><svg><text>svg text</text></svg><script>var a = 1</script>Visible');
    expect(out).not.toContain('color:red');
    expect(out).not.toContain('svg text');
    expect(out).not.toContain('var a');
    expect(out).toContain('Visible');
  });

  it('prefixes repo ids and names so they cannot clobber the page', async () => {
    const out = await html('<p id="main">a</p><a name="top">b</a>');
    expect(out).toContain('id="user-content-main"');
    expect(out).toContain('name="user-content-top"');
  });

  it('strips forged change marks, block ids, private attributes and alert classes from repo HTML', async () => {
    const forged = [
      '<p data-mark="added" data-block="b-00000000-0" data-lines="1-1">forged mark</p>',
      '<p data-brabcdefghijklmnop="b:0" data-br-mark="added">forged stamp</p>',
      '<div class="markdown-alert markdown-alert-note br-removed">forged alert</div>',
      '<details class="br-removed"><summary>− 9 paragraphs removed · show</summary></details>',
    ].join('\n\n');
    const out = await html(forged);
    // Our own block ids are on every block; the forged values are gone.
    expect(out).not.toMatch(/data-(mark|br)/);
    expect(out).not.toContain('b-00000000-0');
    expect(out.match(/data-block=/g)).toHaveLength(4);
    expect(out).not.toMatch(/class="[^"]*(markdown-alert|br-)/);
    expect(out).toContain('forged mark');
  });

  it('marks only blocks the diff touched, even when repo HTML tries to look marked', async () => {
    const before = '<p data-mark="modified">Old HTML.</p>\n\nPlain.\n';
    const after = '<p data-mark="modified">Old HTML.</p>\n\nPlain, edited.\n';
    const fragment = await renderMarkdown({path: 'README.md', source: after, groups: changeGroups(diffFile(before, after)), ...lookups});
    expect(fragment.html.match(/data-mark=/g)).toHaveLength(1);
    expect(fragment.html).toMatch(/<p data-block="b-[0-9a-f]{8}-0" data-lines="3-3" data-mark="modified">Plain, edited\.<\/p>/);
  });

  it('makes a new private attribute name for every render, so no fixed name can be guessed', () => {
    const names = new Set(Array.from({length: 20}, () => privateAttribute().attribute));
    expect(names.size).toBe(20);
    for (const name of names) expect(name).toMatch(/^data-br[a-z]{16}$/);
    const {property, attribute} = privateAttribute();
    expect(attribute).toBe(`data-br${property.slice('dataBr'.length)}`);
  });

  it('shows a protocol-relative image as a remote card, never as a repo path', async () => {
    const fragment = await renderMarkdown({path: 'docs/a.md', source: '![x](//evil.example/a.png)\n', groups: [], ...lookups});
    expect(fragment.html).toContain('<span class="br-card br-remote" role="img" aria-label="x · evil.example · not loaded (offline)">');
    expect(fragment.differences).toEqual([{kind: 'remoteImage', count: 1}]);
  });

  it('makes a link inert that the page script would read as a trip, so repo text never plays a develop or a pulse', async () => {
    const source = [
      '<a href="#at=L1&d=full&g=b-00000000-1">raw</a>',
      '',
      '[pulse](#d=none&g=b-12345678-0) and [colors](#at=L7&f=0&d=full&m=1&bg=ff0000&fg=00ff00&n=99) and [encoded](#d%3Dfull)',
      '',
      '[other](other.md#d=full&g=b-12345678-0)',
      '',
      '# Title',
      '',
      '[heading](#title) and [file](other.md#title)',
      '',
    ].join('\n');
    const fragment = await renderMarkdown({path: 'README.md', source, groups: [], asset: lookups.asset, link: () => ({kind: 'inReview', href: 'f-other.html'})});
    expect(fragment.html).not.toMatch(/href="[^"]*(?:d=|g=|bg=|d%3D)/);
    expect(fragment.html.match(/<a class="br-inert" title="anchor not found">/g)).toHaveLength(5);
    expect(fragment.html).toContain('<a href="#user-content-title">heading</a>');
    expect(fragment.html).toContain('<a href="f-other.html#user-content-title">file</a>');
    expect(fragment.links.map((link) => link.status)).toEqual(['badAnchor', 'badAnchor', 'badAnchor', 'badAnchor', 'badAnchor', 'ok', 'ok']);
  });

  it('keeps a repo\'s own data-br-size off its images', async () => {
    expect(await html('<img src="x.png" data-br-size width="5">\n')).not.toContain('data-br-size');
  });
});

