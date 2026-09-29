import { clerkClient } from "@clerk/express";
import { Router, type IRouter } from "express";
import { asc, eq } from "drizzle-orm";
import { db, staffTable } from "@workspace/db";
import {
  GetSessionResponse, GetStaffResponse, InviteStaffBody, InviteStaffResponse,
  UpdateStaffBody, UpdateStaffParams, UpdateStaffResponse,
} from "@workspace/api-zod";
import { allowRoles, currentStaff } from "../middlewares/clinicStaff";
import { recordAudit } from "../lib/clinicAudit";

const router: IRouter = Router();

function staffDto(staff: typeof staffTable.$inferSelect) {
  return {
    id: staff.id,
    email: staff.email,
    name: staff.name,
    role: staff.role,
    status: staff.status,
    createdAt: staff.createdAt.toISOString(),
  };
}

router.get("/session", (_req, res): void => {
  res.json(GetSessionResponse.parse(staffDto(currentStaff(res))));
});

router.get("/staff", allowRoles("owner", "manager"), async (_req, res): Promise<void> => {
  const staff = await db.select().from(staffTable).orderBy(asc(staffTable.createdAt));
  GetStaffResponse.parse(staff.map(staffDto));
  res.json(staff.map(staffDto));
});

router.post("/staff", allowRoles("owner"), async (req, res): Promise<void> => {
  const parsed = InviteStaffBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  if (parsed.data.role === "owner") {
    res.status(403).json({ error: "The owner role cannot be assigned by invitation" });
    return;
  }
  const [existing] = await db.select().from(staffTable).where(eq(staffTable.email, email));
  if (existing) {
    res.status(409).json({ error: "This email is already on the staff list" });
    return;
  }
  const [staff] = await db.insert(staffTable).values({
    email,
    name: parsed.data.name?.trim() || email.split("@")[0],
    role: parsed.data.role,
    status: "invited",
  }).returning();
  if (process.env.AUTH_PROVIDER !== "oidc") {
    try {
      await clerkClient.invitations.createInvitation({ emailAddress: email });
    } catch (error) {
      req.log.error({ err: error }, "Could not send staff invitation");
      res.status(502).json({ error: "Invitation could not be sent; the staff allowlist entry remains invited" });
      return;
    }
  }
  await recordAudit(currentStaff(res), "invite", "staff", staff.id, `Staff invitation created for ${staff.id}`);
  InviteStaffResponse.parse(staffDto(staff));
  res.status(201).json(staffDto(staff));
});

router.patch("/staff/:staffId", allowRoles("owner"), async (req, res): Promise<void> => {
  const params = UpdateStaffParams.safeParse(req.params);
  const parsed = UpdateStaffBody.safeParse(req.body);
  if (!params.success || !parsed.success || !Object.keys(parsed.data).length) {
    res.status(400).json({ error: "Invalid staff update" });
    return;
  }
  const [existing] = await db.select().from(staffTable).where(eq(staffTable.id, params.data.staffId));
  if (!existing) {
    res.status(404).json({ error: "Staff member not found" });
    return;
  }
  if ((existing.role === "owner" && (parsed.data.role || parsed.data.status)) || parsed.data.role === "owner") {
    res.status(403).json({ error: "The clinic owner cannot be removed or reassigned" });
    return;
  }
  if (parsed.data.status === "active" && !existing.clerkUserId) {
    res.status(400).json({ error: "An invited staff member must first sign in to activate" });
    return;
  }
  const [updated] = await db.update(staffTable).set(parsed.data)
    .where(eq(staffTable.id, existing.id)).returning();
  await recordAudit(currentStaff(res), "update", "staff", updated.id, `Staff ${updated.id} permissions updated`);
  UpdateStaffResponse.parse(staffDto(updated));
  res.json(staffDto(updated));
});

export default router;