import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

// The docs say what Preview and Review in browser do on disk and how
// Preview finds Chromium, as the code does it, in the names a reader sees.

const ROOT = path.join(import.meta.dirname, '..');
const raw = (name: string) => fs.readFileSync(path.join(ROOT, name), 'utf8');
const read = (name: string) => raw(name).replace(/\s+/g, ' ');
const headings = (name: string) => raw(name).split('\n').filter((line) => /^#{1,6} /.test(line));

describe('Preview and Review in browser in the docs', () => {
  it('names the one write into the repo and everything the session directory holds', () => {
    const howItWorks = read('docs/how-it-works.md');
    expect(howItWorks).toContain('`branch-review` never writes to the repo it reviews, except for pages you ask `--export-html` to write into a directory there.');
    for (const held of ['the pages that Review in browser opens', "the page worker's files", "Preview's Chromium profile"]) expect(howItWorks).toContain(held);
  });

  it('lives in docs/preview-and-browser.md, and the README links there', () => {
    expect(fs.existsSync(path.join(ROOT, 'docs/rendered-view.md'))).toBe(false);
    expect(read('README.md')).toContain('(docs/preview-and-browser.md)');
  });

  it('says how BRANCH_REVIEW_CHROME is used and every name looked for on a Linux PATH', () => {
    const doc = read('docs/preview-and-browser.md');
    expect(doc).toContain('an absolute path to a program outside the repo');
    expect(doc).toContain("A `BRANCH_REVIEW_CHROME` that can't be used turns Preview off");
    for (const name of ['chrome-headless-shell', 'chromium', 'chromium-browser', 'google-chrome']) expect(doc).toContain(`\`${name}\``);
    expect(doc).toContain("or `BRANCH_REVIEW_CHROME` names one that can't be used");
  });

  it('says Preview is on where it can draw, and every BRANCH_REVIEW_PREVIEW value that turns it off', () => {
    const doc = read('docs/preview-and-browser.md');
    const readme = read('README.md');
    expect(doc).toContain('set `BRANCH_REVIEW_PREVIEW` to `off`, `0`, `false`, or `none`');
    expect(doc).toContain('`BRANCH_REVIEW_PREVIEW=on` is accepted and changes nothing.');
    expect(readme).toContain('| `BRANCH_REVIEW_PREVIEW` | `off`, `0`, `false`, or `none` turns Preview off');
    for (const text of [doc, readme]) expect(text).not.toContain('turned off by default');
    expect(doc).toContain('the diff comes back in one frame, at the line the page showed at the top');
  });

  it('offers r only in the failures where r still works, and names --export-html over SSH', () => {
    const doc = read('docs/preview-and-browser.md');
    const failures = doc.slice(doc.indexOf("### When Preview can't draw the page"), doc.indexOf('The file keeps its diff'));
    const offering = failures.slice(0, failures.indexOf('When the page worker turns off'));
    expect(offering).toContain('that `r` opens it in the browser');
    expect(offering).not.toContain('worker');
    expect(failures).toContain('When the page worker turns off, the diff comes back the same way, and the footer reads `✗ Preview and Review in browser turned off:` with the reason. `v`, `r`, and `R` then stop working for the session.');
    expect(failures).toContain('Over SSH, where `r` opens nothing, the footer names `branch-review --export-html <dir>` in its place.');
  });

  it('calls the modes Preview, Review in browser, and All files in browser, in every heading and with no old name', () => {
    for (const name of ['README.md', 'docs/preview-and-browser.md', 'docs/how-it-works.md', 'docs/media-previews.md', 'docs/copying.md']) {
      const text = raw(name);
      for (const old of ['--render-out', 'BRANCH_REVIEW_PANE', 'in-pane view', 'Rendered ⇗', 'rendered page', 'rendered view', '`v here`']) expect(text, `${name}: ${old}`).not.toContain(old);
      for (const heading of headings(name)) expect(heading, name).not.toMatch(/render|\bpane\b/i);
    }
    const doc = read('docs/preview-and-browser.md');
    for (const name of ['Preview', 'Review in browser', 'All files in browser']) expect(doc).toContain(`**${name}**`);
  });

  it('tells a new user in one sentence each what v, r, and R do, in the README section after the images one', () => {
    const readme = raw('README.md');
    const section = readme.slice(readme.indexOf('## Preview markdown and review it in the browser'), readme.indexOf('\n## ', readme.indexOf('## Preview markdown and review it in the browser') + 1));
    expect(readme.indexOf('## See images and video in the diff')).toBeLessThan(readme.indexOf('## Preview markdown and review it in the browser'));
    for (const key of ['`v`', '`r`', '`R`', '`?`']) expect(section).toContain(`press ${key}`);
    expect(section).toContain('--export-html');
  });

  it('lists the keys, the flag and the env var in the README tables', () => {
    const readme = read('README.md');
    expect(readme).toContain('| `--export-html DIR` |');
    expect(readme).toContain('| `--json` | With `--export-html`, print the report as JSON. |');
    expect(readme).toContain('| `BRANCH_REVIEW_PREVIEW_DPR` |');
    for (const key of ['`v`', '`r`', '`R`', '`?`']) expect(readme).toContain(`| ${key} |`);
    expect(readme).toContain('| Click **Preview** in a file header |');
    expect(readme).toContain('| Click **Review in browser ⇗** in a file header |');
  });
});
