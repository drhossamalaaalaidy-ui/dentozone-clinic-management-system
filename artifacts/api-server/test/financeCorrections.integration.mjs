import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { build } from "esbuild";
import express from "express";
import { and, eq, inArray, or } from "drizzle-orm";

if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT) {
  throw new Error("Finance correction tests must never run against production");
}
if (!process.env.DATABASE_URL) throw new Error("A development DATABASE_URL is required");

const testDir = dirname(fileURLToPath(import.meta.url));
const output = fileURLToPath(new URL("../node_modules/.cache/finance-corrections-test.mjs", import.meta.url));
await mkdir(dirname(output), { recursive: true });
await build({
  stdin: {
    contents: `
      export { default as financeRouter } from "../src/routes/clinicFinance";
      export { default as dashboardRouter } from "../src/routes/clinicDashboard";
      export {
        db, pool, auditLogTable, financeCorrectionsTable, installmentsTable, invoiceItemsTable,
        invoicesTable, patientsTable, paymentsTable, staffTable,
      } from "@workspace/db";
    `,
    resolveDir: testDir,
    sourcefile: "finance-corrections-entry.ts",
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
  db, pool, auditLogTable, financeCorrectionsTable, installmentsTable, invoiceItemsTable,
  invoicesTable, patientsTable, paymentsTable, staffTable,
} = api;

const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());

test("finance voids retain originals and restore balances with audited reasons", async () => {
  const marker = `FINANCE-CORRECTION-${randomUUID()}`;
  const fixture = { staff: [], patientId: undefined, invoiceIds: [], server: undefined };
  try {
    fixture.staff = await db.insert(staffTable).values(
      ["owner", "manager", "accountant", "assistant"].map((role) => ({
        email: `correction-${role}-${marker.toLowerCase()}@example.invalid`,
        name: `Fictional ${role} ${marker}`,
        role,
        status: "active",
      })),
    ).returning();
    const staffByRole = new Map(fixture.staff.map((staff) => [staff.role, staff]));
    const [patient] = await db.insert(patientsTable).values({
      fullName: `Fictional patient ${marker}`,
      gender: "undisclosed",
      phone: `+201${randomUUID().replaceAll("-", "").slice(0, 10)}`,
      isDemo: true,
    }).returning();
    fixture.patientId = patient.id;

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      const role = req.get("authorization")?.match(/^TestStaff (owner|manager|accountant|assistant)$/)?.[1];
      if (!role) return res.status(401).json({ error: "Test staff authentication required" });
      res.locals.staff = staffByRole.get(role);
      next();
    });
    app.use(api.financeRouter, api.dashboardRouter);
    fixture.server = app.listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => {
      fixture.server.once("listening", resolve);
      fixture.server.once("error", reject);
    });
    const base = `http://127.0.0.1:${fixture.server.address().port}`;
    async function request(role, method, path, body) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `TestStaff ${role}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json() };
    }

    const reportBefore = await request("owner", "GET", `/finance/report?from=${today}&to=${today}`);
    assert.equal(reportBefore.status, 200, JSON.stringify(reportBefore.data));
    const dashboardBefore = await request("owner", "GET", "/dashboard");
    assert.equal(dashboardBefore.status, 200, JSON.stringify(dashboardBefore.data));
    const invoiceResponse = await request("accountant", "POST", "/finance/invoices", {
      patientId: fixture.patientId,
      items: [{ description: "Fictional correction test", quantity: 1, unitPriceCents: 10000 }],
      installments: [{ dueDate: today, amountCents: 5000 }, { dueDate: today, amountCents: 5000 }],
      notes: marker,
    });
    assert.equal(invoiceResponse.status, 201, JSON.stringify(invoiceResponse.data));
    const invoiceId = invoiceResponse.data.id;
    fixture.invoiceIds.push(invoiceId);
    await db.update(invoicesTable).set({ isDemo: true }).where(eq(invoicesTable.id, invoiceId));
    const [first, second] = invoiceResponse.data.installments;

    const paymentA = await request("accountant", "POST", `/finance/invoices/${invoiceId}/payments`, {
      amountCents: 3500, method: "cash", installmentId: first.id, reference: marker,
    });
    const paymentB = await request("manager", "POST", `/finance/invoices/${invoiceId}/payments`, {
      amountCents: 2500, method: "card", installmentId: second.id,
    });
    assert.equal(paymentA.status, 201, JSON.stringify(paymentA.data));
    assert.equal(paymentB.status, 201, JSON.stringify(paymentB.data));
    await db.update(paymentsTable).set({ isDemo: true })
      .where(inArray(paymentsTable.id, [paymentA.data.id, paymentB.data.id]));

    const forbidden = await request("assistant", "POST", `/finance/payments/${paymentA.data.id}/void`, {
      reason: "Fictional correction",
    });
    assert.equal(forbidden.status, 403);
    const unsafeVoid = await request("owner", "POST", `/finance/invoices/${invoiceId}/void`, {
      reason: "Fictional invoice cancellation",
    });
    assert.equal(unsafeVoid.status, 409);

    const reversedA = await request("accountant", "POST", `/finance/payments/${paymentA.data.id}/void`, {
      reason: "Fictional payment entered against the wrong receipt",
    });
    assert.equal(reversedA.status, 200, JSON.stringify(reversedA.data));
    assert.equal(reversedA.data.paidCents, 2500);
    assert.deepEqual(reversedA.data.installments.map((row) => row.paidCents), [0, 2500]);
    assert.equal(reversedA.data.correctionHistory[0].reason, "Fictional payment entered against the wrong receipt");
    const duplicate = await request("owner", "POST", `/finance/payments/${paymentA.data.id}/void`, {
      reason: "Duplicate correction attempt",
    });
    assert.equal(duplicate.status, 409);
    assert.equal((await request("owner", "POST", `/finance/invoices/${invoiceId}/payments`, {
      amountCents: 10001, method: "cash", installmentId: second.id,
    })).status, 409);

    const reversedB = await request("owner", "POST", `/finance/payments/${paymentB.data.id}/void`, {
      reason: "Fictional second receipt correction",
    });
    assert.equal(reversedB.status, 200, JSON.stringify(reversedB.data));
    assert.equal(reversedB.data.paidCents, 0);
    assert.deepEqual(reversedB.data.installments.map((row) => row.paidCents), [0, 0]);
    const originals = await db.select().from(paymentsTable).where(eq(paymentsTable.invoiceId, invoiceId));
    assert.equal(originals.length, 2);
    assert.equal(originals.find((row) => row.id === paymentA.data.id).amountCents, 3500);

    const voidedInvoice = await request("manager", "POST", `/finance/invoices/${invoiceId}/void`, {
      reason: "Fictional invoice created for the incorrect patient",
    });
    assert.equal(voidedInvoice.status, 200, JSON.stringify(voidedInvoice.data));
    assert.equal(voidedInvoice.data.correctionHistory.some((event) => event.entityType === "invoice"), true);
    assert.equal((await request("accountant", "POST", `/finance/invoices/${invoiceId}/payments`, {
      amountCents: 1, method: "cash", installmentId: first.id,
    })).status, 409);
    const reportAfter = await request("owner", "GET", `/finance/report?from=${today}&to=${today}`);
    assert.equal(reportAfter.status, 200);
    assert.equal(reportAfter.data.revenueCents, reportBefore.data.revenueCents);
    assert.equal(reportAfter.data.invoiceCount, reportBefore.data.invoiceCount);

    const auditRows = await db.select().from(auditLogTable).where(and(
      eq(auditLogTable.action, "void"),
      or(
        and(eq(auditLogTable.entityType, "invoice"), eq(auditLogTable.entityId, invoiceId)),
        and(eq(auditLogTable.entityType, "payment"), inArray(auditLogTable.entityId, [paymentA.data.id, paymentB.data.id])),
      ),
    ));
    const paymentEvent = auditRows.find((row) => row.entityType === "payment" && row.entityId === paymentA.data.id);
    const audited = JSON.parse(paymentEvent.summary);
    assert.equal(audited.reason, "Fictional payment entered against the wrong receipt");
    assert.equal(audited.before.invoice.paidCents, 6000);
    assert.equal(audited.after.invoice.paidCents, 2500);
    assert.equal(audited.before.payment.amountCents, 3500);

    await db.delete(auditLogTable).where(and(
      eq(auditLogTable.action, "void"),
      or(
        and(eq(auditLogTable.entityType, "invoice"), eq(auditLogTable.entityId, invoiceId)),
        and(eq(auditLogTable.entityType, "payment"), inArray(auditLogTable.entityId, [paymentA.data.id, paymentB.data.id])),
      ),
    ));
    const detailAfterAuditDeletion = await request("owner", "GET", `/finance/invoices/${invoiceId}`);
    assert.equal(detailAfterAuditDeletion.data.correctionHistory.length, 3);
    assert.equal((await request("accountant", "POST", `/finance/invoices/${invoiceId}/payments`, {
      amountCents: 1, method: "cash", installmentId: first.id,
    })).status, 409);
    const finalReport = await request("owner", "GET", `/finance/report?from=${today}&to=${today}`);
    const finalDashboard = await request("owner", "GET", "/dashboard");
    assert.equal(finalReport.status, 200);
    assert.equal(finalDashboard.status, 200);
    assert.equal(finalDashboard.data.todayRevenue * 100, finalReport.data.revenueCents);
    assert.equal(finalDashboard.data.outstandingPayments * 100, finalReport.data.outstandingCents);
    assert.equal(finalReport.data.revenueCents, reportBefore.data.revenueCents);
    assert.equal(finalDashboard.data.todayRevenue, dashboardBefore.data.todayRevenue);
    assert.equal(finalDashboard.data.outstandingPayments, dashboardBefore.data.outstandingPayments);
  } finally {
    try {
      if (fixture.server) {
        await new Promise((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
      }
      await db.transaction(async (tx) => {
        if (fixture.invoiceIds.length) {
          const paymentRows = await tx.select({ id: paymentsTable.id }).from(paymentsTable)
            .where(inArray(paymentsTable.invoiceId, fixture.invoiceIds));
          await tx.delete(financeCorrectionsTable).where(inArray(financeCorrectionsTable.invoiceId, fixture.invoiceIds));
          await tx.delete(auditLogTable).where(and(
            eq(auditLogTable.action, "void"),
            or(
              and(eq(auditLogTable.entityType, "invoice"), inArray(auditLogTable.entityId, fixture.invoiceIds)),
              and(eq(auditLogTable.entityType, "payment"), inArray(auditLogTable.entityId, paymentRows.map((row) => row.id))),
            ),
          ));
          await tx.delete(paymentsTable).where(inArray(paymentsTable.invoiceId, fixture.invoiceIds));
          await tx.delete(installmentsTable).where(inArray(installmentsTable.invoiceId, fixture.invoiceIds));
          await tx.delete(invoiceItemsTable).where(inArray(invoiceItemsTable.invoiceId, fixture.invoiceIds));
          await tx.delete(invoicesTable).where(inArray(invoicesTable.id, fixture.invoiceIds));
        }
        if (fixture.patientId !== undefined) {
          await tx.delete(patientsTable).where(eq(patientsTable.id, fixture.patientId));
        }
        if (fixture.staff.length) {
          const ids = fixture.staff.map((staff) => staff.id);
          await tx.delete(auditLogTable).where(inArray(auditLogTable.actorStaffId, ids));
          await tx.delete(staffTable).where(inArray(staffTable.id, ids));
        }
      });
    } finally {
      await pool.end();
    }
  }
});
