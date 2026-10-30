// The instructions the assistant runs with, read from its files: `instructions.md`, and each skill's
// SKILL.md, whose name and description eve lists in the system prompt. A turn's trace records their hash
// with the trade pack's overlay (core/turn-traces.ts), and the training export rebuilds the system
// prompt from them (core/dataset.ts). Where the files aren't on disk (a bundle without its sources),
// there is nothing to read and the hash is null.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type AgentSkill = { name: string; description: string; markdown: string };
export type AgentInstructions = { base: string; skills: AgentSkill[] };

/** Where the agent's directory is, from the repo root or from the agent's own (eve runs it from either). */
const ROOTS = ["agents/assistant/agent", "agent"];

/** A SKILL.md's `description` from its frontmatter, and the body after it. */
export function parseSkill(name: string, text: string): AgentSkill {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const description = match ? (/^description:\s*(.+)$/m.exec(match[1])?.[1].trim() ?? "") : "";
  return { name, description: description.replace(/^["']|["']$/g, ""), markdown: match ? text.slice(match[0].length).trim() : text.trim() };
}

/** The agent's instructions and skills as they are on disk, or null when they aren't there. */
export function readAgentInstructions(cwd = process.cwd()): AgentInstructions | null {
  const root = ROOTS.map((dir) => resolve(cwd, dir)).find((dir) => existsSync(join(dir, "instructions.md")));
  if (!root) return null;
  try {
    const base = readFileSync(join(root, "instructions.md"), "utf8");
    const skillsDir = join(root, "skills");
    const names = existsSync(skillsDir)
      ? readdirSync(skillsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, "SKILL.md")))
          .map((entry) => entry.name)
          .sort()
      : [];
    const skills = names.map((name) => parseSkill(name, readFileSync(join(skillsDir, name, "SKILL.md"), "utf8")));
    return { base, skills };
  } catch {
    return null;
  }
}

/** A short hash of the instructions, the pack's overlay, and the skills: equal hashes ran with the same words. */
export function instructionsHash(instructions: AgentInstructions, overlay: string | null): string {
  const parts = [instructions.base, overlay ?? "", ...instructions.skills.map((s) => `${s.name}\n${s.description}\n${s.markdown}`)];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/**
 * The system prompt as the model saw it, rebuilt: the instructions, the pack's overlay, and the list of
 * skills it can load with `eve__skill`. Per-member additions (the glossary, the email inbox) aren't in it.
 */
export function systemPrompt(instructions: AgentInstructions, overlay: string | null): string {
  const parts = [instructions.base.trim()];
  if (overlay) parts.push(overlay.trim());
  if (instructions.skills.length) {
    parts.push(
      [
        "Available skills",
        "If the request clearly matches one of the descriptions below, load it with eve__skill({ name }) before proceeding, then follow its instructions.",
        ...instructions.skills.map((s) => `- ${s.name}: ${s.description}`),
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
}
