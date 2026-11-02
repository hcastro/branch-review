// How long ago something happened, in the words the Review in browser page
// uses for commits. Pure: the page writes it once, and the page script
// writes it again as the page ages in a browser tab.

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `just now`, `12 minutes ago`, `1 hour ago`, `yesterday`, `3 days ago`, then the date itself. */
export function relativeTime(seconds: number, nowSeconds: number): string {
  const ago = Math.max(0, nowSeconds - seconds);
  if (ago < MINUTE) return 'just now';
  if (ago < HOUR) return plural(Math.floor(ago / MINUTE), 'minute');
  if (ago < DAY) return plural(Math.floor(ago / HOUR), 'hour');
  if (ago < 2 * DAY) return 'yesterday';
  if (ago < 30 * DAY) return plural(Math.floor(ago / DAY), 'day');
  return `on ${dayName(seconds)}`;
}

const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? '' : 's'} ago`;

/** `Nov 1, 2026`, in the reader's time zone. */
export function dayName(seconds: number) {
  return new Date(seconds * 1000).toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'});
}
