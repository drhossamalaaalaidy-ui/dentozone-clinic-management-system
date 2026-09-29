# DentOzone Clinic System

An Arabic/English, mobile-first dental clinic workspace for DentOzone in New Cairo.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `DATABASE_URL` is provided by the managed PostgreSQL database.
- Clerk auth keys are provisioned by the Replit-managed auth setup. Never commit keys.
- Before publishing or entering real patient data, set `DENTOZONE_OWNER_EMAIL` to the intended owner's verified Clerk sign-in email in the environment. Production intentionally refuses to assign the first owner unless this is set.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Frontend: React, Vite, Tailwind CSS, Wouter, Orval-generated API hooks
- Auth: managed Clerk, backed by server-side clinic staff allowlisting and roles

## Where things live

- `lib/api-spec/openapi.yaml` is the HTTP contract; regenerate clients with the codegen command above after every change.
- `lib/db/src/schema/` defines the PostgreSQL tables.
- `artifacts/api-server/src/routes/` implements protected clinic endpoints.
- `artifacts/dentozone/src/` holds the bilingual app; `src/lib/locale.tsx` is its interface dictionary.
- `scripts/seed-dentozone.sql` inserts idempotent fictional demo records marked in the database.
- `docs/data-safety.md` documents backup/restore precautions.

## Architecture decisions

- Only the first verified Clerk user can initialize an empty development clinic. In production the user's email must additionally match `DENTOZONE_OWNER_EMAIL`; otherwise no first owner is created. This prevents an arbitrary public sign-up from becoming the clinic owner.
- After initialization, new Clerk sign-ups have no access to clinic records until the owner invites their verified email. Permissions are checked on each protected API request, not trusted from the UI.
- Money is stored in integer piasters (100 per EGP) to avoid rounding errors; Arabic dates/today calculations use `Africa/Cairo`.
- Reception and assistants do not receive financial values. Reception only sees administrative patient details; owners and dentists write clinical records, while managers and assistants can read them. Accountants are denied patient clinical records. Only owners can invite staff or alter roles.

## Product

The current release includes branded sign-in, searchable patient registration/profiles, staff roles, settings, audit events, a dashboard, scheduling with doctor/chair conflict checks, clinical visits and diagnoses/procedures, adult/child odontograms, printable treatment plans, finance and inventory, protected patient documents in private App Storage, orthodontic cases, consent-aware manual appointment reminders, operational count reports, and Arabic/English RTL/LTR navigation. Metadata and clinic records persist in PostgreSQL; file bytes are stored in private App Storage. Existing fictional sample records remain marked as demo.

Automated messaging/provider-verified delivery and AI-generated clinical summaries from the original brief are not implemented. Reminder status means a staff member confirmed sending; it does not prove delivery. Do not label the current release as the complete clinic operating system.

## User preferences

- Build and debug the app for the clinic owner; do not ask them to write code.
- Arabic and English, proper RTL/LTR, EGP, and comfortable iPhone use are essential.
- Avoid fake in-memory patient data or public patient endpoints. Preserve existing data.

## Gotchas

- The first production owner needs `DENTOZONE_OWNER_EMAIL` configured before they can access the protected app.
- Development and production Clerk accounts are separate; use the correct environment during onboarding.
- The `/api` service handles auth and patient data; the web app at `/` must not duplicate or expose it publicly.
- A provider-neutral OCI deployment option is documented in `deploy/README.md`. Replit development remains on its current services until a backed-up, verified data/identity cutover; do not automatically switch it to the portable backends.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
