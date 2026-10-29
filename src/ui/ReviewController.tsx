import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import path from 'node:path';
import {useStdout} from 'ink';
import {getCurrentBranchName, getReviewFileContents, getReviewFingerprint, type DiffRange} from '../git.js';
import {buildReviewModel, buildReviewSections} from '../review/build.js';
import type {ReviewModel} from '../review/model.js';
import type {ClipboardWriter} from '../commands/execute.js';
import {createRepoWatcher, type CreateRepoWatcherOptions, type RepoWatcher} from '../watch/repoWatcher.js';
import {refreshReviewInWorker} from '../review/workerRefresh.js';
import {debounce} from '../watch/debounce.js';
import {App} from './App.js';

type WatchState =
  | {state: 'off'}
  | {state: 'watching'; lastUpdatedAt?: number}
  | {state: 'refreshing'; lastUpdatedAt?: number}
  | {state: 'paused'; message: string; lastUpdatedAt?: number}
  | {state: 'error'; message: string; lastUpdatedAt?: number};

type ReviewBuilder = typeof buildReviewModel;
type WatcherFactory = (options: CreateRepoWatcherOptions) => RepoWatcher;
type RangeResolver = () => DiffRange;
type WorkerRefresher = typeof refreshReviewInWorker;
const WATCH_UPDATE_STATUS_TIMEOUT_MS = 2200;
// A drag-resize sends a burst of events; rebuild once it stops.
const RESIZE_REBUILD_DELAY_MS = 150;

export type ReviewControllerProps = {
  cwd: string;
  range: DiffRange;
  initialReview: ReviewModel;
  watch: boolean;
  watchPoll?: boolean;
  animations?: boolean;
  copyWriter?: ClipboardWriter;
  dimensions?: {columns: number; rows: number};
  initialFingerprint?: string;
  buildReview?: ReviewBuilder;
  createWatcher?: WatcherFactory;
  resolveRange?: RangeResolver;
  requestedBranch?: string;
  requestedBase?: string;
  refreshInWorker?: WorkerRefresher;
};

function findGitReason(text: string) {
  return text.split('\n').map((line) => line.trim()).find((line) => /^(fatal|error):/.test(line));
}

/**
 * One line for the footer. A failed git call's message starts with
 * `Command failed: git ...`; the useful `fatal:` or `error:` line comes from
 * its stderr, or later in the message.
 */
export function formatRefreshError(error: unknown) {
  if (!(error instanceof Error) || !error.message) return 'unknown error';

  const stderr = (error as {stderr?: unknown}).stderr;
  const stderrText = typeof stderr === 'string' ? stderr : Buffer.isBuffer(stderr) ? stderr.toString('utf8') : '';
  return findGitReason(stderrText)
    ?? findGitReason(error.message)
    ?? error.message.split('\n')[0]
    ?? error.message;
}

type TerminalSize = {columns?: number; rows?: number};

// Ink re-lays out on resize but does not re-render components, so the size
// lives in state to make a resize reach the model width and the App.
function useTerminalSize(stdout: NodeJS.WriteStream | undefined): TerminalSize {
  const [size, setSize] = useState<TerminalSize>({columns: stdout?.columns, rows: stdout?.rows});

  useEffect(() => {
    if (!stdout) return undefined;
    const handleResize = () => setSize({columns: stdout.columns, rows: stdout.rows});
    handleResize();
    stdout.on('resize', handleResize);
    return () => {
      stdout.off('resize', handleResize);
    };
  }, [stdout]);

  return size;
}

export function getModelWidth(columns: number) {
  const leftWidth = Math.max(34, Math.floor(columns * 0.27));
  return Math.max(78, columns - leftWidth - 8);
}

export function formatWatchFooterStatus(status: WatchState, now = Date.now()) {
  if (status.state === 'off') return undefined;
  if (status.state === 'refreshing') return 'refreshing...';
  if (status.state === 'paused') return `watch paused: ${status.message}`;
  if (status.state === 'error') return `watch error: ${status.message}`;
  if (!status.lastUpdatedAt) return undefined;

  const elapsed = Math.max(0, now - status.lastUpdatedAt);
  if (elapsed >= WATCH_UPDATE_STATUS_TIMEOUT_MS) return undefined;

  const seconds = Math.floor(elapsed / 1000);
  return `updated ${seconds === 0 ? 'now' : `${seconds}s ago`}`;
}

export function ReviewController({
  cwd,
  range,
  initialReview,
  watch,
  watchPoll = false,
  animations = true,
  copyWriter,
  dimensions,
  initialFingerprint,
  buildReview = buildReviewModel,
  createWatcher = createRepoWatcher,
  resolveRange,
  requestedBranch,
  requestedBase,
  refreshInWorker = refreshReviewInWorker,
}: ReviewControllerProps) {
  const {stdout} = useStdout();
  const terminalSize = useTerminalSize(stdout);
  const columns = dimensions?.columns ?? terminalSize.columns ?? 160;
  const modelWidth = getModelWidth(columns);
  const [review, setReview] = useState(initialReview);
  const [activeRange, setActiveRange] = useState(range);
  const [watchStatus, setWatchStatus] = useState<WatchState>(watch ? {state: 'watching'} : {state: 'off'});
  // Watcher errors stay up until the watcher is recreated: the watcher keeps the
  // rest of the tree watched, so a later good refresh does not mean coverage
  // is back.
  const [watcherError, setWatcherError] = useState<string | null>(null);
  const [worktreeBranchName, setWorktreeBranchName] = useState(() => getCurrentBranchName(cwd) ?? undefined);
  const fingerprintRef = useRef<string | null>(initialFingerprint ?? null);
  const builtWidthRef = useRef(modelWidth);
  const forceRebuildRef = useRef(false);
  const refreshInFlightRef = useRef(false);
  const refreshPendingRef = useRef(false);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  // Read through a ref so a resize or a new callback prop does not recreate
  // the watcher, which would drop changes it had not reported yet.
  const latestRef = useRef({buildReview, modelWidth, range, refreshInWorker, requestedBase, requestedBranch, resolveRange});
  latestRef.current = {buildReview, modelWidth, range, refreshInWorker, requestedBase, requestedBranch, resolveRange};

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      refreshAbortRef.current?.abort();
    };
  }, []);

  const refresh = useCallback(() => {
    if (!watch) return;

    if (refreshInFlightRef.current) {
      refreshPendingRef.current = true;
      return;
    }

    const run = async (): Promise<void> => {
      refreshInFlightRef.current = true;
      // Registered before the yield below, so an unmount during it aborts
      // this run before anything is started.
      const abort = new AbortController();
      refreshAbortRef.current = abort;
      setWatchStatus((current) => ({
        state: 'refreshing',
        lastUpdatedAt: 'lastUpdatedAt' in current ? current.lastUpdatedAt : undefined,
      }));

      await new Promise((resolve) => setTimeout(resolve, 0));
      if (abort.signal.aborted || !mountedRef.current) {
        if (refreshAbortRef.current === abort) refreshAbortRef.current = null;
        refreshInFlightRef.current = false;
        return;
      }

      const latest = latestRef.current;
      const width = latest.modelWidth;
      const forceRebuild = forceRebuildRef.current;
      forceRebuildRef.current = false;
      const previousFingerprint = forceRebuild ? null : fingerprintRef.current;

      try {
        // The app always passes both refs and never a builder, so it always
        // refreshes in the worker. The synchronous path below (fingerprint
        // and build in this process) exists only for tests that inject
        // `buildReview`.
        const workerRefreshAvailable = latest.requestedBranch
          && latest.requestedBase
          && latest.buildReview === buildReviewModel;
        const next = workerRefreshAvailable
          ? await latest.refreshInWorker({
            cwd,
            requestedBranch: latest.requestedBranch!,
            requestedBase: latest.requestedBase!,
            width,
            previousFingerprint,
            signal: abort.signal,
          })
          : null;
        const nextRange = next?.range ?? latest.resolveRange?.() ?? latest.range;
        // Fingerprint before building: a change that lands mid-build then
        // shows up as a new fingerprint on the next refresh.
        const nextFingerprint = next?.fingerprint ?? getReviewFingerprint(cwd, nextRange);
        if (nextFingerprint !== previousFingerprint) {
          const nextReview = next?.review ?? latest.buildReview({cwd, range: nextRange, width});
          if (!mountedRef.current) return;
          setReview(nextReview);
          setActiveRange(nextRange);
          fingerprintRef.current = nextFingerprint;
          builtWidthRef.current = width;
        }

        if (mountedRef.current) {
          setWorktreeBranchName((next ? next.branchName : getCurrentBranchName(cwd)) ?? undefined);
          setWatchStatus({state: 'watching', lastUpdatedAt: Date.now()});
        }
      } catch (error) {
        if (forceRebuild) forceRebuildRef.current = true;
        if (mountedRef.current && !abort.signal.aborted) {
          setWatchStatus({state: 'error', message: formatRefreshError(error)});
        }
      } finally {
        if (refreshAbortRef.current === abort) refreshAbortRef.current = null;
        refreshInFlightRef.current = false;
        if (refreshPendingRef.current && mountedRef.current) {
          refreshPendingRef.current = false;
          await run();
        }
      }
    };

    void run();
  }, [cwd, watch]);

  useEffect(() => {
    if (!watch) {
      setWatchStatus({state: 'off'});
      return undefined;
    }

    setWatchStatus((current) => current.state === 'off' ? {state: 'watching'} : current);
    setWatcherError(null);

    const watcher = createWatcher({
      repoRoot: cwd,
      usePolling: watchPoll,
      onChange: refresh,
      // Changes made before the watcher was listening produce no event, so
      // catch up once it is.
      onReady: refresh,
      onError: (error) => {
        if (mountedRef.current) setWatcherError(formatRefreshError(error));
      },
    });

    return () => {
      void watcher.close();
    };
  }, [createWatcher, cwd, refresh, watch, watchPoll]);

  const rebuildForWidth = useMemo(() => debounce(() => {
    if (latestRef.current.modelWidth === builtWidthRef.current) return;
    forceRebuildRef.current = true;
    refresh();
  }, RESIZE_REBUILD_DELAY_MS), [refresh]);

  useEffect(() => {
    if (watch && modelWidth !== builtWidthRef.current) rebuildForWidth();
    return undefined;
  }, [modelWidth, rebuildForWidth, watch]);

  useEffect(() => () => rebuildForWidth.cancel(), [rebuildForWidth]);

  useEffect(() => {
    if (watchStatus.state !== 'watching' || !watchStatus.lastUpdatedAt) return undefined;

    const lastUpdatedAt = watchStatus.lastUpdatedAt;
    const timeout = setTimeout(() => {
      setWatchStatus((current) => (
        current.state === 'watching' && current.lastUpdatedAt === lastUpdatedAt
          ? {state: 'watching'}
          : current
      ));
    }, WATCH_UPDATE_STATUS_TIMEOUT_MS);

    return () => clearTimeout(timeout);
  }, [watchStatus]);

  const sections = useMemo(() => buildReviewSections(review), [review]);
  const footerStatus = watcherError && watchStatus.state === 'watching'
    ? `watch error: ${watcherError}`
    : formatWatchFooterStatus(watchStatus);

  return (
    <App
      base={activeRange.base}
      branch={review.branch}
      sections={sections}
      branchMetrics={review.metrics}
      review={review}
      copyWriter={copyWriter}
      readFileContent={(file) => getReviewFileContents(cwd, activeRange, file)}
      resolveAbsolutePath={(file) => path.resolve(cwd, file.path)}
      repoRoot={cwd}
      worktreeBranchName={activeRange.includeWorktree ? worktreeBranchName : undefined}
      dimensions={dimensions}
      watchStatus={footerStatus}
      emptyStateHint={watch ? 'Watching for repo updates...' : 'Run again after making changes.'}
      animations={animations}
    />
  );
}
