import type { VerticalPack } from "../types";
import { instructions } from "./instructions";

const LABOR = ["Lawn mowing", "Bed edging", "Hedge trimming", "Palm trimming", "Shrub planting", "Sod installed", "Cleanup labor"];

export const landscaping: VerticalPack = {
  id: "landscaping",
  label: "Landscaping",
  minimumChargeCents: 15000,
  items: [
    { name: "Lawn mowing", unitKind: "visit", unitLabel: "visit", priceCents: 6500, group: "Maintenance" },
    { name: "Mulch installed", unitKind: "each", unitLabel: "cubic yard", priceCents: 9500, group: "Beds" },
    { name: "Bed edging", unitKind: "linear_ft", unitLabel: "linear foot", priceCents: 250, group: "Beds" },
    { name: "Hedge trimming", unitKind: "hour", unitLabel: "hour", priceCents: 7500, group: "Trimming" },
    { name: "Palm trimming", unitKind: "each", unitLabel: "palm", priceCents: 4500, group: "Trimming" },
    {
      name: "Shrub planting",
      unitKind: "each",
      unitLabel: "shrub",
      priceCents: 4000,
      group: "Planting",
      notes: "Labor only; the customer supplies the plant.",
    },
    { name: "Sod installed", unitKind: "sqft", unitLabel: "square foot", priceCents: 185, group: "Lawn" },
    { name: "Cleanup labor", unitKind: "hour", unitLabel: "hour", priceCents: 5500, group: "Cleanup" },
    { name: "Haul-away", unitKind: "flat", unitLabel: "load", priceCents: 15000, group: "Cleanup" },
    { name: "Sprinkler head replacement", unitKind: "each", unitLabel: "head", priceCents: 3500, group: "Irrigation" },
  ],
  rules: [
    {
      text: "Steep slope or terraced yard adds 15% to labor items",
      kind: "pricing_modifier",
      effect: { op: "percent", amount: 1500, appliesTo: LABOR },
    },
    {
      text: "Same-week rush adds 20% to the whole job except haul-away",
      kind: "pricing_modifier",
      effect: {
        op: "percent",
        amount: 2000,
        appliesTo: [
          "Lawn mowing",
          "Mulch installed",
          "Bed edging",
          "Hedge trimming",
          "Palm trimming",
          "Shrub planting",
          "Sod installed",
          "Cleanup labor",
          "Sprinkler head replacement",
        ],
      },
    },
    { text: "Haul-away is required whenever cleanup labor is more than 2 hours", kind: "process" },
  ],
  notes: [
    {
      title: "How we quote",
      body: [
        "Mulch goes down 3 inches deep: about 1 cubic yard per 100 sq ft of bed.",
        "Edging is measured in linear feet along the bed line.",
        "Sod is priced by the square foot the member gives; it comes on 450 sq ft pallets, so mention the pallet count in the confirm but quote the square feet as stated.",
        "Ask for a front and a back photo before quoting.",
        "30% deposit to book. Quotes are good for 14 days.",
      ].join("\n"),
      tags: ["quoting"],
    },
    {
      title: "Crew and schedule",
      body: "Carlos Reyes runs the crew. Visits are Monday to Friday, 7am to 4pm. No Sunday work.",
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
