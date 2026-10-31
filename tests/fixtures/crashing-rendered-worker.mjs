// A stand-in rendered worker that dies on every fragment the way a broken
// install does: an error naming a path under the home dir on stderr, then a
// stack line, then exit 1. It answers a page with the page's content as
// JSON, so a test can read what the UI put on the page.
import os from 'node:os';

const summary = {kind: 'failed', changes: {changed: 0, removed: 0}, differences: [], blocks: [], headings: [], links: [], assets: ''};

process.on('message', (message) => {
  if (message.type === 'page') {
    process.send({id: message.id, ok: true, html: `<pre>${JSON.stringify(message.content)}</pre>`, summary});
    return;
  }
  const stack = `Error: ENOENT: no such file or directory, open '${os.homedir()}/Projects/secret/notes.md'\n    at Object.openSync (node:fs:573:3)\n`;
  process.stderr.write(stack, () => process.exit(1));
});
process.on('disconnect', () => process.exit(0));
