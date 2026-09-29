import { Router, type IRouter } from "express";
import { and, eq, sql, type SQLWrapper } from "drizzle-orm";
import {
  appointmentsTable, db, orthodonticCasesTable, patientDocumentsTable, patientsTable,
  reminderPreferencesTable, remindersTable, visitProceduresTable, visitsTable,
} from "@workspace/db";
import {
  GetClinicOperationalReportQueryParams, GetClinicOperationalReportResponse,
} from "@workspace/api-zod";
import { allowRoles } from "../middlewares/clinicStaff";

const router: IRouter = Router();
const reportReaders = allowRoles("owner", "manager");
const MAX_RANGE_DAYS = 366;

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

router.get("/clinic/reports", reportReaders, async (req, res): Promise<void> => {
  const query = req.query as Record<string, unknown>;
  if (!isCalendarDate(query.from) || !isCalendarDate(query.to)) {
    res.status(400).json({ error: "from and to must be valid YYYY-MM-DD dates" });
    return;
  }
  const fromDate = new Date(`${query.from}T00:00:00.000Z`);
  const toDate = new Date(`${query.to}T00:00:00.000Z`);
  const parsed = GetClinicOperationalReportQueryParams.safeParse({ from: fromDate, to: toDate });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const dayCount = (toDate.getTime() - fromDate.getTime()) / 86_400_000;
  if (dayCount < 0 || dayCount >= MAX_RANGE_DAYS) {
    res.status(400).json({ error: "Report range must be inclusive, ordered, and no longer than 366 days" });
    return;
  }
  const dateBounds = (column: SQLWrapper) => sql`(${column} AT TIME ZONE 'Africa/Cairo')::date BETWEEN ${query.from}::date AND ${query.to}::date`;
  const count = sql<number>`count(*)::int`;

  const [
    appointmentRows,
    [newPatients],
    [visits],
    [procedures],
    [documents],
    [orthodonticCases],
    [optedInPatients],
    [manuallySentReminders],
  ] = await Promise.all([
    db.select({
      status: appointmentsTable.status,
      count,
    }).from(appointmentsTable).where(dateBounds(appointmentsTable.startsAt))
      .groupBy(appointmentsTable.status),
    db.select({ count }).from(patientsTable).where(dateBounds(patientsTable.registrationDate)),
    db.select({ count }).from(visitsTable).where(dateBounds(visitsTable.occurredAt)),
    db.select({ count }).from(visitProceduresTable).where(dateBounds(visitProceduresTable.recordedAt)),
    db.select({ count }).from(patientDocumentsTable).where(dateBounds(patientDocumentsTable.createdAt)),
    db.select({ count }).from(orthodonticCasesTable).where(dateBounds(orthodonticCasesTable.createdAt)),
    db.select({ count }).from(reminderPreferencesTable).where(eq(reminderPreferencesTable.optIn, true)),
    db.select({ count }).from(remindersTable).where(and(
      eq(remindersTable.status, "staff_confirmed_sent"),
      dateBounds(remindersTable.sentAt),
    )),
  ]);
  const report = {
    from: parsed.data.from,
    to: parsed.data.to,
    appointmentsByStatus: appointmentRows.map((row) => ({ status: row.status, count: Number(row.count) })),
    newPatients: Number(newPatients.count),
    visits: Number(visits.count),
    procedures: Number(procedures.count),
    documents: Number(documents.count),
    orthodonticCases: Number(orthodonticCases.count),
    optedInPatients: Number(optedInPatients.count),
    manuallySentReminders: Number(manuallySentReminders.count),
  };
  const validated = GetClinicOperationalReportResponse.parse(report);
  res.json({ ...validated, from: query.from, to: query.to });
});

export default router;