import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { build } from "esbuild";
import express from "express";
import { eq, inArray } from "drizzle-orm";

// These tests use fictional, uniquely identified fixtures and must only touch development data.
if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT) {
  throw new Error("Finance integration tests must never run against production");
}
if (!process.env.DATABASE_URL) throw new Error("A development DATABASE_URL is required");

const testDir = dirname(fileURLToPath(import.meta.url));
const output = fileURLToPath(new URL("../node_modules/.cache/finance-flows-test.mjs", import.meta.url));
await mkdir(dirname(output), { recursive: true });
await build({
  stdin: {
    contents: `
      export { default as financeRouter } from "../src/routes/clinicFinance";
      export { default as inventoryRouter } from "../src/routes/clinicInventory";
      export {
        db, pool, auditLogTable, expensesTable, installmentsTable, inventoryItemsTable,
        invoiceItemsTable, invoicesTable, patientsTable, paymentsTable, staffTable,
        stockMovementsTable, suppliersTable,
      } from "@workspace/db";
    `,
    resolveDir: testDir,
    sourcefile: "finance-flows-entry.ts",
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
  db, pool, auditLogTable, expensesTable, installmentsTable, inventoryItemsTable,
  invoiceItemsTable, invoicesTable, patientsTable, paymentsTable, staffTable,
  stockMovementsTable, suppliersTable,
} = api;

const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
const afterToday = new Date(`${today}T00:00:00.000Z`);
afterToday.setUTCDate(afterToday.getUTCDate() + 21);
const secondDueDate = afterToday.toISOString().slice(0, 10);

test("finance and inventory routes persist correct fictional transactions", async () => {
  const marker = `FINANCE-FLOW-${randomUUID()}`;
  const fixture = {
    staff: [],
    patientId: undefined,
    supplierId: undefined,
    itemId: undefined,
    invoiceIds: [],
    expenseIds: [],
    movementIds: [],
    server: undefined,
  };
  try {
    fixture.staff = await db.insert(staffTable).values(
      ["owner", "manager", "accountant", "assistant", "reception"].map((role) => ({
        email: `fixture-${role}-${marker.toLowerCase()}@example.invalid`,
        name: `Fictional ${role} ${marker}`,
        role,
        status: "active",
      })),
    ).returning();
    const staffByRole = new Map(fixture.staff.map((staff) => [staff.role, staff]));
    const [patient] = await db.insert(patientsTable).values({
      fullName: `Fictional Patient ${marker}`,
      gender: "undisclosed",
      phone: `+201${randomUUID().replaceAll("-", "").slice(0, 10)}`,
      isDemo: true,
    }).returning();
    fixture.patientId = patient.id;

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      const role = req.get("authorization")?.match(
        /^TestStaff (owner|manager|accountant|assistant|reception)$/,
      )?.[1];
      if (!role) return res.status(401).json({ error: "Test staff authentication required" });
      res.locals.staff = staffByRole.get(role);
      next();
    });
    app.use(api.financeRouter, api.inventoryRouter);
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
      const type = response.headers.get("content-type");
      return {
        status: response.status,
        data: type?.includes("application/json") ? await response.json() : await response.text(),
      };
    }

    assert.equal((await request("assistant", "GET", "/finance/invoices")).status, 403);
    assert.equal((await request("reception", "POST", "/finance/suppliers", { name: marker })).status, 403);
    const baseline = await request("owner", "GET", `/finance/report?from=${today}&to=${today}`);
    assert.equal(baseline.status, 200, JSON.stringify(baseline.data));

    const supplier = await request("accountant", "POST", "/finance/suppliers", {
      name: `Supplier ${marker}`,
      phone: "+201000000001",
      email: `supplier-${randomUUID()}@example.invalid`,
      notes: "Fictional integration fixture",
    });
    assert.equal(supplier.status, 201, JSON.stringify(supplier.data));
    fixture.supplierId = supplier.data.id;
    await db.update(suppliersTable).set({ isDemo: true })
      .where(eq(suppliersTable.id, fixture.supplierId));
    const editedSupplier = await request("owner", "PATCH", `/finance/suppliers/${fixture.supplierId}`, {
      phone: "+201000000002",
      notes: "Updated fictional fixture",
    });
    assert.equal(editedSupplier.status, 200);
    assert.equal(editedSupplier.data.phone, "+201000000002");
    assert.equal((await request("accountant", "GET", "/finance/suppliers")).data
      .some((row) => row.id === fixture.supplierId), true);

    const createdItem = await request("owner", "POST", "/inventory", {
      name: `Fictional stock ${marker}`,
      sku: marker,
      unit: "box",
      reorderLevel: 3,
      unitCostCents: 725,
      supplierId: fixture.supplierId,
    });
    assert.equal(createdItem.status, 201, JSON.stringify(createdItem.data));
    fixture.itemId = createdItem.data.id;
    await db.update(inventoryItemsTable).set({ isDemo: true })
      .where(eq(inventoryItemsTable.id, fixture.itemId));
    assert.equal((await request("reception", "GET", "/inventory")).status, 403);
    const assistantStock = await request("assistant", "GET", "/inventory");
    assert.equal(assistantStock.status, 200);
    assert.equal(assistantStock.data.find((row) => row.id === fixture.itemId).unitCostCents, null);
    assert.equal((await request("assistant", "POST", `/inventory/${fixture.itemId}/movements`,
      { delta: 6, reason: "receive" })).status, 403);
    const received = await request("accountant", "POST", `/inventory/${fixture.itemId}/movements`,
      { delta: 6, reason: "receive", note: "Fictional receipt" });
    assert.equal(received.status, 201, JSON.stringify(received.data));
    fixture.movementIds.push(received.data.id);
    const consumed = await request("assistant", "POST", `/inventory/${fixture.itemId}/movements`,
      { delta: -2, reason: "consume", note: "Fictional use" });
    assert.equal(consumed.status, 201, JSON.stringify(consumed.data));
    fixture.movementIds.push(consumed.data.id);
    assert.equal((await request("owner", "POST", `/inventory/${fixture.itemId}/movements`,
      { delta: -99, reason: "consume" })).status, 409);
    const itemList = await request("owner", "GET", "/inventory");
    const itemDto = itemList.data.find((row) => row.id === fixture.itemId);
    assert.equal(itemDto.quantityOnHand, 4);
    assert.equal(itemDto.lowStock, false);
    assert.equal((await request("owner", "GET", `/inventory/${fixture.itemId}/movements`)).data.length, 2);

    const invoice = await request("accountant", "POST", "/finance/invoices", {
      patientId: fixture.patientId,
      items: [
        { description: "Fictional exam", quantity: 2, unitPriceCents: 3250 },
        { description: "Fictional procedure", quantity: 1, unitPriceCents: 5000 },
      ],
      installments: [
        { dueDate: today, amountCents: 7000 },
        { dueDate: secondDueDate, amountCents: 4500 },
      ],
      dueDate: secondDueDate,
      notes: "Fictional integration invoice",
    });
    assert.equal(invoice.status, 201, JSON.stringify(invoice.data));
    fixture.invoiceIds.push(invoice.data.id);
    await db.update(invoicesTable).set({ isDemo: true })
      .where(eq(invoicesTable.id, invoice.data.id));
    assert.equal(invoice.data.totalCents, 11500);
    assert.deepEqual(invoice.data.items.map((row) => row.totalCents), [6500, 5000]);
    assert.equal(invoice.data.balanceCents, 11500);
    assert.equal(invoice.data.installments.reduce((sum, row) => sum + row.amountCents, 0), 11500);
    assert.equal(invoice.data.installments.length, 2);
    const invoiceId = invoice.data.id;
    const [firstInstallment, secondInstallment] = invoice.data.installments;

    assert.equal((await request("assistant", "POST", `/finance/invoices/${invoiceId}/payments`, {
      amountCents: 1, method: "cash", installmentId: firstInstallment.id,
    })).status, 403);
    const firstPayment = await request("accountant", "POST", `/finance/invoices/${invoiceId}/payments`, {
      amountCents: 4000, method: "cash", installmentId: firstInstallment.id,
      reference: `fictional-${marker}`,
    });
    assert.equal(firstPayment.status, 201, JSON.stringify(firstPayment.data));
    await db.update(paymentsTable).set({ isDemo: true })
      .where(eq(paymentsTable.id, firstPayment.data.id));
    assert.equal((await request("owner", "POST", `/finance/invoices/${invoiceId}/payments`, {
      amountCents: 3001, method: "card", installmentId: firstInstallment.id,
    })).status, 409);
    const restOfFirstInstallment = await request("owner", "POST", `/finance/invoices/${invoiceId}/payments`, {
      amountCents: 3000, method: "card", installmentId: firstInstallment.id,
    });
    assert.equal(restOfFirstInstallment.status, 201, JSON.stringify(restOfFirstInstallment.data));
    await db.update(paymentsTable).set({ isDemo: true })
      .where(eq(paymentsTable.id, restOfFirstInstallment.data.id));
    const secondPayment = await request("accountant", "POST", `/finance/invoices/${invoiceId}/payments`, {
      amountCents: 4500, method: "bank_transfer", installmentId: secondInstallment.id,
    });
    assert.equal(secondPayment.status, 201, JSON.stringify(secondPayment.data));
    await db.update(paymentsTable).set({ isDemo: true })
      .where(eq(paymentsTable.id, secondPayment.data.id));
    const paidInvoice = await request("owner", "GET", `/finance/invoices/${invoiceId}`);
    assert.equal(paidInvoice.status, 200);
    assert.equal(paidInvoice.data.paidCents, 11500);
    assert.equal(paidInvoice.data.balanceCents, 0);
    assert.equal(paidInvoice.data.status, "paid");
    assert.deepEqual(paidInvoice.data.installments.map((row) => row.paidCents), [7000, 4500]);

    const noScheduleInvoice = await request("owner", "POST", "/finance/invoices", {
      patientId: fixture.patientId,
      items: [{ description: "Fictional add-on", quantity: 1, unitPriceCents: 1000 }],
    });
    assert.equal(noScheduleInvoice.status, 201, JSON.stringify(noScheduleInvoice.data));
    fixture.invoiceIds.push(noScheduleInvoice.data.id);
    await db.update(invoicesTable).set({ isDemo: true })
      .where(eq(invoicesTable.id, noScheduleInvoice.data.id));
    assert.equal((await request("accountant", "POST",
      `/finance/invoices/${noScheduleInvoice.data.id}/payments`, {
        amountCents: 1001, method: "cash",
      })).status, 409);
    assert.equal((await request("accountant", "POST",
      `/finance/invoices/${noScheduleInvoice.data.id}/payments`, {
        amountCents: 1000, method: "cash",
      })).status, 201);
    const [noSchedulePayment] = await db.select({ id: paymentsTable.id })
      .from(paymentsTable).where(eq(paymentsTable.invoiceId, noScheduleInvoice.data.id));
    await db.update(paymentsTable).set({ isDemo: true })
      .where(eq(paymentsTable.id, noSchedulePayment.id));

    const expense = await request("accountant", "POST", "/finance/expenses", {
      category: `Fictional supplies ${marker}`,
      amountCents: 2400,
      supplierId: fixture.supplierId,
      notes: "Fictional expense",
    });
    assert.equal(expense.status, 201, JSON.stringify(expense.data));
    fixture.expenseIds.push(expense.data.id);
    await db.update(expensesTable).set({ isDemo: true })
      .where(eq(expensesTable.id, expense.data.id));
    assert.equal(expense.data.supplierName, `Supplier ${marker}`);
    const correctedExpense = await request("owner", "PATCH", `/finance/expenses/${expense.data.id}`, {
      amountCents: 2100,
      notes: "Corrected fictional expense",
    });
    assert.equal(correctedExpense.status, 200);
    assert.equal(correctedExpense.data.amountCents, 2100);
    assert.equal((await request("accountant", "GET", "/finance/expenses")).data
      .find((row) => row.id === expense.data.id).amountCents, 2100);

    const report = await request("owner", "GET", `/finance/report?from=${today}&to=${today}`);
    assert.equal(report.status, 200, JSON.stringify(report.data));
    assert.equal(report.data.revenueCents - baseline.data.revenueCents, 12500);
    assert.equal(report.data.expenseCents - baseline.data.expenseCents, 2100);

    // A newly opened PostgreSQL connection observes committed API writes.
    const connectionBeforeReconnect = await pool.connect();
    try {
      const firstRead = await connectionBeforeReconnect.query(
        "SELECT total_cents, paid_cents, is_demo FROM invoices WHERE id = $1",
        [invoiceId],
      );
      assert.deepEqual(firstRead.rows[0], { total_cents: 11500, paid_cents: 11500, is_demo: true });
    } finally {
      connectionBeforeReconnect.release(true);
    }
    const reconnectedClient = await pool.connect();
    try {
      const persistedInvoice = await reconnectedClient.query(
        "SELECT total_cents, paid_cents, is_demo FROM invoices WHERE id = $1", [invoiceId],
      );
      const persistedExpense = await reconnectedClient.query(
        "SELECT amount_cents, is_demo FROM expenses WHERE id = $1", [expense.data.id],
      );
      const persistedItem = await reconnectedClient.query(
        "SELECT quantity_on_hand, is_demo FROM inventory_items WHERE id = $1", [fixture.itemId],
      );
      const persistedSupplier = await reconnectedClient.query(
        "SELECT is_demo FROM suppliers WHERE id = $1", [fixture.supplierId],
      );
      const persistedPayments = await reconnectedClient.query(
        "SELECT count(*)::int AS count FROM payments WHERE invoice_id = $1", [invoiceId],
      );
      const persistedMovements = await reconnectedClient.query(
        "SELECT count(*)::int AS count FROM stock_movements WHERE item_id = $1", [fixture.itemId],
      );
      assert.deepEqual(persistedInvoice.rows[0], { total_cents: 11500, paid_cents: 11500, is_demo: true });
      assert.deepEqual(persistedExpense.rows[0], { amount_cents: 2100, is_demo: true });
      assert.deepEqual(persistedItem.rows[0], { quantity_on_hand: 4, is_demo: true });
      assert.deepEqual(persistedSupplier.rows[0], { is_demo: true });
      assert.equal(persistedPayments.rows[0].count, 3);
      assert.equal(persistedMovements.rows[0].count, 2);
    } finally {
      reconnectedClient.release(true);
    }
  } finally {
    try {
      if (fixture.server) {
        await new Promise((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
      }
      await db.transaction(async (tx) => {
        if (fixture.movementIds.length) {
          await tx.delete(stockMovementsTable).where(inArray(stockMovementsTable.id, fixture.movementIds));
        }
        if (fixture.itemId !== undefined) {
          await tx.delete(stockMovementsTable).where(eq(stockMovementsTable.itemId, fixture.itemId));
          await tx.delete(inventoryItemsTable).where(eq(inventoryItemsTable.id, fixture.itemId));
        }
        for (const invoiceId of fixture.invoiceIds) {
          await tx.delete(paymentsTable).where(eq(paymentsTable.invoiceId, invoiceId));
          await tx.delete(installmentsTable).where(eq(installmentsTable.invoiceId, invoiceId));
          await tx.delete(invoiceItemsTable).where(eq(invoiceItemsTable.invoiceId, invoiceId));
          await tx.delete(invoicesTable).where(eq(invoicesTable.id, invoiceId));
        }
        if (fixture.expenseIds.length) {
          await tx.delete(expensesTable).where(inArray(expensesTable.id, fixture.expenseIds));
        }
        if (fixture.supplierId !== undefined) {
          await tx.delete(suppliersTable).where(eq(suppliersTable.id, fixture.supplierId));
        }
        if (fixture.patientId !== undefined) {
          await tx.delete(patientsTable).where(eq(patientsTable.id, fixture.patientId));
        }
        if (fixture.staff.length) {
          const staffIds = fixture.staff.map((row) => row.id);
          await tx.delete(auditLogTable).where(inArray(auditLogTable.actorStaffId, staffIds));
          await tx.delete(staffTable).where(inArray(staffTable.id, staffIds));
        }
      });
    } finally {
      await pool.end();
    }
  }
});