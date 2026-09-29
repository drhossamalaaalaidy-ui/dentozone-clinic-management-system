import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { eq } from "drizzle-orm";
import {
  auditLogTable, db, expensesTable, installmentsTable, inventoryItemsTable,
  invoiceItemsTable, invoicesTable, patientsTable, paymentsTable, pool,
  staffTable, stockMovementsTable, suppliersTable,
} from "@workspace/db";
import financeRouter from "../routes/clinicFinance";
import inventoryRouter from "../routes/clinicInventory";

const marker = `FINANCE-SMOKE-${Date.now()}`;
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
const later = new Date(`${today}T00:00:00Z`);
later.setUTCDate(later.getUTCDate() + 30);
const dueDate = later.toISOString().slice(0, 10);

async function run(): Promise<void> {
  let staffId = 0;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.locals.staff = {
      id: staffId, name: marker, role: req.header("x-test-role") ?? "owner", status: "active",
    };
    next();
  });
  app.use(financeRouter, inventoryRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const request = async (
    method: string, path: string, body?: object, role = "owner",
  ): Promise<{ status: number; data: any }> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-test-role": role },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };

  let patientId: number | undefined;
  try {
    const [staff] = await db.insert(staffTable).values({
      email: `${marker.toLowerCase()}@example.invalid`,
      name: marker,
      role: "owner",
      status: "active",
    }).returning();
    staffId = staff.id;
    const [patient] = await db.insert(patientsTable).values({
      fullName: marker,
      gender: "undisclosed",
      phone: `09${Date.now()}`,
      isDemo: true,
    }).returning();
    patientId = patient.id;

    const baseline = await request("GET", `/finance/report?from=${today}&to=${today}`);
    assert.equal(baseline.status, 200, JSON.stringify(baseline.data));

    const search = await request("GET", `/finance/patients?search=${marker}`, undefined, "accountant");
    assert.equal(search.status, 200, JSON.stringify(search.data));
    assert.deepEqual(Object.keys(search.data.find((p: any) => p.id === patientId)).sort(),
      ["fullName", "id", "patientCode"]);
    assert.equal((await request("GET", "/finance/invoices", undefined, "assistant")).status, 403);

    const supplier = await request("POST", "/finance/suppliers", { name: marker });
    assert.equal(supplier.status, 201, JSON.stringify(supplier.data));
    const item = await request("POST", "/inventory", {
      name: marker, sku: marker, unit: "box", reorderLevel: 5,
      unitCostCents: 1250, supplierId: supplier.data.id,
    });
    assert.equal(item.status, 201, JSON.stringify(item.data));
    assert.equal((await request("GET", "/inventory", undefined, "reception")).status, 403);
    const assistantList = await request("GET", "/inventory", undefined, "assistant");
    assert.equal(assistantList.status, 200);
    assert.equal(assistantList.data.find((row: any) => row.id === item.data.id).unitCostCents, null);
    assert.equal((await request("POST", `/inventory/${item.data.id}/movements`,
      { delta: 5, reason: "receive" }, "assistant")).status, 403);
    assert.equal((await request("POST", `/inventory/${item.data.id}/movements`,
      { delta: 5, reason: "receive" })).status, 201);
    assert.equal((await request("POST", `/inventory/${item.data.id}/movements`,
      { delta: -2, reason: "consume" }, "assistant")).status, 201);
    assert.equal((await request("POST", `/inventory/${item.data.id}/movements`,
      { delta: -99, reason: "consume" })).status, 409);
    const stock = await request("GET", "/inventory");
    const updatedItem = stock.data.find((row: any) => row.id === item.data.id);
    assert.equal(updatedItem.quantityOnHand, 3);
    assert.equal(updatedItem.lowStock, true);
    assert.equal((await request("GET", `/inventory/${item.data.id}/movements`)).data.length, 2);
    const competingConsumption = await Promise.all([
      request("POST", `/inventory/${item.data.id}/movements`,
        { delta: -2, reason: "consume" }, "assistant"),
      request("POST", `/inventory/${item.data.id}/movements`,
        { delta: -2, reason: "consume" }, "assistant"),
    ]);
    assert.deepEqual(competingConsumption.map((response) => response.status).sort(), [201, 409]);
    const afterCompetition = await request("GET", "/inventory");
    assert.equal(afterCompetition.data.find((row: any) => row.id === item.data.id).quantityOnHand, 1);

    const invoice = await request("POST", "/finance/invoices", {
      patientId, items: [
        { description: "Consultation", quantity: 1, unitPriceCents: 10000 },
        { description: "Procedure", quantity: 1, unitPriceCents: 5000 },
      ],
      installments: [
        { dueDate: today, amountCents: 10000 },
        { dueDate, amountCents: 5000 },
      ],
      dueDate,
    });
    assert.equal(invoice.status, 201, JSON.stringify(invoice.data));
    assert.equal(invoice.data.totalCents, 15000);
    assert.equal(invoice.data.balanceCents, 15000);
    assert.equal(invoice.data.dueDate, dueDate);
    assert.equal(invoice.data.installments[0].dueDate, today);
    const invoiceId = invoice.data.id;
    const firstPage = await request("GET", `/finance/invoices?patientId=${patientId}&limit=1&offset=0`);
    const secondPage = await request("GET", `/finance/invoices?patientId=${patientId}&limit=1&offset=1`);
    assert.equal(firstPage.data[0].id, invoiceId);
    assert.deepEqual(secondPage.data, []);
    const firstInstallmentId = invoice.data.installments[0].id;
    const secondInstallmentId = invoice.data.installments[1].id;

    const partial = await request("POST", `/finance/invoices/${invoiceId}/payments`, {
      amountCents: 3000, method: "cash", installmentId: firstInstallmentId,
    });
    assert.equal(partial.status, 201, JSON.stringify(partial.data));
    assert.equal((await request("POST", `/finance/invoices/${invoiceId}/payments`, {
      amountCents: 8000, method: "cash", installmentId: firstInstallmentId,
    })).status, 409);
    const competingPayments = await Promise.all([
      request("POST", `/finance/invoices/${invoiceId}/payments`, {
        amountCents: 6000, method: "card", installmentId: firstInstallmentId,
      }),
      request("POST", `/finance/invoices/${invoiceId}/payments`, {
        amountCents: 6000, method: "card", installmentId: firstInstallmentId,
      }),
    ]);
    assert.deepEqual(competingPayments.map((response) => response.status).sort(), [201, 409]);
    assert.equal((await request("POST", `/finance/invoices/${invoiceId}/payments`, {
      amountCents: 1000, method: "card", installmentId: firstInstallmentId,
    })).status, 201);
    assert.equal((await request("POST", `/finance/invoices/${invoiceId}/payments`, {
      amountCents: 5000, method: "cash", installmentId: secondInstallmentId,
    })).status, 201);
    const paidInvoice = await request("GET", `/finance/invoices/${invoiceId}`);
    assert.equal(paidInvoice.status, 200);
    assert.equal(paidInvoice.data.paidCents, 15000);
    assert.equal(paidInvoice.data.balanceCents, 0);
    assert.equal(paidInvoice.data.status, "paid");

    const expense = await request("POST", "/finance/expenses", {
      category: marker, amountCents: 2500, supplierId: supplier.data.id,
    });
    assert.equal(expense.status, 201, JSON.stringify(expense.data));
    assert.equal((await request("PATCH", `/finance/expenses/${expense.data.id}`,
      { amountCents: 2000 })).status, 200);
    const beforeApril1 = await request("GET", "/finance/report?from=2026-04-01&to=2026-04-01");
    const beforeApril2 = await request("GET", "/finance/report?from=2026-04-02&to=2026-04-02");
    const lateExpense = await request("POST", "/finance/expenses", {
      category: marker, amountCents: 100, occurredAt: "2026-04-01T22:30:00.000Z",
    });
    assert.equal(lateExpense.status, 201, JSON.stringify(lateExpense.data));
    const correctedLateExpense = await request("PATCH", `/finance/expenses/${lateExpense.data.id}`,
      { amountCents: 200 });
    assert.equal(correctedLateExpense.status, 200);
    assert.equal(correctedLateExpense.data.occurredAt, "2026-04-01T22:30:00.000Z");
    const afterApril1 = await request("GET", "/finance/report?from=2026-04-01&to=2026-04-01");
    const afterApril2 = await request("GET", "/finance/report?from=2026-04-02&to=2026-04-02");
    assert.equal(afterApril1.data.expenseCents - beforeApril1.data.expenseCents, 0);
    assert.equal(afterApril2.data.expenseCents - beforeApril2.data.expenseCents, 200);
    const report = await request("GET", `/finance/report?from=${today}&to=${today}`);
    assert.equal(report.status, 200, JSON.stringify(report.data));
    assert.equal(report.data.from, today);
    assert.equal(report.data.revenueCents - baseline.data.revenueCents, 15000);
    assert.equal(report.data.expenseCents - baseline.data.expenseCents, 2000);
    const audits = await db.select().from(auditLogTable).where(eq(auditLogTable.actorName, marker));
    assert.ok(audits.length >= 8, `Expected audit records; got ${audits.length}`);
    process.stdout.write("Finance and inventory smoke checks passed.\n");
  } finally {
    try {
      await db.transaction(async (tx) => {
        const items = await tx.select({ id: inventoryItemsTable.id }).from(inventoryItemsTable)
          .where(eq(inventoryItemsTable.sku, marker));
        for (const item of items) {
          await tx.delete(stockMovementsTable).where(eq(stockMovementsTable.itemId, item.id));
          await tx.delete(inventoryItemsTable).where(eq(inventoryItemsTable.id, item.id));
        }
        if (patientId !== undefined) {
          const invoices = await tx.select({ id: invoicesTable.id }).from(invoicesTable)
            .where(eq(invoicesTable.patientId, patientId));
          for (const invoice of invoices) {
            await tx.delete(paymentsTable).where(eq(paymentsTable.invoiceId, invoice.id));
            await tx.delete(installmentsTable).where(eq(installmentsTable.invoiceId, invoice.id));
            await tx.delete(invoiceItemsTable).where(eq(invoiceItemsTable.invoiceId, invoice.id));
            await tx.delete(invoicesTable).where(eq(invoicesTable.id, invoice.id));
          }
        }
        await tx.delete(expensesTable).where(eq(expensesTable.category, marker));
        await tx.delete(suppliersTable).where(eq(suppliersTable.name, marker));
        if (patientId !== undefined) await tx.delete(patientsTable).where(eq(patientsTable.id, patientId));
        await tx.delete(auditLogTable).where(eq(auditLogTable.actorName, marker));
        if (staffId) await tx.delete(staffTable).where(eq(staffTable.id, staffId));
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    }
  }
}

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});