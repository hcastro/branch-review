import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isUtf8} from 'node:buffer';
import {createHash} from 'node:crypto';
import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import type {BranchMetrics, FileMetrics} from './sections.js';
import {escapeHiddenCharactersInLines} from './controlChars.js';

const MIB = 1024 * 1024;
// High enough that real diffs never hit it. Output past the limit is an error,
// never a silently truncated result.
const MAX_TOOL_OUTPUT_BYTES = 512 * MIB;
// Largest file read for copying contents or hashing the worktree fingerprint.
export const MAX_FILE_CONTENT_BYTES = 16 * MIB;

// Prepended to every git call. core.fsmonitor would run a command named in the
// repo's config. core.splitIndex=false keeps git from splitting the private
// index copy, which would write a new shared index file into .git.
// --literal-pathspecs keeps names like `app/[id]/page.tsx` from being read as
// glob patterns. core.quotePath=false prints non-ASCII names as they are in
// patch headers (control characters are still quoted), and
// diff.suppressBlankEmpty=false keeps the space on blank context lines so a
// copied patch still applies. diff.autoRefreshIndex=true makes git re-check a
// file whose stat changed but whose content did not, so it is not listed as
// modified; the refreshed stat info is written to the private index copy only.
//
// Three things under .git can still change, all accepted: clean and process
// filters configured for the repo (git-lfs, for example) run on worktree files
// exactly as they do for `git status` or `git diff`, and may store objects
// under .git/lfs; in a partial clone, reading a blob that was never fetched
// fetches it, and git writes the new pack under .git/objects; and in a repo
// that already uses a split index, every read refreshes the shared index
// file's mtime (its content stays the same). Nothing else under .git is
// created or rewritten.
const GIT_SAFETY_ARGS = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.splitIndex=false',
  '-c', 'core.quotePath=false',
  '-c', 'diff.suppressBlankEmpty=false',
  '-c', 'diff.autoRefreshIndex=true',
  '--literal-pathspecs',
];
// Set for every git call. Without optional locks, a status check inside a
// submodule (which git runs with the submodule's own index, not
// GIT_INDEX_FILE) reads that index without writing a refreshed copy back.
// With terminal prompts off, a lazy fetch in a partial clone that needs
// credentials fails at once instead of prompting while the UI owns the
// terminal.
export const GIT_ENV = {GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0'} as const;
// Added to every diff so repo config can't replace the patch text with an
// external tool's output or a textconv rendering, or change the a/ b/ path
// prefixes (diff.noprefix, diff.mnemonicPrefix) that git apply relies on.
const DIFF_ARGS = ['--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/'];
// Rename detection only, even when diff.renames=copies, so the file list,
// metrics and per-file diffs all pair the same files.
const RENAME_ARGS = ['-M'];

/** A required executable (git or delta) is not on PATH. */
export class MissingToolError extends Error {}

/**
 * git or delta was stopped by SIGINT, SIGTERM or SIGHUP: the user pressed
 * Ctrl-C or closed the terminal, and the signal reached the whole process
 * group. The build stops instead of moving on to the next file.
 */
export class InterruptedError extends Error {
  constructor(readonly signal: NodeJS.Signals) {
    super(`interrupted by ${signal}`);
  }
}

/** An asynchronous refresh was cancelled through its AbortSignal. */
export class AbortedError extends Error {
  constructor() {
    super('refresh aborted');
  }
}

class OutputTooLargeError extends Error {}

const INTERRUPT_SIGNALS = new Set<NodeJS.Signals>(['SIGINT', 'SIGTERM', 'SIGHUP']);

type ToolResult = {
  stdout: string;
  /** The raw stdout, for output that must be checked byte by byte. */
  stdoutBytes: Buffer;
  /** Whether the raw stdout bytes were valid UTF-8 before decoding. */
  stdoutIsUtf8: boolean;
  stderr: string;
  status: number | null;
  /** The signal that killed the tool, if one did. */
  signal: NodeJS.Signals | null;
};

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

/** Why a tool that did not succeed stopped, when it printed no reason itself. */
function exitReason(result: Pick<ToolResult, 'status' | 'signal'>) {
  return result.signal ? `killed by ${result.signal}` : `exit code ${result.status ?? 'unknown'}`;
}

function spawnError(command: string, cwd: string, error: Error) {
  const code = errorCode(error);
  if (code === 'ENOENT' && !fs.existsSync(cwd)) return new Error(`directory not found: ${cwd}`);
  if (code === 'ENOENT') return new MissingToolError(`${command} not found on PATH`);
  return new Error(`${command} failed: ${error.message}`);
}

function outputTooLarge(command: string, maxBuffer: number) {
  return new OutputTooLargeError(`${command} output is larger than ${Math.floor(maxBuffer / MIB)} MB`);
}

function toolResult(stdout: Buffer, stderr: Buffer, status: number | null, signal: NodeJS.Signals | null): ToolResult {
  if (signal && INTERRUPT_SIGNALS.has(signal)) throw new InterruptedError(signal);
  return {
    stdout: stdout.toString('utf8'),
    stdoutBytes: stdout,
    stdoutIsUtf8: isUtf8(stdout),
    stderr: stderr.toString('utf8'),
    status,
    signal,
  };
}

function runTool(command: string, args: string[], options: RunToolOptions): ToolResult {
  const maxBuffer = options.maxBuffer ?? MAX_TOOL_OUTPUT_BYTES;
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    maxBuffer,
    windowsHide: true,
  });

  if (result.error) {
    if (errorCode(result.error) === 'ENOBUFS') throw outputTooLarge(command, maxBuffer);
    throw spawnError(command, options.cwd, result.error);
  }

  return toolResult(result.stdout, result.stderr, result.status, result.signal);
}

type AsyncControl = {
  /** Called for each chunk a tool prints or reads, and for each file a loop handles. */
  onProgress?: () => void;
  signal?: AbortSignal;
};

const INPUT_CHUNK_BYTES = 64 * 1024;

// Feeds `input` in chunks, waiting for the tool to take each one, so a tool
// that reads a large patch before printing anything still shows progress.
function writeInput(stdin: NodeJS.WritableStream, input: Buffer, onChunk: () => void) {
  let offset = 0;
  const writeMore = () => {
    while (offset < input.length) {
      const chunk = input.subarray(offset, offset + INPUT_CHUNK_BYTES);
      offset += chunk.length;
      if (!stdin.write(chunk)) {
        stdin.once('drain', () => {
          onChunk();
          writeMore();
        });
        return;
      }
    }
    stdin.end();
  };
  writeMore();
}

// How long an aborted tool may take to exit after SIGKILL before the abort
// is reported anyway.
const KILL_GRACE_MS = 500;

/**
 * runTool without blocking the event loop: each chunk of output counts as
 * progress, and an abort kills the tool and rejects with AbortedError once
 * the tool has exited.
 */
function runToolAsync(command: string, args: string[], options: RunToolOptions, control: AsyncControl): Promise<ToolResult> {
  const maxBuffer = options.maxBuffer ?? MAX_TOOL_OUTPUT_BYTES;
  const {onProgress, signal} = control;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedError());
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(command, args, {cwd: options.cwd, env: options.env, stdio: 'pipe', windowsHide: true});
    } catch (error) {
      reject(spawnError(command, options.cwd, error as Error));
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', handleAbort);
      finish();
    };
    const stopWith = (error: Error) => {
      if (settled) return;
      child.kill('SIGKILL');
      let reported = false;
      const report = () => {
        if (reported) return;
        reported = true;
        settle(() => reject(error));
      };
      if (child.exitCode !== null || child.signalCode !== null) report();
      else {
        child.once('exit', report);
        setTimeout(report, KILL_GRACE_MS).unref();
      }
    };
    const handleAbort = () => stopWith(new AbortedError());
    signal?.addEventListener('abort', handleAbort, {once: true});

    // Like spawnSync's maxBuffer, the limit applies to each stream on its own.
    const collect = (chunks: Buffer[]) => {
      let bytes = 0;
      return (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > maxBuffer) {
          stopWith(outputTooLarge(command, maxBuffer));
          return;
        }
        chunks.push(chunk);
        onProgress?.();
      };
    };
    child.stdout!.on('data', collect(stdout));
    child.stderr!.on('data', collect(stderr));
    // The tool may exit before reading all of its input.
    child.stdin!.on('error', () => {});

    child.on('error', (error) => settle(() => reject(spawnError(command, options.cwd, error))));
    child.on('close', (status, exitSignal) => settle(() => {
      try {
        resolve(toolResult(Buffer.concat(stdout), Buffer.concat(stderr), status, exitSignal));
      } catch (error) {
        reject(error);
      }
    }));

    if (options.input === undefined) child.stdin!.end();
    else writeInput(child.stdin!, Buffer.from(options.input, 'utf8'), () => onProgress?.());
  });
}

/*
 * The git and delta work is written once, as generator "operations" that
 * yield each tool run (and a progress tick after each file a loop handles)
 * and get the tool's result back. A synchronous driver runs them with
 * spawnSync for callers that need an answer at once; an asynchronous driver
 * runs them with spawn, so a long refresh keeps the event loop free, reports
 * progress on every chunk of output, and can be aborted. Both drivers run the
 * same code, so both produce the same results.
 */
type ToolStep = {
  kind: 'tool';
  command: string;
  args: string[];
  cwd: string;
  /** Unset for git: the driver supplies the git environment for `cwd`. */
  env?: NodeJS.ProcessEnv;
  input?: string;
  maxBuffer?: number;
};
type ProgressStep = {kind: 'progress'};
type OperationStep = ToolStep | ProgressStep;

/** A unit of git and delta work; run it with runOperation or runOperationAsync. */
export type GitOperation<T> = Generator<OperationStep, T, ToolResult | undefined>;

function* runToolStep(step: Omit<ToolStep, 'kind'>): GitOperation<ToolResult> {
  return (yield {kind: 'tool', ...step}) as ToolResult;
}

/** Marks one file handled, for progress reporting. */
export function* progressTick(): GitOperation<void> {
  yield {kind: 'progress'};
}

/** Runs an operation with synchronous tools. */
export function runOperation<T>(operation: GitOperation<T>, onProgress?: () => void): T {
  let next = operation.next();
  while (!next.done) {
    const step = next.value;
    if (step.kind === 'progress') {
      onProgress?.();
      next = operation.next(undefined);
      continue;
    }

    let result: ToolResult;
    try {
      result = runTool(step.command, step.args, {...step, env: step.env ?? gitEnv(step.cwd)});
    } catch (error) {
      next = operation.throw(error);
      continue;
    }
    next = operation.next(result);
  }
  return next.value;
}

/** A private index copy that git calls in `cwd` read instead of the repo's own. */
type PrivateIndex = {cwd: string; indexFile: string};

type OperationScope = AsyncControl & {privateIndex?: PrivateIndex};

// How long the asynchronous driver may run file loops before it lets timers,
// signal handlers and IPC run.
const EVENT_LOOP_SLICE_MS = 20;

/**
 * Runs an operation with asynchronous tools. Rejects with AbortedError soon
 * after `scope.signal` aborts, killing the tool that is running.
 */
export async function runOperationAsync<T>(operation: GitOperation<T>, scope: OperationScope = {}): Promise<T> {
  const {onProgress, signal, privateIndex} = scope;
  const stop = () => {
    operation.return(undefined as T);
    return new AbortedError();
  };
  let sliceStart = Date.now();

  let next = operation.next();
  while (!next.done) {
    if (signal?.aborted) throw stop();
    const step = next.value;
    if (step.kind === 'progress') {
      onProgress?.();
      if (Date.now() - sliceStart >= EVENT_LOOP_SLICE_MS) {
        await new Promise((resolve) => setImmediate(resolve));
        sliceStart = Date.now();
      }
      next = operation.next(undefined);
      continue;
    }

    const env = step.env ?? gitEnvFor(step.cwd, privateIndex);
    let result: ToolResult;
    try {
      result = await runToolAsync(step.command, step.args, {...step, env}, {onProgress, signal});
    } catch (error) {
      if (error instanceof AbortedError || signal?.aborted) throw stop();
      next = operation.throw(error);
      continue;
    } finally {
      sliceStart = Date.now();
    }
    next = operation.next(result);
  }
  return next.value;
}

// While a private index is active for a repo, every synchronous git call in
// it reads and refreshes a temp copy of the index, so the repo's own
// .git/index is never rewritten. Synchronous code runs to completion, so one
// module-level slot is enough; asynchronous runs carry their own copy in
// their scope instead.
let indexSession: PrivateIndex | null = null;

// Temp dirs holding a private index copy that `finally` has not removed yet.
const liveIndexDirs = new Set<string>();

/**
 * Removes every private index copy still on disk. For an exit hook: a
 * process.exit() or fatal signal ends the process without running the
 * `finally` that normally removes them.
 */
export function removePrivateIndexDirs() {
  for (const dir of liveIndexDirs) {
    fs.rmSync(dir, {recursive: true, force: true});
    liveIndexDirs.delete(dir);
  }
}

function removeIndexDir(dir: string) {
  fs.rmSync(dir, {recursive: true, force: true});
  liveIndexDirs.delete(dir);
}

// Copies the index at `indexPath` into a new temp dir and returns the dir and
// the copy's path.
function copyIndex(indexPath: string) {
  // A parent process that may kill this one passes its own temp dir, so it can
  // remove whatever is left behind. Resolved here: git resolves a relative
  // GIT_INDEX_FILE against the repo, not against this process's directory.
  const parent = path.resolve(process.env.BRANCH_REVIEW_TMPDIR || os.tmpdir());
  const dir = fs.mkdtempSync(path.join(parent, 'branch-review-index-'));
  liveIndexDirs.add(dir);
  const indexFile = path.join(dir, 'index');
  try {
    fs.copyFileSync(indexPath, indexFile);
    // git's racy-clean check compares each entry's mtime with the index
    // file's own mtime: an entry not older than the index has its content
    // re-read instead of trusting a matching stat. A fresh copy gets a new
    // mtime, so a same-size edit made in the same second as the last index
    // write would look unchanged. Carry the mtime over, floored to the
    // second so rounding can only make more entries racy, never fewer.
    const {mtimeMs} = fs.statSync(indexPath);
    const seconds = Math.floor(mtimeMs / 1000);
    fs.utimesSync(indexFile, seconds, seconds);
  } catch (error) {
    // A repo with no commits staged yet has no index; git treats a missing
    // file as an empty index.
    if (errorCode(error) !== 'ENOENT') {
      removeIndexDir(dir);
      throw error;
    }
  }
  return {dir, indexFile};
}

const GIT_INDEX_PATH_ARGS = ['rev-parse', '--git-path', 'index'];

/**
 * Runs `fn` with every git call in `cwd` pointed at a temp copy of the repo's
 * index. Porcelain `git diff` refreshes stat info and writes the index back;
 * with the copy, that write lands in the temp file, which is deleted
 * afterwards. Nested calls for the same repo share one copy.
 */
export function withPrivateIndex<T>(cwd: string, fn: () => T): T {
  if (indexSession?.cwd === cwd) return fn();

  const {dir, indexFile} = copyIndex(path.resolve(cwd, runGitLine(cwd, GIT_INDEX_PATH_ARGS)));
  try {
    const previous = indexSession;
    indexSession = {cwd, indexFile};
    try {
      return fn();
    } finally {
      indexSession = previous;
    }
  } finally {
    removeIndexDir(dir);
  }
}

/** withPrivateIndex for asynchronous runs: `fn` gets a scope that carries the copy. */
async function withPrivateIndexAsync<T>(
  cwd: string,
  control: AsyncControl,
  fn: (scope: OperationScope) => Promise<T>,
): Promise<T> {
  const indexPath = await runOperationAsync(gitLineOperation(cwd, GIT_INDEX_PATH_ARGS), control);
  const {dir, indexFile} = copyIndex(path.resolve(cwd, indexPath));
  try {
    return await fn({...control, privateIndex: {cwd, indexFile}});
  } finally {
    removeIndexDir(dir);
  }
}

function gitEnvFor(cwd: string, privateIndex: PrivateIndex | null | undefined): NodeJS.ProcessEnv {
  return privateIndex?.cwd === cwd
    ? {...process.env, ...GIT_ENV, GIT_INDEX_FILE: privateIndex.indexFile}
    : {...process.env, ...GIT_ENV};
}

function gitEnv(cwd: string): NodeJS.ProcessEnv {
  return gitEnvFor(cwd, indexSession);
}

type RunGitOptions = {
  /** `git diff --no-index` exits 1 when the files differ. */
  allowDiffExit?: boolean;
  maxBuffer?: number;
};

function* gitResultOperation(cwd: string, args: string[], options: RunGitOptions = {}): GitOperation<ToolResult> {
  const result = yield* runToolStep({
    command: 'git',
    args: [...GIT_SAFETY_ARGS, ...args],
    cwd,
    maxBuffer: options.maxBuffer,
  });
  if (result.status === 0) return result;

  // Exit 1 also covers errors such as an unreadable or vanished file, which
  // print error:/fatal: and no patch.
  if (
    options.allowDiffExit
    && result.status === 1
    && result.stdout !== ''
    && !/^(error|fatal):/m.test(result.stderr)
  ) {
    return result;
  }

  const reason = firstLine(result.stderr) || exitReason(result);
  // The full stderr rides along so callers can show git's fatal:/error: line
  // when it is not the first line.
  throw Object.assign(new Error(`git ${args[0]} failed: ${reason}`), {stderr: result.stderr, status: result.status});
}

function runGitResult(cwd: string, args: string[], options: RunGitOptions = {}): ToolResult {
  return runOperation(gitResultOperation(cwd, args, options));
}

function* gitOperation(cwd: string, args: string[], options: RunGitOptions = {}): GitOperation<string> {
  return (yield* gitResultOperation(cwd, args, options)).stdout;
}

function* gitBytesOperation(cwd: string, args: string[]): GitOperation<Buffer> {
  return (yield* gitResultOperation(cwd, args)).stdoutBytes;
}

// Failures that affect every file, so per-file isolation must not swallow them.
export function isFatalToolError(error: unknown) {
  return error instanceof MissingToolError || error instanceof InterruptedError || error instanceof AbortedError;
}

/** For commands that print one value: drops only the final newline. */
function* gitLineOperation(cwd: string, args: string[]): GitOperation<string> {
  return (yield* gitOperation(cwd, args)).replace(/\r?\n$/, '');
}

function* tryGitOperation(cwd: string, args: string[]): GitOperation<string | null> {
  try {
    return yield* gitLineOperation(cwd, args);
  } catch (error) {
    if (isFatalToolError(error)) throw error;
    return null;
  }
}

function runGitLine(cwd: string, args: string[]) {
  return runOperation(gitLineOperation(cwd, args));
}

function* hasRefOperation(cwd: string, ref: string): GitOperation<boolean> {
  return (yield* tryGitOperation(cwd, ['rev-parse', '--verify', '--quiet', ref])) !== null;
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
  /**
   * Set when git listed the name (or a rename's old name) as bytes that are
   * not valid UTF-8. `path` then shows each invalid byte as a `\ooo` octal
   * escape, so it names no real file and the file can't be read or diffed.
   */
  nameError?: string;
};

export const NAME_NOT_UTF8 = 'file name is not UTF-8';

/** The work tree root for `cwd`, with a one-line reason when there is none. */
export function getRepoRoot(cwd: string) {
  const result = runTool('git', [...GIT_SAFETY_ARGS, 'rev-parse', '--show-toplevel'], {cwd, env: gitEnv(cwd)});
  const root = result.status === 0 ? result.stdout.replace(/\r?\n$/, '') : '';
  if (root) return root;

  if (/not a git repository/i.test(result.stderr)) {
    throw new Error(`not a git repository: ${cwd}`);
  }

  throw new Error(`not inside a git work tree: ${firstLine(result.stderr) || cwd}`);
}

function* resolveRefOperation(cwd: string, requested: string): GitOperation<string | null> {
  if (yield* hasRefOperation(cwd, requested)) return requested;
  if (yield* hasRefOperation(cwd, `origin/${requested}`)) return `origin/${requested}`;
  return null;
}

function* inferBaseRefOperation(cwd: string): GitOperation<string> {
  const originHead = yield* tryGitOperation(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (originHead && (yield* hasRefOperation(cwd, originHead))) {
    return originHead;
  }

  for (const candidate of ['development', 'main', 'master', 'trunk']) {
    const resolved = yield* resolveRefOperation(cwd, candidate);
    if (resolved) {
      return resolved;
    }
  }

  const currentBranch = yield* tryGitOperation(cwd, ['branch', '--show-current']);
  if (currentBranch) {
    const resolved = yield* resolveRefOperation(cwd, currentBranch);
    if (resolved) {
      return resolved;
    }
  }

  throw new Error('Could not infer a base ref. Pass one explicitly, for example: branch-review HEAD main');
}

export function inferBaseRef(cwd: string) {
  return runOperation(inferBaseRefOperation(cwd));
}

/** inferBaseRef with asynchronous git calls, cancelled by `control.signal`. */
export function inferBaseRefAsync(cwd: string, control: AsyncControl = {}) {
  return runOperationAsync(inferBaseRefOperation(cwd), control);
}

export function* currentBranchNameOperation(cwd: string): GitOperation<string | null> {
  return (yield* tryGitOperation(cwd, ['branch', '--show-current'])) || null;
}

export function getCurrentBranchName(cwd: string) {
  return runOperation(currentBranchNameOperation(cwd));
}

// `git merge-base` exits 1 with no output when the refs have no common
// ancestor: unrelated branches, or a shallow clone cut above the fork point.
function* mergeBaseOperation(cwd: string, base: string, branch: string): GitOperation<string> {
  try {
    return yield* gitLineOperation(cwd, ['merge-base', base, branch]);
  } catch (error) {
    if ((error as {status?: unknown}).status === 1) {
      throw new Error(`${base} and ${branch} share no history (shallow clone or unrelated branches)`);
    }
    throw error;
  }
}

export function* resolveRefsOperation(cwd: string, requestedBranch: string, requestedBase: string): GitOperation<DiffRange> {
  const base = yield* resolveRefOperation(cwd, requestedBase);
  if (!base) {
    throw new Error(`Base ref not found: ${requestedBase}`);
  }

  if (requestedBranch === 'HEAD') {
    const diffBase = yield* mergeBaseOperation(cwd, base, 'HEAD');
    return {
      base,
      branch: 'HEAD',
      diffArg: diffBase,
      includeWorktree: true,
    };
  }

  const branch = yield* resolveRefOperation(cwd, requestedBranch);
  if (!branch) {
    throw new Error(`Branch ref not found: ${requestedBranch}`);
  }
  // `base...branch` needs a merge base too; without this check git's error
  // would name neither ref.
  yield* mergeBaseOperation(cwd, base, branch);

  return {
    base,
    branch,
    diffArg: `${base}...${branch}`,
    includeWorktree: false,
  };
}

export function resolveRefs(cwd: string, requestedBranch: string, requestedBase: string): DiffRange {
  return runOperation(resolveRefsOperation(cwd, requestedBranch, requestedBase));
}

// The byte length of the UTF-8 sequence a lead byte starts; 0 for a byte no
// valid sequence starts with.
function utf8SequenceLength(lead: number) {
  if (lead < 0x80) return 1;
  if (lead >= 0xC2 && lead <= 0xDF) return 2;
  if (lead >= 0xE0 && lead <= 0xEF) return 3;
  if (lead >= 0xF0 && lead <= 0xF4) return 4;
  return 0;
}

/**
 * A file name from a `-z` listing. A name that is not valid UTF-8 keeps its
 * valid characters and shows each invalid byte as a `\ooo` octal escape, the
 * way git quotes it, so two such names never decode to the same string.
 */
function decodeName(bytes: Buffer): {name: string; utf8: boolean} {
  if (isUtf8(bytes)) return {name: bytes.toString('utf8'), utf8: true};

  let name = '';
  for (let index = 0; index < bytes.length;) {
    const length = utf8SequenceLength(bytes[index]!);
    const sequence = bytes.subarray(index, index + length);
    if (length > 0 && sequence.length === length && isUtf8(sequence)) {
      name += sequence.toString('utf8');
      index += length;
    } else {
      name += `\\${bytes[index]!.toString(8).padStart(3, '0')}`;
      index += 1;
    }
  }
  return {name, utf8: false};
}

function splitNul(output: Buffer) {
  const fields: Buffer[] = [];
  let start = 0;
  for (let end = output.indexOf(0); end >= 0; end = output.indexOf(0, start)) {
    fields.push(output.subarray(start, end));
    start = end + 1;
  }
  fields.push(output.subarray(start));
  return fields;
}

function* untrackedFilesOperation(cwd: string): GitOperation<ChangedFileEntry[]> {
  const output = yield* gitBytesOperation(cwd, ['ls-files', '-z', '--others', '--exclude-standard']);
  return splitNul(output)
    .map(decodeName)
    // A trailing slash marks a nested repository, which has no diff of its own.
    .filter(({name}) => name !== '' && !name.endsWith('/'))
    .map(({name, utf8}) => ({path: name, status: 'untracked' as const, ...(utf8 ? {} : {nameError: NAME_NOT_UTF8})}));
}

export function getUntrackedFiles(cwd: string) {
  return withPrivateIndex(cwd, () => runOperation(untrackedFilesOperation(cwd))).map((entry) => entry.path);
}

export function getChangedFiles(cwd: string, range: DiffRange) {
  return getChangedFileEntries(cwd, range).map((entry) => entry.path);
}

function parseNameStatus(output: Buffer): ChangedFileEntry[] {
  const fields = splitNul(output);
  const entries: ChangedFileEntry[] = [];
  const nameAt = (index: number) => decodeName(fields[index] ?? Buffer.alloc(0));

  for (let index = 0; index < fields.length;) {
    const statusCode = fields[index++]!.toString('latin1');
    if (!statusCode) continue;

    if (statusCode.startsWith('R') || statusCode.startsWith('C')) {
      const oldName = nameAt(index++);
      const nextName = nameAt(index++);
      if (!oldName.name || !nextName.name) break;
      const nameError = oldName.utf8 && nextName.utf8 ? {} : {nameError: NAME_NOT_UTF8};
      // A copy leaves its source in place, so the copy is a new file.
      entries.push(statusCode.startsWith('R')
        ? {path: nextName.name, oldPath: oldName.name, status: 'renamed', ...nameError}
        : {path: nextName.name, status: 'added', ...(nextName.utf8 ? {} : {nameError: NAME_NOT_UTF8})});
      continue;
    }

    const {name: filePath, utf8} = nameAt(index++);
    if (!filePath) break;
    const nameError = utf8 ? {} : {nameError: NAME_NOT_UTF8};

    if (statusCode === 'A') entries.push({path: filePath, status: 'added', ...nameError});
    else if (statusCode === 'D') entries.push({path: filePath, status: 'deleted', ...nameError});
    else entries.push({path: filePath, status: 'modified', ...nameError});
  }

  return entries;
}

/**
 * The changed files of a range, plus the untracked ones on their own: the
 * line counts need every untracked file, even one whose path also has a
 * tracked change.
 */
export type ReviewChanges = {
  entries: ChangedFileEntry[];
  untracked: ChangedFileEntry[];
};

export function* reviewChangesOperation(cwd: string, range: DiffRange): GitOperation<ReviewChanges> {
  const entries = parseNameStatus(
    yield* gitBytesOperation(cwd, ['diff', '--name-status', '-z', ...DIFF_ARGS, ...RENAME_ARGS, range.diffArg, '--']),
  );
  const untracked = range.includeWorktree ? yield* untrackedFilesOperation(cwd) : [];

  const seen = new Set(entries.map((entry) => entry.path));
  for (const entry of untracked) {
    if (!seen.has(entry.path)) {
      entries.push(entry);
      seen.add(entry.path);
    }
  }

  entries.sort((left, right) => left.path.localeCompare(right.path));
  return {entries, untracked};
}

export function getChangedFileEntries(cwd: string, range: DiffRange): ChangedFileEntry[] {
  return withPrivateIndex(cwd, () => runOperation(reviewChangesOperation(cwd, range)).entries);
}

const C_ESCAPES: Record<string, string> = {
  '\x07': '\\a', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\v': '\\v', '\f': '\\f', '\r': '\\r', '"': '\\"', '\\': '\\\\',
};

// A path in a patch header, quoted the way git quotes it with
// core.quotePath=false: only a name holding a quote, a backslash or a control
// character is wrapped in quotes and C-escaped.
function headerPath(prefix: string, filePath: string) {
  const name = `${prefix}${filePath}`;
  if (!/["\\\x00-\x1F\x7F]/.test(name)) return name;
  const escaped = name.replace(/["\\\x00-\x1F\x7F]/g, (char) => (
    C_ESCAPES[char] ?? `\\${char.charCodeAt(0).toString(8).padStart(3, '0')}`
  ));
  return `"${escaped}"`;
}

// `git diff --no-index` can't diff a symlink to a directory (it diffs the
// directory instead), so every untracked symlink gets the patch git prints
// for a link to a file: mode 120000 and the link text as the added lines,
// counted and marked the way git does for any added file.
function untrackedSymlinkPatch(filePath: string, target: Buffer) {
  const blob = createHash('sha1')
    .update(`blob ${target.length}\0`)
    .update(target)
    .digest('hex');
  const header = [
    `diff --git ${headerPath('a/', filePath)} ${headerPath('b/', filePath)}`,
    'new file mode 120000',
    `index 0000000..${blob.slice(0, 7)}`,
  ];
  // Like an empty file, an empty link text has no hunk.
  if (target.length === 0) return [...header, ''].join('\n');

  const text = target.toString('utf8');
  const endsWithNewline = text.endsWith('\n');
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split('\n');
  return [
    ...header,
    '--- /dev/null',
    // Like git, end a name holding a space with a tab, for patch(1).
    `+++ ${headerPath('b/', filePath)}${filePath.includes(' ') ? '\t' : ''}`,
    `@@ -0,0 +${lines.length === 1 ? '1' : `1,${lines.length}`} @@`,
    ...lines.map((line) => `+${line}`),
    ...(endsWithNewline ? [] : ['\\ No newline at end of file']),
    '',
  ].join('\n');
}

function* untrackedFileDiffOperation(cwd: string, filePath: string): GitOperation<{text: string; utf8: boolean}> {
  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(path.join(cwd, filePath));
  } catch {
    // Gone since it was listed: git reports that as the error below.
  }
  if (stat?.isSymbolicLink()) {
    const target = fs.readlinkSync(path.join(cwd, filePath), {encoding: 'buffer'});
    return {text: untrackedSymlinkPatch(filePath, target), utf8: isUtf8(target)};
  }

  // `--no-index` reads a bare `-` from stdin, so that name goes in as `./-`
  // and the header is put back to the plain name.
  const arg = filePath === '-' ? './-' : filePath;
  const result = yield* gitResultOperation(cwd, ['diff', '--no-index', ...DIFF_ARGS, '--', '/dev/null', arg], {allowDiffExit: true});
  if (arg === filePath) return {text: result.stdout, utf8: result.stdoutIsUtf8};

  const hunk = result.stdout.search(/^@@ /m);
  const headerEnd = hunk < 0 ? result.stdout.length : hunk;
  const header = result.stdout.slice(0, headerEnd)
    .replace(/^diff --git a\/\.\/- b\/\.\/-$/m, 'diff --git a/- b/-')
    .replace(/^\+\+\+ b\/\.\/-$/m, '+++ b/-');
  return {text: header + result.stdout.slice(headerEnd), utf8: result.stdoutIsUtf8};
}

/** readRawFileDiff as an operation; the caller provides the private index. */
export function* rawFileDiffOperation(
  cwd: string,
  range: DiffRange,
  filePath: string,
  untrackedFiles?: ReadonlySet<string>,
  oldPath?: string,
): GitOperation<{text: string; utf8: boolean}> {
  const isUntracked = range.includeWorktree && (untrackedFiles?.has(filePath) ?? false);
  if (isUntracked) return yield* untrackedFileDiffOperation(cwd, filePath);

  const paths = oldPath && oldPath !== filePath ? [oldPath, filePath] : [filePath];
  const result = yield* gitResultOperation(cwd, ['diff', ...DIFF_ARGS, ...RENAME_ARGS, range.diffArg, '--', ...paths]);
  return {text: result.stdout, utf8: result.stdoutIsUtf8};
}

/**
 * The exact patch text for one file, trailing newline included, and whether
 * git printed it as valid UTF-8. A renamed file passes its `oldPath` so git
 * pairs both sides of the rename.
 */
export function readRawFileDiff(
  cwd: string,
  range: DiffRange,
  filePath: string,
  untrackedFiles?: ReadonlySet<string>,
  oldPath?: string,
): {text: string; utf8: boolean} {
  return withPrivateIndex(cwd, () => runOperation(rawFileDiffOperation(cwd, range, filePath, untrackedFiles, oldPath)));
}

/** The exact patch text for one file; see readRawFileDiff. */
export function getRawFileDiff(
  cwd: string,
  range: DiffRange,
  filePath: string,
  untrackedFiles?: ReadonlySet<string>,
  oldPath?: string,
) {
  return readRawFileDiff(cwd, range, filePath, untrackedFiles, oldPath).text;
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

function notUtf8(filePath: string) {
  return new Error(`${filePath} is not UTF-8 text`);
}

/**
 * Worktree contents the way git diffs them: a symlink is its link text, and
 * only regular files are read, so a link can't pull in a file from outside the
 * repo and a FIFO or device can't block or stream forever. Contents that are
 * not valid UTF-8 throw rather than come back altered.
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

  const bytes = stat.isSymbolicLink()
    ? fs.readlinkSync(absolutePath, {encoding: 'buffer'})
    : stat.isFile() ? readRegularFile(absolutePath, filePath, MAX_FILE_CONTENT_BYTES) : null;
  if (!bytes) throw new Error(`${filePath} is not a regular file`);
  if (!isUtf8(bytes)) throw notUtf8(filePath);
  return bytes.toString('utf8');
}

/**
 * Full contents of the reviewed version of a file, or null for a deleted
 * file. Throws with a one-line reason when the contents can't be read or are
 * not valid UTF-8.
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
    const result = runGitResult(cwd, ['show', `${range.branch}:${file.path}`], {maxBuffer: MAX_FILE_CONTENT_BYTES});
    if (!result.stdoutIsUtf8) throw notUtf8(file.path);
    return result.stdout;
  } catch (error) {
    if (error instanceof OutputTooLargeError) {
      throw new Error(`${file.path} is larger than ${Math.floor(MAX_FILE_CONTENT_BYTES / MIB)} MB`);
    }
    throw error;
  }
}

export function getFileStat(cwd: string, range: DiffRange, filePath: string) {
  return withPrivateIndex(cwd, () => runOperation(gitOperation(cwd, ['diff', '--stat', ...DIFF_ARGS, ...RENAME_ARGS, range.diffArg, '--', filePath])))
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

function parseNumstat(output: Buffer) {
  const fields = splitNul(output);
  const metrics = new Map<string, FileMetrics>();

  for (let index = 0; index < fields.length;) {
    const field = fields[index++]!;
    if (field.length === 0) continue;

    // The counts are ASCII; only the path after them needs decoding.
    const firstTab = field.indexOf(0x09);
    const secondTab = firstTab < 0 ? -1 : field.indexOf(0x09, firstTab + 1);
    if (secondTab < 0) continue;

    const additions = parseNumstatValue(field.toString('latin1', 0, firstTab));
    const deletions = parseNumstatValue(field.toString('latin1', firstTab + 1, secondTab));
    let filePath = decodeName(field.subarray(secondTab + 1)).name;
    // A rename is `adds\tdels\t` followed by the old and new paths as their
    // own fields; metrics are keyed on the new path.
    if (filePath === '') {
      index += 1;
      filePath = decodeName(fields[index++] ?? Buffer.alloc(0)).name;
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

function errorLine(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] || 'unknown error';
}

// Whole-range numstat fails outright when git can't hash one worktree file
// (an unreadable file, a missing blob in a partial clone). Then each changed
// file is counted on its own, and the ones that fail get an error instead.
function* perFileNumstatOperation(cwd: string, range: DiffRange, entries: readonly ChangedFileEntry[]) {
  const metrics = new Map<string, FileMetrics>();
  const errors = new Map<string, string>();
  for (const entry of entries) {
    // An untracked file is counted below; a name that isn't UTF-8 can't be
    // passed back to git.
    if (entry.status === 'untracked' || entry.nameError !== undefined) continue;
    const paths = entry.oldPath && entry.oldPath !== entry.path ? [entry.oldPath, entry.path] : [entry.path];
    try {
      const output = yield* gitBytesOperation(cwd, ['diff', '--numstat', '-z', ...DIFF_ARGS, ...RENAME_ARGS, range.diffArg, '--', ...paths]);
      for (const [filePath, metric] of parseNumstat(output)) metrics.set(filePath, metric);
    } catch (error) {
      if (isFatalToolError(error)) throw error;
      errors.set(entry.path, errorLine(error));
    }
    yield* progressTick();
  }
  return {metrics, errors};
}

/** Line counts per changed file, and a one-line reason for each file git could not count. */
export type ReviewMetrics = {
  metrics: Map<string, FileMetrics>;
  errors: Map<string, string>;
};

export function* fileMetricsOperation(cwd: string, range: DiffRange, changes: ReviewChanges): GitOperation<ReviewMetrics> {
  let counted: ReviewMetrics;
  try {
    counted = {
      metrics: parseNumstat(yield* gitBytesOperation(cwd, ['diff', '--numstat', '-z', ...DIFF_ARGS, ...RENAME_ARGS, range.diffArg, '--'])),
      errors: new Map(),
    };
  } catch (error) {
    if (isFatalToolError(error)) throw error;
    counted = yield* perFileNumstatOperation(cwd, range, changes.entries);
  }
  const {metrics} = counted;

  for (const entry of changes.untracked) {
    const additions = entry.nameError === undefined ? countUntrackedLines(cwd, entry.path) : 0;
    metrics.set(entry.path, {
      path: entry.path,
      additions,
      deletions: 0,
      changedLines: additions,
    });
    yield* progressTick();
  }

  return counted;
}

/**
 * Line counts for every changed file, plus a one-line reason for each file
 * git could not count.
 */
export function readFileMetrics(cwd: string, range: DiffRange): ReviewMetrics {
  return withPrivateIndex(cwd, () => runOperation((function* () {
    const changes = yield* reviewChangesOperation(cwd, range);
    return yield* fileMetricsOperation(cwd, range, changes);
  })()));
}

export function getFileMetricsMap(cwd: string, range: DiffRange) {
  return readFileMetrics(cwd, range).metrics;
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
// The executable bit is part of it: a chmod changes the file's diff header.
function worktreeFingerprint(cwd: string, filePath: string) {
  const absolutePath = path.join(cwd, filePath);
  try {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) return `link:${fs.readlinkSync(absolutePath, 'utf8')}`;
    if (!stat.isFile()) return `other:${stat.mode}`;
    const kind = stat.mode & 0o111 ? 'exec' : 'file';
    if (stat.size > MAX_FILE_CONTENT_BYTES) return `large-${kind}:${stat.size}:${stat.mtimeMs}`;
    try {
      const contents = readRegularFile(absolutePath, filePath, MAX_FILE_CONTENT_BYTES);
      return `${kind}:${createHash('sha1').update(contents).digest('hex')}`;
    } catch {
      // Unreadable (permissions): its stat still changes when it is written.
      return `unreadable-${kind}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    }
  } catch {
    return 'missing';
  }
}

/**
 * A hash of everything the review shows for the range, from changes and
 * metrics the caller has already read, so a refresh reads them once for both
 * the fingerprint and the build.
 */
export function* reviewFingerprintOperation(
  cwd: string,
  range: DiffRange,
  changes: ReviewChanges,
  {metrics, errors}: ReviewMetrics,
): GitOperation<string> {
  const head = (yield* tryGitOperation(cwd, ['rev-parse', 'HEAD'])) ?? '';
  const raw = yield* gitOperation(cwd, ['diff', '--raw', '-z', ...DIFF_ARGS, ...RENAME_ARGS, range.diffArg, '--']);
  const hash = createHash('sha1');

  hash.update(range.base);
  hash.update('\0');
  hash.update(range.branch);
  hash.update('\0');
  hash.update(head);
  hash.update('\0');
  hash.update(raw);

  for (const entry of changes.entries) {
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
    hash.update(errors.get(entry.path) ?? '');
    hash.update('\0');
    hash.update(range.includeWorktree ? worktreeFingerprint(cwd, entry.path) : statFingerprint(cwd, entry.path));
    yield* progressTick();
  }

  return hash.digest('hex');
}

export function getReviewFingerprint(cwd: string, range: DiffRange) {
  return withPrivateIndex(cwd, () => runOperation((function* () {
    const changes = yield* reviewChangesOperation(cwd, range);
    const metrics = yield* fileMetricsOperation(cwd, range, changes);
    return yield* reviewFingerprintOperation(cwd, range, changes, metrics);
  })()));
}

/**
 * Runs `operation` asynchronously against a private index copy for `cwd`;
 * see withPrivateIndex and runOperationAsync.
 */
export function runWithPrivateIndexAsync<T>(cwd: string, operation: () => GitOperation<T>, control: AsyncControl = {}) {
  return withPrivateIndexAsync(cwd, control, (scope) => runOperationAsync(operation(), scope));
}

/**
 * The one colour-off rule for delta and the app chrome: NO_COLOR set and
 * non-empty, FORCE_COLOR of `0` or `false`, or TERM=dumb.
 */
export function isColorDisabled(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(env.NO_COLOR) || env.FORCE_COLOR === '0' || env.FORCE_COLOR === 'false' || env.TERM === 'dumb';
}

/**
 * Replaces characters a terminal would act on, or that reorder or hide text,
 * with visible markers (^M, ␛, <U+202E>; see controlChars.ts). Tab and
 * newline are kept.
 */
export function makeControlCharsVisible(text: string) {
  return escapeHiddenCharactersInLines(text);
}

const DELTA_LAYOUT_ARGS = [
  '--no-gitconfig',
  '--paging=never',
  // delta cuts lines past 3000 characters by default; the app wraps rows itself.
  '--max-line-length=0',
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

/** renderDiffForDisplay as an operation. */
export function* renderDiffOperation(cwd: string, rawDiff: string, width: number): GitOperation<string> {
  if (rawDiff === '') return '';

  const args = [
    ...DELTA_LAYOUT_ARGS,
    ...(isColorDisabled() ? DELTA_PLAIN_ARGS : DELTA_THEME_ARGS),
    `--width=${Math.max(width, 80)}`,
  ];

  // DELTA_FEATURES would switch on side-by-side, hyperlinks and other layouts
  // the fixed argument list rules out.
  const {DELTA_FEATURES: _features, ...env} = process.env;

  let result: ToolResult;
  try {
    result = yield* runToolStep({command: 'delta', args, cwd, env, input: makeControlCharsVisible(rawDiff)});
  } catch (error) {
    if (error instanceof MissingToolError) {
      throw new MissingToolError('delta not found on PATH. Install git-delta: https://dandavison.github.io/delta/installation.html');
    }
    throw error;
  }

  if (result.status !== 0) {
    throw new Error(`delta failed: ${firstLine(result.stderr) || exitReason(result)}`);
  }

  return result.stdout.trimEnd();
}

/**
 * Renders a raw patch with delta for display. delta runs directly, without a
 * shell, on the patch with control characters made visible. A missing delta
 * throws MissingToolError; a failing one throws with delta's stderr.
 */
export function renderDiffForDisplay(cwd: string, rawDiff: string, width: number) {
  return runOperation(renderDiffOperation(cwd, rawDiff, width));
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
