import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { listMembers } from "../../../core/members";
import type config from "./evals.config";

// PHOTON_ADMIN_FAKE=1 (set in evals.config.ts) keeps the Photon management API off the network.
export default defineEval<typeof config>({
  description: "Adding crew by text registers them and hands the owner an invite to forward.",
  async test(t) {
    const business = await t.context.seed.priced();

    await t.send("add Carlos 305 555 0142");
    t.succeeded();
    t.calledTool("add_member");
    t.judge(
      "The reply says the invite is for the owner to forward and does not claim to have texted Carlos.",
    ).gate(0.7);

    const crew = (await listMembers(business.orgId)).filter((member) => member.role === "member");
    t.check(
      crew.map((member) => member.name),
      satisfies((names: string[]) => names.some((name) => /carlos/i.test(name)), "Carlos is an active crew member"),
    );
  },
});
