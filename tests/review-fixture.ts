import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import type {FragmentResult, PageResult, RenderedBackend, ReviewResult} from '../src/rendered/backend.js';
import {createRenderedHandler} from '../src/rendered/worker/handler.js';
import {commitAll, git, initRepo, writeFiles} from './core-helpers.js';
import {pngFixture} from './media-helpers.js';

// A branch shaped like the Review in browser page's approved mock: a
// README rewritten, a package.json bumped, a new guide, a hero image
// redrawn, a CLI edited and a new module, in two commits on
// `feature/docs-refresh` over `main`. Its texts are the mock's own.

const fixture = (name: string) => fs.readFileSync(fileURLToPath(new URL(`./fixtures/review/${name}`, import.meta.url)), 'utf8');

export const MOCK_FILES = ['README.md', 'docs/guide.md', 'img/hero.png', 'package.json', 'src/cli.ts', 'src/preview.ts'] as const;

// The hero image, as the mock draws it: a diagonal gradient with a sun,
// which the branch moves and recolors.
function hero(from: [number, number, number], to: [number, number, number], sun: {x: number; y: number; r: number}) {
  return pngFixture(300, 120, (x, y) => {
    if ((x - sun.x) ** 2 + (y - sun.y) ** 2 <= sun.r ** 2) return [244, 183, 64, 255];
    const t = (x / 300 + y / 120) / 2;
    return [Math.round(from[0] + (to[0] - from[0]) * t), Math.round(from[1] + (to[1] - from[1]) * t), Math.round(from[2] + (to[2] - from[2]) * t), 255];
  });
}

export function mockBranchRepo() {
  const cwd = initRepo({
    'README.md': fixture('README.before.md'),
    'package.json': fixture('package.before.json'),
    'src/cli.ts': fixture('cli.before.ts.txt'),
  });
  fs.mkdirSync(`${cwd}/img`);
  fs.writeFileSync(`${cwd}/img/hero.png`, hero([20, 50, 79], [47, 109, 181], {x: 235, y: 61, r: 31}));
  commitAll(cwd, 'chore: the widget as it was');
  git(cwd, 'checkout', '-q', '-b', 'feature/docs-refresh');
  writeFiles(cwd, {'package.json': fixture('package.after.json'), 'src/cli.ts': fixture('cli.after.ts.txt'), 'src/preview.ts': fixture('preview.ts.txt'), 'docs/guide.md': fixture('guide.md')});
  commitAll(cwd, 'feat(cli): add a preview command and a user guide');
  writeFiles(cwd, {'README.md': fixture('README.after.md')});
  fs.writeFileSync(`${cwd}/img/hero.png`, hero([42, 27, 92], [138, 63, 179], {x: 264, y: 39, r: 25}));
  commitAll(cwd, 'docs: refresh the README and the hero image');
  return cwd;
}

/** The rendered worker's jobs run in this process: a backend with no process, no deadline and no strikes. */
export function inProcessBackend(): RenderedBackend & {handler: ReturnType<typeof createRenderedHandler>} {
  const handler = createRenderedHandler();
  return {
    handler,
    fragment: (request) => handler.handle({type: 'fragment', ...request}) as Promise<FragmentResult>,
    prioritize: () => undefined,
    page: (request) => handler.handle({type: 'page', ...request}) as Promise<PageResult>,
    review: (request) => handler.handle({type: 'review', ...request}) as Promise<ReviewResult>,
    dispose: () => handler.dispose(),
    disabledReason: () => null,
  };
}
