import { Experimental_DecisionLanguageModel } from "@ai-sdk/provider-utils/experimental-decision";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";
import { defineEvalConfig } from "eve/evals";
import { languageModel, modelProviderOptions } from "../../../core/model-provider";
import { forceOffline } from "../../../core/offline";
import { truncateAll } from "../../../core/test-db";
import { VERTICALS } from "../../../verticals";
import { captureDir, captureReporter, stagingSeeds } from "./capture";
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
  seedVerticalBusiness,
  seedWorkToInvoice,
} from "./seed";

// The judge is a Meta model (`EVAL_JUDGE_MODEL_ID`, Wonder by default) at low reasoning effort, answering
// the judge's questions as structured output. Not a provider's `decisionModel`: that calls OpenAI's
// `/decisions` API, which Meta doesn't serve, and not eve's default (Jev), which needs AI Gateway
// credentials.
const judge = new Experimental_DecisionLanguageModel({
  model: wrapLanguageModel({
    model: languageModel(process.env.EVAL_JUDGE_MODEL_ID?.trim() || "muse-wonder-1.0"),
    middleware: defaultSettingsMiddleware({ settings: { providerOptions: modelProviderOptions("low") } }),
  }),
});

// `EVAL_CAPTURE_DIR` turns the run's passing evals into training examples (./capture.ts).
const capture = captureDir();

export default defineEvalConfig({
  judge: { model: judge },
  reporters: capture ? [captureReporter(capture)] : [],
  // Every eval truncates the database and seeds one business, and the agent resolves that business's
  // first owner, so evals must not overlap.
  maxConcurrency: 1,
  async setup() {
    // Nothing but the model touches the network: no Blob uploads, iMessage posts, Photon management
    // calls, or email, whatever `.env.local` holds (`core/offline.ts`). The dev server `eve eval`
    // boots after setup inherits these, and its env-file reload keeps them, since they are set.
    forceOffline();
    // `EVAL_MODEL_ID` runs the agent on another model; the dev server inherits it as `MODEL_ID`.
    if (process.env.EVAL_MODEL_ID) process.env.MODEL_ID = process.env.EVAL_MODEL_ID;
    // `EVAL_MODEL_BASE_URL`, with its key and API, puts the agent on another OpenAI-compatible server (a
    // tuned model's, `npm run scorecard -- --model`). The judge was built above, so it stays on Meta.
    if (process.env.EVAL_MODEL_BASE_URL) process.env.MODEL_BASE_URL = process.env.EVAL_MODEL_BASE_URL;
    if (process.env.EVAL_MODEL_API_KEY) process.env.META_MODEL_API_KEY = process.env.EVAL_MODEL_API_KEY;
    if (process.env.EVAL_MODEL_API) process.env.MODEL_API = process.env.EVAL_MODEL_API;
    process.env.BLOB_FAKE = "1";
    process.env.EMAIL_FAKE = "1";
    process.env.STRIPE_FAKE = "1";
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set. Put a local test database's URL in .env.local.");
    }
    // Start from an empty database; each seed also truncates first, so every eval is self-contained.
    await truncateAll();
    const seed = {
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
      // One seed per trade pack, for the evals tagged with its id.
      landscaping: () => seedVerticalBusiness(VERTICALS.landscaping),
      irrigation: () => seedVerticalBusiness(VERTICALS.irrigation),
      pool: () => seedVerticalBusiness(VERTICALS.pool),
      tree: () => seedVerticalBusiness(VERTICALS.tree),
    };
    // Capturing, each seed first copies the last eval's turns, before it empties the database.
    return { seed: capture ? stagingSeeds(seed) : seed };
  },
  async teardown() {
    const { closeDb } = await import("../../../core/db");
    await closeDb();
  },
});
