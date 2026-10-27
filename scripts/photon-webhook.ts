// Manages the Photon project's webhooks, so pointing the line at a deployment needs no dashboard.
// Every webhook gets every text, so a line should have exactly one, or each text is answered twice.
//
//   npm run photon:webhook -- list
//   npm run photon:webhook -- add <url> | vercel env add IMESSAGE_WEBHOOK_SECRET production
//   npm run photon:webhook -- remove <id or url>
//
// `add` prints only the signing secret on stdout: Photon shows it once, so pipe it where it goes.

import process from "node:process";

const BASE_URL = "https://spectrum.photon.codes";

type Webhook = { id: string; webhookUrl: string };

async function call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  const projectId = process.env.IMESSAGE_PROJECT_ID;
  const secret = process.env.IMESSAGE_PROJECT_SECRET;
  if (!projectId || !secret) throw new Error("Set IMESSAGE_PROJECT_ID and IMESSAGE_PROJECT_SECRET in .env.local.");
  const response = await fetch(`${BASE_URL}/projects/${encodeURIComponent(projectId)}/webhooks/${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${projectId}:${secret}`).toString("base64")}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Photon returned HTTP ${response.status} for ${method} webhooks/${path}.`);
  return ((await response.json()) as { data: T }).data;
}

const [command, arg] = process.argv.slice(2);
try {
  if (command === "list") {
    for (const hook of await call<Webhook[]>("GET", "")) console.log(`${hook.id}  ${hook.webhookUrl}`);
  } else if (command === "add" && arg) {
    const hook = await call<Webhook & { signingSecret: string }>("POST", "", { webhookUrl: arg });
    console.error(`Added ${hook.id} for ${hook.webhookUrl}. Its signing secret is on stdout.`);
    process.stdout.write(hook.signingSecret);
  } else if (command === "remove" && arg) {
    const hooks = await call<Webhook[]>("GET", "");
    const hook = hooks.find((candidate) => candidate.id === arg || candidate.webhookUrl === arg);
    if (!hook) throw new Error(`No webhook ${arg}.`);
    await call("DELETE", `${encodeURIComponent(hook.id)}/`);
    console.error(`Removed ${hook.webhookUrl}.`);
  } else {
    throw new Error("usage: photon-webhook list | add <url> | remove <id or url>");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
