import type { VerticalPack } from "../types";
import { instructions } from "./instructions";

export const irrigation: VerticalPack = {
  id: "irrigation",
  label: "Irrigation",
  minimumChargeCents: 9500,
  profile: { quoteValidityDays: 30 },
  items: [
    {
      name: "Zone inspection",
      unitKind: "each",
      unitLabel: "zone",
      priceCents: 1500,
      group: "Inspection",
      notes: "Run the zone from the controller, check every head, and find the fault.",
    },
    {
      name: "Sprinkler head replacement",
      unitKind: "each",
      unitLabel: "head",
      priceCents: 3500,
      group: "Repairs",
      photoPrompt: "sprinkler head",
    },
    {
      name: "Valve replacement",
      unitKind: "each",
      unitLabel: "valve",
      priceCents: 17500,
      group: "Repairs",
      photoPrompt: "irrigation valve box",
    },
    {
      name: "Controller install",
      unitKind: "each",
      unitLabel: "controller",
      priceCents: 32500,
      group: "Install",
      notes: "Includes the controller, up to 8 zones.",
      photoPrompt: "irrigation controller",
    },
    { name: "Drip line", unitKind: "linear_ft", unitLabel: "linear foot", priceCents: 300, group: "Install", weatherSensitive: true },
    { name: "Pipe repair", unitKind: "each", unitLabel: "repair", priceCents: 12500, group: "Repairs" },
    { name: "Backflow test", unitKind: "flat", unitLabel: "device", priceCents: 7500, group: "Testing" },
    { name: "Wire tracing", unitKind: "hour", unitLabel: "hour", priceCents: 9500, group: "Repairs", equipment: ["pipe locator"] },
    {
      name: "Seasonal start-up",
      unitKind: "each",
      unitLabel: "system",
      priceCents: 8500,
      group: "Inspection",
      notes: "Run every zone, adjust the heads, and set the controller for the season's watering days.",
    },
  ],
  rules: [
    {
      text: "After-hours emergency work adds 25% to repairs",
      kind: "pricing_modifier",
      effect: { op: "percent", amount: 2500, appliesTo: ["Sprinkler head replacement", "Valve replacement", "Pipe repair", "Wire tracing"] },
    },
    { text: "A backflow test needs the tester's license number on the invoice", kind: "process" },
  ],
  notes: [
    {
      title: "How we quote",
      body: [
        "Inspections are priced per zone: a zone is one valve and the heads it runs. The controller shows how many zones there are.",
        "Heads, valves, and controllers are counted each.",
        "Drip line is measured in linear feet along the bed.",
        "A pipe repair is one break dug up and fixed; two breaks are two repairs.",
        "Wire tracing is hourly; most cut wires are found inside 2 hours.",
        "A backflow test is one flat charge per device, with the license number on the invoice.",
        "Quotes are good for 30 days.",
      ].join("\n"),
      tags: ["quoting"],
    },
    {
      title: "Crew and schedule",
      body: "Carlos Reyes runs the crew and carries the pipe locator. Visits are Monday to Friday, 7am to 4pm; emergency repairs any day.",
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
