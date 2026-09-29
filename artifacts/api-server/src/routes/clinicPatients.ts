import { Router, type IRouter } from "express";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import { db, patientsTable, type Patient } from "@workspace/db";
import {
  CreatePatientBody, CreatePatientResponse, GetPatientParams, GetPatientResponse,
  GetPatientsQueryParams, GetPatientsResponse, UpdatePatientBody, UpdatePatientParams,
  UpdatePatientResponse,
} from "@workspace/api-zod";
import { allowRoles, currentStaff } from "../middlewares/clinicStaff";
import { recordAudit } from "../lib/clinicAudit";
import { canWriteClinicalHistory } from "../lib/clinicPolicy";

const router: IRouter = Router();
const reader = allowRoles("owner", "manager", "dentist", "reception", "assistant");
const writer = allowRoles("owner", "manager", "dentist", "reception");
const clinicalFields = [
  "allergies", "medications", "medicalConditions", "previousSurgeries", "diabetes",
  "hypertension", "heartDisease", "bleedingDisorders", "pregnancy", "smoking",
  "previousDentalTreatment", "previousOrthodonticTreatment", "oralHygiene",
  "dentalComplaints", "previousDentist", "notes",
] as const;

function patientDto(patient: Patient, role: string) {
  const dto = {
    ...patient,
    patientCode: `DZO-${String(patient.id).padStart(5, "0")}`,
    registrationDate: patient.registrationDate.toISOString(),
  };
  if (role !== "reception") return dto;
  return {
    ...dto,
    allergies: null, medications: null, medicalConditions: null, previousSurgeries: null,
    diabetes: false, hypertension: false, heartDisease: false, bleedingDisorders: false,
    pregnancy: false, smoking: false, previousDentalTreatment: null,
    previousOrthodonticTreatment: null, oralHygiene: null, dentalComplaints: null,
    previousDentist: null, notes: null,
  };
}

function normalizeBody(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const normalized = { ...body } as Record<string, unknown>;
  for (const key of [
    "dateOfBirth", "whatsapp", "email", "address", "emergencyContact", "occupation",
    "referralSource", "allergies", "medications", "medicalConditions", "previousSurgeries",
    "previousDentalTreatment", "previousOrthodonticTreatment", "oralHygiene",
    "dentalComplaints", "previousDentist", "notes",
  ]) {
    if (normalized[key] === "") normalized[key] = null;
  }
  return normalized;
}

function toDbInput<T extends { dateOfBirth?: Date | null }>(input: T) {
  return {
    ...input,
    dateOfBirth: input.dateOfBirth === undefined
      ? undefined
      : input.dateOfBirth?.toISOString().slice(0, 10) ?? null,
  };
}

router.get("/patients", reader, async (req, res): Promise<void> => {
  const parsed = GetPatientsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { search, limit, offset } = parsed.data;
  const needle = search?.trim();
  const rows = await db.select().from(patientsTable)
    .where(needle ? or(
      ilike(patientsTable.fullName, `%${needle}%`),
      ilike(patientsTable.phone, `%${needle}%`),
      ilike(patientsTable.email, `%${needle}%`),
    ) : undefined)
    .orderBy(desc(patientsTable.registrationDate))
    .limit(limit).offset(offset);
  const result = rows.map((row) => patientDto(row, currentStaff(res).role));
  GetPatientsResponse.parse(result);
  res.json(result);
});

router.post("/patients", writer, async (req, res): Promise<void> => {
  const parsed = CreatePatientBody.safeParse(normalizeBody(req.body));
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const input = toDbInput(parsed.data);
  const actor = currentStaff(res);
  if (!canWriteClinicalHistory(actor.role) && clinicalFields.some((field) => {
    const value = parsed.data[field];
    return value !== undefined && value !== null && value !== "" && value !== false;
  })) {
    res.status(403).json({ error: "Clinical history can only be entered by clinical staff" });
    return;
  }
  const [patient] = await db.insert(patientsTable).values(input).returning();
  await recordAudit(actor, "create", "patient", patient.id, `Patient ${patient.id} registered`);
  const result = patientDto(patient, actor.role);
  CreatePatientResponse.parse(result);
  res.status(201).json(result);
});

router.get("/patients/:patientId", reader, async (req, res): Promise<void> => {
  const params = GetPatientParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [patient] = await db.select().from(patientsTable).where(eq(patientsTable.id, params.data.patientId));
  if (!patient) {
    res.status(404).json({ error: "Patient not found" });
    return;
  }
  const result = patientDto(patient, currentStaff(res).role);
  GetPatientResponse.parse(result);
  res.json(result);
});

router.patch("/patients/:patientId", writer, async (req, res): Promise<void> => {
  const params = UpdatePatientParams.safeParse(req.params);
  const parsed = UpdatePatientBody.safeParse(normalizeBody(req.body));
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Invalid patient update" });
    return;
  }
  if (!Object.keys(parsed.data).length) {
    res.status(400).json({ error: "No changes provided" });
    return;
  }
  const actor = currentStaff(res);
  if (!canWriteClinicalHistory(actor.role) && clinicalFields.some((field) => field in parsed.data)) {
    res.status(403).json({ error: "Clinical history can only be edited by clinical staff" });
    return;
  }
  const [patient] = await db.update(patientsTable).set(toDbInput(parsed.data))
    .where(eq(patientsTable.id, params.data.patientId)).returning();
  if (!patient) {
    res.status(404).json({ error: "Patient not found" });
    return;
  }
  await recordAudit(actor, "update", "patient", patient.id, `Patient ${patient.id} updated`);
  const result = patientDto(patient, actor.role);
  UpdatePatientResponse.parse(result);
  res.json(result);
});

export default router;