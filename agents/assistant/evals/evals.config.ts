import { createAzure } from "@ai-sdk/azure";
import { Experimental_DecisionLanguageModel } from "@ai-sdk/provider-utils/experimental-decision";
import { defineEvalConfig } from "eve/evals";
import { currentDeployment } from "../../../core/model-pricing";
import { forceOffline } from "../../../core/offline";
import { truncateAll } from "../../../core/test-db";
import {
  seedDraftQuote,
  seedDuplicateCustomers,
  seedEmailBusiness,
  seedEmptyBusiness,
  seedInvoices,
  seedOneItemBusiness,
  seedPricedBusiness,
  seedScheduledBusiness,
  seedSiteNote,
  seedTodaysVisits,
  seedWorkToInvoice,
} from "./seed";

// The judge is the agent's own Azure deployment, answering the judge's questions as structured output.
// Not a provider's `decisionModel`: that calls OpenAI's `/decisions` API, which Azure doesn't serve, and
// not eve's default (Jev), which needs AI Gateway credentials.
const azureJudge = new Experimental_DecisionLanguageModel({
  model: createAzure({ resourceName: process.env.AZURE_RESOURCE_NAME, apiKey: process.env.AZURE_API_KEY })(currentDeployment()),
});

export default defineEvalConfig({
  judge: { model: azureJudge },
  // Every eval truncates the database and seeds one business, and the agent resolves that business's
  // first owner, so evals must not overlap.
  maxConcurrency: 1,
  async setup() {
    // Nothing but the model touches the network: no Blob uploads, iMessage posts, Photon management
    // calls, or email, whatever `.env.local` holds (`core/offline.ts`). The dev server `eve eval`
    // boots after setup inherits these, and its env-file reload keeps them, since they are set.
    forceOffline();
    process.env.BLOB_FAKE = "1";
    process.env.EMAIL_FAKE = "1";
    process.env.STRIPE_FAKE = "1";
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set. Put a local test database's URL in .env.local.");
    }
    // Start from an empty database; each seed also truncates first, so every eval is self-contained.
    await truncateAll();
    return {
      seed: {
        empty: seedEmptyBusiness,
        priced: seedPricedBusiness,
        oneItem: seedOneItemBusiness,
        draftQuote: seedDraftQuote,
        scheduled: seedScheduledBusiness,
        todaysVisits: seedTodaysVisits,
        workToInvoice: seedWorkToInvoice,
        invoices: seedInvoices,
        siteNote: seedSiteNote,
        duplicateCustomers: seedDuplicateCustomers,
        emailBusiness: seedEmailBusiness,
      },
    };
  },
  async teardown() {
    const { closeDb } = await import("../../../core/db");
    await closeDb();
  },
});
