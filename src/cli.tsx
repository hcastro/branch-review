import React from 'react';
import {EventEmitter} from 'node:events';
import {render} from 'ink';
import {parseCliArgs} from './cliArgs.js';
import {ReviewController, getModelWidth} from './ui/ReviewController.js';
import {
  inferBaseRef,
  getReviewFingerprint,
  resolveRefs,
} from './git.js';
import {buildReviewModel} from './review/build.js';

EventEmitter.defaultMaxListeners = 100;

const cwd = process.cwd();
const options = parseCliArgs(process.argv.slice(2), {interactive: Boolean(process.stdout.isTTY)});
const requestedBranch = options.requestedBranch;
const requestedBase = options.requestedBase ?? inferBaseRef(cwd);
const resolveCurrentRange = () => resolveRefs(cwd, requestedBranch, requestedBase);
const range = resolveCurrentRange();

const terminalWidth = process.stdout.columns ?? 160;
const review = buildReviewModel({cwd, range, width: getModelWidth(terminalWidth)});

if (!options.watch && review.files.length === 0) {
  console.log(`No file changes between ${range.base} and ${range.branch}.`);
  process.exit(0);
}

const initialFingerprint = options.watch ? getReviewFingerprint(cwd, range) : undefined;

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
  <ReviewController
    cwd={cwd}
    range={range}
    resolveRange={resolveCurrentRange}
    initialReview={review}
    initialFingerprint={initialFingerprint}
    watch={options.watch}
    watchPoll={options.watchPoll}
  />,
);

instance.waitUntilExit().finally(exitAltScreen);
