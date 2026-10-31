import type {Blockquote, Paragraph, Root, Text} from 'mdast';

export const ALERT_TYPES = ['note', 'tip', 'important', 'warning', 'caution'] as const;
export type AlertType = typeof ALERT_TYPES[number];

const MARKER = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i;

/**
 * GitHub's alerts: a top-level blockquote whose first line is only
 * `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]`, in any
 * case, with content after it. GitHub doesn't turn a nested or an empty one
 * into an alert, so neither does this.
 *
 * The blockquote becomes a div and gains a title paragraph, both tagged with
 * the render's private attribute (`alert:<type>` and `alert-title:<type>`).
 * The classes and the icon go on after the sanitizer, which would strip
 * them.
 */
export function remarkAlerts(options: {stamp: string}) {
  return (tree: Root) => {
    for (const node of tree.children) {
      if (node.type !== 'blockquote') continue;
      const type = alertType(node);
      if (type) toAlert(node, type, options.stamp);
    }
  };
}

function alertType(node: Blockquote): AlertType | null {
  const first = node.children[0];
  if (first?.type !== 'paragraph') return null;
  const text = first.children[0];
  if (text?.type !== 'text') return null;
  const match = MARKER.exec(text.value);
  if (!match) return null;
  const rest = text.value.slice(match[0].length).trim();
  const hasContent = rest !== '' || first.children.length > 1 || node.children.length > 1;
  return hasContent ? match[1]!.toLowerCase() as AlertType : null;
}

function toAlert(node: Blockquote, type: AlertType, stamp: string) {
  const first = node.children[0] as Paragraph;
  const text = first.children[0] as Text;
  text.value = text.value.replace(MARKER, '');
  // A soft break right after the marker starts the body on its own line.
  if (text.value === '') first.children.shift();
  if (first.children.length === 0) node.children.shift();

  const title: Paragraph = {
    type: 'paragraph',
    data: {hProperties: {[stamp]: `alert-title:${type}`}},
    children: [{type: 'text', value: type[0]!.toUpperCase() + type.slice(1)}],
  };
  node.children.unshift(title);
  node.data = {...node.data, hName: 'div', hProperties: {...node.data?.hProperties, [stamp]: `alert:${type}`}};
}
