import { Router, type IRouter } from "express";
import { desc } from "drizzle-orm";
import { auditLogTable, db } from "@workspace/db";
import { GetAuditLogQueryParams, GetAuditLogResponse } from "@workspace/api-zod";
import { allowRoles } from "../middlewares/clinicStaff";

const router: IRouter = Router();

router.get("/audit-log", allowRoles("owner", "manager"), async (req, res): Promise<void> => {
  const parsed = GetAuditLogQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const events = await db.select().from(auditLogTable)
    .orderBy(desc(auditLogTable.createdAt))
    .limit(parsed.data.limit);
  res.json(GetAuditLogResponse.parse(events));
});

export default router;