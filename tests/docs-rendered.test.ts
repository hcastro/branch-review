import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

// The docs say what the rendered view does on disk and how it finds
// Chromium, as the code does it.

const read = (name: string) => fs.readFileSync(path.join(import.meta.dirname, '..', name), 'utf8').replace(/\s+/g, ' ');

describe('the rendered view in the docs', () => {
  it('names the one write into the repo and everything the session directory holds', () => {
    const howItWorks = read('docs/how-it-works.md');
    expect(howItWorks).toContain('`branch-review` never writes to the repo it reviews, except for pages you ask `--render-out` to write into a directory there.');
    for (const held of ['the rendered pages', "the rendered worker's files", "the in-pane view's Chromium profile"]) expect(howItWorks).toContain(held);
  });

  it('says how BRANCH_REVIEW_CHROME is used and every name looked for on a Linux PATH', () => {
    const rendered = read('docs/rendered-view.md');
    expect(rendered).toContain('an absolute path to a program outside the repo');
    expect(rendered).toContain("A `BRANCH_REVIEW_CHROME` that can't be used turns the in-pane view off");
    for (const name of ['chrome-headless-shell', 'chromium', 'chromium-browser', 'google-chrome']) expect(rendered).toContain(`\`${name}\``);
    expect(rendered).toContain("or `BRANCH_REVIEW_CHROME` names one that can't be used");
  });

  it('says the in-pane view is on where it can draw, and every BRANCH_REVIEW_PANE value that turns it off', () => {
    const rendered = read('docs/rendered-view.md');
    const readme = read('README.md');
    expect(rendered).toContain('set `BRANCH_REVIEW_PANE` to `off`, `0`, `false`, or `none`');
    expect(rendered).toContain('`BRANCH_REVIEW_PANE=on` is accepted and changes nothing.');
    expect(readme).toContain('| `BRANCH_REVIEW_PANE` | `off`, `0`, `false`, or `none` turns off the in-pane view');
    for (const text of [rendered, readme]) expect(text).not.toContain('turned off by default');
    expect(rendered).toContain('The pane goes back to the file\'s diff in one frame, at the line the page showed at the top');
  });

  it('offers r only in the failures where r still works, and names --render-out over SSH', () => {
    const rendered = read('docs/rendered-view.md');
    const failures = rendered.slice(rendered.indexOf("### When the page can't be drawn"), rendered.indexOf('The file keeps its diff'));
    const offering = failures.slice(0, failures.indexOf('When the rendered view\'s worker turns off'));
    expect(offering).toContain('that `r` opens it in the browser');
    expect(offering).not.toContain('worker');
    expect(failures).toContain("When the rendered view's worker turns off, the pane goes back to the diff the same way, and the footer reads `✗ in-pane view: rendered view turned off:` with the reason. `v`, `r`, and `R` then stop working for the session.");
    expect(failures).toContain('Over SSH, where `r` opens nothing, the footer names `branch-review --render-out <dir>` in its place.');
  });
});
