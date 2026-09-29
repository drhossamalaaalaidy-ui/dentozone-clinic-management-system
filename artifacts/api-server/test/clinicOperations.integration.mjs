import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { build } from "esbuild";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";

// Tests exercise the real Express handlers and PostgreSQL in development only.
// The tiny auth adapter is test-only; production still uses Clerk + requireStaff.
if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT) {
  throw new Error("Clinic integration tests must never run against production");
}
if (!process.env.DATABASE_URL) throw new Error("A development DATABASE_URL is required");

const output = fileURLToPath(new URL("../node_modules/.cache/clinic-operations-test.mjs", import.meta.url));
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
  db, pool, staffTable, patientsTable, visitsTable, appointmentsTable,
  patientDocumentsTable, orthodonticCasesTable, orthodonticProgressTable,
  reminderPreferencesTable, reminderTemplatesTable, remindersTable, auditLogTable,
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
process.env.PRIVATE_OBJECT_DIR = "fake-bucket/clinic-integration-tests";

test("protected operations honor roles, patient boundaries, file integrity, and consent", async (t) => {
  const marker = randomUUID();
  let a, b, visitA, visitB, appointment, server;
  let staff = [], templates = [];
  try {
  staff = await db.insert(staffTable).values(
    ["owner", "manager", "dentist", "assistant", "reception", "accountant"].map((role) => ({
      email: `fixture-${role}-${marker}@example.invalid`,
      name: `Fictional Test ${role}`, role, status: "active",
    })),
  ).returning();
  const actor = staff[0];
  [a, b] = await db.insert(patientsTable).values(["A", "B"].map((letter) => ({
    fullName: `Fictional Patient ${letter} ${marker}`,
    phone: "+201000000000", gender: "undisclosed", isDemo: true,
  }))).returning();
  [visitA, visitB] = await db.insert(visitsTable).values([a, b].map((patient) => ({
    patientId: patient.id, doctorStaffId: actor.id, occurredAt: new Date(), isDemo: true,
  }))).returning();
  [appointment] = await db.insert(appointmentsTable).values({
    patientId: a.id, doctorStaffId: actor.id, doctorName: "Fictional Test Dentist",
    treatment: "Fictional review", startsAt: new Date(Date.now() + 14 * 86_400_000),
    endsAt: new Date(Date.now() + 14 * 86_400_000 + 1_800_000), isDemo: true,
  }).returning();
  templates = await db.insert(reminderTemplatesTable).values(["whatsapp", "sms"].map((channel) => ({
    title: `Test ${channel} ${marker}`, bodyEn: "Reminder {patient_name} {date}",
    bodyAr: "تذكير {patient_name} {date}", channel, createdByStaffId: actor.id, isDemo: true,
  }))).returning();

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const role = req.get("authorization")?.match(/^TestStaff (owner|manager|dentist|assistant|reception|accountant)$/)?.[1];
    if (!role) return res.status(401).json({ error: "Test staff authentication required" });
    res.locals.staff = staff.find((item) => item.role === role);
    next();
  });
  app.use(api.documentsRouter, api.orthodonticsRouter, api.remindersRouter, api.reportsRouter);
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
    const type = response.headers.get("content-type");
    return { status: response.status, data: type?.includes("application/json")
      ? await response.json() : await response.text() };
  }

    await t.test("unauthenticated and nonclinical staff never read private records", async () => {
      for (const path of [`/patients/${a.id}/documents`, `/patients/${a.id}/orthodontic-cases`]) {
        assert.equal((await request(null, "GET", path)).status, 401);
        for (const role of ["reception", "accountant"]) {
          assert.equal((await request(role, "GET", path)).status, 403, `${role} ${path}`);
        }
      }
      assert.equal((await request("assistant", "GET", `/patients/${a.id}/documents`)).status, 200);
      assert.equal((await request("manager", "GET", `/patients/${a.id}/orthodontic-cases`)).status, 200);
    });

    await t.test("document ownership, byte verification, and withdrawal", async () => {
      const meta = { kind: "consent", filename: "fictional-consent.pdf",
        contentType: "application/pdf", sizeBytes: 9, visitId: visitB.id };
      assert.equal((await request("owner", "POST", `/patients/${a.id}/documents/upload-request`, meta)).status, 400);
      assert.equal((await request("assistant", "POST", `/patients/${a.id}/documents/upload-request`,
        { ...meta, visitId: visitA.id })).status, 403);
      const issued = await request("owner", "POST", `/patients/${a.id}/documents/upload-request`,
        { ...meta, visitId: visitA.id });
      assert.equal(issued.status, 201);
      const id = issued.data.document.id;
      const complete = `/patients/${a.id}/documents/${id}/complete`;
      assert.equal((await request("owner", "POST", complete, {})).status, 409);
      await fetch(issued.data.uploadURL, { method: "PUT", headers: { "Content-Type": "application/pdf" },
        body: Buffer.from("wrong") });
      assert.equal((await request("owner", "POST", complete, {})).status, 409);
      const bytes = Buffer.from("%PDF-test");
      await fetch(issued.data.uploadURL, { method: "PUT", headers: { "Content-Type": "application/pdf" },
        body: bytes });
      assert.equal((await request("owner", "POST", complete, {})).status, 200);
      assert.equal((await request("owner", "GET", `/patients/${b.id}/documents/${id}/file`)).status, 404);
      assert.equal((await request("assistant", "GET", `/patients/${a.id}/documents/${id}/file`)).status, 200);
      await fetch(issued.data.uploadURL, { method: "PUT", headers: { "Content-Type": "application/pdf" },
        body: Buffer.from("new-bytes") });
      assert.equal((await request("assistant", "GET", `/patients/${a.id}/documents/${id}/file`)).data,
        bytes.toString());
      assert.equal((await request("owner", "PATCH", `/patients/${a.id}/documents/${id}`,
        { status: "withdrawn" })).status, 200);
      assert.equal((await request("owner", "GET", `/patients/${a.id}/documents/${id}/file`)).status, 404);
    });

    await t.test("orthodontic progress cannot attach another patient's visit", async () => {
      const created = await request("owner", "POST", `/patients/${a.id}/orthodontic-cases`, {
        title: "Fictional braces", goal: "Alignment", appliance: "Braces", doctorStaffId: actor.id,
      });
      assert.equal(created.status, 201);
      const id = created.data.id;
      assert.equal((await request("reception", "GET", `/orthodontic-cases/${id}`)).status, 403);
      assert.equal((await request("assistant", "POST", `/orthodontic-cases/${id}/progress`,
        { note: "Adjustment", phase: "Phase one" })).status, 403);
      assert.equal((await request("owner", "POST", `/orthodontic-cases/${id}/progress`,
        { note: "Adjustment", phase: "Phase one", visitId: visitB.id })).status, 409);
      assert.equal((await request("owner", "POST", `/orthodontic-cases/${id}/progress`,
        { note: "Adjustment", phase: "Phase one", visitId: visitA.id })).status, 201);
    });

    await t.test("channel changes and opt-out cancel drafts; send rechecks current consent", async () => {
      const prefs = `/patients/${a.id}/reminder-preferences`;
      const draftPath = `/appointments/${appointment.id}/reminders`;
      assert.equal((await request("reception", "PUT", prefs,
        { optIn: true, channel: "whatsapp" })).status, 200);
      const first = await request("reception", "POST", draftPath, { templateId: templates[0].id });
      assert.equal(first.status, 201);
      const firstSend = `/reminders/${first.data.id}/mark-sent`;
      assert.equal((await request("reception", "PUT", prefs,
        { optIn: true, channel: "sms" })).status, 200);
      assert.equal((await request("reception", "POST", firstSend, {})).status, 409);
      const [cancelled] = await db.select().from(remindersTable).where(eq(remindersTable.id, first.data.id));
      assert.equal(cancelled.status, "cancelled");
      const second = await request("reception", "POST", draftPath, { templateId: templates[1].id });
      assert.equal(second.status, 201);
      assert.equal((await request("reception", "PUT", prefs,
        { optIn: false, channel: "sms" })).status, 200);
      const [optedOut] = await db.select().from(remindersTable).where(eq(remindersTable.id, second.data.id));
      assert.equal(optedOut.status, "cancelled");
      assert.equal((await request("reception", "POST", `/reminders/${second.data.id}/mark-sent`, {})).status, 409);
      assert.equal((await request("reception", "POST", draftPath, { templateId: templates[1].id })).status, 409);
      // Simulate a preference race where a draft remains, independently of the cancellation endpoint.
      await request("reception", "PUT", prefs, { optIn: true, channel: "sms" });
      const race = await request("reception", "POST", draftPath, { templateId: templates[1].id });
      assert.equal(race.status, 201);
      await db.update(reminderPreferencesTable).set({ channel: "whatsapp" })
        .where(eq(reminderPreferencesTable.patientId, a.id));
      assert.equal((await request("reception", "POST", `/reminders/${race.data.id}/mark-sent`, {})).status, 409);
    });

    await t.test("operational reporting is owner/manager only and excludes patient and money fields", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const path = `/clinic/reports?from=${today}&to=${today}`;
      for (const role of ["reception", "accountant", "assistant", "dentist"]) {
        assert.equal((await request(role, "GET", path)).status, 403, role);
      }
      for (const role of ["owner", "manager"]) {
        const report = await request(role, "GET", path);
        assert.equal(report.status, 200);
        assert.equal(typeof report.data.newPatients, "number");
        assert.equal(/patientId|name|amount|revenue|egp/i.test(JSON.stringify(report.data)), false);
      }
    });
  } finally {
    try {
      if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (staff.length) await db.delete(auditLogTable).where(inArray(auditLogTable.actorStaffId, staff.map((row) => row.id)));
      if (a && b) {
        const patientIds = [a.id, b.id];
        await db.delete(remindersTable).where(inArray(remindersTable.patientId, patientIds));
        await db.delete(reminderPreferencesTable).where(inArray(reminderPreferencesTable.patientId, patientIds));
        await db.delete(orthodonticProgressTable).where(inArray(orthodonticProgressTable.caseId,
          db.select({ id: orthodonticCasesTable.id }).from(orthodonticCasesTable)
            .where(inArray(orthodonticCasesTable.patientId, patientIds))));
        await db.delete(orthodonticCasesTable).where(inArray(orthodonticCasesTable.patientId, patientIds));
        await db.delete(patientDocumentsTable).where(inArray(patientDocumentsTable.patientId, patientIds));
      }
      if (templates.length) await db.delete(reminderTemplatesTable).where(inArray(reminderTemplatesTable.id, templates.map((row) => row.id)));
      if (appointment) await db.delete(appointmentsTable).where(eq(appointmentsTable.id, appointment.id));
      if (visitA && visitB) await db.delete(visitsTable).where(inArray(visitsTable.id, [visitA.id, visitB.id]));
      if (a && b) await db.delete(patientsTable).where(inArray(patientsTable.id, [a.id, b.id]));
      if (staff.length) await db.delete(staffTable).where(inArray(staffTable.id, staff.map((row) => row.id)));
    } finally {
      stored.clear();
      globalThis.fetch = realFetch;
      await pool.end();
    }
  }
});