import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createRenderedService, OPEN_DEADLINE_MS, readTips, type SetTimer} from '../src/rendered/service.js';
import {createRenderedSite} from '../src/rendered/site.js';
import {prepareStartup} from '../src/startup.js';
import {cleanupTempDirs, git, makeTempDir, writeFiles} from './core-helpers.js';
import {inProcessBackend, MOCK_FILES, mockBranchRepo} from './review-fixture.js';

// The Review in browser page end to end, on a real repo: the review the
// TUI builds, the service planning it, the worker's jobs reading, coloring
// and rendering it (here in this process), and the page on disk, as `r`
// and `R` open it.

vi.setConfig({testTimeout: 60_000});
afterEach(cleanupTempDirs);

// The service's timers, with the press's deadline stretched: the worker's
// jobs run in this process, beside the rest of a loaded suite, and a press
// that missed the real 10 s would show nothing to read. The deadline itself
// is tests/rendered-service.test.ts's.
const patientTimer: SetTimer = (run, ms) => {
  const timer = setTimeout(run, ms === OPEN_DEADLINE_MS ? 60_000 : ms);
  timer.unref();
  return () => clearTimeout(timer);
};

async function openPage(cwd: string, press: (service: ReturnType<typeof createRenderedService>) => Promise<unknown>) {
  const {range, review} = await prepareStartup({cwd, options: {requestedBranch: 'feature/docs-refresh', requestedBase: 'main', watch: false, watchPoll: false, animations: false}, width: 100});
  const session = makeTempDir('branch-review-session-');
  const shown: string[] = [];
  const backend = inProcessBackend();
  const service = createRenderedService({
    backend,
    site: createRenderedSite({tempDir: () => session}),
    surface: {kind: 'browser', refusal: null, destination: 'in your browser', show: async (url) => {
      shown.push(url);
      return {where: 'browser', message: 'opened in your browser'};
    }},
    animations: false,
    tips: readTips,
    setTimer: patientTimer,
  });
  service.setReview(review, {cwd, range});
  const outcome = await press(service);
  expect(shown, `the press showed no page: ${JSON.stringify(outcome)}`).not.toHaveLength(0);
  const url = shown.at(-1)!;
  // A page that had to leave something out to arrive in time (on a loaded
  // machine, the commits or a rich view) is written again: the page the
  // reader gets on their next press is the one these tests read.
  let file = fileURLToPath(url.split('#')[0]!);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const written = await service.page();
    if (written.ok && !written.partial) {
      file = fileURLToPath(written.url);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_100));
  }
  service.dispose();
  return {outcome, url, html: fs.readFileSync(file, 'utf8'), review};
}

describe('the Review in browser page on a real branch', () => {
  it('opens at the active file\'s card, with one card per changed file in the review\'s order', async () => {
    const cwd = mockBranchRepo();
    const {outcome, url, html, review} = await openPage(cwd, (service) => service.open({fileKey: 'src/cli.ts'}));
    expect(outcome).toEqual({kind: 'info', message: '⇗ cli.ts opened in your browser'});
    const order = review.files.map((file) => file.path);
    expect([...order].sort()).toEqual([...MOCK_FILES]);
    expect(url).toMatch(new RegExp(`/rendered/[0-9a-f]{20}\\.html#file-${order.indexOf('src/cli.ts')}&m=0&n=1$`));
    const cards = [...html.matchAll(/<section class="rv-card"[^>]* aria-label="([^"]+)"/g)].map((match) => match[1]);
    expect(cards).toEqual(order);
  });

  it('colors code with GitHub\'s grammars across the whole file, marks the words a line changed, and carries the file for context', async () => {
    const cwd = mockBranchRepo();
    const {html, review} = await openPage(cwd, (service) => service.openOverview());
    const cli = review.files.findIndex((file) => file.path === 'src/cli.ts');
    const card = html.slice(html.indexOf(`id="file-${cli}"`), html.indexOf(`id="file-${cli + 1}"`));
    expect(card).toContain('<span class="pl-k">import</span>');
    expect(card).toMatch(/version<\/span>\(<span class="pl-s"><span class="pl-pds">&quot;<\/span>0.<span class="x">[^<]*<\/span>/);
    expect(card).toContain('+11</span><span class="rv-d">−7</span>');
    const data = JSON.parse(/<script type="application\/json" id="rv-data">([\s\S]*?)<\/script>/.exec(html)![1]!) as {cards: Array<{diff: {context: string[] | null; total?: number} | null}>};
    const lines = fs.readFileSync(`${cwd}/src/cli.ts`, 'utf8').split('\n').length - 1;
    expect(data.cards[cli]!.diff!.context).toHaveLength(lines);
  });

  it('gives the README a rich view from the renderer, with its marks, and the new guide its new-file note', async () => {
    const cwd = mockBranchRepo();
    const {html, review} = await openPage(cwd, (service) => service.openOverview());
    const readme = review.files.findIndex((file) => file.path === 'README.md');
    const card = html.slice(html.indexOf(`id="file-${readme}"`), html.indexOf(`id="file-${readme + 1}"`));
    expect(card).toContain('<div class="rv-v-rich" hidden>');
    expect(card).toContain('<article class="markdown-body">');
    expect(card).toMatch(/data-mark="(added|modified)"/);
    expect(card).toContain('markdown-alert-tip');
    expect(html).toContain('<b>New file.</b> Everything below is added in this branch.');
  });

  it('compares the redrawn hero image side by side with each side\'s size', async () => {
    const cwd = mockBranchRepo();
    const {html} = await openPage(cwd, (service) => service.openOverview());
    expect(html).toContain('>Onion skin</button>');
    expect(html).toMatch(/300 × 120 · \d+ KB → 300 × 120 · \d+ KB/);
    expect(html).toContain('src="data:image/png;base64,');
  });

  it('lists the branch\'s commits and says it was never pushed', async () => {
    const cwd = mockBranchRepo();
    const {html} = await openPage(cwd, (service) => service.openOverview());
    expect(html).toMatch(/<span class="rv-state rv-state-unpushed">.*Not pushed<\/span>/);
    expect(html).toContain('<p class="rv-msg">docs: refresh the README and the hero image</p>');
    expect(html).toContain('<p class="rv-msg">feat(cli): add a preview command and a user guide</p>');
    expect(html).toContain('Showing changes from <b>all 2 commits</b>');
    expect(html).not.toMatch(/Test User|test@example\.com/);
  });

  it('says what a push and an amend changed on the next press, though the diff is the same', async () => {
    const cwd = mockBranchRepo();
    const {range, review} = await prepareStartup({cwd, options: {requestedBranch: 'feature/docs-refresh', requestedBase: 'main', watch: false, watchPoll: false, animations: false}, width: 100});
    const service = createRenderedService({backend: inProcessBackend(), site: createRenderedSite({tempDir: () => makeTempDir('branch-review-session-')}), tips: readTips});
    service.setReview(review, {cwd, range});
    const read = async () => {
      const outcome = await service.page();
      return outcome.ok ? fs.readFileSync(fileURLToPath(outcome.url), 'utf8') : '';
    };
    const before = await read();
    expect(before).toMatch(/rv-state-unpushed">.*Not pushed</);
    expect(before).toContain('<p class="rv-msg">docs: refresh the README and the hero image</p>');

    const remote = makeTempDir('branch-review-remote-');
    git(remote, 'init', '-q', '--bare');
    git(cwd, 'remote', 'add', 'origin', remote);
    git(cwd, 'push', '-q', '-u', 'origin', 'feature/docs-refresh');
    expect(await read()).toMatch(/rv-state-even">.*Up to date with origin</);

    // The amend rewrote the commit origin has: each side has one the other lacks.
    git(cwd, 'commit', '-q', '--amend', '-m', 'docs: a renamed subject');
    const after = await read();
    expect(after).toMatch(/rv-state-diverged"[^>]*>.*Ahead 1, behind 1</);
    expect(after).toContain('<p class="rv-msg">docs: a renamed subject</p>');
    expect(after).not.toContain('docs: refresh the README and the hero image');
    service.dispose();
  });

  it('opens a review with nothing but code too, rendering it only when asked', async () => {
    const cwd = mockBranchRepo();
    git(cwd, 'checkout', '-q', '-b', 'feature/code-only', 'main');
    writeFiles(cwd, {'src/cli.ts': 'export {};\n'});
    git(cwd, 'commit', '-qam', 'refactor: empty the CLI');
    const {range, review} = await prepareStartup({cwd, options: {requestedBranch: 'feature/code-only', requestedBase: 'main', watch: false, watchPoll: false, animations: false}, width: 100});
    const shown: string[] = [];
    const backend = inProcessBackend();
    const asked: string[] = [];
    const review$ = backend.review!;
    backend.review = (request, signal) => {
      asked.push(request.key);
      return review$(request, signal);
    };
    const service = createRenderedService({backend, site: createRenderedSite({tempDir: () => makeTempDir('branch-review-session-')}), setTimer: patientTimer, surface: {kind: 'browser', refusal: null, destination: 'in your browser', show: async (url) => {
      shown.push(url);
      return {where: 'browser', message: 'opened in your browser'};
    }}});
    service.setReview(review, {cwd, range});
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(asked).toHaveLength(0);
    expect(await service.open({fileKey: 'src/cli.ts'})).toEqual({kind: 'info', message: '⇗ cli.ts opened in your browser'});
    expect(asked).toHaveLength(1);
    expect(shown[0]).toMatch(/#file-0&m=1&n=1$/);
    service.dispose();
  });
});
