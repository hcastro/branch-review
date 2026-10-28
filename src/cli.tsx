import React from 'react';
import {EventEmitter} from 'node:events';
import {render} from 'ink';
import {parseCliArgs} from './cliArgs.js';
import {ReviewController, getModelWidth} from './ui/ReviewController.js';
import {prepareStartup} from './startup.js';
import {createTerminalSession, runInkApp} from './terminalSession.js';

EventEmitter.defaultMaxListeners = 100;

const options = parseCliArgs(process.argv.slice(2), {interactive: Boolean(process.stdout.isTTY)});
const terminalWidth = process.stdout.columns ?? 160;

let startup: ReturnType<typeof prepareStartup>;
try {
  startup = prepareStartup({cwd: process.cwd(), options, width: getModelWidth(terminalWidth)});
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`branch-review: ${message.split('\n')[0] || 'unknown error'}\n`);
  process.exit(1);
}

const {cwd, range, resolveRange, review, initialFingerprint, requestedBranch, requestedBase} = startup;

if (!options.watch && review.files.length === 0) {
  console.log(`No file changes between ${range.base} and ${range.branch}.`);
  process.exit(0);
}

const session = createTerminalSession({stdout: process.stdout, stderr: process.stderr});
session.install();

void runInkApp(session, () => render(
  <ReviewController
    cwd={cwd}
    range={range}
    resolveRange={resolveRange}
    initialReview={review}
    initialFingerprint={initialFingerprint}
    watch={options.watch}
    watchPoll={options.watchPoll}
    animations={options.animations}
    requestedBranch={requestedBranch}
    requestedBase={requestedBase}
  />,
));
