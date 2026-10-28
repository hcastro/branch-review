import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {getReviewFileContents, getReviewFingerprint, getRepoRoot, resolveRefs, withPrivateIndex} from '../src/git.js';
import {buildReviewModel} from '../src/review/build.js';
import {
  cleanupTempDirs,
  commitAll,
  git,
  gitSpy,
  initRepo,
  makeTempDir,
  snapshotTree,
  withEnv,
  writeFiles,
} from './core-helpers.js';

// Each test builds real repos and runs git and delta many times.
vi.setConfig({testTimeout: 30_000});

// Absolute, so a child started in a temp repo still resolves tsx from this checkout.
const tsxLoader = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href;

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  cleanupTempDirs();
});

function touchLater(filePath: string) {
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(filePath, future, future);
}

function repoWithSubmodule() {
  const sub = initRepo({'inner.txt': 'inner\n'});
  const cwd = initRepo({'a.txt': 'a\n'});
  git(cwd, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sub');
  commitAll(cwd, 'add submodule');
  return cwd;
}

describe('every git call runs without optional locks or terminal prompts', () => {
  it('passes GIT_OPTIONAL_LOCKS=0 and GIT_TERMINAL_PROMPT=0 to every git spawn', () => {
    const cwd = initRepo({'a.txt': 'a\n', 'b.txt': 'b\n'});
    git(cwd, 'checkout', '-q', '-b', 'feature');
    writeFiles(cwd, {'a.txt': 'a2\n', 'new.txt': 'new\n'});
    const spy = gitSpy();

    withEnv({PATH: spy.pathValue, GIT_OPTIONAL_LOCKS: undefined, GIT_TERMINAL_PROMPT: undefined}, () => {
      const root = getRepoRoot(cwd);
      const range = resolveRefs(root, 'HEAD', 'main');
      buildReviewModel({cwd: root, range, width: 100});
      getReviewFingerprint(root, range);
      const committed = resolveRefs(root, 'feature', 'main');
      getReviewFileContents(root, {...committed, includeWorktree: false}, {path: 'a.txt', status: 'modified'});
    });

    const calls = spy.calls();
    expect(calls.length).toBeGreaterThan(5);
    for (const call of calls) {
      expect({args: call.args, optionalLocks: call.optionalLocks, terminalPrompt: call.terminalPrompt})
        .toEqual({args: call.args, optionalLocks: '0', terminalPrompt: '0'});
    }
  });

  it('leaves every file under .git unchanged, submodule index included, for a stat-dirty submodule file', () => {
    const cwd = repoWithSubmodule();
    writeFiles(cwd, {'a.txt': 'a changed\n', 'untracked.txt': 'u\n'});
    touchLater(path.join(cwd, 'sub', 'inner.txt'));
    touchLater(path.join(cwd, 'a.txt'));

    const gitDir = path.join(cwd, '.git');
    expect(fs.existsSync(path.join(gitDir, 'modules', 'sub', 'index'))).toBe(true);
    const before = snapshotTree(gitDir);

    const range = resolveRefs(cwd, 'HEAD', 'main');
    const model = buildReviewModel({cwd, range, width: 100});
    getReviewFingerprint(cwd, range);

    expect(model.files.map((file) => file.path)).toEqual(['a.txt', 'untracked.txt']);
    const after = snapshotTree(gitDir);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [file, stat] of before) {
      expect({file, ...after.get(file)}).toEqual({file, ...stat});
    }
  });

  it('turns a credential prompt during a lazy fetch into a per-file error', () => {
    // A blobless partial clone whose promisor remote answers every request
    // with 401: diffing a commit whose blobs were never fetched makes git ask
    // for credentials. With prompts off that fails at once.
    const origin = initRepo({'a.txt': 'a\n', 'b.txt': 'b\n'});
    git(origin, 'config', 'uploadpack.allowFilter', 'true');
    git(origin, 'checkout', '-q', '-b', 'feature');
    writeFiles(origin, {'a.txt': 'a changed on feature\n'});
    commitAll(origin, 'feature');
    git(origin, 'checkout', '-q', 'main');

    const clone = makeTempDir('branch-review-partial-');
    git(clone, 'clone', '-q', '--filter=blob:none', '--no-checkout', `file://${origin}`, '.');
    git(clone, 'checkout', '-q', 'main');

    const server = spawn(process.execPath, ['-e', `
      require('node:http').createServer((request, response) => {
        response.writeHead(401, {'WWW-Authenticate': 'Basic realm="test"'});
        response.end();
      }).listen(0, '127.0.0.1', function () { console.log(this.address().port); });
    `], {stdio: ['ignore', 'pipe', 'inherit']});
    children.push(server);
    const port = waitForLine(server);

    const globalConfig = path.join(makeTempDir('branch-review-config-'), 'gitconfig');
    fs.writeFileSync(globalConfig, '');

    return port.then((value) => {
      git(clone, 'remote', 'set-url', 'origin', `http://127.0.0.1:${value}/repo.git`);
      // In a child with a timeout, so a prompt that blocks fails the test
      // instead of hanging the runner.
      const script = `
        import {resolveRefs} from ${JSON.stringify(fileURLToPath(new URL('../src/git.ts', import.meta.url)))};
        import {buildReviewModel} from ${JSON.stringify(fileURLToPath(new URL('../src/review/build.ts', import.meta.url)))};
        const cwd = ${JSON.stringify(clone)};
        const model = buildReviewModel({cwd, range: resolveRefs(cwd, 'origin/feature', 'main'), width: 100});
        console.log(JSON.stringify(model.files.map((file) => ({path: file.path, error: file.error ?? null}))));
      `;
      const child = spawnSync(process.execPath, ['--import', tsxLoader, '--input-type=module', '-e', script], {
        cwd: clone,
        encoding: 'utf8',
        timeout: 20_000,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: globalConfig,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_ASKPASS: '',
          SSH_ASKPASS: '',
          GIT_TERMINAL_PROMPT: undefined,
        },
      });

      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      const files = JSON.parse(child.stdout.trim()) as Array<{path: string; error: string | null}>;
      expect(files.map((file) => file.path)).toEqual(['a.txt']);
      expect(files[0]?.error).toBeTruthy();
    });
  });
});

function waitForLine(child: ChildProcess) {
  return new Promise<string>((resolve, reject) => {
    let buffer = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline >= 0) resolve(buffer.slice(0, newline).trim());
    });
    child.once('exit', (code) => reject(new Error(`server exited with ${code}`)));
  });
}

describe('private index location', () => {
  it('creates the private index under BRANCH_REVIEW_TMPDIR when it is set', () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    writeFiles(cwd, {'a.txt': 'a2\n'});
    const parent = makeTempDir('branch-review-parent-');
    const spy = gitSpy();

    let seenInside: string[] = [];
    withEnv({BRANCH_REVIEW_TMPDIR: parent, PATH: spy.pathValue}, () => {
      withPrivateIndex(cwd, () => {
        seenInside = fs.readdirSync(parent);
        const range = resolveRefs(cwd, 'HEAD', 'main');
        buildReviewModel({cwd, range, width: 100});
      });
    });

    expect(seenInside).toHaveLength(1);
    expect(seenInside[0]).toMatch(/^branch-review-index-/);
    const indexFiles = new Set(spy.calls().map((call) => call.indexFile).filter((file) => file !== 'unset'));
    expect([...indexFiles]).toEqual([path.join(parent, seenInside[0]!, 'index')]);
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  it('removes a private index copy still in use when the process exits from inside the build', () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    const tmp = makeTempDir('branch-review-exit-');
    const gitModule = fileURLToPath(new URL('../src/git.ts', import.meta.url));
    const script = `
      import fs from 'node:fs';
      import {removePrivateIndexDirs, withPrivateIndex} from ${JSON.stringify(gitModule)};
      process.on('exit', removePrivateIndexDirs);
      withPrivateIndex(${JSON.stringify(cwd)}, () => {
        console.log(fs.readdirSync(${JSON.stringify(tmp)}).join(','));
        process.exit(3);
      });
    `;
    const child = spawnSync(process.execPath, ['--import', tsxLoader, '--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 20_000,
      env: {...process.env, BRANCH_REVIEW_TMPDIR: tmp},
    });

    expect(child.status, child.stderr).toBe(3);
    expect(child.stdout.trim()).toMatch(/^branch-review-index-[^,]+$/);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });
});
