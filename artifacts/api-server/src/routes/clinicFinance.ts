import { Router, type IRouter } from "express";
import { and, asc, desc, eq, gte, ilike, lt, notExists, or, sql } from "drizzle-orm";
import {
  db, auditLogTable, expensesTable, financeCorrectionsTable, installmentsTable, invoiceItemsTable,
  invoicesTable, patientsTable, paymentsTable, suppliersTable,
  type Staff,
} from "@workspace/db";
import {
  CreateExpenseBody, CreateExpenseResponse, CreateInvoiceBody, CreateInvoiceResponse,
  CreateSupplierBody, CreateSupplierResponse, GetFinanceReportQueryParams,
  GetFinanceReportResponse, GetInvoiceParams, GetInvoiceResponse,
  ListExpensesResponse, ListInvoicesQueryParams, ListInvoicesResponse,
  ListSuppliersResponse, RecordPaymentBody, RecordPaymentParams, RecordPaymentResponse,
  SearchBillingPatientsQueryParams, SearchBillingPatientsResponse,
  UpdateExpenseBody, UpdateExpenseParams, UpdateExpenseResponse,
  UpdateSupplierBody, UpdateSupplierParams, UpdateSupplierResponse,
} from "@workspace/api-zod";
import { allowRoles, currentStaff } from "../middlewares/clinicStaff";

const router: IRouter = Router();
const financeAccess = allowRoles("owner", "manager", "accountant");
const MAX_CENTS = 2_147_483_647;
const CAIRO = "Africa/Cairo";

function dateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CAIRO, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

function dateKeyToDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function cairoMidnight(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day);
  let utc = target;
  for (let i = 0; i < 3; i += 1) {
    const local = new Intl.DateTimeFormat("en-GB", {
      timeZone: CAIRO, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(utc));
    const part = (type: string) => Number(local.find((item) => item.type === type)?.value);
    const displayed = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
    utc += target - displayed;
  }
  return new Date(utc);
}

function addDays(value: string, days: number): string {
  const date = dateKeyToDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function toDateColumn(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function normalizeOptionalStrings(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const normalized = { ...(body as Record<string, unknown>) };
  for (const key of ["supplierId", "notes", "phone", "email"]) {
    if (normalized[key] === "") normalized[key] = null;
  }
  return normalized;
}

function auditValues(actor: Staff, action: string, entity: string, id: number, summary: string) {
  return {
    actorStaffId: actor.id, actorName: actor.name, action,
    entityType: entity, entityId: id, summary,
  };
}

async function invoiceDto(invoiceId: number) {
  const [invoice] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invoiceId));
  if (!invoice) return null;
  const [patient] = await db.select({ fullName: patientsTable.fullName })
    .from(patientsTable).where(eq(patientsTable.id, invoice.patientId));
  if (!patient) return null;
  const [items, installments, payments] = await Promise.all([
    db.select().from(invoiceItemsTable).where(eq(invoiceItemsTable.invoiceId, invoiceId))
      .orderBy(asc(invoiceItemsTable.id)),
    db.select().from(installmentsTable).where(eq(installmentsTable.invoiceId, invoiceId))
      .orderBy(asc(installmentsTable.dueDate), asc(installmentsTable.id)),
    db.select().from(paymentsTable).where(eq(paymentsTable.invoiceId, invoiceId))
      .orderBy(asc(paymentsTable.paidAt)),
  ]);
  const correctionRows = await db.select().from(financeCorrectionsTable)
    .where(eq(financeCorrectionsTable.invoiceId, invoiceId))
    .orderBy(asc(financeCorrectionsTable.createdAt), asc(financeCorrectionsTable.id));
  const correctionHistory = correctionRows.map((event) => ({
    id: event.id,
    entityType: event.entityType,
    entityId: event.entityId,
    action: "void",
    reason: event.reason,
    before: event.beforeSnapshot,
    after: event.afterSnapshot,
    actorName: event.actorName,
    createdAt: event.createdAt,
  }));
  const today = dateKey(new Date());
  return {
    id: invoice.id,
    patientId: invoice.patientId,
    patientName: patient.fullName,
    totalCents: invoice.totalCents,
    paidCents: invoice.paidCents,
    balanceCents: invoice.totalCents - invoice.paidCents,
    status: invoice.status,
    issuedAt: invoice.issuedAt,
    dueDate: invoice.dueDate,
    notes: invoice.notes,
    items: items.map(({ id, description, quantity, unitPriceCents, totalCents }) => ({
      id, description, quantity, unitPriceCents, totalCents,
    })),
    installments: installments.map((item) => ({
      id: item.id,
      dueDate: item.dueDate,
      amountCents: item.amountCents,
      paidCents: item.paidCents,
      status: item.paidCents >= item.amountCents
        ? "paid" as const
        : item.paidCents > 0
          ? "partial" as const
          : item.dueDate < today ? "overdue" as const : "upcoming" as const,
    })),
    payments: payments.map((payment) => ({
      id: payment.id,
      invoiceId: payment.invoiceId,
      patientId: payment.patientId,
      installmentId: payment.installmentId,
      amountCents: payment.amountCents,
      method: payment.method,
      reference: payment.reference,
      notes: payment.notes,
      paidAt: payment.paidAt,
    })),
    correctionHistory,
  };
}

const correctionBody = (body: unknown): { reason: string } | null => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const reason = (body as Record<string, unknown>).reason;
  return typeof reason === "string" && reason.trim().length >= 8 && reason.trim().length <= 1000
    ? { reason: reason.trim() }
    : null;
};

function correctionSummary(reason: string, before: unknown, after: unknown): string {
  return JSON.stringify({ reason, before, after });
}

function expenseDto(expense: typeof expensesTable.$inferSelect) {
  return {
    id: expense.id,
    category: expense.category,
    amountCents: expense.amountCents,
    supplierId: expense.supplierId,
    supplierName: expense.supplier,
    notes: expense.notes,
    occurredAt: expense.occurredAt,
  };
}

function supplierDto(supplier: typeof suppliersTable.$inferSelect) {
  return {
    id: supplier.id, name: supplier.name, phone: supplier.phone,
    email: supplier.email, notes: supplier.notes, active: supplier.active,
  };
}

router.get("/finance/patients", financeAccess, async (req, res): Promise<void> => {
  const rawSearch = req.query.search;
  const parsed = SearchBillingPatientsQueryParams.safeParse({
    ...req.query,
    search: typeof rawSearch === "string" ? rawSearch.trim() : rawSearch,
  });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const search = parsed.data.search.trim();
  if (search.length < 2) {
    res.status(400).json({ error: "Search must contain at least two characters" });
    return;
  }
  const codeMatch = /^DZO-(\d+)$/i.exec(search);
  const numericId = /^\d+$/.test(search) ? Number(search) : codeMatch ? Number(codeMatch[1]) : null;
  const idFilter = numericId !== null && Number.isSafeInteger(numericId)
    ? eq(patientsTable.id, numericId) : undefined;
  const patients = await db.select({
    id: patientsTable.id,
    fullName: patientsTable.fullName,
  }).from(patientsTable).where(or(
    ilike(patientsTable.fullName, `%${search}%`),
    idFilter,
  )).orderBy(asc(patientsTable.fullName)).limit(parsed.data.limit);
  const result = patients.map((patient) => ({
    id: patient.id,
    patientCode: `DZO-${String(patient.id).padStart(5, "0")}`,
    fullName: patient.fullName,
  }));
  SearchBillingPatientsResponse.parse(result);
  res.json(result);
});

router.get("/finance/invoices", financeAccess, async (req, res): Promise<void> => {
  const parsed = ListInvoicesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const where = parsed.data.patientId === undefined
    ? undefined : eq(invoicesTable.patientId, parsed.data.patientId);
  const invoices = await db.select({ id: invoicesTable.id }).from(invoicesTable)
    .where(where)
    .orderBy(desc(invoicesTable.issuedAt), desc(invoicesTable.id))
    .limit(parsed.data.limit)
    .offset(parsed.data.offset);
  const rows = await Promise.all(invoices.map(({ id }) => invoiceDto(id)));
  const result = rows.filter((row) => row !== null);
  ListInvoicesResponse.parse(result);
  res.json(result);
});

router.post("/finance/invoices", financeAccess, async (req, res): Promise<void> => {
  const parsed = CreateInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const input = parsed.data;
  if (input.items.some((item) => !item.description.trim())) {
    res.status(400).json({ error: "Invoice items require a description" });
    return;
  }
  const amounts = input.items.map((item) => item.quantity * item.unitPriceCents);
  const totalCents = amounts.reduce((sum, amount) => sum + amount, 0);
  if (amounts.some((amount) => !Number.isSafeInteger(amount) || amount > MAX_CENTS)
    || !Number.isSafeInteger(totalCents) || totalCents < 1 || totalCents > MAX_CENTS) {
    res.status(400).json({ error: "Invoice total exceeds the supported amount" });
    return;
  }
  if (input.installments && input.installments.reduce((sum, installment) => sum + installment.amountCents, 0) !== totalCents) {
    res.status(400).json({ error: "Installments must sum exactly to the invoice total" });
    return;
  }
  const actor = currentStaff(res);
  const invoiceId = await db.transaction(async (tx) => {
    const [patient] = await tx.select({ id: patientsTable.id }).from(patientsTable)
      .where(eq(patientsTable.id, input.patientId));
    if (!patient) return null;
    const [invoice] = await tx.insert(invoicesTable).values({
      patientId: input.patientId,
      totalCents,
      paidCents: 0,
      status: "unpaid",
      dueDate: toDateColumn(input.dueDate),
      notes: input.notes ?? null,
    }).returning();
    await tx.insert(invoiceItemsTable).values(input.items.map((item, index) => ({
      invoiceId: invoice.id,
      description: item.description.trim(),
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      totalCents: amounts[index],
    })));
    if (input.installments?.length) {
      await tx.insert(installmentsTable).values(input.installments.map((item) => ({
        invoiceId: invoice.id,
        dueDate: toDateColumn(item.dueDate)!,
        amountCents: item.amountCents,
        paidCents: 0,
      })));
    }
    await tx.insert(auditLogTable).values(auditValues(actor, "create", "invoice", invoice.id, `Invoice ${invoice.id} created`));
    return invoice.id;
  });
  if (invoiceId === null) {
    res.status(404).json({ error: "Patient not found" });
    return;
  }
  const result = await invoiceDto(invoiceId);
  CreateInvoiceResponse.parse(result);
  res.status(201).json(result);
});

router.get("/finance/invoices/:invoiceId", financeAccess, async (req, res): Promise<void> => {
  const params = GetInvoiceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const invoice = await invoiceDto(params.data.invoiceId);
  if (!invoice) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  const validated = GetInvoiceResponse.parse(invoice);
  res.json({ ...validated, correctionHistory: invoice.correctionHistory });
});

router.post("/finance/invoices/:invoiceId/payments", financeAccess, async (req, res): Promise<void> => {
  const params = RecordPaymentParams.safeParse(req.params);
  const parsed = RecordPaymentBody.safeParse(normalizeOptionalStrings(req.body));
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Invalid payment request" });
    return;
  }
  const actor = currentStaff(res);
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM invoices WHERE id = ${params.data.invoiceId} FOR UPDATE`);
    const [invoice] = await tx.select().from(invoicesTable).where(eq(invoicesTable.id, params.data.invoiceId));
    if (!invoice) return { error: "not_found" as const };
    const [invoiceVoid] = await tx.select({ id: financeCorrectionsTable.id }).from(financeCorrectionsTable).where(and(
      eq(financeCorrectionsTable.entityType, "invoice"),
      eq(financeCorrectionsTable.entityId, invoice.id),
    )).limit(1);
    if (invoiceVoid) return { error: "invoice_voided" as const };
    const [schedule] = await tx.select({ id: installmentsTable.id })
      .from(installmentsTable).where(eq(installmentsTable.invoiceId, invoice.id)).limit(1);
    const installmentId = parsed.data.installmentId ?? null;
    let installment: typeof installmentsTable.$inferSelect | undefined;
    if (schedule) {
      if (installmentId === null) return { error: "schedule_required" as const };
      [installment] = await tx.select().from(installmentsTable).where(and(
        eq(installmentsTable.id, installmentId),
        eq(installmentsTable.invoiceId, invoice.id),
      ));
      if (!installment || parsed.data.amountCents > installment.amountCents - installment.paidCents) {
        return { error: "installment_balance" as const };
      }
    } else if (installmentId !== null) {
      return { error: "unexpected_installment" as const };
    }
    if (parsed.data.amountCents > invoice.totalCents - invoice.paidCents) {
      return { error: "invoice_balance" as const };
    }
    const paidCents = invoice.paidCents + parsed.data.amountCents;
    const [payment] = await tx.insert(paymentsTable).values({
      patientId: invoice.patientId,
      invoiceId: invoice.id,
      installmentId,
      amountCents: parsed.data.amountCents,
      method: parsed.data.method,
      reference: parsed.data.reference ?? null,
      notes: parsed.data.notes ?? null,
    }).returning();
    await tx.update(invoicesTable).set({
      paidCents,
      status: paidCents === invoice.totalCents ? "paid" : "partial",
    }).where(eq(invoicesTable.id, invoice.id));
    if (installment) {
      await tx.update(installmentsTable).set({
        paidCents: installment.paidCents + parsed.data.amountCents,
      }).where(eq(installmentsTable.id, installment.id));
    }
    await tx.insert(auditLogTable).values(auditValues(
      actor, "create", "payment", payment.id, `Payment ${payment.id} recorded for invoice ${invoice.id}`,
    ));
    return { payment };
  });
  if ("error" in result) {
    if (result.error === "not_found") {
      res.status(404).json({ error: "Invoice not found" });
      return;
    }
    res.status(409).json({ error: result.error === "schedule_required"
      ? "An installment must be selected for this invoice"
      : result.error === "unexpected_installment"
        ? "This invoice has no installment schedule"
        : result.error === "installment_balance"
          ? "Payment exceeds the selected installment balance"
          : result.error === "invoice_voided"
            ? "A voided invoice cannot accept payments"
            : "Payment exceeds the invoice balance" });
    return;
  }
  res.status(201).json(RecordPaymentResponse.parse(result.payment));
});

router.post("/finance/invoices/:invoiceId/void", financeAccess, async (req, res): Promise<void> => {
  const params = GetInvoiceParams.safeParse(req.params);
  const body = correctionBody(req.body);
  if (!params.success || !body) {
    res.status(400).json({ error: "A reason of 8 to 1000 characters is required" });
    return;
  }
  const actor = currentStaff(res);
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM invoices WHERE id = ${params.data.invoiceId} FOR UPDATE`);
    const [invoice] = await tx.select().from(invoicesTable).where(eq(invoicesTable.id, params.data.invoiceId));
    if (!invoice) return { error: "not_found" as const };
    const [alreadyVoided] = await tx.select({ id: financeCorrectionsTable.id }).from(financeCorrectionsTable).where(and(
      eq(financeCorrectionsTable.entityType, "invoice"),
      eq(financeCorrectionsTable.entityId, invoice.id),
    )).limit(1);
    if (alreadyVoided) return { error: "already_voided" as const };
    const activePayments = await tx.select({ id: paymentsTable.id }).from(paymentsTable)
      .where(and(
        eq(paymentsTable.invoiceId, invoice.id),
        notExists(tx.select({ id: financeCorrectionsTable.id }).from(financeCorrectionsTable).where(and(
        eq(financeCorrectionsTable.entityType, "payment"),
        eq(financeCorrectionsTable.entityId, paymentsTable.id),
        ))),
      ));
    if (invoice.paidCents !== 0 || activePayments.length > 0) return { error: "not_safe" as const };
    const before = {
      status: invoice.status,
      totalCents: invoice.totalCents,
      paidCents: invoice.paidCents,
      balanceCents: invoice.totalCents - invoice.paidCents,
    };
    const after = { status: "voided", paidCents: invoice.paidCents, balanceCents: invoice.totalCents - invoice.paidCents };
    await tx.insert(financeCorrectionsTable).values({
      entityType: "invoice",
      entityId: invoice.id,
      invoiceId: invoice.id,
      reason: body.reason,
      beforeSnapshot: before,
      afterSnapshot: after,
      actorStaffId: actor.id,
      actorName: actor.name,
    });
    await tx.insert(auditLogTable).values({
      ...auditValues(actor, "void", "invoice", invoice.id, correctionSummary(body.reason, before, after)),
    });
    return { invoiceId: invoice.id };
  });
  if ("error" in outcome) {
    res.status(outcome.error === "not_found" ? 404 : 409).json({
      error: outcome.error === "not_found" ? "Invoice not found"
        : outcome.error === "already_voided" ? "Invoice is already voided"
          : "Invoice can only be voided when it has no remaining active payments and a zero paid balance",
    });
    return;
  }
  const result = await invoiceDto(outcome.invoiceId);
  if (!result) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  const validated = GetInvoiceResponse.parse(result);
  res.json({ ...validated, correctionHistory: result.correctionHistory });
});

router.post("/finance/payments/:paymentId/void", financeAccess, async (req, res): Promise<void> => {
  const paymentId = Number(req.params.paymentId);
  const body = correctionBody(req.body);
  if (!Number.isSafeInteger(paymentId) || paymentId < 1 || !body) {
    res.status(400).json({ error: "Payment id and a reason of 8 to 1000 characters are required" });
    return;
  }
  const actor = currentStaff(res);
  const outcome = await db.transaction(async (tx) => {
    const [lookup] = await tx.select({ invoiceId: paymentsTable.invoiceId }).from(paymentsTable)
      .where(eq(paymentsTable.id, paymentId));
    if (!lookup?.invoiceId) return { error: "not_found" as const };
    await tx.execute(sql`SELECT id FROM invoices WHERE id = ${lookup.invoiceId} FOR UPDATE`);
    await tx.execute(sql`SELECT id FROM payments WHERE id = ${paymentId} FOR UPDATE`);
    const [payment] = await tx.select().from(paymentsTable).where(and(
      eq(paymentsTable.id, paymentId),
      eq(paymentsTable.invoiceId, lookup.invoiceId),
    ));
    const [invoice] = await tx.select().from(invoicesTable).where(eq(invoicesTable.id, lookup.invoiceId));
    if (!payment || !invoice) return { error: "not_found" as const };
    const [alreadyVoided] = await tx.select({ id: financeCorrectionsTable.id }).from(financeCorrectionsTable).where(and(
      eq(financeCorrectionsTable.entityType, "payment"),
      eq(financeCorrectionsTable.entityId, payment.id),
    )).limit(1);
    if (alreadyVoided) return { error: "already_voided" as const };
    let installment: typeof installmentsTable.$inferSelect | undefined;
    if (payment.installmentId !== null) {
      [installment] = await tx.select().from(installmentsTable).where(and(
        eq(installmentsTable.id, payment.installmentId),
        eq(installmentsTable.invoiceId, invoice.id),
      ));
      if (!installment || installment.paidCents < payment.amountCents) {
        return { error: "balance_mismatch" as const };
      }
    }
    if (invoice.paidCents < payment.amountCents) return { error: "balance_mismatch" as const };
    const paidCents = invoice.paidCents - payment.amountCents;
    const status = paidCents === 0 ? "unpaid" : paidCents === invoice.totalCents ? "paid" : "partial";
    const installmentPaidCents = installment ? installment.paidCents - payment.amountCents : null;
    if (installment) {
      await tx.update(installmentsTable).set({ paidCents: installmentPaidCents! })
        .where(eq(installmentsTable.id, installment.id));
    }
    await tx.update(invoicesTable).set({ paidCents, status }).where(eq(invoicesTable.id, invoice.id));
    const before = {
      payment: {
        id: payment.id,
        invoiceId: payment.invoiceId,
        installmentId: payment.installmentId,
        amountCents: payment.amountCents,
        method: payment.method,
        reference: payment.reference,
        notes: payment.notes,
        paidAt: payment.paidAt,
      },
      invoice: { paidCents: invoice.paidCents, status: invoice.status },
      installment: installment ? { id: installment.id, paidCents: installment.paidCents } : null,
    };
    const after = {
      invoice: { paidCents, status },
      installment: installment ? { id: installment.id, paidCents: installmentPaidCents } : null,
      payment: { id: payment.id, state: "voided" },
    };
    await tx.insert(financeCorrectionsTable).values({
      entityType: "payment",
      entityId: payment.id,
      invoiceId: invoice.id,
      reason: body.reason,
      beforeSnapshot: before,
      afterSnapshot: after,
      actorStaffId: actor.id,
      actorName: actor.name,
    });
    await tx.insert(auditLogTable).values(auditValues(
      actor, "void", "payment", payment.id, correctionSummary(body.reason, before, after),
    ));
    return { invoiceId: invoice.id };
  });
  if ("error" in outcome) {
    res.status(outcome.error === "not_found" ? 404 : 409).json({
      error: outcome.error === "not_found" ? "Payment not found"
        : outcome.error === "already_voided" ? "Payment is already voided"
          : "Payment and invoice balances are inconsistent; no correction was applied",
    });
    return;
  }
  const result = await invoiceDto(outcome.invoiceId);
  if (!result) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  const validated = GetInvoiceResponse.parse(result);
  res.json({ ...validated, correctionHistory: result.correctionHistory });
});

router.get("/finance/expenses", financeAccess, async (_req, res): Promise<void> => {
  const rows = await db.select().from(expensesTable).orderBy(desc(expensesTable.occurredAt));
  res.json(ListExpensesResponse.parse(rows.map(expenseDto)));
});

router.post("/finance/expenses", financeAccess, async (req, res): Promise<void> => {
  const parsed = CreateExpenseBody.safeParse(normalizeOptionalStrings(req.body));
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!parsed.data.category.trim()) {
    res.status(400).json({ error: "Category cannot be empty" });
    return;
  }
  const actor = currentStaff(res);
  const created = await db.transaction(async (tx) => {
    let supplierName: string | null = null;
    if (parsed.data.supplierId != null) {
      const [supplier] = await tx.select().from(suppliersTable)
        .where(eq(suppliersTable.id, parsed.data.supplierId));
      if (!supplier) return null;
      supplierName = supplier.name;
    }
    const [expense] = await tx.insert(expensesTable).values({
      category: parsed.data.category.trim(),
      amountCents: parsed.data.amountCents,
      supplierId: parsed.data.supplierId ?? null,
      supplier: supplierName,
      notes: parsed.data.notes ?? null,
      occurredAt: parsed.data.occurredAt,
    }).returning();
    await tx.insert(auditLogTable).values(auditValues(actor, "create", "expense", expense.id, `Expense ${expense.id} recorded`));
    return expense;
  });
  if (!created) {
    res.status(404).json({ error: "Supplier not found" });
    return;
  }
  res.status(201).json(CreateExpenseResponse.parse(expenseDto(created)));
});

router.patch("/finance/expenses/:expenseId", financeAccess, async (req, res): Promise<void> => {
  const params = UpdateExpenseParams.safeParse(req.params);
  const parsed = UpdateExpenseBody.safeParse(normalizeOptionalStrings(req.body));
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Invalid expense update" });
    return;
  }
  if (!Object.keys(parsed.data).length) {
    res.status(400).json({ error: "No changes provided" });
    return;
  }
  if (parsed.data.category !== undefined && !parsed.data.category.trim()) {
    res.status(400).json({ error: "Category cannot be empty" });
    return;
  }
  const actor = currentStaff(res);
  const outcome = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(expensesTable).where(eq(expensesTable.id, params.data.expenseId));
    if (!existing) return { error: "not_found" as const };
    let snapshot = existing.supplier;
    if (parsed.data.supplierId !== undefined) {
      snapshot = null;
      if (parsed.data.supplierId !== null) {
        const [supplier] = await tx.select().from(suppliersTable)
          .where(eq(suppliersTable.id, parsed.data.supplierId));
        if (!supplier) return { error: "supplier_not_found" as const };
        snapshot = supplier.name;
      }
    }
    const [expense] = await tx.update(expensesTable).set({
      ...(parsed.data.category !== undefined ? { category: parsed.data.category.trim() } : {}),
      ...(parsed.data.amountCents !== undefined ? { amountCents: parsed.data.amountCents } : {}),
      ...(parsed.data.supplierId !== undefined ? { supplierId: parsed.data.supplierId, supplier: snapshot } : {}),
      ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
      ...(parsed.data.occurredAt !== undefined ? { occurredAt: parsed.data.occurredAt } : {}),
    }).where(eq(expensesTable.id, existing.id)).returning();
    await tx.insert(auditLogTable).values(auditValues(actor, "update", "expense", expense.id, `Expense ${expense.id} corrected`));
    return { expense };
  });
  if ("error" in outcome) {
    res.status(outcome.error === "not_found" ? 404 : 404)
      .json({ error: outcome.error === "not_found" ? "Expense not found" : "Supplier not found" });
    return;
  }
  res.json(UpdateExpenseResponse.parse(expenseDto(outcome.expense)));
});

router.get("/finance/suppliers", financeAccess, async (_req, res): Promise<void> => {
  const rows = await db.select().from(suppliersTable).orderBy(asc(suppliersTable.name));
  res.json(ListSuppliersResponse.parse(rows.map(supplierDto)));
});

router.post("/finance/suppliers", financeAccess, async (req, res): Promise<void> => {
  const parsed = CreateSupplierBody.safeParse(normalizeOptionalStrings(req.body));
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!parsed.data.name.trim()) {
    res.status(400).json({ error: "Supplier name cannot be empty" });
    return;
  }
  const actor = currentStaff(res);
  const supplier = await db.transaction(async (tx) => {
    const [created] = await tx.insert(suppliersTable).values({
      name: parsed.data.name.trim(),
      phone: parsed.data.phone ?? null,
      email: parsed.data.email ?? null,
      notes: parsed.data.notes ?? null,
    }).returning();
    await tx.insert(auditLogTable).values(auditValues(actor, "create", "supplier", created.id, `Supplier ${created.id} created`));
    return created;
  });
  res.status(201).json(CreateSupplierResponse.parse(supplierDto(supplier)));
});

router.patch("/finance/suppliers/:supplierId", financeAccess, async (req, res): Promise<void> => {
  const params = UpdateSupplierParams.safeParse(req.params);
  const parsed = UpdateSupplierBody.safeParse(normalizeOptionalStrings(req.body));
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Invalid supplier update" });
    return;
  }
  if (parsed.data.name !== undefined && !parsed.data.name.trim()) {
    res.status(400).json({ error: "Supplier name cannot be empty" });
    return;
  }
  if (!Object.keys(parsed.data).length) {
    res.status(400).json({ error: "No changes provided" });
    return;
  }
  const actor = currentStaff(res);
  const updated = await db.transaction(async (tx) => {
    const [supplier] = await tx.update(suppliersTable).set({
      ...(parsed.data.name !== undefined ? { name: parsed.data.name.trim() } : {}),
      ...(parsed.data.phone !== undefined ? { phone: parsed.data.phone } : {}),
      ...(parsed.data.email !== undefined ? { email: parsed.data.email } : {}),
      ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
      ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
    }).where(eq(suppliersTable.id, params.data.supplierId)).returning();
    if (!supplier) return null;
    await tx.insert(auditLogTable).values(auditValues(actor, "update", "supplier", supplier.id, `Supplier ${supplier.id} updated`));
    return supplier;
  });
  if (!updated) {
    res.status(404).json({ error: "Supplier not found" });
    return;
  }
  res.json(UpdateSupplierResponse.parse(supplierDto(updated)));
});

router.get("/finance/report", financeAccess, async (req, res): Promise<void> => {
  const raw = req.query as Record<string, unknown>;
  const rawFrom = typeof raw.from === "string" ? raw.from : "";
  const rawTo = typeof raw.to === "string" ? raw.to : "";
  const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
  if (!validDate(rawFrom) || !validDate(rawTo)) {
    res.status(400).json({ error: "from and to must be valid YYYY-MM-DD dates" });
    return;
  }
  const parsed = GetFinanceReportQueryParams.safeParse({
    from: dateKeyToDate(rawFrom), to: dateKeyToDate(rawTo),
  });
  if (!parsed.success || rawFrom > rawTo) {
    res.status(400).json({ error: "Invalid report date range" });
    return;
  }
  const dayCount = (dateKeyToDate(rawTo).getTime() - dateKeyToDate(rawFrom).getTime()) / 86_400_000 + 1;
  if (dayCount > 366) {
    res.status(400).json({ error: "Report range cannot exceed 366 days" });
    return;
  }
  const start = cairoMidnight(rawFrom);
  const end = cairoMidnight(addDays(rawTo, 1));
  const [payments, expenses, allInvoices, inRangeInvoices, paymentVoids, invoiceVoids] = await Promise.all([
    db.select().from(paymentsTable).where(and(gte(paymentsTable.paidAt, start), lt(paymentsTable.paidAt, end))),
    db.select().from(expensesTable).where(and(gte(expensesTable.occurredAt, start), lt(expensesTable.occurredAt, end))),
    db.select().from(invoicesTable),
    db.select({ id: invoicesTable.id }).from(invoicesTable)
      .where(and(gte(invoicesTable.issuedAt, start), lt(invoicesTable.issuedAt, end),
        notExists(db.select({ id: financeCorrectionsTable.id }).from(financeCorrectionsTable).where(and(
          eq(financeCorrectionsTable.entityType, "invoice"),
          eq(financeCorrectionsTable.entityId, invoicesTable.id),
        ))))),
    db.select({ entityId: financeCorrectionsTable.entityId })
      .from(financeCorrectionsTable).where(eq(financeCorrectionsTable.entityType, "payment")),
    db.select({ entityId: financeCorrectionsTable.entityId })
      .from(financeCorrectionsTable).where(eq(financeCorrectionsTable.entityType, "invoice")),
  ]);
  const voidedPaymentIds = new Set(paymentVoids.map((event) => event.entityId));
  const voidedInvoiceIds = new Set(invoiceVoids.map((event) => event.entityId));
  const days = new Map<string, { revenueCents: number; expenseCents: number }>();
  for (let offset = 0; offset < dayCount; offset += 1) {
    days.set(addDays(rawFrom, offset), { revenueCents: 0, expenseCents: 0 });
  }
  const methods = new Map<string, number>();
  let revenueCents = 0;
  for (const payment of payments) {
    if (voidedPaymentIds.has(payment.id)) continue;
    revenueCents += payment.amountCents;
    const key = dateKey(payment.paidAt);
    const day = days.get(key);
    if (day) day.revenueCents += payment.amountCents;
    methods.set(payment.method, (methods.get(payment.method) ?? 0) + payment.amountCents);
  }
  let expenseCents = 0;
  const categories = new Map<string, number>();
  for (const expense of expenses) {
    expenseCents += expense.amountCents;
    const key = dateKey(expense.occurredAt);
    const day = days.get(key);
    if (day) day.expenseCents += expense.amountCents;
    categories.set(expense.category, (categories.get(expense.category) ?? 0) + expense.amountCents);
  }
  const today = dateKey(new Date());
  const activeInvoices = allInvoices.filter((invoice) => !voidedInvoiceIds.has(invoice.id));
  const outstandingCents = activeInvoices.reduce((sum, invoice) => sum + invoice.totalCents - invoice.paidCents, 0);
  const overdueCents = activeInvoices.reduce((sum, invoice) =>
    sum + (invoice.dueDate !== null && invoice.dueDate < today
      ? invoice.totalCents - invoice.paidCents : 0), 0);
  const result = {
    from: rawFrom,
    to: rawTo,
    revenueCents,
    expenseCents,
    netCents: revenueCents - expenseCents,
    outstandingCents,
    overdueCents,
    invoiceCount: inRangeInvoices.length,
    unpaidInvoiceCount: activeInvoices.filter((invoice) => invoice.paidCents < invoice.totalCents).length,
    days: [...days.entries()].map(([date, totals]) => ({ date, ...totals })),
    categories: [...categories.entries()].map(([category, amountCents]) => ({ category, amountCents })),
    methods: [...methods.entries()].map(([method, amountCents]) => ({ method, amountCents })),
  };
  GetFinanceReportResponse.parse(result);
  res.json(result);
});

export default router;