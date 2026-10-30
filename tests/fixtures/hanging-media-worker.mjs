// A stand-in media worker that never answers. It starts a long sleep in its
// own process group, as the real worker starts git, and logs both pids so a
// test can check that killing the group ended them.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

const child = spawn('/bin/sleep', ['30'], {stdio: 'ignore'});
const log = path.join(process.env.BRANCH_REVIEW_MEDIA_TMP, 'hanging.log');
fs.appendFileSync(log, `${JSON.stringify({at: Date.now(), pid: process.pid, childPid: child.pid})}\n`);

process.on('message', () => {
  if (process.env.HANGING_WORKER_EXIT === '1') process.exit(3);
});
process.on('disconnect', () => process.exit(0));
