import { and, eq } from "drizzle-orm";
import { defineEval } from "eve/evals";
import { equals, includes } from "eve/evals/expect";
import { db } from "../../../core/db";
import { listQuotes } from "../../../core/quotes";
import { conversations } from "../../../schema/schema";
import type config from "./evals.config";

// One number per person: their thread is the index, and multi-step work about another customer goes
// to a job, which the assistant drives in its own session and relays briefly.
export default defineEval<typeof config>({
  description: "With a quote in progress, back-and-forth work about another customer opens a job; the thread's reply stays short.",
  async test(t) {
    const business = await t.context.seed.priced();

    const first = await t.send("new one. 310 Coral Way, 16 windows in and out, no screens");
    first.calledTool("create_quote");
    t.check(first.message, includes("192"));

    const turn = await first.session.send(
      "keep that one as is. different thing: Sam Placeholder at 9 Sample Rd wants their place priced, 20 windows in and out plus screens, and they'll go back and forth on it a few times. work that one up on its own",
    );
    t.succeeded();
    turn.calledTool("start_job", { count: 1 });
    t.check((turn.message ?? "").length <= 400, equals(true)).label("thread reply is short");
    t.check(/\bjob_[0-9a-f]{6,}/.test(turn.message ?? ""), equals(false)).label("no job id in the reply");
    t.judge(
      "The assistant's last reply is short (a few lines at most), is about the 9 Sample Rd work for Sam Placeholder, and doesn't change or re-send the 310 Coral Way quote.",
    ).gate(0.7);

    // The job is the owner's, under their thread, about the new work, with its own session.
    const jobs = await db()
      .select()
      .from(conversations)
      .where(and(eq(conversations.orgId, business.orgId), eq(conversations.kind, "job")));
    t.check(jobs.length, equals(1)).label("jobs opened");
    const [job] = jobs;
    t.check(job?.memberId, equals(business.owner.memberId)).label("job member");
    t.check(Boolean(job?.parentId), equals(true)).label("job has a parent thread");
    t.check(Boolean(job?.eveSessionId), equals(true)).label("job has its own session");
    t.check(job?.status, equals("active")).label("job status");
    t.check(/sample rd|placeholder/i.test(job?.title ?? ""), equals(true)).label("job title");

    // Coral Way stayed as it was.
    const coral = (await listQuotes(business.orgId, {})).find((q) => /coral/i.test(q.title));
    t.check(coral?.totalCents, equals(19200)).label("Coral Way total");
    t.check(coral?.revisionNumber, equals(1)).label("Coral Way revision");
  },
});
