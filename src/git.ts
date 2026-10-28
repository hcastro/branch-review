import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import type {BranchMetrics, FileMetrics} from './sections.js';

const MIB = 1024 * 1024;
// High enough that real diffs never hit it. Output past the limit is an error,
// never a silently truncated result.
const MAX_TOOL_OUTPUT_BYTES = 512 * MIB;
// Largest file read for copying contents or hashing the worktree fingerprint.
export const MAX_FILE_CONTENT_BYTES = 16 * MIB;

// Prepended to every git call. core.fsmonitor would run a command named in the
// repo's config; a split index would make git write a shared index file into
// .git; --literal-pathspecs keeps names like `app/[id]/page.tsx` from being
// read as glob patterns.
const GIT_SAFETY_ARGS = ['-c', 'core.fsmonitor=false', '-c', 'core.splitIndex=false', '--literal-pathspecs'];
// Added to every diff so repo config can't replace the patch text with an
// external tool's output or a textconv rendering.
const DIFF_ARGS = ['--no-ext-diff', '--no-textconv', '--no-color'];
// Rename detection only, even when diff.renames=copies, so the file list,
// metrics and per-file diffs all pair the same files.
const RENAME_ARGS = ['-M'];

/** A required executable (git or delta) is not on PATH. */
export class MissingToolError extends Error {}

class OutputTooLargeError extends Error {}

type ToolResult = {stdout: string; stderr: string; status: number | null};

type RunToolOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  maxBuffer?: number;
};

function firstLine(text: string) {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

function errorCode(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function runTool(command: string, args: string[], options: RunToolOptions): ToolResult {
  const maxBuffer = options.maxBuffer ?? MAX_TOOL_OUTPUT_BYTES;
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: 'utf8',
    maxBuffer,
    windowsHide: true,
  });

  if (result.error) {
    const code = errorCode(result.error);
    if (code === 'ENOENT' && !fs.existsSync(options.cwd)) {
      throw new Error(`directory not found: ${options.cwd}`);
    }
    if (code === 'ENOENT') throw new MissingToolError(`${command} not found on PATH`);
    if (code === 'ENOBUFS') {
      throw new OutputTooLargeError(`${command} output is larger than ${Math.floor(maxBuffer / MIB)} MB`);
    }
    throw new Error(`${command} failed: ${result.error.message}`);
  }

  return {stdout: result.stdout, stderr: result.stderr, status: result.status};
}

// While a private index is active for a repo, every git call in it reads and
// refreshes a temp copy of the index, so the repo's own .git/index is never
// rewritten. The code is synchronous, so one module-level slot is enough.
let indexSession: {cwd: string; env: NodeJS.ProcessEnv} | null = null;

/**
 * Runs `fn` with every git call in `cwd` pointed at a temp copy of the repo's
 * index. Porcelain `git diff` refreshes stat info and writes the index back;
 * with the copy, that write lands in the temp file, which is deleted
 * afterwards. Nested calls for the same repo share one copy.
 */
export function withPrivateIndex<T>(cwd: string, fn: () => T): T {
  if (indexSession?.cwd === cwd) return fn();

  const indexPath = path.resolve(cwd, runGitLine(cwd, ['rev-parse', '--git-path', 'index']));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-review-index-'));
  const privateIndex = path.join(dir, 'index');
  try {
    try {
      fs.copyFileSync(indexPath, privateIndex);
      // git's racy-clean check compares each entry's mtime with the index
      // file's own mtime: an entry not older than the index has its content
      // re-read instead of trusting a matching stat. A fresh copy gets a new
      // mtime, so a same-size edit made in the same second as the last index
      // write would look unchanged. Carry the mtime over, floored to the
      // second so rounding can only make more entries racy, never fewer.
      const {mtimeMs} = fs.statSync(indexPath);
      const seconds = Math.floor(mtimeMs / 1000);
      fs.utimesSync(privateIndex, seconds, seconds);
    } catch (error) {
      // A repo with no commits staged yet has no index; git treats a missing
      // file as an empty index.
      if (errorCode(error) !== 'ENOENT') throw error;
    }

    const previous = indexSession;
    indexSession = {cwd, env: {...process.env, GIT_INDEX_FILE: privateIndex}};
    try {
      return fn();
    } finally {
      indexSession = previous;
    }
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

type RunGitOptions = {
  /** `git diff --no-index` exits 1 when the files differ. */
  allowDiffExit?: boolean;
  maxBuffer?: number;
};

function runGit(cwd: string, args: string[], options: RunGitOptions = {}) {
  const result = runTool('git', [...GIT_SAFETY_ARGS, ...args], {
    cwd,
    env: indexSession?.cwd === cwd ? indexSession.env : undefined,
    maxBuffer: options.maxBuffer,
  });
  if (result.status === 0) return result.stdout;

  // Exit 1 also covers errors such as an unreadable or vanished file, which
  // print error:/fatal: and no patch.
  if (
    options.allowDiffExit
    && result.status === 1
    && result.stdout !== ''
    && !/^(error|fatal):/m.test(result.stderr)
  ) {
    return result.stdout;
  }

  const reason = firstLine(result.stderr) || `exit code ${result.status ?? 'unknown'}`;
  // The full stderr rides along so callers can show git's fatal:/error: line
  // when it is not the first line.
  throw Object.assign(new Error(`git ${args[0]} failed: ${reason}`), {stderr: result.stderr});
}

/** For commands that print one value: drops only the final newline. */
function runGitLine(cwd: string, args: string[]) {
  return runGit(cwd, args).replace(/\r?\n$/, '');
}

function tryRunGit(cwd: string, args: string[]) {
  try {
    return runGitLine(cwd, args);
  } catch (error) {
    if (error instanceof MissingToolError) throw error;
    return null;
  }
}

function hasRef(cwd: string, ref: string) {
  return tryRunGit(cwd, ['rev-parse', '--verify', '--quiet', ref]) !== null;
}

function parseNumstatValue(value: string) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

export type DiffRange = {
  base: string;
  branch: string;
  diffArg: string;
  includeWorktree: boolean;
};

export type FileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

export type ChangedFileEntry = {
  path: string;
  status: FileStatus;
  oldPath?: string;
};

/** The work tree root for `cwd`, with a one-line reason when there is none. */
export function getRepoRoot(cwd: string) {
  const result = runTool('git', [...GIT_SAFETY_ARGS, 'rev-parse', '--show-toplevel'], {cwd});
  const root = result.status === 0 ? result.stdout.replace(/\r?\n$/, '') : '';
  if (root) return root;

  if (/not a git repository/i.test(result.stderr)) {
    throw new Error(`not a git repository: ${cwd}`);
  }

  throw new Error(`not inside a git work tree: ${firstLine(result.stderr) || cwd}`);
}

function resolveRef(cwd: string, requested: string) {
  if (hasRef(cwd, requested)) return requested;
  if (hasRef(cwd, `origin/${requested}`)) return `origin/${requested}`;
  return null;
}

export function inferBaseRef(cwd: string) {
  const originHead = tryRunGit(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (originHead && hasRef(cwd, originHead)) {
    return originHead;
  }

  for (const candidate of ['development', 'main', 'master', 'trunk']) {
    const resolved = resolveRef(cwd, candidate);
    if (resolved) {
      return resolved;
    }
  }

  const currentBranch = tryRunGit(cwd, ['branch', '--show-current']);
  if (currentBranch) {
    const resolved = resolveRef(cwd, currentBranch);
    if (resolved) {
      return resolved;
    }
  }

  throw new Error('Could not infer a base ref. Pass one explicitly, for example: branch-review HEAD main');
}

export function getCurrentBranchName(cwd: string) {
  return tryRunGit(cwd, ['branch', '--show-current']) || null;
}

export function resolveRefs(cwd: string, requestedBranch: string, requestedBase: string): DiffRange {
  const base = resolveRef(cwd, requestedBase);
  if (!base) {
    throw new Error(`Base ref not found: ${requestedBase}`);
  }

  if (requestedBranch === 'HEAD') {
    const mergeBase = runGitLine(cwd, ['merge-base', base, 'HEAD']);
    return {
      base,
      branch: 'HEAD',
      diffArg: mergeBase,
      includeWorktree: true,
    };
  }

  const branch = resolveRef(cwd, requestedBranch);
  if (!branch) {
    throw new Error(`Branch ref not found: ${requestedBranch}`);
  }

  return {
    base,
    branch,
    diffArg: `${base}...${branch}`,
    includeWorktree: false,
  };
}

function splitNul(output: string) {
  return output.split('\0');
}

export function getUntrackedFiles(cwd: string) {
  return withPrivateIndex(cwd, () => splitNul(runGit(cwd, ['ls-files', '-z', '--others', '--exclude-standard'])))
    // A trailing slash marks a nested repository, which has no diff of its own.
    .filter((filePath) => filePath !== '' && !filePath.endsWith('/'));
}

export function getChangedFiles(cwd: string, range: DiffRange) {
  return getChangedFileEntries(cwd, range).map((entry) => entry.path);
}

function parseNameStatus(output: string): ChangedFileEntry[] {
  const fields = splitNul(output);
  const entries: ChangedFileEntry[] = [];

  for (let index = 0; index < fields.length;) {
    const statusCode = fields[index++];
    if (!statusCode) continue;

    if (statusCode.startsWith('R') || statusCode.startsWith('C')) {
      const oldPath = fields[index++];
      const nextPath = fields[index++];
      if (!oldPath || !nextPath) break;
      // A copy leaves its source in place, so the copy is a new file.
      entries.push(statusCode.startsWith('R')
        ? {path: nextPath, oldPath, status: 'renamed'}
        : {path: nextPath, status: 'added'});
      continue;
    }

    const filePath = fields[index++];
    if (!filePath) break;

    if (statusCode === 'A') entries.push({path: filePath, status: 'added'});
    else if (statusCode === 'D') entries.push({path: filePath, status: 'deleted'});
    else entries.push({path: filePath, status: 'modified'});
  }

  return entries;
}

export function getChangedFileEntries(cwd: string, range: DiffRange): ChangedFileEntry[] {
  return withPrivateIndex(cwd, () => {
    const entries = parseNameStatus(
      runGit(cwd, ['diff', '--name-status', '-z', ...DIFF_ARGS, ...RENAME_ARGS, range.diffArg]),
    );

    if (range.includeWorktree) {
      const seen = new Set(entries.map((entry) => entry.path));
      for (const filePath of getUntrackedFiles(cwd)) {
        if (!seen.has(filePath)) {
          entries.push({path: filePath, status: 'untracked'});
          seen.add(filePath);
        }
      }
    }

    return entries.sort((left, right) => left.path.localeCompare(right.path));
  });
}

/**
 * The exact patch text for one file, trailing newline included. A renamed
 * file passes its `oldPath` so git pairs both sides of the rename.
 */
export function getRawFileDiff(
  cwd: string,
  range: DiffRange,
  filePath: string,
  untrackedFiles?: ReadonlySet<string>,
  oldPath?: string,
) {
  const isUntracked = range.includeWorktree && (untrackedFiles?.has(filePath) ?? false);

  return withPrivateIndex(cwd, () => {
    if (isUntracked) {
      return runGit(cwd, ['diff', '--no-index', ...DIFF_ARGS, '--', '/dev/null', filePath], {allowDiffExit: true});
    }

    const paths = oldPath && oldPath !== filePath ? [oldPath, filePath] : [filePath];
    return runGit(cwd, ['diff', ...DIFF_ARGS, ...RENAME_ARGS, range.diffArg, '--', ...paths]);
  });
}

const OPEN_REGULAR_FLAGS = fs.constants.O_RDONLY
  // A FIFO opened without O_NONBLOCK blocks until a writer appears.
  | (fs.constants.O_NONBLOCK ?? 0)
  // Fails if the path was swapped for a symlink after lstat.
  | (fs.constants.O_NOFOLLOW ?? 0);

function openRegularFile(absolutePath: string, displayPath: string) {
  const fd = fs.openSync(absolutePath, OPEN_REGULAR_FLAGS);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${displayPath} is not a regular file`);
    return {fd, size: stat.size};
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function readRegularFile(absolutePath: string, displayPath: string, limit: number) {
  const tooLarge = () => new Error(`${displayPath} is larger than ${Math.floor(limit / MIB)} MB`);
  const {fd, size} = openRegularFile(absolutePath, displayPath);
  try {
    if (size > limit) throw tooLarge();

    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limit) throw tooLarge();
      chunks.push(chunk.subarray(0, bytesRead));
    }

    return Buffer.concat(chunks, total);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Worktree contents the way git diffs them: a symlink is its link text, and
 * only regular files are read, so a link can't pull in a file from outside the
 * repo and a FIFO or device can't block or stream forever.
 */
function readWorktreeText(cwd: string, filePath: string) {
  const absolutePath = path.join(cwd, filePath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error(`${filePath} no longer exists`);
    throw error;
  }

  if (stat.isSymbolicLink()) return fs.readlinkSync(absolutePath, 'utf8');
  if (!stat.isFile()) throw new Error(`${filePath} is not a regular file`);
  return readRegularFile(absolutePath, filePath, MAX_FILE_CONTENT_BYTES).toString('utf8');
}

/**
 * Full contents of the reviewed version of a file, or null for a deleted
 * file. Throws with a one-line reason when the contents can't be read.
 */
export function getReviewFileContents(
  cwd: string,
  range: DiffRange,
  file: Pick<ChangedFileEntry, 'path' | 'status'>,
) {
  if (file.status === 'deleted') {
    return null;
  }

  if (range.includeWorktree || file.status === 'untracked') {
    return readWorktreeText(cwd, file.path);
  }

  try {
    return runGit(cwd, ['show', `${range.branch}:${file.path}`], {maxBuffer: MAX_FILE_CONTENT_BYTES});
  } catch (error) {
    if (error instanceof OutputTooLargeError) {
      throw new Error(`${file.path} is larger than ${Math.floor(MAX_FILE_CONTENT_BYTES / MIB)} MB`);
    }
    throw error;
  }
}

export function getFileStat(cwd: string, range: DiffRange, filePath: string) {
  return withPrivateIndex(cwd, () => runGit(cwd, ['diff', '--stat', ...DIFF_ARGS, ...RENAME_ARGS, range.diffArg, '--', filePath]))
    .replace(/\n$/, '');
}

// Counts lines the way numstat does for an added file: a final line without a
// newline still counts, and a symlink is one line of link text.
function countUntrackedLines(cwd: string, filePath: string) {
  const absolutePath = path.join(cwd, filePath);
  try {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) return 1;
    if (!stat.isFile()) return 0;

    const {fd} = openRegularFile(absolutePath, filePath);
    try {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let lines = 0;
      let lastByte = -1;
      for (;;) {
        const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        for (let index = 0; index < bytesRead; index += 1) {
          if (chunk[index] === 0x0a) lines += 1;
        }
        lastByte = chunk[bytesRead - 1]!;
      }
      return lastByte === -1 || lastByte === 0x0a ? lines : lines + 1;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return 0;
  }
}

function parseNumstat(output: string) {
  const fields = splitNul(output);
  const metrics = new Map<string, FileMetrics>();

  for (let index = 0; index < fields.length;) {
    const record = fields[index++];
    if (!record) continue;

    const firstTab = record.indexOf('\t');
    const secondTab = firstTab < 0 ? -1 : record.indexOf('\t', firstTab + 1);
    if (secondTab < 0) continue;

    const additions = parseNumstatValue(record.slice(0, firstTab));
    const deletions = parseNumstatValue(record.slice(firstTab + 1, secondTab));
    let filePath = record.slice(secondTab + 1);
    // A rename is `adds\tdels\t` followed by the old and new paths as their
    // own fields; metrics are keyed on the new path.
    if (filePath === '') {
      index += 1;
      filePath = fields[index++] ?? '';
    }
    if (!filePath) continue;

    metrics.set(filePath, {
      path: filePath,
      additions,
      deletions,
      changedLines: additions + deletions,
    });
  }

  return metrics;
}

export function getFileMetricsMap(cwd: string, range: DiffRange) {
  return withPrivateIndex(cwd, () => {
    const metrics = parseNumstat(
      runGit(cwd, ['diff', '--numstat', '-z', ...DIFF_ARGS, ...RENAME_ARGS, range.diffArg]),
    );

    if (range.includeWorktree) {
      for (const filePath of getUntrackedFiles(cwd)) {
        const additions = countUntrackedLines(cwd, filePath);
        metrics.set(filePath, {
          path: filePath,
          additions,
          deletions: 0,
          changedLines: additions,
        });
      }
    }

    return metrics;
  });
}

export function getBranchMetrics(cwd: string, range: DiffRange): BranchMetrics {
  const fileMetrics = [...getFileMetricsMap(cwd, range).values()];

  return {
    filesChanged: fileMetrics.length,
    additions: fileMetrics.reduce((sum, item) => sum + item.additions, 0),
    deletions: fileMetrics.reduce((sum, item) => sum + item.deletions, 0),
    changedLines: fileMetrics.reduce((sum, item) => sum + item.changedLines, 0),
  };
}

function statFingerprint(cwd: string, filePath: string) {
  try {
    const stat = fs.statSync(path.join(cwd, filePath));
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

// Size and mtime alone miss a same-size edit inside one mtime tick on coarse
// filesystems, so worktree files are hashed by content up to the size cap.
function worktreeFingerprint(cwd: string, filePath: string) {
  const absolutePath = path.join(cwd, filePath);
  try {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) return `link:${fs.readlinkSync(absolutePath, 'utf8')}`;
    if (!stat.isFile()) return `other:${stat.mode}`;
    if (stat.size > MAX_FILE_CONTENT_BYTES) return `large:${stat.size}:${stat.mtimeMs}`;
    const contents = readRegularFile(absolutePath, filePath, MAX_FILE_CONTENT_BYTES);
    return `file:${createHash('sha1').update(contents).digest('hex')}`;
  } catch {
    return 'missing';
  }
}

export function getReviewFingerprint(cwd: string, range: DiffRange) {
  return withPrivateIndex(cwd, () => {
    const entries = getChangedFileEntries(cwd, range);
    const metrics = getFileMetricsMap(cwd, range);
    const head = tryRunGit(cwd, ['rev-parse', 'HEAD']) ?? '';
    const raw = runGit(cwd, ['diff', '--raw', '-z', ...DIFF_ARGS, ...RENAME_ARGS, range.diffArg]);
    const hash = createHash('sha1');

    hash.update(range.base);
    hash.update('\0');
    hash.update(range.branch);
    hash.update('\0');
    hash.update(head);
    hash.update('\0');
    hash.update(raw);

    for (const entry of entries) {
      const metric = metrics.get(entry.path);
      hash.update('\0');
      hash.update(entry.status);
      hash.update('\0');
      hash.update(entry.oldPath ?? '');
      hash.update('\0');
      hash.update(entry.path);
      hash.update('\0');
      hash.update(metric ? `${metric.additions}:${metric.deletions}:${metric.changedLines}` : '0:0:0');
      hash.update('\0');
      hash.update(range.includeWorktree ? worktreeFingerprint(cwd, entry.path) : statFingerprint(cwd, entry.path));
    }

    return hash.digest('hex');
  });
}

/** NO_COLOR set and non-empty, or FORCE_COLOR=0, turns colour off. */
export function isColorDisabled(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(env.NO_COLOR) || env.FORCE_COLOR === '0';
}

/**
 * Replaces control characters that a terminal would act on with visible
 * markers: C0 controls as caret notation (^M, ^H, ^G), ESC as U+241B, DEL as
 * ^?, and C1 controls as <U+009B>. Tab and newline are kept.
 */
export function makeControlCharsVisible(text: string) {
  return text.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, (char) => {
    const code = char.charCodeAt(0);
    if (code === 0x1b) return '␛';
    if (code < 0x20) return `^${String.fromCharCode(code + 0x40)}`;
    if (code === 0x7f) return '^?';
    return `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`;
  });
}

const DELTA_LAYOUT_ARGS = [
  '--no-gitconfig',
  '--paging=never',
  '--line-numbers',
  '--navigate',
  '--line-fill-method=spaces',
  '--file-style=omit',
  '--hunk-header-decoration-style=omit',
];

const DELTA_THEME_ARGS = [
  '--dark',
  '--syntax-theme=Monokai Extended',
  '--hunk-header-style=syntax file line-number',
  '--plus-style=syntax #003800',
  '--minus-style=syntax #3f0001',
];

// Every style delta colours is set to `normal`, so it emits no SGR codes, and
// the +/- markers stay so added and removed lines remain distinct.
const DELTA_PLAIN_ARGS = [
  '--syntax-theme=none',
  '--keep-plus-minus-markers',
  '--hunk-header-style=file line-number',
  ...[
    'hunk-header-file-style',
    'hunk-header-line-number-style',
    'plus-style',
    'minus-style',
    'zero-style',
    'plus-emph-style',
    'minus-emph-style',
    'plus-non-emph-style',
    'minus-non-emph-style',
    'whitespace-error-style',
    'line-numbers-minus-style',
    'line-numbers-plus-style',
    'line-numbers-zero-style',
    'line-numbers-left-style',
    'line-numbers-right-style',
  ].map((option) => `--${option}=normal`),
];

/**
 * Renders a raw patch with delta for display. delta runs directly, without a
 * shell, on the patch with control characters made visible. A missing delta
 * throws MissingToolError; a failing one throws with delta's stderr.
 */
export function renderDiffForDisplay(cwd: string, rawDiff: string, width: number) {
  if (rawDiff === '') return '';

  const args = [
    ...DELTA_LAYOUT_ARGS,
    ...(isColorDisabled() ? DELTA_PLAIN_ARGS : DELTA_THEME_ARGS),
    `--width=${Math.max(width, 80)}`,
  ];

  let result: ToolResult;
  try {
    result = runTool('delta', args, {cwd, input: makeControlCharsVisible(rawDiff)});
  } catch (error) {
    if (error instanceof MissingToolError) {
      throw new MissingToolError('delta not found on PATH. Install git-delta: https://dandavison.github.io/delta/installation.html');
    }
    throw error;
  }

  if (result.status !== 0) {
    throw new Error(`delta failed: ${firstLine(result.stderr) || `exit code ${result.status ?? 'unknown'}`}`);
  }

  return result.stdout.trimEnd();
}

export function getColoredFileDiff(
  cwd: string,
  range: DiffRange,
  filePath: string,
  width: number,
  untrackedFiles?: ReadonlySet<string>,
  oldPath?: string,
) {
  return renderDiffForDisplay(cwd, getRawFileDiff(cwd, range, filePath, untrackedFiles, oldPath), width);
}
