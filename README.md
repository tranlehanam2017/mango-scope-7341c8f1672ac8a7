# Neighborly Board

Balance community commitments by urgency, effort, and local value.

This repository contains a complete, local-first TypeScript web application. It is generated as
an independent project, and its neutral repository name is **mango-scope-7341c8f1672ac8a7**.

## What it does

- Captures and validates volunteer activity records.
- Computes an explainable priority score from urgency, impact, effort, and status.
- Builds a seven-day plan with workload and category summaries.
- Persists data in browser storage with a versioned envelope and safe recovery.
- Imports strictly runtime-validated JSON, produces JSON/CSV exports, and includes deterministic tests.
- Displays the repository revision ledger used by scheduled maintenance commits.

## Run locally

```bash
npm install
npm run dev
```

Use `npm run build` for a production build and `npm test` for the planning-engine tests.

## Architecture

- `src/core/planner.ts` contains pure validation, scoring, forecasting, and aggregation logic.
- `src/core/store.ts` provides versioned local persistence and subscriber notifications.
- `src/core/exchange.ts` owns JSON/CSV interchange without coupling it to the interface.
- `src/main.ts` renders the application and coordinates user interactions.
- `src/generated/revision-ledger.ts` is imported by the application and records maintenance revisions.

The application keeps all personal data in the current browser. It does not send records to a
remote service.
