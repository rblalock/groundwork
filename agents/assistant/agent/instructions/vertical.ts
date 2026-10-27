import { defineDynamic, defineInstructions } from "eve/instructions";
import { activeVertical } from "../../../../verticals";

/** The trade pack's overlay when `VERTICAL` names one (verticals/), else null. Read every call. */
export function verticalInstructions(): string | null {
  return activeVertical()?.instructions ?? null;
}

// The trade's vocabulary and what to ask, added every turn while VERTICAL names a pack. Nothing
// when it is unset or `none`, so the assistant stays trade-agnostic.
export default defineDynamic({
  events: {
    "turn.started": () => {
      const content = verticalInstructions();
      return content ? defineInstructions({ content }) : null;
    },
  },
});
