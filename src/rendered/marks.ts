// Marks the TUI shows for the rendered view, in a module that imports
// nothing, so the UI can name them without loading the rendered service.

/**
 * The mark for "opens outside the pane". `↗` would read better, but
 * string-width, which Ink lays rows out with, counts it two cells while
 * terminals draw it in one, so every row holding it would end a cell short.
 */
export const LEAVES_PANE = '⇗';
