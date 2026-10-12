# FBI IVANS Cancellation Tracker

Standalone cancellation workflow for FPT CSRs. Consumes EZLynx scheduled
reports (Policy Transaction Detail + Pending Transactions Detail) and
surfaces a clean, action-oriented queue: Save Queue / Already Cancelled /
Rewrites.

Lives separately from the FBI Portal so the Phase-1 rollout can't touch
portal KV.

## Local dev

```bash
npm install
npm run dev    # starts Vite on localhost:5173
```

Without KV env vars set, the app runs in **local mode** — all CSR edits
land in `localStorage` only. Fine for prototyping.

## Deploy to Vercel

1. **Push to GitHub.** Create a new repo, push this directory.
2. **Create Vercel project** from the repo. Framework preset: Vite.
3. **Add Upstash Redis integration** (Vercel Marketplace → Upstash Redis).
   This auto-populates the `KV_*` env vars on the project.
4. **Set `WEBHOOK_SECRET`** env var (random string, 32+ chars). Required
   by the EZLynx webhook endpoint to reject unauthenticated POSTs.
5. **Deploy.** The build runs `vite build`; API routes are deployed as
   Vercel serverless Node functions.
6. **Smoke test**: visit `https://fpt-automatedtransactions.vercel.app/api/data?table=cancellations`
   — expect `[]` (empty array). If you get 501, KV env vars aren't wired.

## Configure EZLynx scheduled reports

Two reports, both delivered via webhook to the same endpoint with
different `report` query params.

### Policy Transaction Detail (daily)
- **Delivery**: Webhook
- **URL**: `https://fpt-automatedtransactions.vercel.app/api/webhook/ezlynx?report=ptd`
- **Format**: JSON — Simple
- **Filter**: Download Date in past 2 days (overlap for late arrivals; dedupe is idempotent)
- **Custom header**: `X-Webhook-Secret: <same value as WEBHOOK_SECRET env>`

### Pending Transactions Detail (daily)
- Same as above but URL ends `?report=pending`.
- No date filter needed — the report is scoped to currently-pending transactions.

### Advanced
- EZLynx may expose more fields in the column picker. Specifically useful
  if available: a cancel-reason or non-pay flag (would restore the
  Progressive XLN semantic split we lose vs raw IVANS).

## Data flow

```
Daily:
  EZLynx PTD cron    → POST /api/webhook/ezlynx?report=ptd
  EZLynx Pending cron → POST /api/webhook/ezlynx?report=pending
                      ↓
             Parse + classify rewrites + resolve REI/RSN
                      ↓
             Upsert into KV `ivans-cancellations`
                      ↓
            CSRs open /tasks, work Save Queue
```

## Key files

- `api/webhook/ezlynx.js` — webhook handler, routes by `?report=`
- `api/data.js` — generic KV CRUD, mirrors the FBI Portal pattern
- `src/parsers/ezlynxPtd.js`, `src/parsers/ezlynxPending.js` — report parsers
- `src/parsers/ezlynxIvans.js` — legacy IVANS exportDetails parser (manual CSV fallback)
- `src/lib/rewriteClassifier.js` — sales-log cross-reference, fuzzy name match, Foremost Premier auto-strong
- `src/lib/ezlynxReport.js` — shared field extraction + carrier normalization
- `src/data/cancellations.js` — tab routing + PTD/Pending record merge
- `src/hooks/useCancellationData.js` — API data layer, falls back to localStorage when KV not provisioned
- `src/hooks/useSalesLog.js` — portal /sales auto-refresh for rewrite detection

## Scripts

- `scripts/smokeEzlynx.mjs` — parse PTD + Pending CSVs, print bucket counts
- `scripts/smokeMerge.mjs` — combined parse + merge + classifier
- `scripts/compareSources.mjs` — IVANS exportDetails vs EZLynx coverage diff
- `scripts/exportDiffV6.mjs` — full diff + CSV outputs for triage
