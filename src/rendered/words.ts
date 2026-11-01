import type {AssetAnswer, LinkStatus, RefusedReason} from './markdown.js';

// The words the rendered view says of links and images, and where a link's
// heading lands: plain functions with no parser, which the UI process's
// report and pages share with the renderer.

/** An id as the page has it: GitHub's `user-content-` prefix, once. */
export const withPrefix = (anchor: string) => (anchor.startsWith('user-content-') ? anchor : `user-content-${anchor}`);

// An empty fragment, or `top` in any case, opens a page at its top, as the
// HTML standard says, whatever ids the page has.
export const pageTop = (fragment: string) => fragment === '' || fragment.toLowerCase() === 'top';

/**
 * Where a link's fragment lands on a page with `ids` (`anchors`), as GitHub
 * finds it: the `user-content-` id it names, else that id in lowercase,
 * which GitHub's page script also tries; `top` for the top of the page; or
 * null when it lands nowhere. One rule for a link into the same page,
 * another rendered page, and a markdown file outside the review.
 */
export function anchorTarget(ids: ReadonlySet<string>, fragment: string): string | 'top' | null {
  const id = withPrefix(fragment);
  if (ids.has(id)) return id;
  if (ids.has(id.toLowerCase())) return id.toLowerCase();
  return pageTop(fragment) ? 'top' : null;
}

/** What a link that opens no page says of itself. */
export const LINK_TEXT: Record<Exclude<LinkStatus, 'ok'>, string> = {
  outside: 'not part of this review',
  unchecked: 'not checked in time',
  missing: 'file not found',
  badAnchor: 'anchor not found',
  untracked: 'file is untracked',
  ignored: 'ignored by git',
  caseMismatch: 'case mismatch',
};

/** The words for a link that won't resolve on GitHub: its reason, and for a case mismatch the names it confused. */
export function linkReason(status: Exclude<LinkStatus, 'ok' | 'outside' | 'unchecked'>, hint?: string) {
  return status === 'caseMismatch' && hint ? `${LINK_TEXT.caseMismatch}: ${hint}` : LINK_TEXT[status];
}

export const REFUSED_TEXT: Record<Extract<AssetAnswer, {kind: 'refused'}>['reason'], string> = {
  remote: 'not loaded (offline)',
  untracked: "won't render on GitHub: file is untracked",
  ignored: "won't render on GitHub: ignored by git",
  caseMismatch: "won't render on GitHub: case mismatch",
  missing: "won't render on GitHub: file not found",
  symlink: "won't render on GitHub: symlink · not followed",
  outside: "won't render on GitHub: outside the repo",
  lfs: "won't render on GitHub: LFS object · not fetched",
  submodule: "won't render on GitHub: submodule · not rendered",
  notImage: "won't render on GitHub: not an image",
  tooLarge: 'image not inlined · page limit',
  pageLimit: 'image not inlined · page limit',
  unreadable: 'image not inlined',
};

const GITHUB_REFUSAL = "won't render on GitHub: ";

/**
 * What the card in place of an image says, and whether it is soft: an
 * image GitHub can show that this page leaves out, in amber, rather than
 * one GitHub won't show either, in red.
 */
export function refusedCard(reason: RefusedReason, hint?: string): {text: string; soft: boolean} {
  const soft = reason === 'tooLarge' || reason === 'pageLimit' || reason === 'unreadable';
  const text = !hint ? REFUSED_TEXT[reason]
    : reason === 'caseMismatch' ? `${REFUSED_TEXT.caseMismatch}: ${hint}`
      : reason === 'unreadable' ? `${REFUSED_TEXT.unreadable} · ${hint}` : REFUSED_TEXT[reason];
  return {text, soft};
}

/**
 * What an image card says after `won't render on GitHub:`, for an image
 * GitHub won't show either, or null for one only this page leaves out
 * (remote, too large, unreadable).
 */
export function imageFinding(reason: RefusedReason, hint?: string): string | null {
  const text = REFUSED_TEXT[reason];
  if (!text.startsWith(GITHUB_REFUSAL)) return null;
  const said = text.slice(GITHUB_REFUSAL.length);
  return reason === 'caseMismatch' && hint ? `${said}: ${hint}` : said;
}

