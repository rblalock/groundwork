import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { agentTools, parametersOf } from "./agent-tools";

test("a tool's zod input becomes JSON schema", () => {
  assert.deepEqual(parametersOf(z.object({ query: z.string().min(1), limit: z.number().int().optional() })), {
    type: "object",
    properties: { query: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: -9007199254740991, maximum: 9007199254740991 } },
    required: ["query"],
  });
});

test("the agent's tools, resolved for the turn's source", async () => {
  const text = await agentTools("text");
  const names = text.map((t) => t.function.name);
  assert.ok(names.includes("create_quote"));
  assert.ok(names.includes("no_reply"));
  assert.ok(names.includes("start_job"));
  const quote = text.find((t) => t.function.name === "create_quote");
  assert.equal(quote?.function.parameters.type, "object");
  assert.ok(quote?.function.description.length);

  assert.ok(!(await agentTools("web")).some((t) => t.function.name === "no_reply"));
  assert.ok(!(await agentTools("job")).some((t) => t.function.name === "start_job"));
});
