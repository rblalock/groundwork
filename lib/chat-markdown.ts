import remarkBreaks from "remark-breaks";
import { defaultRemarkPlugins } from "streamdown";

/**
 * The chat's Markdown plugins: Streamdown's own, plus a single newline as a line break. Replies are
 * written for iMessage, where a quote summary's lines are separated by one newline; Markdown alone would
 * run them into one line. Lists and paragraphs parse as before.
 */
export const chatRemarkPlugins = [...Object.values(defaultRemarkPlugins), remarkBreaks];
