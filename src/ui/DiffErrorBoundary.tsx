import React from 'react';
import {Box, Text} from 'ink';
import {palette} from './palette.js';
import {cellWidth, toDisplayText, truncateEnd, truncateStart} from './text.js';

type Props = {
  filePath: string;
  // Any change (a scroll, a refresh, another file) retries rendering.
  resetKey: string;
  width: number;
  children: React.ReactNode;
};

type State = {error: Error | null; resetKey: string};

function errorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message.split('\n')[0]! : String(error);
}

const FAILURE_PREFIX = '✗ could not render ';

// `✗ could not render <path>: <reason>` in at most `width` cells. A long path
// is cut from its start so the reason stays whole; a reason too long for the
// row comes first, so the row still starts with why it failed.
export function renderFailureText(path: string, reason: string, width: number) {
  const displayPath = toDisplayText(path);
  const tail = `: ${toDisplayText(reason)}`;
  const full = `${FAILURE_PREFIX}${displayPath}${tail}`;
  if (cellWidth(full) <= width) return full;

  const pathRoom = width - cellWidth(FAILURE_PREFIX) - cellWidth(tail);
  if (pathRoom >= 2) return `${FAILURE_PREFIX}${truncateStart(displayPath, pathRoom)}${tail}`;

  return truncateEnd(`✗ ${toDisplayText(reason)} · ${displayPath}`, Math.max(1, width));
}

// Keeps a render failure in the diff pane inside the pane: the tree, the
// footer and every key keep working, and the pane says which file failed.
export class DiffErrorBoundary extends React.Component<Props, State> {
  override state: State = {error: null, resetKey: this.props.resetKey};

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {error};
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.resetKey ? null : {error: null, resetKey: props.resetKey};
  }

  override render() {
    const {error} = this.state;
    if (!error) return this.props.children;

    const message = renderFailureText(this.props.filePath || 'diff', errorMessage(error), Math.max(1, this.props.width - 4));
    return (
      <Box width={this.props.width} borderStyle="round" borderColor={palette.ink('gray')} paddingX={1}>
        <Text color={palette.ink('red')} wrap="truncate">{message}</Text>
      </Box>
    );
  }
}
