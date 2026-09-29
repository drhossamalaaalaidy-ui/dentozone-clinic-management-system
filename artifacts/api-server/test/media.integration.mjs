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
  throw new Error("Media integration tests must never run against production");
}
if (!process.env.DATABASE_URL) throw new Error("A development DATABASE_URL is required");

const output = fileURLToPath(new URL("../node_modules/.cache/media-test.mjs", import.meta.url));
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
  db, pool, staffTable, patientsTable, visitsTable, patientDocumentsTable, auditLogTable,
} = api;

const objects = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  if (String(input) === "http://127.0.0.1:1106/object-storage/signed-object-url") {
    const { object_name: name, method } = JSON.parse(options.body);
    return Response.json({ signed_url: `https://private-media.invalid/${encodeURIComponent(name)}?method=${method}` });
  }
  const url = new URL(String(input));
  if (url.hostname !== "private-media.invalid") return realFetch(input, options);
  const key = decodeURIComponent(url.pathname.slice(1));
  const method = options.method ?? url.searchParams.get("method");
  if (method === "PUT") {
    objects.set(key, { bytes: Buffer.from(options.body), contentType: options.headers["Content-Type"] });
    return new Response(null, { status: 200 });
  }
  const item = objects.get(key);
  if (!item) return new Response(null, { status: 404 });
  const headers = { "content-type": item.contentType, "content-length": String(item.bytes.length) };
  return method === "HEAD" ? new Response(null, { status: 200, headers })
    : new Response(item.bytes, { status: 200, headers });
};
process.env.PRIVATE_OBJECT_DIR = "fake-bucket/media-integration-tests";

test("patient photo and X-ray documents stay private, visit-bound, restorable, and audited", async () => {
  const marker = randomUUID();
  let staff = [];
  let patients = [];
  let visits = [];
  let server;
  try {
    staff = await db.insert(staffTable).values(["owner", "dentist", "assistant", "manager"].map((role) => ({
      email: `media-${role}-${marker}@example.invalid`,
      name: `Fictional Media ${role}`,
      role,
      status: "active",
    }))).returning();
    patients = await db.insert(patientsTable).values(["A", "B"].map((name) => ({
      fullName: `Fictional Media Patient ${name} ${marker}`,
      phone: "+201000000000",
      gender: "undisclosed",
      isDemo: true,
    }))).returning();
    visits = await db.insert(visitsTable).values(patients.map((patient) => ({
      patientId: patient.id,
      doctorStaffId: staff[0].id,
      occurredAt: new Date(),
      isDemo: true,
    }))).returning();

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      const role = req.get("authorization")?.match(/^TestStaff (owner|dentist|assistant|manager)$/)?.[1];
      if (!role) return res.status(401).json({ error: "Test staff authentication required" });
      res.locals.staff = staff.find((member) => member.role === role);
      next();
    });
    app.use(api.documentsRouter);
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

    const patient = patients[0];
    const visit = visits[0];
    const wrongVisit = visits[1];
    const metadata = {
      kind: "photo",
      filename: "fictional-clinical-photo.jpg",
      contentType: "image/jpeg",
      sizeBytes: 13,
      visitId: visit.id,
    };
    assert.equal((await request("owner", "POST", `/patients/${patient.id}/documents/upload-request`,
      { ...metadata, visitId: wrongVisit.id })).status, 400, "cross-patient visit must be rejected");
    const issued = await request("owner", "POST", `/patients/${patient.id}/documents/upload-request`, metadata);
    assert.equal(issued.status, 201);
    assert.equal(issued.data.document.isDemo, true);
    assert.equal(issued.data.document.visitId, visit.id);
    const documentId = issued.data.document.id;
    const bytes = Buffer.from("demo-photo-01");
    await fetch(issued.data.uploadURL, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: bytes });
    const complete = await request("owner", "POST", `/patients/${patient.id}/documents/${documentId}/complete`, {});
    assert.equal(complete.status, 200);
    const objectKey = complete.data.objectKey;
    const stagingKey = decodeURIComponent(new URL(issued.data.uploadURL).pathname.slice(1));
    assert.notEqual(objectKey, stagingKey, "activation must promote uploads to a server-only sealed object");
    assert.equal(objects.size, 2, "one staging object and one sealed active object are expected");
    await fetch(issued.data.uploadURL, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
      body: Buffer.from("tampered-after-completion"),
    });

    const filePath = `/patients/${patient.id}/documents/${documentId}/file`;
    assert.equal((await request("assistant", "GET", filePath)).data, bytes.toString(),
      "a still-valid staging PUT URL must not mutate the sealed active file");
    const withdrawn = await request("owner", "PATCH", `/patients/${patient.id}/documents/${documentId}`, { status: "withdrawn" });
    assert.equal(withdrawn.status, 200);
    assert.equal((await request("assistant", "GET", filePath)).status, 404, "withdrawn file reads must be blocked");
    assert.equal((await request("manager", "PATCH", `/patients/${patient.id}/documents/${documentId}`, { status: "active" })).status, 403);
    assert.equal((await request("owner", "PATCH", `/patients/${patient.id}/documents/${documentId}`, { status: "withdrawn" })).status, 409);
    const restored = await request("dentist", "PATCH", `/patients/${patient.id}/documents/${documentId}`, { status: "active" });
    assert.equal(restored.status, 200);
    assert.equal(restored.data.objectKey, objectKey, "restore must reuse the retained object rather than duplicate bytes");
    assert.equal(objects.size, 2, "restore must not create another object");
    assert.equal((await request("assistant", "GET", filePath)).data, bytes.toString());

    const xrayBytes = Buffer.from("demo-xray-02");
    const xrayTicket = await request("dentist", "POST", `/patients/${patient.id}/documents/upload-request`, {
      ...metadata,
      kind: "xray",
      filename: "fictional-xray.jpg",
      sizeBytes: xrayBytes.length,
    });
    assert.equal(xrayTicket.status, 201);
    await fetch(xrayTicket.data.uploadURL, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: xrayBytes });
    assert.equal((await request("dentist", "POST",
      `/patients/${patient.id}/documents/${xrayTicket.data.document.id}/complete`, {})).status, 200);
    const listed = await request("assistant", "GET", `/patients/${patient.id}/documents`);
    assert.deepEqual(listed.data.map((row) => row.kind).sort(), ["photo", "xray"]);
    assert.equal(listed.data.every((row) => row.visitId === visit.id), true);
    assert.equal(listed.data.every((row) => row.isDemo), true);

    const logs = await db.select().from(auditLogTable).where(eq(auditLogTable.entityId, documentId));
    assert.deepEqual(logs.map((log) => log.action).sort(), ["complete", "create", "restore", "withdraw"]);
    assert.equal(logs.every((log) => log.entityType === "patient_document"), true);
  } finally {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (staff.length) await db.delete(auditLogTable).where(inArray(auditLogTable.actorStaffId, staff.map((member) => member.id)));
    if (patients.length) await db.delete(patientDocumentsTable).where(inArray(patientDocumentsTable.patientId, patients.map((patient) => patient.id)));
    if (visits.length) await db.delete(visitsTable).where(inArray(visitsTable.id, visits.map((visit) => visit.id)));
    if (patients.length) await db.delete(patientsTable).where(inArray(patientsTable.id, patients.map((patient) => patient.id)));
    if (staff.length) await db.delete(staffTable).where(inArray(staffTable.id, staff.map((member) => member.id)));
    objects.clear();
    globalThis.fetch = realFetch;
    await pool.end();
  }
});