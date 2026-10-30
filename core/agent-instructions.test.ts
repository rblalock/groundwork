import assert from "node:assert/strict";
import { test } from "node:test";
import { instructionsHash, parseSkill, readAgentInstructions, systemPrompt } from "./agent-instructions";

test("parseSkill reads the description from the frontmatter and keeps the body", () => {
  const skill = parseSkill("quoting", "---\ndescription: Use before quoting.\n---\n\n# Quoting\n\nAsk once.\n");
  assert.deepEqual(skill, { name: "quoting", description: "Use before quoting.", markdown: "# Quoting\n\nAsk once." });
});

test("the agent's instructions and skills are read from the repo, and the hash follows the overlay", () => {
  const instructions = readAgentInstructions();
  assert.ok(instructions);
  assert.ok(instructions.base.length > 1000);
  assert.ok(instructions.skills.some((s) => s.name === "quoting" && s.description.length > 0));
  const plain = instructionsHash(instructions, null);
  assert.match(plain, /^[0-9a-f]{16}$/);
  assert.equal(instructionsHash(instructions, null), plain);
  assert.notEqual(instructionsHash(instructions, "Mulch is sold by the yard."), plain);
  const prompt = systemPrompt(instructions, "Mulch is sold by the yard.");
  assert.ok(prompt.startsWith(instructions.base.trim()));
  assert.match(prompt, /Mulch is sold by the yard\.\n\nAvailable skills\n/);
  assert.match(prompt, /^- quoting: /m);
});

test("no instructions where the agent's files aren't", () => {
  assert.equal(readAgentInstructions("/nonexistent"), null);
});
