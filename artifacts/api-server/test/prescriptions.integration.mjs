import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { build } from "esbuild";
import express from "express";
import { eq, inArray } from "drizzle-orm";

if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT) {
  throw new Error("Prescription integration tests must never run against production");
}
if (!process.env.DATABASE_URL) throw new Error("A development DATABASE_URL is required");

const output = fileURLToPath(new URL("../node_modules/.cache/prescriptions-test.mjs", import.meta.url));
await mkdir(dirname(output), { recursive: true });
await build({
  stdin: {
    contents: `
      export { default as prescriptionsRouter } from "../src/routes/clinicPrescriptions";
      export { db, pool, staffTable, patientsTable, visitsTable, auditLogTable } from "@workspace/db";
      export { prescriptionsTable, prescriptionAmendmentsTable } from "../../../lib/db/src/schema/prescriptions";
    `,
    resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    sourcefile: "prescriptions-test-entry.ts",
    loader: "ts",
  },
  outfile: output,
  platform: "node",
  format: "esm",
  bundle: true,
  external: ["pg-native"],
  banner: { js: "import { createRequire } from 'node:module'; globalThis.require = createRequire(import.meta.url);" },
  logLevel: "silent",
});
const api = await import(pathToFileURL(output).href);
const {
  db, pool, staffTable, patientsTable, visitsTable, prescriptionsTable,
  prescriptionAmendmentsTable, auditLogTable, prescriptionsRouter,
} = api;

test("clinical prescriptions persist with ownership, role, and amendment safeguards", async (t) => {
  const suffix = randomUUID();
  const actorByRole = new Map();
  const createdStaff = [];
  const patientIds = [];
  const visitIds = [];
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const role = req.header("x-test-role");
    const staff = actorByRole.get(role);
    if (staff) res.locals.staff = staff;
    next();
  });
  app.use("/api", prescriptionsRouter);
  const server = app.listen(0);
  const baseUrl = await new Promise((resolve) => server.once("listening", () =>
    resolve(`http://127.0.0.1:${server.address().port}`)));
  const request = async (role, method, path, body) => {
    const response = await fetch(`${baseUrl}/api${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-test-role": role,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = response.status === 204 ? null : await response.json();
    return { status: response.status, data };
  };

  try {
    for (const role of ["owner", "dentist", "manager", "assistant", "reception", "accountant"]) {
      const [staff] = await db.insert(staffTable).values({
        email: `${role}-${suffix}@prescription-test.invalid`,
        name: `Test ${role}`,
        role,
        status: "active",
      }).returning();
      actorByRole.set(role, staff);
      createdStaff.push(staff.id);
    }
    const [patient] = await db.insert(patientsTable).values({
      fullName: "Fictional Prescription Test Patient",
      gender: "undisclosed",
      phone: `prescription-${suffix}`,
      isDemo: true,
    }).returning();
    patientIds.push(patient.id);
    const [otherPatient] = await db.insert(patientsTable).values({
      fullName: "Fictional Other Test Patient",
      gender: "undisclosed",
      phone: `prescription-other-${suffix}`,
      isDemo: false,
    }).returning();
    patientIds.push(otherPatient.id);
    const [visit] = await db.insert(visitsTable).values({
      patientId: otherPatient.id,
      doctorStaffId: actorByRole.get("dentist").id,
      occurredAt: new Date(),
      status: "draft",
    }).returning();
    visitIds.push(visit.id);
    const [ownedVisit] = await db.insert(visitsTable).values({
      patientId: patient.id,
      doctorStaffId: actorByRole.get("dentist").id,
      occurredAt: new Date(),
      status: "draft",
    }).returning();
    visitIds.push(ownedVisit.id);

    const medication = {
      medication: "Fictional analgesic",
      dose: "200 mg",
      route: "oral",
      frequency: "Every 8 hours",
      duration: "3 days",
      instructions: "Take with food",
      issuedDate: "2025-03-14",
    };
    assert.equal((await request("assistant", "POST", `/patients/${patient.id}/prescriptions`, medication)).status, 403);
    assert.equal((await request("reception", "GET", `/patients/${patient.id}/prescriptions`)).status, 403);
    assert.equal((await request("accountant", "GET", `/patients/${patient.id}/prescriptions`)).status, 403);
    assert.equal((await request("dentist", "POST", `/patients/${patient.id}/prescriptions`, {
      ...medication, visitId: visit.id,
    })).status, 404, "a visit owned by another patient must not be linked");

    const created = await request("dentist", "POST", `/patients/${patient.id}/prescriptions`, {
      ...medication,
      visitId: ownedVisit.id,
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const prescription = created.data;
    assert.equal(prescription.visitId, ownedVisit.id);
    assert.equal(prescription.isDemo, true, "demo status inherits from the patient");
    assert.equal(prescription.authorDentistStaffId, actorByRole.get("dentist").id);
    assert.equal(prescription.status, "issued");

    for (const role of ["manager", "assistant"]) {
      const listed = await request(role, "GET", `/patients/${patient.id}/prescriptions`);
      assert.equal(listed.status, 200);
      assert.equal(listed.data.length, 1);
      assert.equal(listed.data[0].medication, "Fictional analgesic");
    }

    const corrected = await request("dentist", "POST", `/prescriptions/${prescription.id}/amendments`, {
      amendmentType: "correction",
      reason: "Correct the recorded dose",
      replacement: { ...medication, dose: "250 mg" },
    });
    assert.equal(corrected.status, 201, JSON.stringify(corrected.data));
    assert.equal(corrected.data.dose, "250 mg");
    assert.equal(corrected.data.original.dose, "200 mg", "the issued prescription remains preserved");
    assert.equal(corrected.data.status, "corrected");
    assert.equal(corrected.data.amendments.length, 1);

    assert.equal((await request("manager", "POST", `/prescriptions/${prescription.id}/amendments`, {
      amendmentType: "void", reason: "Manager cannot void",
    })).status, 403);
    const voided = await request("owner", "POST", `/prescriptions/${prescription.id}/amendments`, {
      amendmentType: "void",
      reason: "Issued in error",
    });
    assert.equal(voided.status, 201, JSON.stringify(voided.data));
    assert.equal(voided.data.status, "void");
    assert.equal(voided.data.original.dose, "200 mg");
    assert.equal((await request("dentist", "POST", `/prescriptions/${prescription.id}/amendments`, {
      amendmentType: "correction",
      reason: "Cannot change a void prescription",
      replacement: { ...medication, dose: "300 mg" },
    })).status, 409);
    assert.equal((await db.select().from(prescriptionsTable)
      .where(eq(prescriptionsTable.id, prescription.id))).length, 1);
    assert.equal((await db.select().from(prescriptionAmendmentsTable)
      .where(eq(prescriptionAmendmentsTable.prescriptionId, prescription.id))).length, 2);
    const auditEvents = await db.select().from(auditLogTable)
      .where(eq(auditLogTable.entityId, prescription.id));
    assert.equal(auditEvents.filter((event) => event.entityType === "prescription").length, 3);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (patientIds.length) {
      const prescriptionIds = db.select({ id: prescriptionsTable.id }).from(prescriptionsTable)
        .where(inArray(prescriptionsTable.patientId, patientIds));
      await db.delete(prescriptionAmendmentsTable)
        .where(inArray(prescriptionAmendmentsTable.prescriptionId, prescriptionIds));
      await db.delete(prescriptionsTable).where(inArray(prescriptionsTable.patientId, patientIds));
    }
    if (visitIds.length) await db.delete(visitsTable).where(inArray(visitsTable.id, visitIds));
    if (patientIds.length) {
      await db.delete(patientsTable).where(inArray(patientsTable.id, patientIds));
    }
    if (createdStaff.length) await db.delete(staffTable).where(inArray(staffTable.id, createdStaff));
    await pool.end();
  }
});