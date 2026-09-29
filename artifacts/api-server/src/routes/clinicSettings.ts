import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, clinicSettingsTable } from "@workspace/db";
import {
  GetClinicSettingsResponse, UpdateClinicSettingsBody, UpdateClinicSettingsResponse,
} from "@workspace/api-zod";
import { allowRoles, currentStaff } from "../middlewares/clinicStaff";
import { recordAudit } from "../lib/clinicAudit";

const router: IRouter = Router();

async function settings() {
  await db.insert(clinicSettingsTable).values({ id: 1 }).onConflictDoNothing();
  const [record] = await db.select().from(clinicSettingsTable).where(eq(clinicSettingsTable.id, 1));
  return record;
}

router.get("/clinic-settings", async (_req, res): Promise<void> => {
  const record = await settings();
  res.json(GetClinicSettingsResponse.parse(record));
});

router.patch("/clinic-settings", allowRoles("owner", "manager"), async (req, res): Promise<void> => {
  const parsed = UpdateClinicSettingsBody.safeParse(req.body);
  if (!parsed.success || !Object.keys(parsed.data).length) {
    res.status(400).json({ error: "Invalid settings update" });
    return;
  }
  await settings();
  const [updated] = await db.update(clinicSettingsTable)
    .set(parsed.data)
    .where(eq(clinicSettingsTable.id, 1))
    .returning();
  await recordAudit(currentStaff(res), "update", "clinic_settings", 1, "Clinic settings updated");
  res.json(UpdateClinicSettingsResponse.parse(updated));
});

export default router;