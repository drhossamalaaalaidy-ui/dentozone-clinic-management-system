import { Router, type IRouter } from "express";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  auditLogTable, db, laboratoryOrderHistoryTable, laboratoryOrdersTable,
  patientsTable, suppliersTable, visitsTable,
  type LaboratoryOrder,
} from "@workspace/db";
import { allowRoles, currentStaff } from "../middlewares/clinicStaff";

const router: IRouter = Router();
const reader = allowRoles("owner", "manager", "dentist", "assistant");
const writer = allowRoles("owner", "dentist");
const caseTypes = ["crown", "bridge", "denture", "implant", "orthodontic", "other"] as const;
const statuses = ["submitted", "in_progress", "ready", "delivered", "cancelled"] as const;
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value: string) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Expected a real calendar date");
const idParams = z.object({ orderId: z.coerce.number().int().positive() });
const patientParams = z.object({ patientId: z.coerce.number().int().positive() });
const createBody = z.object({
  visitId: z.number().int().positive().nullable().optional(),
  labName: z.string().trim().min(1).max(200),
  supplierId: z.number().int().positive().nullable().optional(),
  caseType: z.enum(caseTypes),
  dueDate: dateOnly.nullable().optional(),
  notes: z.string().max(10_000).nullable().optional(),
}).strict();
const updateBody = z.object({
  visitId: z.number().int().positive().nullable().optional(),
  labName: z.string().trim().min(1).max(200).optional(),
  supplierId: z.number().int().positive().nullable().optional(),
  caseType: z.enum(caseTypes).optional(),
  dueDate: dateOnly.nullable().optional(),
  status: z.enum(statuses).optional(),
  notes: z.string().max(10_000).nullable().optional(),
}).strict();

type OrderSnapshot = Pick<LaboratoryOrder,
  "patientId" | "visitId" | "labName" | "supplierId" | "caseType" | "dueDate" | "status" | "notes" | "isDemo">;

function snapshot(order: LaboratoryOrder): OrderSnapshot {
  return {
    patientId: order.patientId,
    visitId: order.visitId,
    labName: order.labName,
    supplierId: order.supplierId,
    caseType: order.caseType,
    dueDate: order.dueDate,
    status: order.status,
    notes: order.notes,
    isDemo: order.isDemo,
  };
}

function dto(order: LaboratoryOrder, history: typeof laboratoryOrderHistoryTable.$inferSelect[] = []) {
  return {
    ...order,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    history: history.map((entry) => ({
      ...entry,
      occurredAt: entry.occurredAt.toISOString(),
    })),
  };
}

function auditValues(
  actor: ReturnType<typeof currentStaff>,
  orderId: number,
  action: "create" | "update" | "cancel",
  before: OrderSnapshot | null,
  after: OrderSnapshot,
) {
  return {
    orderId,
    actorStaffId: actor.id,
    actorName: actor.name,
    action,
    before,
    after,
  };
}

function auditLogValues(
  actor: ReturnType<typeof currentStaff>,
  action: "create" | "update" | "cancel",
  orderId: number,
) {
  return {
    actorStaffId: actor.id,
    actorName: actor.name,
    action,
    entityType: "laboratory_order",
    entityId: orderId,
    summary: `Laboratory order ${orderId} ${action === "create" ? "created" : action === "cancel" ? "cancelled" : "updated"}`,
  };
}

function hasOnlyKeys(value: unknown, keys: string[]): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key));
}

async function addAudit(
  tx: Pick<typeof db, "insert">,
  actor: ReturnType<typeof currentStaff>,
  action: "create" | "update" | "cancel",
  order: LaboratoryOrder,
  before: OrderSnapshot | null,
): Promise<void> {
  await tx.insert(laboratoryOrderHistoryTable).values(
    auditValues(actor, order.id, action, before, snapshot(order)),
  );
  await tx.insert(auditLogTable).values(auditLogValues(actor, action, order.id));
}

async function orderWithHistory(order: LaboratoryOrder) {
  const history = await db.select().from(laboratoryOrderHistoryTable)
    .where(eq(laboratoryOrderHistoryTable.orderId, order.id))
    .orderBy(asc(laboratoryOrderHistoryTable.occurredAt), asc(laboratoryOrderHistoryTable.id));
  return dto(order, history);
}

router.get("/patients/:patientId/laboratory-orders", reader, async (req, res): Promise<void> => {
  const params = patientParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid patient ID" }); return; }
  const [patient] = await db.select({ id: patientsTable.id }).from(patientsTable)
    .where(eq(patientsTable.id, params.data.patientId));
  if (!patient) { res.status(404).json({ error: "Patient not found" }); return; }
  const orders = await db.select().from(laboratoryOrdersTable)
    .where(eq(laboratoryOrdersTable.patientId, patient.id))
    .orderBy(desc(laboratoryOrdersTable.createdAt), desc(laboratoryOrdersTable.id));
  const history = orders.length
    ? await db.select().from(laboratoryOrderHistoryTable)
      .where(inArray(laboratoryOrderHistoryTable.orderId, orders.map((order) => order.id)))
      .orderBy(asc(laboratoryOrderHistoryTable.occurredAt), asc(laboratoryOrderHistoryTable.id))
    : [];
  const historyByOrder = new Map<number, typeof history>();
  for (const entry of history) {
    const entries = historyByOrder.get(entry.orderId) ?? [];
    entries.push(entry);
    historyByOrder.set(entry.orderId, entries);
  }
  res.json(orders.map((order) => dto(order, historyByOrder.get(order.id) ?? [])));
});

router.post("/patients/:patientId/laboratory-orders", writer, async (req, res): Promise<void> => {
  const params = patientParams.safeParse(req.params);
  const parsed = hasOnlyKeys(req.body, [
    "visitId", "labName", "supplierId", "caseType", "dueDate", "status", "notes",
  ]) ? createBody.safeParse(req.body) : null;
  if (!params.success || !parsed?.success) {
    res.status(400).json({ error: !params.success ? "Invalid patient ID"
      : parsed && !parsed.success ? parsed.error.message : "Unexpected laboratory order field" });
    return;
  }
  const actor = currentStaff(res);
  const outcome = await db.transaction(async (tx) => {
    const [patient] = await tx.select().from(patientsTable)
      .where(eq(patientsTable.id, params.data.patientId));
    if (!patient) return { error: "patient_not_found" as const };
    if (patient.status !== "active") return { error: "patient_inactive" as const };
    if (parsed.data.visitId != null) {
      const [visit] = await tx.select({ patientId: visitsTable.patientId }).from(visitsTable)
        .where(eq(visitsTable.id, parsed.data.visitId));
      if (!visit) return { error: "visit_not_found" as const };
      if (visit.patientId !== patient.id) return { error: "visit_mismatch" as const };
    }
    if (parsed.data.supplierId != null) {
      const [supplier] = await tx.select({ id: suppliersTable.id, active: suppliersTable.active })
        .from(suppliersTable).where(eq(suppliersTable.id, parsed.data.supplierId));
      if (!supplier || !supplier.active) return { error: "supplier_not_found" as const };
    }
    const [created] = await tx.insert(laboratoryOrdersTable).values({
      patientId: patient.id,
      visitId: parsed.data.visitId ?? null,
      labName: parsed.data.labName,
      supplierId: parsed.data.supplierId ?? null,
      caseType: parsed.data.caseType,
      dueDate: parsed.data.dueDate ?? null,
      status: "submitted",
      notes: parsed.data.notes ?? null,
      createdByStaffId: actor.id,
      updatedByStaffId: actor.id,
      isDemo: patient.isDemo,
    }).returning();
    await addAudit(tx, actor, "create", created, null);
    return { order: created };
  });
  if ("error" in outcome) {
    const notFound = outcome.error === "patient_not_found" || outcome.error === "visit_not_found"
      || outcome.error === "supplier_not_found";
    res.status(notFound ? 404 : 409).json({
      error: outcome.error === "patient_not_found" ? "Patient not found"
        : outcome.error === "patient_inactive" ? "Patient is inactive"
          : outcome.error === "visit_not_found" ? "Visit not found"
            : outcome.error === "visit_mismatch" ? "Visit does not belong to this patient"
              : "Active supplier not found",
    });
    return;
  }
  res.status(201).json(await orderWithHistory(outcome.order));
});

router.get("/laboratory-orders/:orderId", reader, async (req, res): Promise<void> => {
  const params = idParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid laboratory order ID" }); return; }
  const [order] = await db.select().from(laboratoryOrdersTable)
    .where(eq(laboratoryOrdersTable.id, params.data.orderId));
  if (!order) { res.status(404).json({ error: "Laboratory order not found" }); return; }
  res.json(await orderWithHistory(order));
});

router.patch("/laboratory-orders/:orderId", writer, async (req, res): Promise<void> => {
  const params = idParams.safeParse(req.params);
  const parsed = hasOnlyKeys(req.body, [
    "visitId", "labName", "supplierId", "caseType", "dueDate", "status", "notes",
  ]) ? updateBody.safeParse(req.body) : null;
  if (!params.success || !parsed?.success) {
    res.status(400).json({ error: !params.success ? "Invalid laboratory order ID"
      : parsed && !parsed.success ? parsed.error.message : "Unexpected laboratory order field" });
    return;
  }
  if (!Object.keys(parsed.data).length) {
    res.status(400).json({ error: "Provide at least one laboratory order change" });
    return;
  }
  const actor = currentStaff(res);
  const outcome = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(laboratoryOrdersTable)
      .where(eq(laboratoryOrdersTable.id, params.data.orderId)).for("update");
    if (!existing) return { error: "not_found" as const };
    const [patient] = await tx.select({ id: patientsTable.id, status: patientsTable.status })
      .from(patientsTable).where(eq(patientsTable.id, existing.patientId));
    if (!patient || patient.status !== "active") return { error: "patient_inactive" as const };
    if (existing.status === "delivered" || existing.status === "cancelled") {
      return { error: "closed" as const };
    }
    if (parsed.data.visitId !== undefined && parsed.data.visitId !== null) {
      const [visit] = await tx.select({ patientId: visitsTable.patientId }).from(visitsTable)
        .where(eq(visitsTable.id, parsed.data.visitId));
      if (!visit) return { error: "visit_not_found" as const };
      if (visit.patientId !== existing.patientId) return { error: "visit_mismatch" as const };
    }
    if (parsed.data.supplierId !== undefined && parsed.data.supplierId !== null) {
      const [supplier] = await tx.select({ id: suppliersTable.id, active: suppliersTable.active })
        .from(suppliersTable).where(eq(suppliersTable.id, parsed.data.supplierId));
      if (!supplier || !supplier.active) return { error: "supplier_not_found" as const };
    }
    if (parsed.data.status !== undefined && parsed.data.status !== existing.status) {
      const allowed: Record<string, string[]> = {
        submitted: ["in_progress", "cancelled"],
        in_progress: ["ready", "cancelled"],
        ready: ["in_progress", "delivered", "cancelled"],
      };
      if (!allowed[existing.status]?.includes(parsed.data.status)) {
        return { error: "invalid_transition" as const };
      }
    }
    const [updated] = await tx.update(laboratoryOrdersTable).set({
      ...(parsed.data.visitId !== undefined ? { visitId: parsed.data.visitId } : {}),
      ...(parsed.data.labName !== undefined ? { labName: parsed.data.labName } : {}),
      ...(parsed.data.supplierId !== undefined ? { supplierId: parsed.data.supplierId } : {}),
      ...(parsed.data.caseType !== undefined ? { caseType: parsed.data.caseType } : {}),
      ...(parsed.data.dueDate !== undefined ? { dueDate: parsed.data.dueDate } : {}),
      ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
      ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
      updatedByStaffId: actor.id,
      updatedAt: new Date(),
    }).where(eq(laboratoryOrdersTable.id, existing.id)).returning();
    await addAudit(tx, actor, "update", updated, snapshot(existing));
    return { order: updated };
  });
  if ("error" in outcome) {
    const notFound = outcome.error === "not_found" || outcome.error === "visit_not_found"
      || outcome.error === "supplier_not_found";
    const status = notFound ? 404 : outcome.error === "visit_mismatch" ? 409
      : outcome.error === "closed" || outcome.error === "invalid_transition" || outcome.error === "patient_inactive" ? 409 : 400;
    res.status(status).json({
      error: outcome.error === "not_found" ? "Laboratory order not found"
        : outcome.error === "patient_inactive" ? "Patient is inactive"
          : outcome.error === "visit_not_found" ? "Visit not found"
            : outcome.error === "visit_mismatch" ? "Visit does not belong to this patient"
              : outcome.error === "supplier_not_found" ? "Active supplier not found"
                : outcome.error === "invalid_transition" ? "Invalid laboratory order status transition"
                  : "Delivered or cancelled orders cannot be changed",
    });
    return;
  }
  res.json(await orderWithHistory(outcome.order));
});

router.delete("/laboratory-orders/:orderId", writer, async (req, res): Promise<void> => {
  const params = idParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid laboratory order ID" }); return; }
  const actor = currentStaff(res);
  const outcome = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(laboratoryOrdersTable)
      .where(eq(laboratoryOrdersTable.id, params.data.orderId)).for("update");
    if (!existing) return { error: "not_found" as const };
    if (existing.status === "delivered" || existing.status === "cancelled") {
      return { error: "closed" as const };
    }
    const [cancelled] = await tx.update(laboratoryOrdersTable)
      .set({ status: "cancelled", updatedByStaffId: actor.id, updatedAt: new Date() })
      .where(eq(laboratoryOrdersTable.id, existing.id)).returning();
    await addAudit(tx, actor, "cancel", cancelled, snapshot(existing));
    return { order: cancelled };
  });
  if ("error" in outcome) {
    res.status(outcome.error === "not_found" ? 404 : 409).json({
      error: outcome.error === "not_found" ? "Laboratory order not found" : "Delivered or cancelled orders cannot be cancelled",
    });
    return;
  }
  res.json(await orderWithHistory(outcome.order));
});

export default router;