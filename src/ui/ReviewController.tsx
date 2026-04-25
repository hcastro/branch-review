import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useStdout} from 'ink';
import {getReviewFingerprint, type DiffRange} from '../git.js';
import {buildReviewModel, buildReviewSections} from '../review/build.js';
import type {ReviewModel} from '../review/model.js';
import type {ClipboardWriter} from '../commands/execute.js';
import {createRepoWatcher, type CreateRepoWatcherOptions, type RepoWatcher} from '../watch/repoWatcher.js';
import {App} from './App.js';

type WatchState =
  | {state: 'off'}
  | {state: 'watching'; lastUpdatedAt?: number}
  | {state: 'refreshing'; lastUpdatedAt?: number}
  | {state: 'paused'; message: string; lastUpdatedAt?: number}
  | {state: 'error'; message: string; lastUpdatedAt?: number};

type ReviewBuilder = typeof buildReviewModel;
type WatcherFactory = (options: CreateRepoWatcherOptions) => RepoWatcher;

export type ReviewControllerProps = {
  cwd: string;
  range: DiffRange;
  initialReview: ReviewModel;
  watch: boolean;
  watchPoll?: boolean;
  copyWriter?: ClipboardWriter;
  dimensions?: {columns: number; rows: number};
  initialFingerprint?: string;
  buildReview?: ReviewBuilder;
  createWatcher?: WatcherFactory;
};

function formatError(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message.split('\n')[0] ?? error.message;
  }

  return 'unknown error';
}

export function getModelWidth(columns: number) {
  const leftWidth = Math.max(34, Math.floor(columns * 0.27));
  return Math.max(78, columns - leftWidth - 12);
}

export function formatWatchFooterStatus(status: WatchState, now = Date.now()) {
  if (status.state === 'off') return undefined;
  if (status.state === 'refreshing') return 'refreshing...';
  if (status.state === 'paused') return `watch paused: ${status.message}`;
  if (status.state === 'error') return `watch error: ${status.message}`;
  if (!status.lastUpdatedAt) return 'watching';

  const seconds = Math.max(0, Math.floor((now - status.lastUpdatedAt) / 1000));
  return `watching · updated ${seconds === 0 ? 'now' : `${seconds}s ago`}`;
}

export function ReviewController({
  cwd,
  range,
  initialReview,
  watch,
  watchPoll = false,
  copyWriter,
  dimensions,
  initialFingerprint,
  buildReview = buildReviewModel,
  createWatcher = createRepoWatcher,
}: ReviewControllerProps) {
  const {stdout} = useStdout();
  const columns = dimensions?.columns ?? stdout?.columns ?? 160;
  const modelWidth = getModelWidth(columns);
  const [review, setReview] = useState(initialReview);
  const [watchStatus, setWatchStatus] = useState<WatchState>(watch ? {state: 'watching'} : {state: 'off'});
  const fingerprintRef = useRef<string | null>(initialFingerprint ?? null);
  const refreshInFlightRef = useRef(false);
  const refreshPendingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
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
      setWatchStatus((current) => ({
        state: 'refreshing',
        lastUpdatedAt: 'lastUpdatedAt' in current ? current.lastUpdatedAt : undefined,
      }));

      await new Promise((resolve) => setTimeout(resolve, 0));

      try {
        const nextFingerprint = getReviewFingerprint(cwd, range);
        if (nextFingerprint !== fingerprintRef.current) {
          const nextReview = buildReview({cwd, range, width: modelWidth});
          if (!mountedRef.current) return;
          setReview(nextReview);
          fingerprintRef.current = nextFingerprint;
        }

        if (mountedRef.current) {
          setWatchStatus({state: 'watching', lastUpdatedAt: Date.now()});
        }
      } catch (error) {
        if (mountedRef.current) {
          setWatchStatus({state: 'error', message: formatError(error)});
        }
      } finally {
        refreshInFlightRef.current = false;
        if (refreshPendingRef.current && mountedRef.current) {
          refreshPendingRef.current = false;
          await run();
        }
      }
    };

    void run();
  }, [buildReview, cwd, modelWidth, range, watch]);

  useEffect(() => {
    if (!watch) {
      setWatchStatus({state: 'off'});
      return undefined;
    }

    if (fingerprintRef.current === null) {
      try {
        fingerprintRef.current = getReviewFingerprint(cwd, range);
      } catch {
        fingerprintRef.current = null;
      }
    }

    setWatchStatus((current) => current.state === 'off' ? {state: 'watching'} : current);

    const watcher = createWatcher({
      repoRoot: cwd,
      usePolling: watchPoll,
      onChange: refresh,
      onError: (error) => setWatchStatus({state: 'error', message: formatError(error)}),
    });

    return () => {
      void watcher.close();
    };
  }, [createWatcher, cwd, range, refresh, watch, watchPoll]);

  const sections = useMemo(() => buildReviewSections(review), [review]);
  const footerStatus = formatWatchFooterStatus(watchStatus);

  return (
    <App
      base={range.base}
      branch={review.branch}
      sections={sections}
      branchMetrics={review.metrics}
      review={review}
      copyWriter={copyWriter}
      dimensions={dimensions}
      watchStatus={footerStatus}
      emptyStateHint={watch ? 'Watching for repo updates...' : 'Run again after making changes.'}
    />
  );
}
