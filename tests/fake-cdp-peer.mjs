// A stand-in for Chromium on --remote-debugging-pipe, for the CDP and
// browser tests: it reads NUL-terminated JSON commands on fd 3 and writes
// answers and events on fd 4, as Chromium does, and never touches the
// network or the screen. FAKE_CDP_MODE picks a behavior, FAKE_CDP_LOG
// names a file that gets one JSON line per command (and the argv first).
import fs from 'node:fs';

const mode = process.env.FAKE_CDP_MODE ?? 'browser';
const log = process.env.FAKE_CDP_LOG;
const input = fs.createReadStream(null, {fd: 3, encoding: 'utf8'});
const output = fs.createWriteStream(null, {fd: 4});
const record = (entry) => {
  if (log) fs.appendFileSync(log, `${JSON.stringify(entry)}\n`);
};
record({argv: process.argv.slice(2)});

// A 1 by 1 transparent PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

// Writes one message, a few bytes at a time in `echo` mode, so the reader
// must join chunks.
function send(message) {
  const text = `${JSON.stringify(message)}\0`;
  if (mode !== 'echo') {
    output.write(text);
    return;
  }
  for (let at = 0; at < text.length; at += 3) output.write(text.slice(at, at + 3));
}

const strings = ['#document', 'HTML', 'BODY', 'P', 'data-block', 'b-1', 'data-lines', '3-4', 'data-mark', 'added', 'A', 'href', 'f-123.html#user-content-x', 'DETAILS', 'class', 'br-removed', 'H2', 'id', 'user-content-intro', 'anchor', '#user-content-intro'];
const s = (text) => strings.indexOf(text);
const SNAPSHOT = {
  strings,
  documents: [{
    nodes: {
      nodeName: [s('#document'), s('HTML'), s('BODY'), s('H2'), s('A'), s('P'), s('A'), s('DETAILS')],
      attributes: [[], [], [], [s('id'), s('user-content-intro')], [s('class'), s('anchor'), s('href'), s('#user-content-intro')], [s('data-block'), s('b-1'), s('data-lines'), s('3-4'), s('data-mark'), s('added')], [s('href'), s('f-123.html#user-content-x')], [s('class'), s('br-removed')]],
    },
    layout: {
      nodeIndex: [1, 2, 3, 4, 5, 6, 7],
      bounds: [[0, 0, 980, 600], [0, 0, 980, 600], [16, 20, 900, 30], [0, 24, 16, 16], [16, 80, 900, 48], [40, 80, 60, 20], [16, 200, 900, 22]],
    },
  }],
};

let buffer = '';
let session = 0;
input.on('data', (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf('\0'); at >= 0; at = buffer.indexOf('\0')) {
    const message = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    record({method: message.method, params: message.params, sessionId: message.sessionId});
    answer(message);
  }
});
input.on('end', () => process.exit(0));

function answer({id, method, params, sessionId}) {
  if (mode === `crash:${method}`) process.exit(3);
  if (mode === `hang:${method}`) return;
  if (mode === 'echo') {
    if (method === 'Test.event') send({method: 'Test.happened', params: {value: params.value}, sessionId: 'S1'});
    if (method === 'Test.fail') {
      send({id, error: {code: -32000, message: 'No such thing\nsecond line'}});
      return;
    }
    send({id, result: {method, params}});
    return;
  }
  const result = {
    'Target.createTarget': () => ({targetId: 'T1'}),
    'Target.attachToTarget': () => ({sessionId: `S${(session += 1)}`}),
    'Page.getFrameTree': () => ({frameTree: {frame: {id: 'F1'}}}),
    'Page.getLayoutMetrics': () => ({cssContentSize: {x: 0, y: 0, width: 980, height: 1234.5}}),
    'DOMSnapshot.captureSnapshot': () => SNAPSHOT,
    'Page.captureScreenshot': () => ({data: PNG}),
  }[method]?.() ?? {};
  send({id, result});
  // A blank page loads at once.
  if (method === 'Page.navigate') send({method: 'Page.loadEventFired', params: {}, sessionId});
  if (method === 'Page.setDocumentContent') {
    // A remote request the page made, which the browser must fail.
    send({method: 'Fetch.requestPaused', params: {requestId: 'R1', request: {url: 'https://example.com/x.png'}}, sessionId});
    send({method: 'Page.loadEventFired', params: {}, sessionId});
  }
}
