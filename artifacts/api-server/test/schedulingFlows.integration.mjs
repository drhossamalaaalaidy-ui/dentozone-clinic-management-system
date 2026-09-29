import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { build } from "esbuild";
import express from "express";
import { eq, inArray } from "drizzle-orm";

// Runs real Express handlers against a development PostgreSQL database only.
if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT) {
  throw new Error("Scheduling integration tests must never run against production");
}
if (!process.env.DATABASE_URL) throw new Error("A development DATABASE_URL is required");

const output = fileURLToPath(new URL("../node_modules/.cache/scheduling-flows-test.mjs", import.meta.url));
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
  db, pool, staffTable, patientsTable, appointmentsTable, remindersTable,
  reminderPreferencesTable, reminderTemplatesTable, auditLogTable,
  invoicesTable, paymentsTable, expensesTable,
  appointmentsRouter, dashboardRouter, remindersRouter, reportsRouter,
} = api;

function cairoParts(date) {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return values;
}

function cairoDay(date) {
  const { year, month, day } = cairoParts(date);
  return `${year}-${month}-${day}`;
}

function shiftDay(day, amount) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function cairoInstant(day, hour, minute = 0) {
  const [year, month, date] = day.split("-").map(Number);
  const desired = Date.UTC(year, month - 1, date, hour, minute);
  let instant = new Date(desired);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = cairoParts(instant);
    const observed = Date.UTC(
      Number(actual.year), Number(actual.month) - 1, Number(actual.day),
      Number(actual.hour), Number(actual.minute), Number(actual.second),
    );
    instant = new Date(instant.getTime() + desired - observed);
  }
  return instant;
}

test("appointment scheduling, Cairo dashboard, reports, and reminder consent flows", async (t) => {
  const marker = randomUUID();
  let server;
  let staff = [];
  let patients = [];
  let appointments = [];
  let templates = [];
  let preferences = [];
  let reminders = [];
  let invoices = [];
  let payments = [];
  let expenses = [];

  try {
    staff = await db.insert(staffTable).values(
      ["owner", "manager", "dentist", "dentist", "reception", "accountant", "assistant"].map((role, index) => ({
        email: `scheduling-${role}-${index}-${marker}@example.invalid`,
        name: `Fictional Scheduling ${role} ${index}`,
        role,
        status: "active",
      })),
    ).returning();
    const roleStaff = {};
    for (const row of staff) roleStaff[row.role] ??= row;
    const alternateDentist = staff.find((row) => row.role === "dentist" && row.id !== roleStaff.dentist.id);
    const now = new Date();
    const today = cairoDay(now);
    const yesterday = shiftDay(today, -1);
    const oldRegistration = cairoInstant(yesterday, 12);
    const todaysRegistration = cairoInstant(today, 12);
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      const role = req.get("authorization")?.match(/^TestStaff (owner|manager|dentist|reception|accountant|assistant)$/)?.[1];
      if (!role) return res.status(401).json({ error: "Test staff authentication required" });
      res.locals.staff = roleStaff[role];
      next();
    });
    app.use(appointmentsRouter, dashboardRouter, remindersRouter, reportsRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(role, method, path, body) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(role ? { Authorization: `TestStaff ${role}` } : {}),
          "Accept-Language": "en",
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

    const baselineDashboard = await request("owner", "GET", "/dashboard");
    const baselineRevenue = baselineDashboard.data.todayRevenue;
    const baselineExpenses = baselineDashboard.data.todayExpenses;
    const baselineOutstanding = baselineDashboard.data.outstandingPayments;
    const baselinePending = baselineDashboard.data.pendingFollowUps;
    const reportPath = `/clinic/reports?from=${today}&to=${today}`;
    const baselineReport = await request("owner", "GET", reportPath);
    assert.equal(baselineReport.status, 200);
    const baselinePreviousReport = await request("owner", "GET",
      `/clinic/reports?from=${shiftDay(today, -1)}&to=${shiftDay(today, -1)}`);
    assert.equal(baselinePreviousReport.status, 200);
    patients = await db.insert(patientsTable).values([
      {
        fullName: `Fictional Returning Patient ${marker}`, phone: "+201000000001",
        gender: "undisclosed", registrationDate: oldRegistration, isDemo: true,
      },
      {
        fullName: `Fictional New Patient ${marker}`, phone: "+201000000002",
        gender: "undisclosed", registrationDate: todaysRegistration, isDemo: true,
      },
    ]).returning();
    const [returningPatient, newPatient] = patients;

    await t.test("half-open conflict boundaries, concurrent writes, and update checks", async () => {
      const start = new Date(Date.now() + 30 * 86_400_000);
      start.setUTCSeconds(0, 0);
      const end = new Date(start.getTime() + 30 * 60_000);
       const create = (startsAt, endsAt, chair = `Chair A ${marker}`, doctorStaffId = roleStaff.dentist.id) => request("reception", "POST", "/appointments", {
        patientId: returningPatient.id,
        doctorStaffId,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        treatment: "Fictional checkup",
        chair,
      });

      const first = await create(start, end);
      assert.equal(first.status, 201, JSON.stringify(first.data));
      appointments.push(first.data.id);
      const touching = await create(end, new Date(end.getTime() + 30 * 60_000));
      assert.equal(touching.status, 201, JSON.stringify(touching.data));
      appointments.push(touching.data.id);
      assert.equal((await create(new Date(start.getTime() + 29 * 60_000), new Date(start.getTime() + 59 * 60_000))).status, 409);
      assert.equal((await create(new Date(start.getTime() + 29 * 60_000),
         new Date(start.getTime() + 59 * 60_000), `Chair A ${marker}`, alternateDentist.id)).status, 409,
      "a different dentist cannot double-book the same chair");
       assert.equal((await create(new Date(start.getTime() + 59 * 60_000), new Date(start.getTime() + 89 * 60_000), `Chair B ${marker}`)).status, 409,
        "a second booking on the same doctor is rejected even on another chair");

      const concurrentStart = new Date(start.getTime() + 4 * 60 * 60_000);
      const concurrentEnd = new Date(concurrentStart.getTime() + 30 * 60_000);
      const concurrent = await Promise.all([
         create(concurrentStart, concurrentEnd, `Chair B ${marker}`),
         create(concurrentStart, concurrentEnd, `Chair B ${marker}`),
      ]);
      assert.deepEqual(concurrent.map((response) => response.status).sort(), [201, 409]);
      appointments.push(...concurrent.filter((response) => response.status === 201).map((response) => response.data.id));

      const updateConflict = await request("dentist", "PATCH", `/appointments/${first.data.id}`, {
        startsAt: end.toISOString(),
         endsAt: new Date(end.getTime() + 30 * 60_000).toISOString(),
      });
      assert.equal(updateConflict.status, 409);
      const updated = await request("dentist", "PATCH", `/appointments/${first.data.id}`, {
        notes: "Fictional updated note",
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.data.notes, "Fictional updated note");

      const listed = await request("reception", "GET",
        `/appointments?from=${end.toISOString()}&to=${new Date(end.getTime() + 30 * 60_000).toISOString()}`);
      assert.equal(listed.status, 200);
      assert.equal(listed.data.some((row) => row.id === first.data.id), false,
        "an appointment ending exactly at range start is excluded");
      assert.equal(listed.data.some((row) => row.id === touching.data.id), true);
    });

    await t.test("Cairo calendar boundaries drive dashboard and inclusive reports", async () => {
      const yesterdayLate = cairoInstant(yesterday, 23, 30);
      const todayEarly = cairoInstant(today, 0, 30);
      const endYesterday = new Date(yesterdayLate.getTime() + 30 * 60_000);
      const endToday = new Date(todayEarly.getTime() + 30 * 60_000);
      const rows = await db.insert(appointmentsTable).values([
        {
          patientId: returningPatient.id, doctorStaffId: roleStaff.dentist.id,
          doctorName: roleStaff.dentist.name, treatment: "Fictional yesterday visit",
          startsAt: yesterdayLate, endsAt: endYesterday, status: "scheduled", isDemo: true,
        },
        {
          patientId: returningPatient.id, doctorStaffId: roleStaff.dentist.id,
          doctorName: roleStaff.dentist.name, treatment: "Fictional Cairo-boundary visit",
          startsAt: todayEarly, endsAt: endToday, status: "scheduled", isDemo: true,
        },
        {
          patientId: newPatient.id, doctorStaffId: roleStaff.dentist.id,
          doctorName: roleStaff.dentist.name, treatment: "Fictional new-patient visit",
          startsAt: new Date(todayEarly.getTime() + 60 * 60_000),
          endsAt: new Date(todayEarly.getTime() + 90 * 60_000),
          status: "scheduled", isDemo: true,
        },
      ]).returning();
      appointments.push(...rows.map((row) => row.id));

      const todayReport = await request("owner", "GET", reportPath);
      assert.equal(todayReport.status, 200);
      const todayScheduled = todayReport.data.appointmentsByStatus.find((row) => row.status === "scheduled")?.count ?? 0;
      const baseScheduled = baselineReport.data.appointmentsByStatus.find((row) => row.status === "scheduled")?.count ?? 0;
      assert.equal(todayScheduled - baseScheduled, 2,
        "Cairo today includes its UTC-previous-day early appointment but not the preceding Cairo day");
      const previousReport = await request("manager", "GET", `/clinic/reports?from=${yesterday}&to=${yesterday}`);
      assert.equal(previousReport.status, 200);
      const previousScheduled = previousReport.data.appointmentsByStatus.find((row) => row.status === "scheduled")?.count ?? 0;
      const baselinePreviousScheduled =
        baselinePreviousReport.data.appointmentsByStatus.find((row) => row.status === "scheduled")?.count ?? 0;
      assert.equal(previousScheduled - baselinePreviousScheduled, 1);

      const dashboard = await request("owner", "GET", "/dashboard");
      assert.equal(dashboard.status, 200);
      assert.equal(dashboard.data.todayAppointments - baselineDashboard.data.todayAppointments, 2);
      assert.equal(dashboard.data.todayPatients - baselineDashboard.data.todayPatients, 2);
      assert.equal(dashboard.data.returningPatients - baselineDashboard.data.returningPatients, 1,
        "returning status uses the Cairo registration calendar date");
      assert.equal(dashboard.data.newPatients - baselineDashboard.data.newPatients, 1);

      assert.equal((await request("owner", "GET",
        `/clinic/reports?from=${shiftDay(today, -365)}&to=${today}`)).status, 200,
      "366 inclusive calendar dates are allowed");
      assert.equal((await request("owner", "GET",
        `/clinic/reports?from=${shiftDay(today, -366)}&to=${today}`)).status, 400,
      "ranges longer than 366 inclusive dates are rejected");
    });

    await t.test("dashboard finance is role-redacted and pending follow-ups reflect drafts", async () => {
       const start = cairoInstant(shiftDay(today, 30), 14);
      const end = new Date(start.getTime() + 30 * 60_000);
      const appointment = await request("reception", "POST", "/appointments", {
        patientId: returningPatient.id, doctorStaffId: roleStaff.dentist.id,
        startsAt: start.toISOString(), endsAt: end.toISOString(),
         treatment: "Fictional consent follow-up", chair: `Chair Reminder ${marker}`,
      });
      assert.equal(appointment.status, 201, JSON.stringify(appointment.data));
      appointments.push(appointment.data.id);
      templates = await db.insert(reminderTemplatesTable).values([
        {
          title: `Fictional WhatsApp ${marker}`,
          bodyEn: "Fictional reminder for {patient_name} on {date} at {time} with {doctor}",
          bodyAr: "تذكير {patient_name} {date} {time} {doctor}",
          channel: "whatsapp", createdByStaffId: roleStaff.owner.id, isDemo: true,
        },
        {
          title: `Fictional SMS ${marker}`,
          bodyEn: "Fictional SMS {date} {time}", bodyAr: "رسالة {date} {time}",
          channel: "sms", createdByStaffId: roleStaff.owner.id, isDemo: true,
        },
      ]).returning();

      const preferencesPath = `/patients/${returningPatient.id}/reminder-preferences`;
      const reminderPath = `/appointments/${appointment.data.id}/reminders`;
      assert.equal((await request("reception", "POST", reminderPath, { templateId: templates[0].id })).status, 409,
        "drafts require explicit consent");
      const optedIn = await request("reception", "PUT", preferencesPath, {
        optIn: true, channel: "whatsapp", consentRecordedAt: new Date(Date.now() - 60_000).toISOString(),
      });
      assert.equal(optedIn.status, 200);
      preferences.push(returningPatient.id);
       assert.equal((await request("reception", "PUT", preferencesPath, {
        optIn: true, channel: "email", consentRecordedAt: new Date(Date.now() + 60_000).toISOString(),
      })).status, 400, "future consent timestamps are rejected");
      const draft = await request("reception", "POST", reminderPath, { templateId: templates[0].id });
      assert.equal(draft.status, 201, JSON.stringify(draft.data));
      reminders.push(draft.data.id);
      const expectedDate = new Intl.DateTimeFormat("en", {
        timeZone: "Africa/Cairo", year: "numeric", month: "long", day: "numeric",
      }).format(new Date(appointment.data.startsAt));
      const expectedTime = new Intl.DateTimeFormat("en", {
        timeZone: "Africa/Cairo", hour: "numeric", minute: "2-digit",
      }).format(new Date(appointment.data.startsAt));
      assert.match(draft.data.renderedMessage, new RegExp(expectedDate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(draft.data.renderedMessage, new RegExp(expectedTime.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal((await request("owner", "GET", "/dashboard")).data.pendingFollowUps, baselinePending + 1);

      const manuallySent = await request("reception", "POST", `/reminders/${draft.data.id}/mark-sent`, {});
      assert.equal(manuallySent.status, 200);
      assert.equal(manuallySent.data.status, "staff_confirmed_sent");
      assert.ok(manuallySent.data.sentAt);
      const nextDraft = await request("reception", "POST", reminderPath, { templateId: templates[0].id });
      assert.equal(nextDraft.status, 201);
      reminders.push(nextDraft.data.id);
      const optedOut = await request("reception", "PUT", preferencesPath, { optIn: false, channel: "whatsapp" });
      assert.equal(optedOut.status, 200);
      const [cancelledDraft] = await db.select().from(remindersTable)
        .where(eq(remindersTable.id, nextDraft.data.id));
      assert.equal(cancelledDraft.status, "cancelled");
      assert.equal((await request("reception", "POST", reminderPath, { templateId: templates[0].id })).status, 409);
      assert.equal((await request("owner", "GET", "/dashboard")).data.pendingFollowUps, baselinePending,
        "cancelled and staff-confirmed reminders are not pending drafts");

      const baselineTodayRevenue = Number(baselineRevenue ?? 0);
      const baselineTodayExpenses = Number(baselineExpenses ?? 0);
      const baselineOutstandingPayments = Number(baselineOutstanding ?? 0);
      invoices = await db.insert(invoicesTable).values({
        patientId: returningPatient.id, totalCents: 50_000, paidCents: 10_000,
        status: "partial", notes: `Fictional invoice ${marker}`, isDemo: true,
      }).returning();
      payments = await db.insert(paymentsTable).values({
        patientId: returningPatient.id, invoiceId: invoices[0].id,
        amountCents: 10_000, method: "cash", notes: `Fictional payment ${marker}`,
        paidAt: new Date(), isDemo: true,
      }).returning();
      expenses = await db.insert(expensesTable).values({
        category: "demo", supplier: `Fictional supplier ${marker}`,
        amountCents: 2_500, notes: `Fictional expense ${marker}`,
        occurredAt: new Date(), isDemo: true,
      }).returning();
      const accountantDashboard = await request("accountant", "GET", "/dashboard");
      assert.equal(accountantDashboard.status, 200);
      assert.equal(accountantDashboard.data.todayRevenue, baselineTodayRevenue + 100);
      assert.equal(accountantDashboard.data.todayExpenses, baselineTodayExpenses + 25);
      assert.equal(accountantDashboard.data.netRevenue, baselineTodayRevenue + 75 - baselineTodayExpenses);
      assert.equal(accountantDashboard.data.outstandingPayments, baselineOutstandingPayments + 400);
      const receptionDashboard = await request("reception", "GET", "/dashboard");
      assert.equal(receptionDashboard.status, 200);
      for (const field of ["todayRevenue", "todayExpenses", "netRevenue", "outstandingPayments"]) {
        assert.equal(receptionDashboard.data[field], null, `${field} must be redacted for reception`);
      }
      for (const role of ["reception", "accountant", "assistant", "dentist"]) {
        assert.equal((await request(role, "GET", reportPath)).status, 403,
          `${role} cannot read the owner/manager-only operational report`);
      }
      const operationalReport = await request("manager", "GET", reportPath);
      assert.equal(operationalReport.status, 200);
      assert.equal(/patientId|patientName|Fictional|amount|revenue|EGP/i.test(JSON.stringify(operationalReport.data)), false,
        "operational reports contain neither patient identities nor finance data");
    });
  } finally {
    try {
      if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      const staffIds = staff.map((row) => row.id);
      const patientIds = patients.map((row) => row.id);
      if (staffIds.length) {
        await db.delete(auditLogTable).where(inArray(auditLogTable.actorStaffId, staffIds));
      }
      if (reminders.length) await db.delete(remindersTable).where(inArray(remindersTable.id, reminders));
      if (patientIds.length) await db.delete(reminderPreferencesTable)
        .where(inArray(reminderPreferencesTable.patientId, patientIds));
       if (patientIds.length) await db.delete(appointmentsTable).where(inArray(appointmentsTable.patientId, patientIds));
      if (templates.length) await db.delete(reminderTemplatesTable).where(inArray(reminderTemplatesTable.id, templates.map((row) => row.id)));
      if (payments.length) await db.delete(paymentsTable).where(inArray(paymentsTable.id, payments.map((row) => row.id)));
      if (invoices.length) await db.delete(invoicesTable).where(inArray(invoicesTable.id, invoices.map((row) => row.id)));
      if (expenses.length) await db.delete(expensesTable).where(inArray(expensesTable.id, expenses.map((row) => row.id)));
      if (patientIds.length) await db.delete(patientsTable).where(inArray(patientsTable.id, patientIds));
      if (staffIds.length) await db.delete(staffTable).where(inArray(staffTable.id, staffIds));
    } finally {
      await pool.end();
    }
  }
});