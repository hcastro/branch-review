import React from 'react';
import {Box, Text} from 'ink';
import {palette} from './palette.js';
import {toDisplayText, truncateEnd} from './text.js';

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

    const message = `✗ could not render ${toDisplayText(this.props.filePath || 'diff')}: ${toDisplayText(errorMessage(error))}`;
    return (
      <Box width={this.props.width} borderStyle="round" borderColor={palette.ink('gray')} paddingX={1}>
        <Text color={palette.ink('red')} wrap="truncate">{truncateEnd(message, Math.max(1, this.props.width - 4))}</Text>
      </Box>
    );
  }
}
