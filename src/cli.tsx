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
  resolveRefs,
} from './git.js';

EventEmitter.defaultMaxListeners = 100;

const cwd = process.cwd();
const requestedBranch = process.argv[2] ?? 'HEAD';
const requestedBase = process.argv[3] ?? 'development';
const refs = resolveRefs(cwd, requestedBranch, requestedBase);
const files = getChangedFiles(cwd, refs.base, refs.branch);

if (files.length === 0) {
  console.log(`No file changes between ${refs.base} and ${refs.branch}.`);
  process.exit(0);
}

const terminalWidth = process.stdout.columns ?? 160;
const leftWidth = Math.max(34, Math.floor(terminalWidth * 0.27));
const rightWidth = Math.max(78, terminalWidth - leftWidth - 12);
const metricsMap = getFileMetricsMap(cwd, refs.base, refs.branch);
const branchMetrics = getBranchMetrics(cwd, refs.base, refs.branch);
const sections = buildDiffSections(
  files.map((filePath) => ({
    path: filePath,
    metrics: metricsMap.get(filePath) ?? {
      path: filePath,
      additions: 0,
      deletions: 0,
      changedLines: 0,
    },
    diff: getColoredFileDiff(cwd, refs.base, refs.branch, filePath, rightWidth),
  })),
);

render(
  <App
    base={refs.base}
    branch={refs.branch}
    sections={sections}
    branchMetrics={branchMetrics}
  />,
);
