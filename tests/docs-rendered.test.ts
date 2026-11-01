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
});
