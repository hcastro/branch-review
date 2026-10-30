// Replies to the startup queries (detect.ts) that arrive after detection
// stopped listening reach the app as input. Ink strips a leading ESC, so a
// whole reply shows up as `_Gi=31;OK…`, `[?62;22c` and so on; a reply split
// after its ESC shows up as a lone Esc, which would quit, then the rest. A
// reply cut anywhere else, as the app took stdin or between two reads later,
// ends in a tail of its own, such as `c` from `ESC[?62;22` + `c`, which would
// run that key.

const ONE_REPLY = String.raw`(?:_G[^\x1B]*\x1B\\|\[\?[\d;]*c|P>\|[^\x1B]*\x1B\\|\[[46];\d+;\d+t)`;
const REPLIES = new RegExp(String.raw`^\x1B?${ONE_REPLY}(?:\x1B${ONE_REPLY})*$`);
// How a reply continues after its ESC.
const REPLY_REST = /^(?:_G|\[|P)/;
// Whole replies, then the start of one that has not finished arriving.
const UNFINISHED = new RegExp(String.raw`^(?:\x1B${ONE_REPLY})*\x1B(?:_G[^\x1B]*\x1B?|P(?:>(?:\|[^\x1B]*\x1B?)?)?|\[(?:\?[\d;]*|>|[46](?:;\d*){0,2})?)?$`);
const ESC = '\x1B';
// Long enough for the rest of a split reply to follow its ESC, short enough
// that Esc still feels instant.
const ESCAPE_DEFER_MS = 60;

/** True when `input` is one or more complete terminal replies and no keys. */
export function isTerminalReply(input: string) {
  return REPLIES.test(input);
}

// What Ink reports as the input for a chunk holding only `keys`: the text,
// or the text less the leading ESC Ink strips; nothing for a named key such
// as an arrow, Return or Esc; the letter for one control character.
function inputsFor(keys: string) {
  const inputs = new Set([keys]);
  if (keys.startsWith(ESC)) inputs.add(keys.slice(1));
  if (/^[\x00-\x1F\x7F]/.test(keys)) inputs.add('');
  const code = keys.length === 1 ? keys.charCodeAt(0) : 0;
  if (code >= 1 && code <= 26) inputs.add(String.fromCharCode(code + 96));
  return inputs;
}

/**
 * Drops whole replies at any time. After a detection that timed out, it also
 * holds a lone Esc for a moment: when the next input continues a reply, the
 * Esc was its first byte and nothing quits. Given `replyHead`, the start of a
 * reply detection saw cut off, it drops inputs for as long as they continue
 * that reply, and an input that starts a reply without finishing it becomes
 * such a head too. Detection pushes the keys typed during its window back
 * ahead of that reply's rest, so when `keysBeforeReply` names them, the
 * first input is checked as those keys and leaves the head for the input
 * after. Outside the armed window only whole replies are dropped.
 */
export function createLoneEscapeGuard(opts: {
  armedUntil: number;
  now: () => number;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
  replyHead?: string;
  keysBeforeReply?: string;
}) {
  let pending: ReturnType<typeof setTimeout> | null = null;
  let head = opts.replyHead ?? '';
  let keysFirst = head && opts.keysBeforeReply ? inputsFor(opts.keysBeforeReply) : null;

  return {
    onInput(input: string, key: {escape: boolean}, quit: () => void): 'handled' | 'pass' {
      // When the first input is more than those keys, the reply's rest came
      // joined on, and it is checked against the head as a whole below.
      const typedEarlier = keysFirst?.has(input) ?? false;
      keysFirst = null;
      if (head && !typedEarlier) {
        const before = head;
        head = '';
        if (opts.now() < opts.armedUntil) {
          // Ink strips an input's leading ESC and reports a lone ESC as an
          // empty Esc key, so the rest may have lost one.
          const rests = key.escape && input === '' ? [ESC] : [input, ESC + input];
          const joined = rests.map((rest) => before + rest);
          if (joined.some(isTerminalReply)) return 'handled';
          const longer = joined.find((text) => UNFINISHED.test(text));
          if (longer !== undefined) {
            head = longer;
            return 'handled';
          }
        }
      }

      if (pending !== null) {
        opts.clearTimer(pending);
        pending = null;
        if (REPLY_REST.test(input)) {
          // The rest can itself stop short of the reply's end.
          if (UNFINISHED.test(ESC + input)) head = ESC + input;
          return 'handled';
        }
        // A real Esc followed by another key: the Esc still quits.
        quit();
        return 'handled';
      }

      if (opts.now() < opts.armedUntil) {
        if (key.escape && input === '') {
          pending = opts.setTimer(() => {
            pending = null;
            quit();
          }, ESCAPE_DEFER_MS);
          return 'handled';
        }
        // A reply that arrives in two reads: the first, its ESC stripped by
        // Ink, is held so the second is dropped. One character is a key
        // (`[` moves the block focus); a reply cut that early leaves a tail
        // of several characters, which no key binding matches.
        if (input.length > 1 && UNFINISHED.test(ESC + input)) {
          head = ESC + input;
          return 'handled';
        }
      }

      return isTerminalReply(input) ? 'handled' : 'pass';
    },
    dispose() {
      if (pending !== null) opts.clearTimer(pending);
      pending = null;
    },
  };
}
