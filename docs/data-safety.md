# DentOzone data safety and recovery

Patient information belongs only in the protected PostgreSQL database. The app's demo records are fictional and explicitly marked `is_demo`; never replace real patient records with a fresh seed.

## Backup strategy

1. Use the managed PostgreSQL production database's scheduled daily backup and point-in-time restore options in the Database tool settings. Confirm that backups are enabled and monitor the most recent restore point after publishing.
2. Before high-risk bulk data changes, export an additional encrypted PostgreSQL backup with a standard tool such as `pg_dump --format=custom`. Keep it outside public app directories and restrict access to the clinic owner/authorized operator. Do not commit dumps or credentials to Git.
3. Test restoring an export into a separate, non-production database periodically. A successful export file alone does not prove recovery works.
4. When document and x-ray storage is introduced, back up its App Storage objects and metadata together. A PostgreSQL dump alone will not include file bytes.

## Restoration

1. Stop writes and record the target environment and desired restore time. Tell affected staff that newer changes after the chosen point will be lost.
2. Make a fresh backup of the current target before restoring. Use the Database tool's scheduled backup or point-in-time restore for managed production. For external custom-format exports, restore with standard PostgreSQL tools only into the confirmed target, preferably a separate staging database first.
3. Check patient counts, recent edits, appointments, finance totals, and staff access after restoration before reopening the clinic system.
4. Do not use a development database restore as a substitute for restoring production data. Development and published environments have separate data and auth accounts.

## Before real patient use

- Bind the production owner's verified sign-in email with `DENTOZONE_OWNER_EMAIL` before publishing. Do not use the development first-user bootstrap as a public onboarding mechanism.
- Review authorized staff, permissions, privacy obligations, and backup access. The clinical modules and file storage from the full product brief are not yet available.