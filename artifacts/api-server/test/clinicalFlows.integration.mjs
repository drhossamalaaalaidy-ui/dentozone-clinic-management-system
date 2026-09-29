import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { build } from "esbuild";
import express from "express";
import { eq, inArray } from "drizzle-orm";

// Exercise the actual Express handlers against a development database only.
if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT) {
  throw new Error("Clinical integration tests must never run against production");
}
if (!process.env.DATABASE_URL) throw new Error("A development DATABASE_URL is required");

const output = fileURLToPath(new URL("../node_modules/.cache/clinical-flows-test.mjs", import.meta.url));
await mkdir(dirname(output), { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("./route-entry.ts", import.meta.url))],
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
  db, pool, staffTable, patientsTable, visitsTable, visitDiagnosesTable, visitProceduresTable,
  odontogramEntriesTable, treatmentPlansTable, treatmentPlanItemsTable, patientDocumentsTable,
  orthodonticCasesTable, orthodonticProgressTable, auditLogTable,
} = api;

const stored = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  if (String(input) === "http://127.0.0.1:1106/object-storage/signed-object-url") {
    const { object_name: name, method } = JSON.parse(options.body);
    return Response.json({ signed_url: `https://storage.example.invalid/${encodeURIComponent(name)}?method=${method}` });
  }
  const url = new URL(String(input));
  if (url.hostname !== "storage.example.invalid") return realFetch(input, options);
  const key = decodeURIComponent(url.pathname.slice(1));
  const method = options.method ?? url.searchParams.get("method");
  if (method === "PUT") {
    stored.set(key, { bytes: Buffer.from(options.body), contentType: options.headers["Content-Type"] });
    return new Response(null, { status: 200 });
  }
  const item = stored.get(key);
  if (!item) return new Response(null, { status: 404 });
  const headers = { "content-type": item.contentType, "content-length": String(item.bytes.length) };
  return method === "HEAD" ? new Response(null, { status: 200, headers })
    : new Response(item.bytes, { status: 200, headers });
};
process.env.PRIVATE_OBJECT_DIR = "fake-bucket/clinical-flows-integration-tests";

test("clinical patient lifecycle persists safely across API workflows", async (t) => {
  const marker = randomUUID();
  const fixturePatientEmail = `patient-${marker}@example.invalid`;
  let staff = [];
  let patient;
  let visit;
  let plan;
  let orthodonticCase;
  let document;
  let server;
  try {
    staff = await db.insert(staffTable).values(
      ["owner", "dentist", "assistant", "reception", "accountant"].map((role) => ({
        email: `clinical-flow-${role}-${marker}@example.invalid`,
        name: `Fictional Clinical Flow ${role}`, role, status: "active",
      })),
    ).returning();
    const actorFor = (role) => staff.find((member) => member.role === role);

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      const role = req.get("authorization")?.match(/^TestStaff (owner|dentist|assistant|reception|accountant)$/)?.[1];
      if (!role) return res.status(401).json({ error: "Test staff authentication required" });
      res.locals.staff = actorFor(role);
      next();
    });
    app.use(api.patientsRouter, api.visitsRouter, api.carePlansRouter, api.orthodonticsRouter, api.documentsRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(role, method, path, body) {
      const response = await realFetch(`${base}${path}`, {
        method,
        headers: {
          ...(role ? { Authorization: `TestStaff ${role}` } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const contentType = response.headers.get("content-type");
      return {
        status: response.status,
        data: contentType?.includes("application/json") ? await response.json() : await response.text(),
      };
    }

    await t.test("patient create, clinical-history edits, search, and redacted profile boundaries", async () => {
      assert.equal((await request(null, "GET", "/patients")).status, 401);
      assert.equal((await request("accountant", "GET", "/patients")).status, 403);
      const created = await request("dentist", "POST", "/patients", {
        fullName: `Fictional Clinical Patient ${marker}`,
        gender: "undisclosed",
        dateOfBirth: "1990-02-03",
        phone: `+2010${marker.replaceAll("-", "").slice(0, 8)}`,
        email: fixturePatientEmail,
        allergies: "Fictional test: latex",
        medications: "Fictional test: none",
        medicalConditions: "Fictional test: asthma",
        previousSurgeries: "Fictional test: none",
        diabetes: false,
        hypertension: false,
        heartDisease: false,
        bleedingDisorders: false,
        pregnancy: false,
        smoking: false,
        previousDentalTreatment: "Fictional test: cleaning",
        previousOrthodonticTreatment: "Fictional test: none",
        oralHygiene: "Fictional test: good",
        dentalComplaints: "Fictional test: sensitivity",
        previousDentist: "Fictional Test Clinic",
        notes: "Fictional test fixture",
      });
      assert.equal(created.status, 201, JSON.stringify(created.data));
      patient = created.data;
      await db.update(patientsTable).set({ isDemo: true }).where(eq(patientsTable.id, patient.id));

      const edited = await request("dentist", "PATCH", `/patients/${patient.id}`, {
        fullName: `Fictional Updated Patient ${marker}`,
        allergies: "Fictional test: latex and adhesive",
        dentalComplaints: "Fictional test: resolved sensitivity",
      });
      assert.equal(edited.status, 200, JSON.stringify(edited.data));
      assert.equal(edited.data.allergies, "Fictional test: latex and adhesive");
      assert.equal(edited.data.dentalComplaints, "Fictional test: resolved sensitivity");
      assert.equal((await request("reception", "PATCH", `/patients/${patient.id}`,
        { allergies: "Should be rejected" })).status, 403);
      assert.equal((await request("reception", "PATCH", `/patients/${patient.id}`,
        { fullName: `Fictional Reception Edit ${marker}` })).status, 200);
      const profile = await request("assistant", "GET", `/patients/${patient.id}`);
      assert.equal(profile.status, 200);
      assert.equal(profile.data.medicalConditions, "Fictional test: asthma");
      assert.equal(profile.data.isDemo, true);
      const receptionProfile = await request("reception", "GET", `/patients/${patient.id}`);
      assert.equal(receptionProfile.status, 200);
      assert.equal(receptionProfile.data.allergies, null);
      assert.equal(receptionProfile.data.medicalConditions, null);
      const results = await request("reception", "GET", `/patients?search=${encodeURIComponent(marker)}&limit=25&offset=0`);
      assert.equal(results.status, 200);
      assert.equal(results.data.some((item) => item.id === patient.id), true);
    });

    await t.test("odontogram findings, visits, diagnoses, and procedures are persisted", async () => {
      const denied = await request("assistant", "POST", `/patients/${patient.id}/odontogram`, {
        dentition: "adult", toothCode: "11", condition: "caries",
      });
      assert.equal(denied.status, 403);
      const finding = await request("dentist", "POST", `/patients/${patient.id}/odontogram`, {
        dentition: "adult", toothCode: "11", condition: "caries", surfaces: ["M", "O", "M"],
        notes: "Fictional test finding",
      });
      assert.equal(finding.status, 201, JSON.stringify(finding.data));
      assert.deepEqual(finding.data.surfaces, ["M", "O"]);
      assert.equal((await request("dentist", "POST", `/patients/${patient.id}/odontogram`, {
        dentition: "adult", toothCode: "55", condition: "caries",
      })).status, 400);
      const chart = await request("assistant", "GET", `/patients/${patient.id}/odontogram`);
      assert.equal(chart.status, 200);
      assert.equal(chart.data[0].toothCode, "11");
      assert.equal(chart.data[0].recordedByName, actorFor("dentist").name);

      const created = await request("dentist", "POST", `/patients/${patient.id}/visits`, {
        complaint: "Fictional sensitivity review", notes: "Fictional test visit",
      });
      assert.equal(created.status, 201, JSON.stringify(created.data));
      visit = created.data;
      assert.equal(visit.isDemo, true);
      const diagnosis = await request("dentist", "POST", `/visits/${visit.id}/diagnoses`, {
        label: "Fictional dentin sensitivity", code: "TEST-DIAG", toothCode: "11",
      });
      assert.equal(diagnosis.status, 201, JSON.stringify(diagnosis.data));
      assert.equal((await request("dentist", "POST", `/visits/${visit.id}/diagnoses`, {
        label: "Invalid tooth fixture", toothCode: "99",
      })).status, 400);
      const procedure = await request("dentist", "POST", `/visits/${visit.id}/procedures`, {
        label: "Fictional fluoride application", toothCode: "11", notes: "Test-only procedure",
      });
      assert.equal(procedure.status, 201, JSON.stringify(procedure.data));
      const listed = await request("assistant", "GET", `/patients/${patient.id}/visits`);
      assert.equal(listed.status, 200);
      assert.equal(listed.data.length, 1);
      assert.equal(listed.data[0].diagnoses[0].label, "Fictional dentin sensitivity");
      assert.equal(listed.data[0].procedures[0].label, "Fictional fluoride application");
      const completed = await request("dentist", "PATCH", `/visits/${visit.id}`, { status: "completed" });
      assert.equal(completed.status, 200);
      assert.equal((await request("dentist", "POST", `/visits/${visit.id}/procedures`, {
        label: "No additions after completion",
      })).status, 409);
    });

    await t.test("treatment plans and items support read, create, and updates", async () => {
      assert.equal((await request("assistant", "POST", `/patients/${patient.id}/treatment-plans`, {
        title: "Unauthorized plan",
      })).status, 403);
      const created = await request("dentist", "POST", `/patients/${patient.id}/treatment-plans`, {
        title: "Fictional sensitivity care", goal: "Fictional test goal",
        items: [{ description: "Fictional fluoride treatment", toothCode: "11", priority: 1 }],
      });
      assert.equal(created.status, 201, JSON.stringify(created.data));
      plan = created.data;
      assert.equal(plan.isDemo, true);
      const added = await request("dentist", "POST", `/treatment-plans/${plan.id}/items`, {
        description: "Fictional follow-up", priority: 2,
      });
      assert.equal(added.status, 201, JSON.stringify(added.data));
      const editedItem = await request("dentist", "PATCH",
        `/treatment-plans/${plan.id}/items/${added.data.id}`, {
          description: "Fictional follow-up review", status: "in_progress",
        });
      assert.equal(editedItem.status, 200, JSON.stringify(editedItem.data));
      const editedPlan = await request("dentist", "PATCH", `/treatment-plans/${plan.id}`, {
        title: "Fictional updated sensitivity care", status: "active",
      });
      assert.equal(editedPlan.status, 200, JSON.stringify(editedPlan.data));
      const listed = await request("assistant", "GET", `/patients/${patient.id}/treatment-plans`);
      assert.equal(listed.status, 200);
      assert.equal(listed.data[0].title, "Fictional updated sensitivity care");
      assert.equal(listed.data[0].items.find((item) => item.id === added.data.id).status, "in_progress");
      assert.equal((await request("assistant", "GET", `/treatment-plans/${plan.id}`)).status, 200);
    });

    await t.test("orthodontic case and visit-linked progress honor role and patient boundaries", async () => {
      const created = await request("dentist", "POST", `/patients/${patient.id}/orthodontic-cases`, {
        title: "Fictional alignment case", goal: "Fictional alignment goal",
        appliance: "Fictional fixed braces", doctorStaffId: actorFor("dentist").id,
      });
      assert.equal(created.status, 201, JSON.stringify(created.data));
      orthodonticCase = created.data;
      assert.equal(orthodonticCase.isDemo, true);
      assert.equal((await request("assistant", "PATCH", `/orthodontic-cases/${orthodonticCase.id}`,
        { status: "paused" })).status, 403);
      assert.equal((await request("dentist", "PATCH", `/orthodontic-cases/${orthodonticCase.id}`,
        { status: "paused" })).status, 200);
      const progress = await request("dentist", "POST", `/orthodontic-cases/${orthodonticCase.id}/progress`, {
        note: "Fictional adjustment", phase: "Fictional phase one", visitId: visit.id,
      });
      assert.equal(progress.status, 201, JSON.stringify(progress.data));
      assert.equal(progress.data.isDemo, true);
      const detail = await request("assistant", "GET", `/orthodontic-cases/${orthodonticCase.id}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.data.progress[0].visitId, visit.id);
      assert.equal((await request("reception", "GET", `/patients/${patient.id}/orthodontic-cases`)).status, 403);
    });

    await t.test("consent upload is private, verified, readable by clinical staff, and withdrawable", async () => {
      const consentBytes = Buffer.from("%PDF-fictional-consent");
      const issued = await request("dentist", "POST", `/patients/${patient.id}/documents/upload-request`, {
        kind: "consent", filename: "fictional-consent.pdf", contentType: "application/pdf",
        sizeBytes: consentBytes.length, visitId: visit.id, signedAt: new Date().toISOString(),
      });
      assert.equal(issued.status, 201, JSON.stringify(issued.data));
      document = issued.data.document;
      assert.equal(document.isDemo, true);
      assert.equal(document.status, "pending");
      assert.equal((await request("assistant", "GET", `/patients/${patient.id}/documents/${document.id}/file`)).status, 404);
      await fetch(issued.data.uploadURL, {
        method: "PUT", headers: { "Content-Type": "application/pdf" }, body: consentBytes,
      });
      const complete = await request("dentist", "POST",
        `/patients/${patient.id}/documents/${document.id}/complete`, {
          checksumSha256: createHash("sha256").update(consentBytes).digest("hex"),
        });
      assert.equal(complete.status, 200, JSON.stringify(complete.data));
      assert.equal(complete.data.status, "active");
      assert.equal(complete.data.signedAt, new Date(complete.data.signedAt).toISOString());
      const documents = await request("assistant", "GET", `/patients/${patient.id}/documents`);
      assert.equal(documents.status, 200);
      assert.equal(documents.data[0].kind, "consent");
      assert.equal((await request("accountant", "GET", `/patients/${patient.id}/documents`)).status, 403);
      const download = await request("assistant", "GET",
        `/patients/${patient.id}/documents/${document.id}/file`);
      assert.equal(download.status, 200);
      assert.equal(download.data, consentBytes.toString());
      const withdrawn = await request("dentist", "PATCH",
        `/patients/${patient.id}/documents/${document.id}`, { status: "withdrawn" });
      assert.equal(withdrawn.status, 200);
      assert.equal(withdrawn.data.status, "withdrawn");
      assert.equal((await request("assistant", "GET",
        `/patients/${patient.id}/documents/${document.id}/file`)).status, 404);
      assert.equal((await request(null, "GET", `/patients/${patient.id}/documents`)).status, 401);
    });
  } finally {
    try {
      if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (staff.length) {
        await db.delete(auditLogTable).where(inArray(auditLogTable.actorStaffId, staff.map((member) => member.id)));
      }
      const [fixturePatient] = patient
        ? [patient]
        : await db.select({ id: patientsTable.id }).from(patientsTable)
          .where(eq(patientsTable.email, fixturePatientEmail));
      if (fixturePatient) {
        const patientId = fixturePatient.id;
        await db.delete(orthodonticProgressTable).where(inArray(orthodonticProgressTable.caseId,
          db.select({ id: orthodonticCasesTable.id }).from(orthodonticCasesTable)
            .where(eq(orthodonticCasesTable.patientId, patientId))));
        await db.delete(orthodonticCasesTable).where(eq(orthodonticCasesTable.patientId, patientId));
        await db.delete(patientDocumentsTable).where(eq(patientDocumentsTable.patientId, patientId));
        await db.delete(visitDiagnosesTable).where(inArray(visitDiagnosesTable.visitId,
          db.select({ id: visitsTable.id }).from(visitsTable).where(eq(visitsTable.patientId, patientId))));
        await db.delete(visitProceduresTable).where(inArray(visitProceduresTable.visitId,
          db.select({ id: visitsTable.id }).from(visitsTable).where(eq(visitsTable.patientId, patientId))));
        await db.delete(visitsTable).where(eq(visitsTable.patientId, patientId));
        await db.delete(odontogramEntriesTable).where(eq(odontogramEntriesTable.patientId, patientId));
        await db.delete(treatmentPlanItemsTable).where(inArray(treatmentPlanItemsTable.planId,
          db.select({ id: treatmentPlansTable.id }).from(treatmentPlansTable)
            .where(eq(treatmentPlansTable.patientId, patientId))));
        await db.delete(treatmentPlansTable).where(eq(treatmentPlansTable.patientId, patientId));
        await db.delete(patientsTable).where(eq(patientsTable.id, patientId));
      }
      if (staff.length) await db.delete(staffTable).where(inArray(staffTable.id, staff.map((member) => member.id)));
    } finally {
      stored.clear();
      globalThis.fetch = realFetch;
      await pool.end();
    }
  }
});