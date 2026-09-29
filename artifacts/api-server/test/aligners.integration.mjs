import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { build } from "esbuild";
import express from "express";
import { and, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";

if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT) {
  throw new Error("Aligner integration tests must never run against production");
}
if (!process.env.DATABASE_URL) throw new Error("A development DATABASE_URL is required");

const output = fileURLToPath(new URL("../node_modules/.cache/aligners-integration-test.mjs", import.meta.url));
await mkdir(dirname(output), { recursive: true });
await build({
  stdin: {
    contents: `
      export { default as alignersRouter } from "../src/routes/clinicAligners";
      export { db, pool, staffTable, patientsTable, visitsTable, orthodonticCasesTable, auditLogTable } from "./route-entry";
    `,
    resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    sourcefile: "aligners-test-entry.ts",
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
const { db, pool, staffTable, patientsTable, visitsTable, orthodonticCasesTable, auditLogTable } = api;

test("Clear Aligner courses and trays are patient-isolated, audited, and role protected", async (t) => {
  const marker = randomUUID();
  let patients = [], staff = [], cases = [], visits = [], server;
  try {
    staff = await db.insert(staffTable).values(
      ["owner", "manager", "dentist", "assistant", "reception", "dentist"].map((role, index) => ({
        email: `aligner-${role}-${index}-${marker}@example.invalid`,
        name: `Fictional Aligner ${role} ${index}`,
        role,
        status: "active",
      })),
    ).returning();
    patients = await db.insert(patientsTable).values(["A", "B"].map((letter) => ({
      fullName: `Fictional Aligner Patient ${letter} ${marker}`,
      phone: "+201000000000",
      gender: "undisclosed",
      isDemo: true,
    }))).returning();
    cases = await db.insert(orthodonticCasesTable).values(patients.map((patient, index) => ({
      patientId: patient.id,
      title: `Fictional aligner case ${index} ${marker}`,
      goal: "Fictional alignment goal",
      appliance: "Clear aligners",
      doctorStaffId: staff[2].id,
      status: "active",
      isDemo: true,
    }))).returning();
    visits = await db.insert(visitsTable).values(patients.map((patient) => ({
      patientId: patient.id,
      doctorStaffId: staff[2].id,
      occurredAt: new Date(),
      isDemo: true,
    }))).returning();

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      const role = req.get("authorization")?.match(/^TestStaff (owner|manager|dentist|dentist-unassigned|assistant|reception)$/)?.[1];
      if (!role) {
        res.status(401).json({ error: "Test staff authentication required" });
        return;
      }
      res.locals.staff = role === "dentist-unassigned" ? staff[5] : staff.find((member) => member.role === role);
      next();
    });
    app.use(api.alignersRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(role, method, path, body) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(role ? { Authorization: `TestStaff ${role}` } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const type = response.headers.get("content-type");
      return { status: response.status, data: type?.includes("application/json")
        ? await response.json() : await response.text() };
    }
    const pathA = `/patients/${patients[0].id}/aligner-courses`;
    const pathB = `/patients/${patients[1].id}/aligner-courses`;

    await t.test("read roles and patient/case ownership boundaries are enforced", async () => {
      assert.equal((await request(null, "GET", pathA)).status, 401);
      for (const role of ["manager", "assistant"]) {
        assert.equal((await request(role, "GET", pathA)).status, 200);
        assert.equal((await request(role, "POST", pathA, {
          caseId: cases[0].id, title: "Fictional course",
        })).status, 403);
      }
      assert.equal((await request("reception", "GET", pathA)).status, 403);
      assert.equal((await request("owner", "POST", pathA, {
        caseId: cases[1].id, title: "Wrong patient course",
      })).status, 400);
      assert.equal((await request("dentist-unassigned", "POST", pathB, {
        caseId: cases[1].id, title: "Unassigned dentist course",
      })).status, 403);
    });

    const created = await request("owner", "POST", pathA, {
      caseId: cases[0].id, title: "Fictional Clear Aligner Course",
    });
    assert.equal(created.status, 201);
    const courseId = created.data.id;
    await t.test("courses are persisted and cannot be read through another patient path", async () => {
      assert.equal(created.data.patientId, patients[0].id);
      assert.equal(created.data.caseId, cases[0].id);
      assert.equal(created.data.isDemo, true);
      assert.deepEqual(created.data.trays, []);
      assert.equal((await request("manager", "GET", pathA)).data.length, 1);
      assert.equal((await request("assistant", "GET", `${pathB}/${courseId}`)).status, 404);
      assert.equal((await request("owner", "POST", pathA, {
        caseId: cases[0].id, title: "Duplicate course",
      })).status, 409);
    });

    const traysPath = `${pathA}/${courseId}/trays`;
    await t.test("tray sequence, patient-matched visit, status, dates, audit, and demo lineage persist", async () => {
      assert.equal((await request("manager", "POST", traysPath, { sequence: 1 })).status, 403);
      assert.equal((await request("owner", "POST", traysPath, {
        sequence: 1, visitId: visits[1].id,
      })).status, 400);
      assert.equal((await request("owner", "POST", traysPath, {
        sequence: 1, plannedDate: "2027-02-20", deliveredDate: "2027-02-19",
      })).status, 400);
      const added = await request("dentist", "POST", traysPath, {
        sequence: 1,
        plannedDate: "2027-02-20",
        deliveredDate: "2027-02-20",
        status: "delivered",
        wearNotes: "Fictional fit verified",
        visitId: visits[0].id,
      });
      assert.equal(added.status, 201);
      assert.equal(added.data.isDemo, true);
      assert.equal(added.data.status, "delivered");
      assert.equal(added.data.visitId, visits[0].id);
      assert.equal((await request("owner", "POST", traysPath, { sequence: 1 })).status, 409);
      const changed = await request("dentist", "PATCH", `${traysPath}/${added.data.id}`, {
        status: "wearing", wearNotes: "Fictional wear check recorded",
      });
      assert.equal(changed.status, 200);
      assert.equal(changed.data.status, "wearing");
      assert.equal(changed.data.wearNotes, "Fictional wear check recorded");
      const listed = await request("assistant", "GET", `${pathA}/${courseId}`);
      assert.equal(listed.status, 200);
      assert.equal(listed.data.trays.length, 1);
      assert.equal(listed.data.trays[0].sequence, 1);
      const auditRows = await db.select().from(auditLogTable)
        .where(and(inArray(auditLogTable.actorStaffId, staff.map((member) => member.id)),
          inArray(auditLogTable.entityType, ["aligner_course", "aligner_tray"])));
      assert.ok(auditRows.length >= 3);
      const persisted = await db.execute(sql`SELECT is_demo, status FROM aligner_trays WHERE id = ${added.data.id}`);
      assert.equal(persisted.rows[0].is_demo, true);
      assert.equal(persisted.rows[0].status, "wearing");
    });
  } finally {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (patients.length) {
      await db.execute(sql`DELETE FROM aligner_trays WHERE course_id IN
        (SELECT id FROM aligner_courses WHERE patient_id IN (${patients[0].id}, ${patients[1].id}))`);
      await db.execute(sql`DELETE FROM aligner_courses WHERE patient_id IN (${patients[0].id}, ${patients[1].id})`);
    }
    if (staff.length) await db.delete(auditLogTable)
      .where(inArray(auditLogTable.actorStaffId, staff.map((member) => member.id)));
    if (visits.length) await db.delete(visitsTable).where(inArray(visitsTable.id, visits.map((visit) => visit.id)));
    if (cases.length) await db.delete(orthodonticCasesTable)
      .where(inArray(orthodonticCasesTable.id, cases.map((item) => item.id)));
    if (patients.length) await db.delete(patientsTable)
      .where(inArray(patientsTable.id, patients.map((patient) => patient.id)));
    if (staff.length) await db.delete(staffTable).where(inArray(staffTable.id, staff.map((member) => member.id)));
    await pool.end();
  }
});