import {EventEmitter} from 'node:events';
import {render} from 'ink';
import {runCli} from './startup.js';

EventEmitter.defaultMaxListeners = 100;

void runCli({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  proc: process,
  stdout: process.stdout,
  stderr: process.stderr,
  render: (tree, options) => render(tree, options),
});
