import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { searchCustomers } from "../../../core/customers";
import type config from "./evals.config";
import { emailTurnResult, forwardEmail } from "./forwarded-email";

// The owner forwards a request a customer wrote in Spanish. The assistant saves that customer as a Spanish
// speaker, so their quote and its PDF come out in Spanish.
export default defineEval<typeof config>({
  description: "A forwarded request a customer wrote in Spanish saves the customer in Spanish.",
  timeoutMs: 300_000,
  async test(t) {
    const business = await t.context.seed.emailBusiness();
    const { since } = await forwardEmail(t.target, business, {
      subject: "Fwd: Limpieza de ventanas en 7 Example Ave",
      text: [
        "Can you quote this?",
        "",
        "---------- Forwarded message ---------",
        "From: María Ejemplo <maria@example.com>",
        "Date: Mon, Oct 12, 2026 at 9:02 AM",
        "Subject: Limpieza de ventanas en 7 Example Ave",
        "To: <pat@example.com>",
        "",
        "Hola, ¿me pueden cotizar la limpieza de 10 ventanas por dentro y por fuera en 7 Example Ave?",
        "Gracias, María",
      ].join("\n"),
    });
    const { reply, tools } = await emailTurnResult(business, since, (ms) => t.sleep(ms));
    t.log(`reply: ${reply}`);
    t.log(`tools: ${tools.map((tool) => `${tool.name}:${tool.status}`).join(", ")}`);

    const [maria] = await searchCustomers(business.orgId, "María Ejemplo");
    t.check(maria?.language ?? null, equals("es")).label("customer saved in Spanish");
  },
});
