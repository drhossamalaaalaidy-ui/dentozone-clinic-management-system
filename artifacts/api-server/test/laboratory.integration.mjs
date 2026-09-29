import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { build } from "esbuild";
import express from "express";
import { inArray, sql } from "drizzle-orm";

if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT) {
  throw new Error("Laboratory integration tests must never run against production");
}
if (!process.env.DATABASE_URL) throw new Error("A development DATABASE_URL is required");

const cacheDir = fileURLToPath(new URL("../node_modules/.cache/laboratory-test", import.meta.url));
await mkdir(cacheDir, { recursive: true });
await build({
  entryPoints: {
    "route-entry": fileURLToPath(new URL("./route-entry.ts", import.meta.url)),
    "clinic-laboratory": fileURLToPath(new URL("../src/routes/clinicLaboratory.ts", import.meta.url)),
  },
  outdir: cacheDir,
  platform: "node",
  format: "esm",
  bundle: true,
  splitting: true,
  external: ["pg-native"],
  banner: { js: "import { createRequire } from 'node:module'; globalThis.require = createRequire(import.meta.url);" },
  logLevel: "silent",
});
const api = await import(pathToFileURL(`${cacheDir}/route-entry.js`).href);
const { default: laboratoryRouter } = await import(pathToFileURL(`${cacheDir}/clinic-laboratory.js`).href);
const { db, pool, staffTable, patientsTable, visitsTable, auditLogTable } = api;

test("laboratory orders validate ownership, roles, lifecycle, inherited demo state, and audit history", async (t) => {
  const marker = randomUUID();
  let staff = [];
  let patient;
  let otherPatient;
  let visit;
  let otherVisit;
  let supplierId;
  let server;
  let orderId;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const role = req.get("authorization")?.match(
      /^TestStaff (owner|manager|dentist|assistant|reception)$/,
    )?.[1];
    if (!role) return res.status(401).json({ error: "Test staff authentication required" });
    res.locals.staff = staff.find((member) => member.role === role);
    next();
  });
  app.use(laboratoryRouter);
  try {
    staff = await db.insert(staffTable).values(
      ["owner", "manager", "dentist", "assistant", "reception"].map((role) => ({
        email: `laboratory-${role}-${marker}@example.invalid`,
        name: `Fictional Laboratory ${role} ${marker}`,
        role,
        status: "active",
      })),
    ).returning();
    [patient, otherPatient] = await db.insert(patientsTable).values(["A", "B"].map((letter) => ({
      fullName: `Fictional Laboratory Patient ${letter} ${marker}`,
      phone: "+201000000000",
      gender: "undisclosed",
      isDemo: true,
    }))).returning();
    [visit, otherVisit] = await db.insert(visitsTable).values([patient, otherPatient].map((row) => ({
      patientId: row.id,
      doctorStaffId: staff.find((member) => member.role === "dentist").id,
      occurredAt: new Date(),
      isDemo: true,
    }))).returning();
    const supplier = await db.execute(sql`
      INSERT INTO suppliers (name, active, is_demo)
      VALUES (${`Fictional Lab Supplier ${marker}`}, true, true)
      RETURNING id
    `);
    supplierId = supplier.rows[0].id;

    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const realFetch = globalThis.fetch;
    async function request(role, method, path, body) {
      const response = await realFetch(`${base}${path}`, {
        method,
        headers: {
          ...(role ? { Authorization: `TestStaff ${role}` } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        data: response.headers.get("content-type")?.includes("application/json")
          ? await response.json() : await response.text(),
      };
    }

    await t.test("read/write roles and patient-visit ownership are enforced", async () => {
      const path = `/patients/${patient.id}/laboratory-orders`;
      assert.equal((await request(null, "GET", path)).status, 401);
      for (const role of ["manager", "assistant"]) {
        assert.equal((await request(role, "GET", path)).status, 200);
      }
      assert.equal((await request("reception", "GET", path)).status, 403);
      assert.equal((await request("manager", "POST", path, {
        labName: "Fictional Cedar Dental Lab", caseType: "crown",
      })).status, 403);
      assert.equal((await request("owner", "POST", path, {
        visitId: otherVisit.id,
        labName: "Fictional Cedar Dental Lab",
        caseType: "crown",
      })).status, 409);
    });

    await t.test("create, update lifecycle, list, soft delete, and audit are retained", async () => {
      const path = `/patients/${patient.id}/laboratory-orders`;
      const created = await request("dentist", "POST", path, {
        visitId: visit.id,
        labName: "Fictional Cedar Dental Laboratory",
        supplierId,
        caseType: "crown",
        dueDate: "2031-06-15",
        notes: "Fictional ceramic crown specification",
      });
      assert.equal(created.status, 201, JSON.stringify(created.data));
      orderId = created.data.id;
      assert.equal(Number.isSafeInteger(orderId), true);
      assert.equal(created.data.isDemo, true);
      assert.equal(created.data.status, "submitted");
      assert.equal(created.data.supplierId, supplierId);
      assert.equal(created.data.history.length, 1);
      assert.equal(created.data.history[0].action, "create");

      const detailPath = `/laboratory-orders/${orderId}`;
      assert.equal((await request("assistant", "PATCH", detailPath, { status: "in_progress" })).status, 403);
      assert.equal((await request("dentist", "PATCH", detailPath, { status: "ready" })).status, 409);
      assert.equal((await request("dentist", "PATCH", detailPath, { visitId: otherVisit.id })).status, 409);
      const edited = await request("owner", "PATCH", detailPath, {
        status: "in_progress",
        notes: "Fictional shade confirmation requested",
      });
      assert.equal(edited.status, 200, JSON.stringify(edited.data));
      assert.equal(edited.data.status, "in_progress");
      assert.equal(edited.data.history.length, 2);
      assert.equal(edited.data.history[1].before.notes, "Fictional ceramic crown specification");
      assert.equal(edited.data.history[1].after.notes, "Fictional shade confirmation requested");
      assert.equal((await request("assistant", "GET", path)).data[0].id, orderId);

      const deleted = await request("dentist", "DELETE", detailPath);
      assert.equal(deleted.status, 200);
      assert.equal(deleted.data.status, "cancelled");
      assert.equal(deleted.data.history.length, 3);
      assert.equal(deleted.data.history[2].action, "cancel");
      assert.equal((await request("manager", "GET", detailPath)).data.status, "cancelled");
      assert.equal((await request("owner", "PATCH", detailPath, { notes: "Cannot change cancelled" })).status, 409);
    });
  } finally {
    try {
      if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (patient && otherPatient) {
        await db.execute(sql`
          DELETE FROM laboratory_order_history
          WHERE order_id IN (
            SELECT id FROM laboratory_orders WHERE patient_id IN (${patient.id}, ${otherPatient.id})
          )
        `);
        await db.execute(sql`
          DELETE FROM laboratory_orders WHERE patient_id IN (${patient.id}, ${otherPatient.id})
        `);
      }
      if (staff.length) {
        await db.delete(auditLogTable).where(inArray(auditLogTable.actorStaffId, staff.map((member) => member.id)));
      }
      if (visit && otherVisit) {
        await db.delete(visitsTable).where(inArray(visitsTable.id, [visit.id, otherVisit.id]));
      }
      if (patient && otherPatient) {
        await db.delete(patientsTable).where(inArray(patientsTable.id, [patient.id, otherPatient.id]));
      }
      if (supplierId) await db.execute(sql`DELETE FROM suppliers WHERE id = ${supplierId}`);
      if (staff.length) await db.delete(staffTable).where(inArray(staffTable.id, staff.map((member) => member.id)));
    } finally {
      await pool.end();
    }
  }
});