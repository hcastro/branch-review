import {writeClipboard, type ClipboardWriteResult} from '../clipboard/write.js';
import {getCopyCommand, type CommandContext, type CommandPayload} from './registry.js';

export type CopyCommandExecutionResult =
  | {
      ok: true;
      commandId: string;
      toast: string;
      hint?: string;
      bytes: number;
    }
  | {
      ok: false;
      commandId: string;
      toast: string;
      hint?: string;
      reason: 'not-found' | 'disabled' | 'clipboard';
    };

export type ClipboardWriter = (text: string) => ClipboardWriteResult | Promise<ClipboardWriteResult>;

type ExecuteCopyCommandOptions = {
  write?: ClipboardWriter;
};

function byteLength(text: string) {
  return Buffer.byteLength(text, 'utf8');
}

export async function executeCopyCommand(
  commandId: string,
  context: CommandContext,
  options: ExecuteCopyCommandOptions = {},
): Promise<CopyCommandExecutionResult> {
  const command = getCopyCommand(commandId);
  if (!command) {
    return {
      ok: false,
      commandId,
      toast: 'Copy action not found.',
      reason: 'not-found',
    };
  }

  if (!command.isEnabled(context)) {
    return {
      ok: false,
      commandId,
      toast: 'Copy action unavailable.',
      reason: 'disabled',
    };
  }

  let payload: CommandPayload | null;
  try {
    payload = command.buildPayload(context);
  } catch (error) {
    return {
      ok: false,
      commandId,
      toast: 'Copy action unavailable.',
      ...(error instanceof Error ? {hint: error.message} : {}),
      reason: 'disabled',
    };
  }

  if (!payload) {
    return {
      ok: false,
      commandId,
      toast: 'Copy action unavailable.',
      reason: 'disabled',
    };
  }

  try {
    const result = await (options.write ?? writeClipboard)(payload.text);
    if (!result.ok) {
      return {
        ok: false,
        commandId,
        toast: result.message,
        ...(result.hint ? {hint: result.hint} : {}),
        reason: 'clipboard',
      };
    }

    return {
      ok: true,
      commandId,
      toast: payload.toast,
      ...(payload.hint ? {hint: payload.hint} : {}),
      bytes: byteLength(payload.text),
    };
  } catch (error) {
    return {
      ok: false,
      commandId,
      toast: 'Clipboard write failed.',
      ...(error instanceof Error ? {hint: error.message} : {}),
      reason: 'clipboard',
    };
  }
}
