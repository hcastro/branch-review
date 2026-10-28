import type {CliOptions} from './cliArgs.js';
import {getRepoRoot, getReviewFingerprint, inferBaseRef, resolveRefs} from './git.js';
import {buildReviewModel} from './review/build.js';

type PrepareStartupOptions = {
  /** Where the CLI was started; any directory inside the work tree. */
  cwd: string;
  options: CliOptions;
  width: number;
  buildReview?: typeof buildReviewModel;
};

/**
 * Resolves the repo and range and builds the first review. Throws with a
 * one-line message when there is no repo, no git, or no such ref.
 */
export function prepareStartup({cwd: startDir, options, width, buildReview = buildReviewModel}: PrepareStartupOptions) {
  // git reports paths relative to the work tree root, so every git call, file
  // read, watcher and worker runs there, whichever subdirectory we started in.
  const cwd = getRepoRoot(startDir);
  const requestedBranch = options.requestedBranch;
  const requestedBase = options.requestedBase ?? inferBaseRef(cwd);
  const resolveRange = () => resolveRefs(cwd, requestedBranch, requestedBase);
  const range = resolveRange();

  // Taken before the build: a write that lands during the build then makes the
  // first watch refresh see a changed fingerprint and rebuild, instead of
  // skipping as unchanged while the view misses the write.
  const initialFingerprint = options.watch ? getReviewFingerprint(cwd, range) : undefined;
  const review = buildReview({cwd, range, width});

  return {cwd, range, resolveRange, review, initialFingerprint, requestedBranch, requestedBase};
}
