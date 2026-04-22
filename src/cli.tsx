import React from 'react';
import {EventEmitter} from 'node:events';
import {render} from 'ink';
import {App} from './ui/App.js';
import {buildDiffSections} from './sections.js';
import {
  getBranchMetrics,
  getChangedFiles,
  getColoredFileDiff,
  getFileMetricsMap,
  getUntrackedFiles,
  resolveRefs,
} from './git.js';

EventEmitter.defaultMaxListeners = 100;

const cwd = process.cwd();
const requestedBranch = process.argv[2] ?? 'HEAD';
const requestedBase = process.argv[3] ?? 'development';
const range = resolveRefs(cwd, requestedBranch, requestedBase);
const files = getChangedFiles(cwd, range);

if (files.length === 0) {
  console.log(`No file changes between ${range.base} and ${range.branch}.`);
  process.exit(0);
}

const terminalWidth = process.stdout.columns ?? 160;
const leftWidth = Math.max(34, Math.floor(terminalWidth * 0.27));
const rightWidth = Math.max(78, terminalWidth - leftWidth - 12);
const metricsMap = getFileMetricsMap(cwd, range);
const branchMetrics = getBranchMetrics(cwd, range);
const untrackedSet = range.includeWorktree ? new Set(getUntrackedFiles(cwd)) : undefined;
const branchLabel = range.includeWorktree ? `${range.branch} + worktree` : range.branch;
const sections = buildDiffSections(
  files.map((filePath) => ({
    path: filePath,
    metrics: metricsMap.get(filePath) ?? {
      path: filePath,
      additions: 0,
      deletions: 0,
      changedLines: 0,
    },
    diff: getColoredFileDiff(cwd, range, filePath, rightWidth, untrackedSet),
  })),
);

const useAltScreen = Boolean(process.stdout.isTTY);
let altScreenActive = false;
const enterAltScreen = () => {
  if (useAltScreen && !altScreenActive) {
    process.stdout.write('[?1049h[H');
    altScreenActive = true;
  }
};
const exitAltScreen = () => {
  if (altScreenActive) {
    process.stdout.write('[?1049l');
    altScreenActive = false;
  }
};

enterAltScreen();
process.on('exit', exitAltScreen);
process.on('SIGINT', () => {
  exitAltScreen();
  process.exit(130);
});
process.on('SIGTERM', () => {
  exitAltScreen();
  process.exit(143);
});

const instance = render(
  <App
    base={range.base}
    branch={branchLabel}
    sections={sections}
    branchMetrics={branchMetrics}
  />,
);

instance.waitUntilExit().finally(exitAltScreen);
