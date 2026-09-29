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
  throw new Error("Marketing integration tests must never run against production");
}
if (!process.env.DATABASE_URL) throw new Error("A development DATABASE_URL is required");

const testDir = dirname(fileURLToPath(import.meta.url));
const output = fileURLToPath(new URL("../node_modules/.cache/marketing-test.mjs", import.meta.url));
await mkdir(dirname(output), { recursive: true });
await build({
  stdin: {
    contents: `
      export { default as marketingRouter } from "../src/routes/clinicMarketing";
      export { db, pool, patientsTable, staffTable, auditLogTable } from "@workspace/db";
    `,
    resolveDir: testDir,
    sourcefile: "marketing-entry.ts",
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
const { db, pool, patientsTable, staffTable, auditLogTable, marketingRouter } =
  await import(pathToFileURL(output).href);

test("campaign CRUD, aggregate referrals, authorization and audit persist", async () => {
  const marker = `MKT-${randomUUID()}`;
  const fixtures = { staff: [], patientIds: [], campaignIds: [], server: undefined };
  try {
    fixtures.staff = await db.insert(staffTable).values(
      ["owner", "manager", "accountant", "reception"].map((role) => ({
        email: `marketing-${role}-${marker.toLowerCase()}@example.invalid`,
        name: `Fictional ${role} ${marker}`,
        role,
        status: "active",
      })),
    ).returning();
    const staffByRole = new Map(fixtures.staff.map((staff) => [staff.role, staff]));
    const referrals = await db.insert(patientsTable).values([
      { fullName: `Fictional patient ${marker} one`, gender: "undisclosed", phone: `+201${randomUUID().replaceAll("-", "").slice(0, 10)}`, referralSource: ` ${marker.toLowerCase()} `, isDemo: true },
      { fullName: `Fictional patient ${marker} two`, gender: "undisclosed", phone: `+201${randomUUID().replaceAll("-", "").slice(0, 10)}`, referralSource: marker, isDemo: true },
      { fullName: `Fictional patient ${marker} three`, gender: "undisclosed", phone: `+201${randomUUID().replaceAll("-", "").slice(0, 10)}`, referralSource: `Community ${marker}`, isDemo: true },
    ]).returning();
    fixtures.patientIds = referrals.map((patient) => patient.id);

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      const role = req.get("authorization")?.match(/^TestStaff (owner|manager|accountant|reception)$/)?.[1];
      if (!role) return res.status(401).json({ error: "Test staff authentication required" });
      res.locals.staff = staffByRole.get(role);
      next();
    });
    app.use(marketingRouter);
    fixtures.server = app.listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => {
      fixtures.server.once("listening", resolve);
      fixtures.server.once("error", reject);
    });
    const base = `http://127.0.0.1:${fixtures.server.address().port}`;
    async function request(role, method, path, body) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `TestStaff ${role}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        data: response.headers.get("content-type")?.includes("application/json")
          ? await response.json()
          : await response.text(),
      };
    }

    assert.equal((await request("accountant", "GET", "/clinic/marketing/campaigns")).status, 403);
    assert.equal((await request("reception", "POST", "/clinic/marketing/campaigns", {
      code: marker, channel: "referral",
    })).status, 403);
    const created = await request("owner", "POST", "/clinic/marketing/campaigns", {
      code: marker, channel: "community", startDate: "2024-01-01", endDate: "2030-12-31",
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    fixtures.campaignIds.push(created.data.id);
    const updated = await request("manager", "PATCH", `/clinic/marketing/campaigns/${created.data.id}`, {
      channel: "community event",
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.channel, "community event");
    assert.equal((await request("accountant", "GET", "/clinic/marketing/report")).status, 403);

    const report = await request("manager", "GET", "/clinic/marketing/report");
    assert.equal(report.status, 200, JSON.stringify(report.data));
    assert.equal(report.data.campaigns.find((campaign) => campaign.id === created.data.id).referrals, 2);
    assert.equal(
      report.data.unattributedSources.find((source) => source.source === `COMMUNITY ${marker}`.toUpperCase())?.referrals,
      1,
    );
    assert.equal(report.data.totalReferrals >= 3, true);
    const serializedReport = JSON.stringify(report.data);
    function assertAggregateOnly(value) {
      if (Array.isArray(value)) {
        for (const item of value) assertAggregateOnly(item);
      } else if (value && typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
          assert.equal(["patientId", "patient_id", "fullName", "phone", "email"].includes(key), false);
          assertAggregateOnly(item);
        }
      }
    }
    assertAggregateOnly(report.data);
    assert.equal(serializedReport.includes("Fictional patient"), false);
    assert.equal(serializedReport.includes("+201"), false);

    const disabled = await request("owner", "POST", `/clinic/marketing/campaigns/${created.data.id}/disable`);
    assert.equal(disabled.status, 200);
    assert.equal(disabled.data.status, "disabled");
    const connection = await pool.connect();
    try {
      const persisted = await connection.query(
        "SELECT code, status FROM marketing_campaigns WHERE id = $1", [created.data.id],
      );
      assert.deepEqual(persisted.rows[0], { code: marker, status: "disabled" });
      const events = await connection.query(
        `SELECT action FROM clinic_audit_log
          WHERE entity_type = 'marketing_campaign' AND entity_id = $1
          ORDER BY id`, [created.data.id],
      );
      assert.deepEqual(events.rows.map((row) => row.action), ["create", "update", "disable"]);
    } finally {
      connection.release();
    }
  } finally {
    try {
      if (fixtures.server) {
        await new Promise((resolve, reject) => fixtures.server.close((error) => error ? reject(error) : resolve()));
      }
      await db.transaction(async (tx) => {
        if (fixtures.campaignIds.length) {
          const ids = fixtures.campaignIds;
          await tx.execute(sql`DELETE FROM marketing_campaigns WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
          await tx.delete(auditLogTable).where(inArray(auditLogTable.entityId, ids));
        }
        if (fixtures.patientIds.length) {
          await tx.delete(patientsTable).where(inArray(patientsTable.id, fixtures.patientIds));
        }
        if (fixtures.staff.length) {
          const ids = fixtures.staff.map((staff) => staff.id);
          await tx.delete(auditLogTable).where(inArray(auditLogTable.actorStaffId, ids));
          await tx.delete(staffTable).where(inArray(staffTable.id, ids));
        }
      });
    } finally {
      await pool.end();
    }
  }
});