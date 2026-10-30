// A stand-in media worker whose answers a test picks by file name. It logs
// its start (pid and TMPDIR) and every job it receives, so a test can see
// which jobs were in flight in which process. A side path starting with
// `answer` is answered at once; anything else is never answered.
import fs from 'node:fs';
import path from 'node:path';

const log = path.join(process.env.BRANCH_REVIEW_MEDIA_TMP, 'scripted.log');
const write = (entry) => fs.appendFileSync(log, `${JSON.stringify({at: Date.now(), pid: process.pid, ...entry})}\n`);
write({event: 'start', tmpdir: process.env.TMPDIR});

process.on('message', (message) => {
  const file = message.side?.path ?? message.sides?.[0]?.path ?? '';
  write({event: 'job', id: message.id, type: message.type, path: file});
  if (file.startsWith('answer')) process.send({id: message.id, ok: false, state: 'error', reason: `answered ${file}`});
});
process.on('disconnect', () => process.exit(0));
