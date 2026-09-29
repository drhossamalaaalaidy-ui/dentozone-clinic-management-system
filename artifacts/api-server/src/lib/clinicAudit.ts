import { auditLogTable, db, type Staff } from "@workspace/db";

export async function recordAudit(
  actor: Staff,
  action: string,
  entityType: string,
  entityId: number | null,
  summary: string,
): Promise<void> {
  await db.insert(auditLogTable).values({
    actorStaffId: actor.id,
    actorName: actor.name,
    action,
    entityType,
    entityId,
    summary,
  });
}