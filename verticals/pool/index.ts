import type { VerticalPack } from "../types";
import { instructions } from "./instructions";

export const pool: VerticalPack = {
  id: "pool",
  label: "Pool service",
  minimumChargeCents: 7500,
  profile: { quoteValidityDays: 30 },
  items: [
    {
      name: "Weekly service",
      unitKind: "visit",
      unitLabel: "visit",
      priceCents: 3500,
      group: "Service",
      notes: "Skim, brush, vacuum, empty the baskets, and test the water.",
      photoPrompt: "swimming pool",
      weatherSensitive: false,
    },
    { name: "Chemicals", unitKind: "visit", unitLabel: "visit", priceCents: 2000, group: "Service" },
    {
      name: "Green-to-clean",
      unitKind: "flat",
      unitLabel: "pool",
      priceCents: 35000,
      group: "Cleanup",
      notes: "Chemicals included, up to 3 visits.",
      photoPrompt: "swimming pool",
    },
    { name: "Filter clean", unitKind: "each", unitLabel: "filter", priceCents: 9500, group: "Equipment", photoPrompt: "pool filter" },
    { name: "Salt cell clean", unitKind: "each", unitLabel: "cell", priceCents: 7500, group: "Equipment" },
    {
      name: "Pump motor replacement",
      unitKind: "each",
      unitLabel: "motor",
      priceCents: 65000,
      group: "Equipment",
      notes: "Includes the motor; a new pump body is quoted apart.",
      photoPrompt: "pool pump",
    },
    {
      name: "Acid wash",
      unitKind: "each",
      unitLabel: "pool",
      priceCents: 45000,
      group: "Surfaces",
      notes: "Drain, wash, and refill the same day.",
      photoPrompt: "swimming pool",
      equipment: ["acid wash kit"],
      weatherSensitive: true,
    },
    { name: "Tile cleaning", unitKind: "linear_ft", unitLabel: "linear foot", priceCents: 900, group: "Surfaces" },
    { name: "Leak detection", unitKind: "hour", unitLabel: "hour", priceCents: 12500, group: "Repairs" },
  ],
  rules: [
    {
      text: "A screened enclosure adds 10% to acid wash and tile cleaning",
      kind: "pricing_modifier",
      effect: { op: "percent", amount: 1000, appliesTo: ["Acid wash", "Tile cleaning"] },
    },
    { text: "No acid wash within 48 hours of a plaster repair", kind: "process" },
  ],
  notes: [
    {
      title: "How we quote",
      body: [
        "Weekly service is priced per visit, and chemicals are their own line per visit. A month is 4 or 5 visits: propose the count in the confirm.",
        "Green-to-clean is one flat charge per pool, chemicals included.",
        "Filters and salt cells are cleaned each; pump motors are replaced each.",
        "Acid wash is per pool; the pool is drained and refilled the same day.",
        "Tile is measured in linear feet along the waterline.",
        "Leak detection is hourly.",
        "Quotes are good for 30 days.",
      ].join("\n"),
      tags: ["quoting"],
    },
    {
      title: "Crew and schedule",
      body: "Carlos Reyes runs the route and carries the acid wash kit. Weekly stops are Monday to Friday, 7am to 4pm, the same day each week. No Sunday work.",
      tags: ["schedule"],
    },
    {
      title: "Service area",
      body: "Tequesta, Jupiter, Juno Beach, and Hobe Sound. Outside that, add a trip note to the quote.",
      tags: ["area"],
    },
  ],
  instructions,
};
