import type { ThemeConfig } from "./types";

export const theme = {
  "id": "community",
  "product": "Neighborly Board",
  "tagline": "Balance community commitments by urgency, effort, and local value.",
  "itemLabel": "Volunteer activity",
  "dateLabel": "Event date",
  "effortLabel": "Minutes",
  "impactLabel": "Community value",
  "categories": [
    "Food",
    "Education",
    "Environment",
    "Outreach",
    "Logistics"
  ],
  "seeds": [
    [
      "Sort pantry donations",
      "Food",
      60,
      5
    ],
    [
      "Prepare reading materials",
      "Education",
      45,
      4
    ],
    [
      "Map cleanup supplies",
      "Environment",
      30,
      3
    ]
  ]
} as const satisfies ThemeConfig;
