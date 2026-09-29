import { Router, type IRouter } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  db, auditLogTable, odontogramEntriesTable, patientsTable, staffTable,
  treatmentPlanItemsTable, treatmentPlansTable,
} from "@workspace/db";
import {
  AddTreatmentPlanItemBody, AddTreatmentPlanItemParams, AddTreatmentPlanItemResponse,
  CreateToothFindingBody, CreateToothFindingParams, CreateToothFindingResponse,
  CreateTreatmentPlanBody, CreateTreatmentPlanParams, CreateTreatmentPlanResponse,
  GetTreatmentPlanParams, GetTreatmentPlanResponse,
  ListPatientOdontogramParams, ListPatientOdontogramResponse,
  ListPatientTreatmentPlansParams, ListPatientTreatmentPlansResponse,
  UpdateTreatmentPlanBody, UpdateTreatmentPlanItemBody, UpdateTreatmentPlanItemParams,
  UpdateTreatmentPlanItemResponse, UpdateTreatmentPlanParams, UpdateTreatmentPlanResponse,
} from "@workspace/api-zod";
import { allowRoles, currentStaff } from "../middlewares/clinicStaff";

const router: IRouter = Router();
const clinicalRead = allowRoles("owner", "manager", "dentist", "assistant");
const clinicalWrite = allowRoles("owner", "dentist");

function auditValues(actor: ReturnType<typeof currentStaff>, action: string, entity: string, id: number, summary: string) {
  return {
    actorStaffId: actor.id, actorName: actor.name, action,
    entityType: entity, entityId: id, summary,
  };
}

function validToothCode(code: string, dentition?: "adult" | "child"): boolean {
  if (!/^[1-8][1-8]$/.test(code)) return false;
  const quadrant = Number(code[0]);
  const position = Number(code[1]);
  const adult = quadrant >= 1 && quadrant <= 4 && position <= 8;
  const child = quadrant >= 5 && quadrant <= 8 && position <= 5;
  if (dentition === "adult") return adult;
  if (dentition === "child") return child;
  return adult || child;
}

function normalizedSurfaces(surfaces: string[] | undefined): string[] | null {
  const values = surfaces ?? [];
  if (values.some((surface) => !["M", "O", "D", "B", "L", "I"].includes(surface))) return null;
  return [...new Set(values)];
}

function nonempty(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

async function treatmentPlanDto(planId: number) {
  const [plan] = await db.select({
    id: treatmentPlansTable.id,
    patientId: treatmentPlansTable.patientId,
    patientName: patientsTable.fullName,
    title: treatmentPlansTable.title,
    goal: treatmentPlansTable.goal,
    status: treatmentPlansTable.status,
    createdByName: staffTable.name,
    createdAt: treatmentPlansTable.createdAt,
    updatedAt: treatmentPlansTable.updatedAt,
    isDemo: treatmentPlansTable.isDemo,
  }).from(treatmentPlansTable)
    .innerJoin(patientsTable, eq(patientsTable.id, treatmentPlansTable.patientId))
    .innerJoin(staffTable, eq(staffTable.id, treatmentPlansTable.createdByStaffId))
    .where(eq(treatmentPlansTable.id, planId));
  if (!plan) return null;
  const items = await db.select({
    id: treatmentPlanItemsTable.id,
    planId: treatmentPlanItemsTable.planId,
    description: treatmentPlanItemsTable.description,
    toothCode: treatmentPlanItemsTable.toothCode,
    priority: treatmentPlanItemsTable.priority,
    status: treatmentPlanItemsTable.status,
    notes: treatmentPlanItemsTable.notes,
  }).from(treatmentPlanItemsTable)
    .where(eq(treatmentPlanItemsTable.planId, planId))
    .orderBy(asc(treatmentPlanItemsTable.id));
  return { ...plan, items };
}

router.get("/patients/:patientId/odontogram", clinicalRead, async (req, res): Promise<void> => {
  const params = ListPatientOdontogramParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [patient] = await db.select({ id: patientsTable.id }).from(patientsTable)
    .where(eq(patientsTable.id, params.data.patientId));
  if (!patient) {
    res.status(404).json({ error: "Patient not found" });
    return;
  }
  const rows = await db.select({
    id: odontogramEntriesTable.id,
    patientId: odontogramEntriesTable.patientId,
    dentition: odontogramEntriesTable.dentition,
    toothCode: odontogramEntriesTable.toothCode,
    condition: odontogramEntriesTable.condition,
    surfaces: odontogramEntriesTable.surfaces,
    notes: odontogramEntriesTable.notes,
    recordedAt: odontogramEntriesTable.recordedAt,
    recordedByName: staffTable.name,
  }).from(odontogramEntriesTable)
    .innerJoin(staffTable, eq(staffTable.id, odontogramEntriesTable.recordedByStaffId))
    .where(eq(odontogramEntriesTable.patientId, params.data.patientId))
    .orderBy(desc(odontogramEntriesTable.recordedAt), desc(odontogramEntriesTable.id));
  const latest = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    const key = `${row.dentition}:${row.toothCode}`;
    if (!latest.has(key)) latest.set(key, row);
  }
  res.json(ListPatientOdontogramResponse.parse([...latest.values()]));
});

router.post("/patients/:patientId/odontogram", clinicalWrite, async (req, res): Promise<void> => {
  const params = CreateToothFindingParams.safeParse(req.params);
  const parsed = CreateToothFindingBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: params.success ? parsed.error?.message : params.error.message });
    return;
  }
  const input = parsed.data;
  const surfaces = normalizedSurfaces(input.surfaces);
  if (!validToothCode(input.toothCode, input.dentition) || surfaces === null) {
    res.status(400).json({ error: "Invalid tooth code, dentition, or surface" });
    return;
  }
  const actor = currentStaff(res);
  const outcome = await db.transaction(async (tx) => {
    const [patient] = await tx.select().from(patientsTable).where(eq(patientsTable.id, params.data.patientId));
    if (!patient) return { error: "not_found" as const };
    if (patient.status !== "active") return { error: "inactive" as const };
    const [finding] = await tx.insert(odontogramEntriesTable).values({
      patientId: patient.id,
      dentition: input.dentition,
      toothCode: input.toothCode,
      condition: input.condition,
      surfaces,
      notes: input.notes ?? null,
      recordedByStaffId: actor.id,
    }).returning();
    await tx.insert(auditLogTable).values(auditValues(actor, "create", "odontogram_finding", finding.id,
      `Tooth finding recorded for patient ${patient.id}, tooth ${input.toothCode}`));
    return { finding };
  });
  if ("error" in outcome) {
    res.status(outcome.error === "not_found" ? 404 : 409)
      .json({ error: outcome.error === "not_found" ? "Patient not found" : "Patient is inactive" });
    return;
  }
  const result = {
    ...outcome.finding,
    recordedAt: outcome.finding.recordedAt.toISOString(),
    recordedByName: actor.name,
  };
  res.status(201).json(CreateToothFindingResponse.parse(result));
});

router.get("/patients/:patientId/treatment-plans", clinicalRead, async (req, res): Promise<void> => {
  const params = ListPatientTreatmentPlansParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [patient] = await db.select({ id: patientsTable.id }).from(patientsTable)
    .where(eq(patientsTable.id, params.data.patientId));
  if (!patient) {
    res.status(404).json({ error: "Patient not found" });
    return;
  }
  const rows = await db.select({ id: treatmentPlansTable.id }).from(treatmentPlansTable)
    .where(eq(treatmentPlansTable.patientId, params.data.patientId))
    .orderBy(desc(treatmentPlansTable.createdAt), desc(treatmentPlansTable.id));
  const plans = await Promise.all(rows.map(({ id }) => treatmentPlanDto(id)));
  res.json(ListPatientTreatmentPlansResponse.parse(plans.filter((plan) => plan !== null)));
});

router.post("/patients/:patientId/treatment-plans", clinicalWrite, async (req, res): Promise<void> => {
  const params = CreateTreatmentPlanParams.safeParse(req.params);
  const parsed = CreateTreatmentPlanBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: params.success ? parsed.error?.message : params.error.message });
    return;
  }
  const title = nonempty(parsed.data.title);
  if (!title || parsed.data.items?.some((item) => !nonempty(item.description)
    || (item.toothCode != null && !validToothCode(item.toothCode)))) {
    res.status(400).json({ error: "Plan title, item descriptions, or tooth codes are invalid" });
    return;
  }
  const actor = currentStaff(res);
  const created = await db.transaction(async (tx) => {
    const [patient] = await tx.select().from(patientsTable).where(eq(patientsTable.id, params.data.patientId));
    if (!patient) return { error: "not_found" as const };
    if (patient.status !== "active") return { error: "inactive" as const };
    const [plan] = await tx.insert(treatmentPlansTable).values({
      patientId: patient.id,
      title,
      goal: parsed.data.goal ?? null,
      createdByStaffId: actor.id,
      isDemo: patient.isDemo,
    }).returning();
    if (parsed.data.items?.length) {
      await tx.insert(treatmentPlanItemsTable).values(parsed.data.items.map((item) => ({
        planId: plan.id,
        description: item.description.trim(),
        toothCode: item.toothCode ?? null,
        priority: item.priority ?? 2,
        notes: item.notes ?? null,
      })));
    }
    await tx.insert(auditLogTable).values(auditValues(actor, "create", "treatment_plan", plan.id,
      `Treatment plan ${plan.id} created for patient ${patient.id}`));
    return { planId: plan.id };
  });
  if ("error" in created) {
    res.status(created.error === "not_found" ? 404 : 409)
      .json({ error: created.error === "not_found" ? "Patient not found" : "Patient is inactive" });
    return;
  }
  const dto = await treatmentPlanDto(created.planId);
  res.status(201).json(CreateTreatmentPlanResponse.parse(dto));
});

router.get("/treatment-plans/:planId", clinicalRead, async (req, res): Promise<void> => {
  const params = GetTreatmentPlanParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const plan = await treatmentPlanDto(params.data.planId);
  if (!plan) {
    res.status(404).json({ error: "Treatment plan not found" });
    return;
  }
  res.json(GetTreatmentPlanResponse.parse(plan));
});

router.patch("/treatment-plans/:planId", clinicalWrite, async (req, res): Promise<void> => {
  const params = UpdateTreatmentPlanParams.safeParse(req.params);
  const parsed = UpdateTreatmentPlanBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: params.success ? parsed.error?.message : params.error.message });
    return;
  }
  if (!Object.keys(parsed.data).length
    || (parsed.data.title !== undefined && !nonempty(parsed.data.title))) {
    res.status(400).json({ error: "A nonempty title and at least one change are required" });
    return;
  }
  const actor = currentStaff(res);
  const outcome = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(treatmentPlansTable)
      .where(eq(treatmentPlansTable.id, params.data.planId))
      .for("update");
    if (!existing) return { error: "not_found" as const };
    if (existing.status === "completed" || existing.status === "cancelled") return { error: "immutable" as const };
    const [patient] = await tx.select({ status: patientsTable.status }).from(patientsTable)
      .where(eq(patientsTable.id, existing.patientId));
    if (!patient || patient.status !== "active") return { error: "inactive" as const };
    const [plan] = await tx.update(treatmentPlansTable).set({
      ...(parsed.data.title !== undefined ? { title: parsed.data.title.trim() } : {}),
      ...(parsed.data.goal !== undefined ? { goal: parsed.data.goal } : {}),
      ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
      updatedAt: new Date(),
    }).where(eq(treatmentPlansTable.id, existing.id)).returning();
    await tx.insert(auditLogTable).values(auditValues(actor, "update", "treatment_plan", plan.id,
      `Treatment plan ${plan.id} updated`));
    return { planId: plan.id };
  });
  if ("error" in outcome) {
    const status = outcome.error === "not_found" ? 404 : 409;
    res.status(status).json({ error: outcome.error === "not_found" ? "Treatment plan not found"
      : outcome.error === "immutable" ? "Completed or cancelled treatment plans cannot be modified"
        : "Patient is inactive" });
    return;
  }
  const dto = await treatmentPlanDto(outcome.planId);
  res.json(UpdateTreatmentPlanResponse.parse(dto));
});

router.post("/treatment-plans/:planId/items", clinicalWrite, async (req, res): Promise<void> => {
  const params = AddTreatmentPlanItemParams.safeParse(req.params);
  const parsed = AddTreatmentPlanItemBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: params.success ? parsed.error?.message : params.error.message });
    return;
  }
  const description = nonempty(parsed.data.description);
  if (!description || (parsed.data.toothCode != null && !validToothCode(parsed.data.toothCode))) {
    res.status(400).json({ error: "Item description or tooth code is invalid" });
    return;
  }
  const actor = currentStaff(res);
  const outcome = await db.transaction(async (tx) => {
    const [plan] = await tx.select().from(treatmentPlansTable)
      .where(eq(treatmentPlansTable.id, params.data.planId))
      .for("update");
    if (!plan) return { error: "not_found" as const };
    if (plan.status === "completed" || plan.status === "cancelled") return { error: "immutable" as const };
    const [patient] = await tx.select({ status: patientsTable.status }).from(patientsTable)
      .where(eq(patientsTable.id, plan.patientId));
    if (!patient || patient.status !== "active") return { error: "inactive" as const };
    const [item] = await tx.insert(treatmentPlanItemsTable).values({
      planId: plan.id,
      description,
      toothCode: parsed.data.toothCode ?? null,
      priority: parsed.data.priority ?? 2,
      notes: parsed.data.notes ?? null,
    }).returning();
    await tx.insert(auditLogTable).values(auditValues(actor, "create", "treatment_plan_item", item.id,
      `Item ${item.id} added to treatment plan ${plan.id}`));
    return { item };
  });
  if ("error" in outcome) {
    const status = outcome.error === "not_found" ? 404 : 409;
    res.status(status).json({ error: outcome.error === "not_found" ? "Treatment plan not found"
      : outcome.error === "immutable" ? "Completed or cancelled treatment plans cannot be modified"
        : "Patient is inactive" });
    return;
  }
  res.status(201).json(AddTreatmentPlanItemResponse.parse(outcome.item));
});

router.patch("/treatment-plans/:planId/items/:itemId", clinicalWrite, async (req, res): Promise<void> => {
  const params = UpdateTreatmentPlanItemParams.safeParse(req.params);
  const parsed = UpdateTreatmentPlanItemBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: params.success ? parsed.error?.message : params.error.message });
    return;
  }
  if (!Object.keys(parsed.data).length
    || (parsed.data.description !== undefined && !nonempty(parsed.data.description))
    || (parsed.data.toothCode != null && !validToothCode(parsed.data.toothCode))) {
    res.status(400).json({ error: "Invalid item update" });
    return;
  }
  const actor = currentStaff(res);
  const outcome = await db.transaction(async (tx) => {
    const [plan] = await tx.select().from(treatmentPlansTable)
      .where(eq(treatmentPlansTable.id, params.data.planId))
      .for("update");
    if (!plan) return { error: "not_found" as const };
    const [item] = await tx.select().from(treatmentPlanItemsTable).where(and(
      eq(treatmentPlanItemsTable.id, params.data.itemId),
      eq(treatmentPlanItemsTable.planId, plan.id),
    ));
    if (!item) return { error: "item_not_found" as const };
    if (plan.status === "completed" || plan.status === "cancelled") return { error: "immutable" as const };
    const [patient] = await tx.select({ status: patientsTable.status }).from(patientsTable)
      .where(eq(patientsTable.id, plan.patientId));
    if (!patient || patient.status !== "active") return { error: "inactive" as const };
    const [updated] = await tx.update(treatmentPlanItemsTable).set({
      ...(parsed.data.description !== undefined ? { description: parsed.data.description.trim() } : {}),
      ...(parsed.data.toothCode !== undefined ? { toothCode: parsed.data.toothCode } : {}),
      ...(parsed.data.priority !== undefined ? { priority: parsed.data.priority } : {}),
      ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
      ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
      updatedAt: new Date(),
    }).where(eq(treatmentPlanItemsTable.id, item.id)).returning();
    await tx.insert(auditLogTable).values(auditValues(actor, "update", "treatment_plan_item", updated.id,
      `Item ${updated.id} updated in treatment plan ${plan.id}`));
    return { item: updated };
  });
  if ("error" in outcome) {
    const status = outcome.error === "not_found" || outcome.error === "item_not_found" ? 404 : 409;
    res.status(status).json({ error: outcome.error === "not_found" ? "Treatment plan not found"
      : outcome.error === "item_not_found" ? "Treatment plan item not found"
        : outcome.error === "immutable" ? "Completed or cancelled treatment plans cannot be modified"
          : "Patient is inactive" });
    return;
  }
  res.json(UpdateTreatmentPlanItemResponse.parse(outcome.item));
});

export default router;