import { Router, type IRouter } from "express";
import { and, eq, asc, notExists, sql } from "drizzle-orm";
import {
  appointmentsTable, db, expensesTable, financeCorrectionsTable, invoicesTable, patientsTable, paymentsTable, remindersTable,
} from "@workspace/db";
import { GetDashboardResponse } from "@workspace/api-zod";
import { currentStaff } from "../middlewares/clinicStaff";
import { countsAsAttending, isNoShow } from "../lib/clinicPolicy";

const router: IRouter = Router();
const cairoToday = sql`(now() AT TIME ZONE 'Africa/Cairo')::date`;

router.get("/dashboard", async (_req, res): Promise<void> => {
  const appointments = await db.select({
    id: appointmentsTable.id,
    patientId: appointmentsTable.patientId,
    patientName: patientsTable.fullName,
    doctorName: appointmentsTable.doctorName,
    startsAt: appointmentsTable.startsAt,
    endsAt: appointmentsTable.endsAt,
    status: appointmentsTable.status,
    treatment: appointmentsTable.treatment,
    isReturning: sql<boolean>`(${patientsTable.registrationDate} AT TIME ZONE 'Africa/Cairo')::date < ${cairoToday}`,
  }).from(appointmentsTable)
    .innerJoin(patientsTable, eq(appointmentsTable.patientId, patientsTable.id))
    .where(sql`(${appointmentsTable.startsAt} AT TIME ZONE 'Africa/Cairo')::date = ${cairoToday}`)
    .orderBy(asc(appointmentsTable.startsAt));

  const [patientTotals] = await db.select({
    newPatients: sql<number>`count(*)::int`,
  }).from(patientsTable)
    .where(sql`(${patientsTable.registrationDate} AT TIME ZONE 'Africa/Cairo')::date = ${cairoToday}`);
  const visible = appointments.filter((item) => countsAsAttending(item.status));
  const patientIds = new Set(visible.map((item) => item.patientId));
  const returningIds = new Set(visible
    .filter((item) => item.isReturning)
    .map((item) => item.patientId));
  const [followUps] = await db.select({
    count: sql<number>`count(*)::int`,
  }).from(remindersTable).where(eq(remindersTable.status, "draft"));

  const showFinance = ["owner", "manager", "accountant"].includes(currentStaff(res).role);
  let todayRevenue: number | null = null;
  let todayExpenses: number | null = null;
  let netRevenue: number | null = null;
  let outstandingPayments: number | null = null;
  if (showFinance) {
    const [[revenue], [expenses], [outstanding]] = await Promise.all([
      db.select({ cents: sql<number>`coalesce(sum(${paymentsTable.amountCents}), 0)` })
        .from(paymentsTable)
        .where(and(
          sql`(${paymentsTable.paidAt} AT TIME ZONE 'Africa/Cairo')::date = ${cairoToday}`,
          notExists(db.select({ id: financeCorrectionsTable.id }).from(financeCorrectionsTable).where(and(
            eq(financeCorrectionsTable.entityType, "payment"),
            eq(financeCorrectionsTable.entityId, paymentsTable.id),
          ))),
        )),
      db.select({ cents: sql<number>`coalesce(sum(${expensesTable.amountCents}), 0)` })
        .from(expensesTable)
        .where(sql`(${expensesTable.occurredAt} AT TIME ZONE 'Africa/Cairo')::date = ${cairoToday}`),
      db.select({ cents: sql<number>`coalesce(sum(greatest(${invoicesTable.totalCents} - ${invoicesTable.paidCents}, 0)), 0)` })
        .from(invoicesTable)
        .where(notExists(db.select({ id: financeCorrectionsTable.id }).from(financeCorrectionsTable).where(and(
          eq(financeCorrectionsTable.entityType, "invoice"),
          eq(financeCorrectionsTable.entityId, invoicesTable.id),
        )))),
    ]);
    todayRevenue = Number(revenue.cents) / 100;
    todayExpenses = Number(expenses.cents) / 100;
    netRevenue = todayRevenue - todayExpenses;
    outstandingPayments = Number(outstanding.cents) / 100;
  }
  const result = {
    todayAppointments: appointments.length,
    todayPatients: patientIds.size,
    todayRevenue,
    todayExpenses,
    netRevenue,
    outstandingPayments,
    newPatients: patientTotals.newPatients,
    returningPatients: returningIds.size,
    cancelledAppointments: appointments.filter((item) => item.status === "cancelled").length,
    noShows: appointments.filter((item) => isNoShow(item.status)).length,
    pendingFollowUps: followUps.count,
    appointments: appointments.map(({ id, patientName, doctorName, startsAt, endsAt, status, treatment }) => ({
      id, patientName, doctorName, startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(), status, treatment,
    })),
  };
  GetDashboardResponse.parse(result);
  res.json(result);
});

export default router;