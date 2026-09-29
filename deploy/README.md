# DentOzone portable deployment

This is a **new deployment option**, not a live-data migration. The current
Replit development and published app continue to use their existing database,
Clerk tenant, and private App Storage until an explicit, verified cutover. No
patient records, staff rows, or uploaded files are deleted by these changes.

The portable release is one OCI image containing the existing React web app
and Express API, served on the same origin. It needs standard PostgreSQL, a
private S3-compatible bucket, and a self-hosted OpenID Connect provider. The
example Compose stack supplies PostgreSQL, MinIO, Keycloak, and Caddy. The
image can be built once and run unchanged on any host capable of running OCI
images; changing domains or secrets does **not** require rebuilding it.
Replit-specific Vite plugins are development-only; the portable image uses
neither Replit's object-storage sidecar nor its managed Clerk tenant.

## Open the application in this workspace

Open the **DentOzone Clinic System** web preview. The existing API Server and
web workflows start the development app; use the Sign in button with an
authorized clinic staff account. A new email address cannot access clinic
records until an owner has invited/activated it. To build the current source,
run `pnpm run build` from the repository root. The portable image's production
command is `node --enable-source-maps artifacts/api-server/dist/index.mjs`
with `SERVE_STATIC=true`; it serves the built web app and `/api` on one port.
The development preview uses Replit-managed Clerk and private App Storage;
it is not evidence that an independent OIDC/S3 destination has been tested.

Fictional demo patients and their related records carry an `is_demo` marker.
They do not block staff from creating real clinic records. Exclude demo
records deliberately if later transferring data to a live clinic; do not
reset or delete existing records just to start using the application.

## Required services and environment

An independent deployment needs **PostgreSQL** for clinic records, a private
**S3-compatible object store** for patient files, and an **OIDC identity
provider** with verified staff email (Keycloak in the example). Serve the app
and identity provider over HTTPS. The sample Compose stack also runs a
separate PostgreSQL database for Keycloak, MinIO, and Caddy for TLS/DNS.
Back up the clinic database and private bucket together. These services are
not configured or started by this workspace.

For a direct container deployment, provide all of these **required**
application variables (the sample Compose file constructs many of them):

| Variable | Purpose |
| --- | --- |
| `NODE_ENV=production`, `PORT`, `SERVE_STATIC=true` | Production HTTP process and built web client |
| `DATABASE_URL` | PostgreSQL connection for the clinic database |
| `AUTH_PROVIDER=oidc`, `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`, `OIDC_SESSION_SECRET` | Verified-email staff sign-in; use a distinct session secret of at least 32 bytes |
| `DENTOZONE_OWNER_EMAIL`, `COOKIE_SECURE=true` | Initial owner bootstrap on an empty clinic and secure HTTPS cookies |
| `STORAGE_PROVIDER=s3`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Private patient-document storage; endpoint must use HTTPS in production |

For the checked-in Compose example, **every uncommented value** in
`deploy/.env.example` is required: `APP_IMAGE`, `APP_DOMAIN`, `AUTH_DOMAIN`,
`STORAGE_DOMAIN`, `DENTOZONE_OWNER_EMAIL`, `APP_DB_PASSWORD`,
`KEYCLOAK_DB_PASSWORD`, `KEYCLOAK_ADMIN_USER`, `KEYCLOAK_ADMIN_PASSWORD`,
`OIDC_CLIENT_SECRET`, `OIDC_SESSION_SECRET`, `MINIO_ROOT_USER`, and
`MINIO_ROOT_PASSWORD`. The Compose file supplies `PORT`, `DATABASE_URL`,
the OIDC URLs, S3 settings, and the production switches above. Never commit
the filled-in `deploy/.env`.

**Optional / conditional:** `S3_REGION` defaults to `us-east-1`;
`S3_SESSION_TOKEN` is only for temporary S3 credentials; `LOG_LEVEL` controls
logging; `OIDC_APP_URL` can override the auth-return URL.
`PRIVATE_OBJECT_DIR` is needed only for the one-time migration from Replit
App Storage, not normal S3 runtime. Clerk keys apply only to the current
Replit-managed development path, not the independent OIDC container.
**SMTP is not an app runtime variable**: configure it in Keycloak when staff
need verification/password-setup emails. **SMS/WhatsApp/email reminder
delivery providers are not configured or implemented**; reminder records and
opt-in preferences do not send messages by themselves.

## Build once, deploy later

1. On a machine with Docker/Compose, build the image at the repository root:
   `docker build -t dentozone:portable .`. Push that exact image to your
   registry, or transfer it with `docker save` / `docker load`. To move between
   providers without rebuilding, reference the pushed image **digest** in
   `APP_IMAGE`.
2. On the destination host, copy `deploy/.env.example` to `deploy/.env` and
   populate it privately. Keep it out of version control. Generate independent,
   strong secrets for the clinic database, Keycloak database/admin, MinIO,
   OIDC client, and OIDC session (at least 32 bytes). For the Compose database
   URL, choose a URL-safe `APP_DB_PASSWORD`, or percent-encode special
   characters. Do not reuse a password across services.
3. Point three DNS names to the host: `APP_DOMAIN` for clinic users,
   `AUTH_DOMAIN` for self-hosted sign-in, and `STORAGE_DOMAIN` for short-lived
   signed upload links. Allow incoming ports 80/443 so Caddy can obtain TLS.
   Do not publicly expose PostgreSQL, Keycloak's internal HTTP port, MinIO's
   internal port, or the app's internal port.
4. In `deploy/`, run `docker compose pull` and `docker compose up -d`. The
   example stack has persistent volumes, but **you must back up** both database
   volumes and `document-objects` regularly. Restrict access to the host and
   `.env`, apply security updates, and follow applicable patient-data laws.
   Pin and review container image digests before using real patient data.
5. At `https://AUTH_DOMAIN/admin`, create a realm named `dentozone`. Require
   email verification and configure a working SMTP server. Create a
   confidential OIDC client ID `dentozone`, authorization-code flow with
   standard flow/PKCE, client authentication, and the **exact** redirect URI
   `https://APP_DOMAIN/api/auth/callback`. Add
   `https://APP_DOMAIN/` as an allowed post-logout redirect URI. Set its generated secret as
   `OIDC_CLIENT_SECRET` in `deploy/.env`, then restart `app`. The client must
   include the `email` and `profile` scopes and emit `email_verified` in its
   ID token. Avoid public self-registration; only owner-approved staff should
   receive clinic access. `DENTOZONE_OWNER_EMAIL` must match the verified owner
   email before the first owner signs in to an empty clinic database.

For an empty clinic database only, apply the checked-in baseline schema once
with `psql -v ON_ERROR_STOP=1` against `deploy/migrations/0000_outstanding_ozymandias.sql`,
then apply the additive `deploy/migrations/0001_clinic_modules.sql` the same way.
**Do not apply the CREATE TABLE baseline to a restored database**. For
existing records, restore a full authorized PostgreSQL backup into an empty
clinic database instead; if the backup predates the new laboratory, aligner,
prescription, marketing, and finance-correction tables, apply only the additive
`0001` migration after verifying those tables do not already exist. Never run
a destructive schema push or a `--clean` restore against the source clinic.
Check row counts and foreign keys after restore, before admitting users.
These commands must run on the destination host; this development workspace
does not run Docker.

## Preserving existing data and access

1. Arrange a maintenance window and make independent, encrypted backups of
   the existing PostgreSQL database and private file bucket. Determine whether
   the source is the *development* or *published production* database; these
   are distinct. Do not copy demo data into production unintentionally.
2. Restore the full database (including staff, patient, clinical, finance,
   settings, and audit tables) into the destination PostgreSQL. Leave the
   source untouched. The existing staff identity column is reused to link
   verified OIDC subjects at first sign-in, preserving staff roles/status.
3. While still on Replit, the document migration program needs both access to
   the old App Storage sidecar and destination S3 credentials. With
   `DATABASE_URL` pointing to the **matching source database**, and
   `STORAGE_PROVIDER=s3`, `PRIVATE_OBJECT_DIR`, `S3_ENDPOINT`, `S3_BUCKET`,
   `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (and optionally `S3_REGION`)
   configured securely, run:
   - `node artifacts/api-server/dist/scripts/migrateActiveDocumentsToS3.mjs`
     to see counts without reading or writing any objects.
   - Add `--apply` only after backing up and checking the destination bucket
     is private. It copies active/withdrawn documents and any uploaded pending
     staging objects under their **unchanged keys**, validates their type,
     size, and SHA-256, and never deletes the source. Missing active documents
     fail the run; missing pending uploads are reported, with their DB rows
     untouched. Re-running it is safe and checks existing destination bytes.
   - This script is compiled by the normal API build; it cannot run as raw
     TypeScript with Node's strip-types flag.
4. After restoring the database, run
   `node artifacts/api-server/dist/scripts/provisionKeycloakStaff.mjs`
   against the **restored** database for a counts-only dry run. With
   `KEYCLOAK_ADMIN_URL=http://keycloak:8080` (within the Compose network, or
   use `https://AUTH_DOMAIN` externally), `KEYCLOAK_REALM=dentozone`,
   `KEYCLOAK_ADMIN_USER` and `KEYCLOAK_ADMIN_PASSWORD`, add `--apply`.
   It creates matching users without passwords, never modifies staff/patient
   rows, and disables suspended identities. Keycloak's bootstrap admin is in
   the `master` realm. **Do not put admin credentials in the long-running app
   container**; supply them only to the one-off migration process. Once SMTP
   works, use Keycloak's admin UI to send each account a required-actions
   email to verify its address and set a new password. Clerk passwords cannot
   be exported or carried over. Existing active staff regain the same role
   after verified sign-in; newly invited staff need owner activation.
5. Freeze clinic writes briefly, take a final database backup, restore the
   latest data, and re-run both idempotent migrations before switching DNS.
   Compare source/destination document counts and sample file hashes; test
   owner and invited-staff sign-in, roles, clinical records, uploads/downloads,
   and Arabic/English views on the destination. Keep the source and backups
   until you have explicitly accepted the cutover. A database restore cannot
   reproduce file bytes by itself.

The migration utilities deliberately do **not** perform this cutover
automatically. No external destination, SMTP account, or actual user-owned
data migration has been configured or executed in this workspace.