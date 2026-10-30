import os from 'node:os';
import React from 'react';
import {describe, expect, it} from 'vitest';
import {createLoneEscapeGuard, isTerminalReply} from '../src/media/replyGuard.js';
import {NO_GRAPHICS, type GraphicsCaps} from '../src/media/types.js';
import {ReviewController} from '../src/ui/ReviewController.js';
import {binaryMediaFile, buildFixture, flush, frameLines, multiBlockFile, renderSized, appElement, recordingWriter, svgSourceFile, type AppFixtureProps} from './ui-fixtures.js';

// Terminal replies to the startup queries can arrive after detection gave up
// on them, and then reach the app as keys. A whole reply must do nothing, and
// a reply split after its ESC must not read as the Esc key and quit.

const ESC = '\x1B';
const REPLIES = [
  `${ESC}_Gi=31;OK${ESC}\\`,
  `${ESC}_Gi=31;EINVAL:bad${ESC}\\`,
  `${ESC}[?62;22c`,
  `${ESC}[?1;2c`,
  `${ESC}P>|kitty(0.35.2)${ESC}\\`,
  `${ESC}[6;20;10t`,
  `${ESC}[4;800;1200t`,
];
const TIMED_OUT: GraphicsCaps = {...NO_GRAPHICS, detectionTimedOut: true};

function fixture(graphics?: GraphicsCaps): AppFixtureProps {
  return {...buildFixture([multiBlockFile('src/one.ts', [1, 20], 6), multiBlockFile('src/two.ts', [1], 4)]), ...(graphics ? {graphics} : {})};
}

function start(props: AppFixtureProps, copies: string[] = []) {
  const instance = renderSized(appElement(props, {columns: 120, rows: 30}, recordingWriter(copies)));
  const state = {exited: false};
  void instance.waitUntilExit().then(() => {
    state.exited = true;
  });
  return {instance, state};
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('isTerminalReply', () => {
  it('matches each reply, with or without the ESC that Ink strips, and runs of them', () => {
    for (const reply of REPLIES) {
      expect(isTerminalReply(reply), JSON.stringify(reply)).toBe(true);
      expect(isTerminalReply(reply.slice(1)), JSON.stringify(reply.slice(1))).toBe(true);
    }
    expect(isTerminalReply(`[?62;22c${ESC}[6;20;10t`)).toBe(true);
  });

  it('does not match keys', () => {
    for (const key of ['q', 'j', '[', ']', 'P', '_', '', `${ESC}[A`, '[A', `${ESC}`, '[6;20t', 'G']) {
      expect(isTerminalReply(key), JSON.stringify(key)).toBe(false);
    }
  });
});

describe('createLoneEscapeGuard with the start of a cut-off reply', () => {
  const guard = (replyHead: string, armedUntil = Infinity, keysBeforeReply?: string) => {
    const quits: string[] = [];
    const g = createLoneEscapeGuard({armedUntil, now: () => 0, setTimer: setTimeout, clearTimer: clearTimeout, replyHead, keysBeforeReply});
    const feed = (input: string, escape = false) => g.onInput(input, {escape}, () => quits.push(input));
    return {feed, quits};
  };

  it('drops the rest of the reply, however Ink splits it, and then lets keys through', () => {
    const {feed} = guard(`${ESC}[?62;22`);
    expect(feed('c')).toBe('handled');
    expect(feed('c')).toBe('pass');

    const twice = guard(`${ESC}_Gi=31;O`);
    expect(twice.feed('K')).toBe('handled');
    // `ESC \` reaches the app as `\`, its ESC stripped by Ink.
    expect(twice.feed('\\')).toBe('handled');
    expect(twice.feed('j')).toBe('pass');

    const loneEsc = guard(`${ESC}P>|kitty(0.35.2)`);
    expect(loneEsc.feed('', true)).toBe('handled');
    expect(loneEsc.feed('\\')).toBe('handled');
    expect(loneEsc.feed('j')).toBe('pass');
    expect(loneEsc.quits).toEqual([]);

    const more = guard(`${ESC}_Gi=31;OK`);
    expect(more.feed(`${ESC}\\${ESC}[?62;22c`.slice(1))).toBe('handled');
    expect(more.feed('k')).toBe('pass');
  });

  it('lets a key through that does not continue the reply', () => {
    const {feed} = guard(`${ESC}[?62;22`);
    expect(feed('j')).toBe('pass');
    expect(feed('c')).toBe('pass');
  });

  it('reads the keys typed during detection first, and the reply\'s rest after them', () => {
    const typed = guard(`${ESC}[?62;22`, Infinity, 'j');
    expect(typed.feed('j')).toBe('pass');
    expect(typed.feed('c')).toBe('handled');
    expect(typed.feed('c')).toBe('pass');

    // Ink reports an arrow with no input and strips the ESC of other keys.
    const arrow = guard(`${ESC}_Gi=31;O`, Infinity, `${ESC}[A`);
    expect(arrow.feed('')).toBe('pass');
    expect(arrow.feed('K')).toBe('handled');
    const ctrl = guard(`${ESC}[?62;22`, Infinity, '\x04');
    expect(ctrl.feed('d')).toBe('pass');
    expect(ctrl.feed('c')).toBe('handled');

    // The rest joined on to the keys in one read: Ink passes `jc` as text,
    // which runs nothing, and the reply is over.
    const joined = guard(`${ESC}[?62;22`, Infinity, 'j');
    expect(joined.feed('jc')).toBe('pass');
    expect(joined.feed('c')).toBe('pass');
  });

  it('lets the rest through once the window has passed', () => {
    const {feed} = guard(`${ESC}[?62;22`, 0);
    expect(feed('c')).toBe('pass');
  });
});

describe('createLoneEscapeGuard with no reply handed off', () => {
  const guard = (armedUntil: number) => {
    const quits: string[] = [];
    const g = createLoneEscapeGuard({armedUntil, now: () => 0, setTimer: setTimeout, clearTimer: clearTimeout});
    const feed = (input: string, escape = false) => g.onInput(input, {escape}, () => quits.push(input));
    return {feed, quits, dispose: () => g.dispose()};
  };

  it('drops whole replies, armed or not, before any key binding sees them', () => {
    for (const armedUntil of [0, Infinity]) {
      const {feed} = guard(armedUntil);
      for (const reply of REPLIES) expect(feed(reply.slice(1)), JSON.stringify(reply)).toBe('handled');
      expect(feed('j')).toBe('pass');
    }
  });

  it('holds a reply that arrives in two reads inside the window, so its tail runs no key', () => {
    const {feed} = guard(Infinity);
    // Ink strips the ESC of the first read.
    expect(feed('[?62;22')).toBe('handled');
    expect(feed('c')).toBe('handled');
    expect(feed('c')).toBe('pass');

    expect(feed('[6;20;10')).toBe('handled');
    expect(feed('t')).toBe('handled');
    expect(feed('t')).toBe('pass');

    expect(feed('_Gi=31;O')).toBe('handled');
    expect(feed('K')).toBe('handled');
    expect(feed('\\')).toBe('handled');
    expect(feed('j')).toBe('pass');

    // One character is a key, not the start of a reply.
    expect(feed('[')).toBe('pass');
    expect(feed('c')).toBe('pass');
  });

  it('holds the rest of a reply split after its ESC when that rest is cut short too', () => {
    const {feed, quits, dispose} = guard(Infinity);
    expect(feed('', true)).toBe('handled');
    expect(feed('[?62;22')).toBe('handled');
    expect(feed('c')).toBe('handled');
    expect(feed('c')).toBe('pass');
    dispose();
    expect(quits).toEqual([]);
  });

  it('quits once when a real Esc is followed by another key before the timer', async () => {
    const {feed, quits} = guard(Infinity);
    expect(feed('', true)).toBe('handled');
    expect(feed('j')).toBe('handled');
    expect(quits).toHaveLength(1);
    // The deferred quit was cancelled, so it does not run again.
    await wait(120);
    expect(quits).toHaveLength(1);
  });

  it('lets an unfinished read through once the window has passed', () => {
    const {feed} = guard(0);
    expect(feed('[?62;22')).toBe('pass');
    expect(feed('c')).toBe('pass');
  });
});

describe('late terminal replies', () => {
  it('do nothing and do not quit when they arrive whole', async () => {
    const {instance, state} = start(fixture(TIMED_OUT));
    await flush();
    const before = instance.lastFrame();

    for (const reply of REPLIES) {
      instance.stdin.write(reply);
      await flush(2);
    }
    await wait(120);

    expect(state.exited).toBe(false);
    expect(instance.lastFrame()).toBe(before);
    instance.unmount();
  });

  it('do not quit when split after the ESC, following a detection that timed out', async () => {
    const {instance, state} = start(fixture(TIMED_OUT));
    await flush();
    const before = instance.lastFrame();

    for (const reply of REPLIES) {
      instance.stdin.write(ESC);
      await flush();
      instance.stdin.write(reply.slice(1));
      await flush(2);
    }
    await wait(120);

    expect(state.exited).toBe(false);
    expect(instance.lastFrame()).toBe(before);
    instance.unmount();
  });

  it('do not run the key their tail spells when detection handed off a cut-off reply', async () => {
    const copies: string[] = [];
    const {instance, state} = start(fixture({...TIMED_OUT, replyHead: `${ESC}[?62;22`}), copies);
    await flush();
    const before = instance.lastFrame();

    // `c` alone copies the focused block's code.
    instance.stdin.write('c');
    await flush(3);
    await wait(50);

    expect(copies).toEqual([]);
    expect(state.exited).toBe(false);
    expect(instance.lastFrame()).toBe(before);

    // The next `c` is the user's.
    instance.stdin.write('c');
    await flush(3);
    await wait(50);
    expect(copies).toHaveLength(1);
    instance.unmount();
  });

  it('do not run the key their tail spells when they arrive in two reads after the app took stdin', async () => {
    const copies: string[] = [];
    const {instance, state} = start(fixture(TIMED_OUT), copies);
    await flush();
    const before = instance.lastFrame();

    instance.stdin.write(`${ESC}[?62;22`);
    await flush(3);
    instance.stdin.write('c');
    await flush(3);
    await wait(50);

    expect(copies).toEqual([]);
    expect(state.exited).toBe(false);
    expect(instance.lastFrame()).toBe(before);

    instance.stdin.write('c');
    await flush(3);
    await wait(50);
    expect(copies).toHaveLength(1);
    instance.unmount();
  });

  it('do not run the key their tail spells when keys typed during detection come first', async () => {
    const reference = start(fixture());
    await flush();
    reference.instance.stdin.write('j');
    await flush(3);
    const scrolledOnce = reference.instance.lastFrame();
    reference.instance.unmount();

    const copies: string[] = [];
    const {instance, state} = start(fixture({...TIMED_OUT, replyHead: `${ESC}[?62;22`, keysBeforeReply: 'j'}), copies);
    await flush();
    const before = instance.lastFrame();

    // Detection pushed `j` back ahead of the reply's rest, `c`.
    instance.stdin.write('j');
    await flush(3);
    instance.stdin.write('c');
    await flush(3);
    await wait(50);

    expect(copies).toEqual([]);
    expect(state.exited).toBe(false);
    expect(instance.lastFrame()).not.toBe(before);
    expect(instance.lastFrame()).toBe(scrolledOnce);
    instance.unmount();
  });

  it('defer a lone Esc when the review controller passes a timed-out detection to the app', async () => {
    const {review} = buildFixture([multiBlockFile('src/one.ts', [1, 20], 6), multiBlockFile('src/two.ts', [1], 4)]);
    const instance = renderSized(
      <ReviewController
        cwd={os.tmpdir()}
        range={{base: 'development', branch: 'HEAD', diffArg: 'development', includeWorktree: false}}
        initialReview={review}
        watch={false}
        graphics={TIMED_OUT}
        copyWriter={recordingWriter([])}
        dimensions={{columns: 120, rows: 30}}
      />,
      {columns: 120, rows: 30},
    );
    const state = {exited: false};
    void instance.waitUntilExit().then(() => {
      state.exited = true;
    });
    await flush();

    instance.stdin.write(ESC);
    await flush(2);
    expect(state.exited).toBe(false);
    instance.stdin.write('[?62;22c');
    await flush(2);
    await wait(120);
    expect(state.exited).toBe(false);

    instance.stdin.write(ESC);
    await wait(120);
    expect(state.exited).toBe(true);
  });

  it('still let a lone Esc quit, a moment later, after a detection that timed out', async () => {
    const {instance, state} = start(fixture(TIMED_OUT));
    await flush();

    instance.stdin.write(ESC);
    await flush(2);
    expect(state.exited).toBe(false);
    await wait(120);

    expect(state.exited).toBe(true);
  });

  it('still let q quit at once after a detection that timed out', async () => {
    const {instance, state} = start(fixture(TIMED_OUT));
    await flush();
    instance.stdin.write('q');
    await flush(3);
    expect(state.exited).toBe(true);
  });

  it('let Esc quit at once when detection did not time out', async () => {
    for (const graphics of [undefined, NO_GRAPHICS]) {
      const {instance, state} = start(fixture(graphics));
      await flush();
      instance.stdin.write(ESC);
      await flush(3);
      expect(state.exited).toBe(true);
    }
  });

  it('let Esc quit at once once the guard window has passed', async () => {
    const {instance, state} = start(fixture(TIMED_OUT));
    await flush();
    await wait(1600);
    instance.stdin.write(ESC);
    await flush(3);
    expect(state.exited).toBe(true);
  });
});

describe('graphics caps with no protocol', () => {
  it('leave every frame of a review with PNG, SVG and MP4 files exactly as without them', async () => {
    const files = buildFixture([
      binaryMediaFile('assets/banner.png', 'added'),
      svgSourceFile('assets/flow.svg'),
      binaryMediaFile('assets/demo.mp4'),
      binaryMediaFile('assets/old.jpg', 'deleted'),
    ]);
    const frames = async (graphics?: GraphicsCaps) => {
      const {instance} = start({...files, ...(graphics ? {graphics} : {})});
      await flush();
      for (const key of ['j', ']', '\r', 'G', 'g', '\u001B[B']) {
        instance.stdin.write(key);
        await flush(2);
      }
      const all = [...instance.frames];
      instance.unmount();
      return all;
    };

    const plain = await frames();
    expect(frameLines(plain.at(-1)).join('\n')).toContain('binary file changed');
    expect(await frames(NO_GRAPHICS)).toEqual(plain);
    expect(await frames({...NO_GRAPHICS, terminal: 'ghostty 1.3.2'})).toEqual(plain);
  });
});
