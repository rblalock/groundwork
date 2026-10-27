/** What the thread does with a job's reply: relay it briefly, never the job's id over text. */
export function relayGuidance(status: "replied" | "failed" | "limited"): string {
  if (status === "limited") {
    return "The business hit its hourly assistant usage limit, so the job didn't run this turn. Tell the member in one line that it's saved under Jobs and to try again in a few minutes. Don't retry on your own.";
  }
  return status === "failed"
    ? "The job couldn't finish this turn. Tell the member in one line that it didn't go through and that it's saved under Jobs in the web app. Don't retry on your own."
    : "Relay the job's reply to the member in a line or two, in your own words and their language. If it asks questions or sends a quote summary, pass those on as it wrote them. Don't mention the job's id; say \"job\" only if it helps.";
}
