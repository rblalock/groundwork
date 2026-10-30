import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { ToolSchema } from "../core/dataset";
import { APP_JOB, APP_WEB } from "../core/members";

// The assistant's tools as a model sees them, for the training export: each tool in
// agents/assistant/agent/tools/ with its description and its zod input as JSON schema. A tool a dynamic
// resolver returns is resolved for the turn's source, so a web turn has no `no_reply` and a job's thread
// has no `start_job`, as in the agent.

const TOOLS_DIR = resolve(import.meta.dirname, "../agents/assistant/agent/tools");

type ToolDefinition = { description?: string; inputSchema?: z.ZodType };
type ToolModule = ToolDefinition & { events?: { "turn.started"?: (event: unknown, resolve: unknown) => unknown } };

/** The auth a resolver sees for a turn from `source` (core/conversation-events.ts `originOf`). */
function authFor(source: string) {
  const authenticator = source === "web" ? APP_WEB : source === "job" ? APP_JOB : source === "text" || source === "email" ? "photon-imessage" : "local-dev";
  return { authenticator, principalId: "dataset", attributes: {} };
}

/** A tool's input schema as JSON schema: what it accepts, with zod's own keys left out. */
export function parametersOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

const cache = new Map<string, Promise<ToolSchema[]>>();

/** The tools a turn from `source` had, sorted by name. */
export function agentTools(source: string): Promise<ToolSchema[]> {
  let tools = cache.get(source);
  if (!tools) {
    tools = load(source);
    cache.set(source, tools);
  }
  return tools;
}

async function load(source: string): Promise<ToolSchema[]> {
  const files = readdirSync(TOOLS_DIR).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
  const out: ToolSchema[] = [];
  for (const file of files.sort()) {
    const mod = (await import(pathToFileURL(resolve(TOOLS_DIR, file)).href)).default as ToolModule;
    const resolver = mod.events?.["turn.started"];
    const definition = (resolver ? await resolver({}, { session: { auth: { current: authFor(source) } } }) : mod) as ToolDefinition | null;
    if (!definition?.inputSchema) continue;
    out.push({
      type: "function",
      function: { name: file.replace(/\.ts$/, ""), description: definition.description ?? "", parameters: parametersOf(definition.inputSchema) },
    });
  }
  return out;
}
