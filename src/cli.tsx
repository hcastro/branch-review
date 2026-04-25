import React from 'react';
import {EventEmitter} from 'node:events';
import {render} from 'ink';
import {App} from './ui/App.js';
import {buildDiffSections} from './sections.js';
import {
  inferBaseRef,
  resolveRefs,
} from './git.js';
import {buildReviewModel} from './review/build.js';

EventEmitter.defaultMaxListeners = 100;

const cwd = process.cwd();
const requestedBranch = process.argv[2] ?? 'HEAD';
const requestedBase = process.argv[3] ?? inferBaseRef(cwd);
const range = resolveRefs(cwd, requestedBranch, requestedBase);

const terminalWidth = process.stdout.columns ?? 160;
const leftWidth = Math.max(34, Math.floor(terminalWidth * 0.27));
const rightWidth = Math.max(78, terminalWidth - leftWidth - 12);
const review = buildReviewModel({cwd, range, width: rightWidth});

if (review.files.length === 0) {
  console.log(`No file changes between ${range.base} and ${range.branch}.`);
  process.exit(0);
}

const sections = buildDiffSections(
  review.files.map((file) => ({
    path: file.path,
    metrics: file.metrics,
    diff: file.renderedLines.join('\n'),
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
    branch={review.branch}
    sections={sections}
    branchMetrics={review.metrics}
    review={review}
  />,
);

instance.waitUntilExit().finally(exitAltScreen);
