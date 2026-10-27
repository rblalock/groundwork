import { screenshot } from "@agent-browser/eve/tools";
import { defineTool, toolOutput, toolOutputPart } from "eve/tools";

// The extension shows screenshots to the user and keeps them from the model. The designer has to see
// what it's matching, so this hands the model the image itself.
export default defineTool({
  ...screenshot,
  toModelOutput(output) {
    const { imageDataUrl, path: _path, ...rest } = output as { imageDataUrl?: string; path?: string } & Record<string, unknown>;
    const match = imageDataUrl?.match(/^data:([^;]+);base64,(.*)$/);
    if (!match) return toolOutput.json({ ...rest, screenshot: "The screenshot couldn't be read back." });
    return toolOutput.content([toolOutputPart.text("The page as it looks now:"), toolOutputPart.file(match[2], { mediaType: match[1] })]);
  },
});
