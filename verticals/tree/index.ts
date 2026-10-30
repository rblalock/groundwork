import type { VerticalPack } from "../types";
import { instructions } from "./instructions";

export const tree: VerticalPack = {
  id: "tree",
  label: "Tree work",
  minimumChargeCents: 25000,
  profile: { quoteValidityDays: 21, depositPercent: 25 },
  items: [
    {
      name: "Tree removal",
      unitKind: "each",
      unitLabel: "tree",
      priceCents: 85000,
      group: "Removal",
      notes: "A tree up to 40 feet, cut to the ground; the stump is its own line.",
      photoPrompt: "tree",
      equipment: ["bucket truck"],
      weatherSensitive: true,
    },
    {
      name: "Crown trimming",
      unitKind: "each",
      unitLabel: "tree",
      priceCents: 35000,
      group: "Trimming",
      notes: "Thin and raise the crown and take out the deadwood.",
      photoPrompt: "tree",
      equipment: ["bucket truck"],
      weatherSensitive: true,
    },
    { name: "Palm trimming", unitKind: "each", unitLabel: "palm", priceCents: 6500, group: "Trimming", photoPrompt: "palm tree", weatherSensitive: true },
    { name: "Stump grinding", unitKind: "each", unitLabel: "stump", priceCents: 15000, group: "Removal", photoPrompt: "tree stump", equipment: ["stump grinder"] },
    { name: "Limb removal", unitKind: "each", unitLabel: "limb", priceCents: 12500, group: "Removal", photoPrompt: "fallen limb" },
    { name: "Storm debris cleanup", unitKind: "hour", unitLabel: "hour", priceCents: 9500, group: "Cleanup" },
    { name: "Chipping", unitKind: "hour", unitLabel: "hour", priceCents: 7500, group: "Cleanup", equipment: ["chipper"] },
    { name: "Haul-away", unitKind: "flat", unitLabel: "load", priceCents: 17500, group: "Cleanup", equipment: ["trailer"] },
    { name: "Crane day", unitKind: "flat", unitLabel: "day", priceCents: 250000, group: "Removal", notes: "The crane and its operator for the day." },
  ],
  rules: [
    {
      text: "A tree within 10 feet of a house or other structure adds 20% to removal, crown trimming, and limb removal",
      kind: "pricing_modifier",
      effect: { op: "percent", amount: 2000, appliesTo: ["Tree removal", "Crown trimming", "Limb removal"] },
    },
    { text: "Removing a tree over 60 feet tall needs a Crane day on the quote", kind: "process" },
  ],
  notes: [
    {
      title: "How we quote",
      body: [
        "Removal and crown trimming are priced per tree, for a tree up to 40 feet. Ask the member for the price of a taller one; over 60 feet, it also needs a crane day.",
        "Palms are trimmed per palm, stumps ground per stump, and limbs taken down per limb.",
        "Storm debris cleanup and chipping are hourly.",
        "Haul-away is a flat charge per trailer load taken off site.",
        "Ask for a photo of each tree before quoting it, with the house in the frame when it is close.",
        "25% deposit to book. Quotes are good for 21 days.",
      ].join("\n"),
      tags: ["quoting"],
    },
    {
      title: "Crew and schedule",
      body: "Carlos Reyes runs the crew with the bucket truck, chipper, and stump grinder. Work is Monday to Saturday, 7am to 4pm, and nothing goes up in high wind or lightning.",
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
