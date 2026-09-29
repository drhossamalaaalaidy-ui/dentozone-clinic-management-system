// Test-only entry point: bundle the real route modules and DB into one module.
export { default as documentsRouter } from "../src/routes/clinicDocuments";
export { default as orthodonticsRouter } from "../src/routes/clinicOrthodontics";
export { default as patientsRouter } from "../src/routes/clinicPatients";
export { default as visitsRouter } from "../src/routes/clinicVisits";
export { default as carePlansRouter } from "../src/routes/clinicCarePlans";
export { default as remindersRouter } from "../src/routes/clinicReminders";
export { default as reportsRouter } from "../src/routes/clinicReports";
export { default as appointmentsRouter } from "../src/routes/clinicAppointments";
export { default as dashboardRouter } from "../src/routes/clinicDashboard";
export { default as laboratoryRouter } from "../src/routes/clinicLaboratory";
export { default as alignersRouter } from "../src/routes/clinicAligners";
export { default as prescriptionsRouter } from "../src/routes/clinicPrescriptions";
export { default as marketingRouter } from "../src/routes/clinicMarketing";
export {
  db, pool, staffTable, patientsTable, visitsTable, visitDiagnosesTable, visitProceduresTable,
  paymentsTable, invoicesTable, expensesTable,
  odontogramEntriesTable, treatmentPlansTable, treatmentPlanItemsTable, appointmentsTable,
  patientDocumentsTable, orthodonticCasesTable, orthodonticProgressTable,
  reminderPreferencesTable, reminderTemplatesTable, remindersTable, auditLogTable,
  laboratoryOrdersTable, laboratoryOrderHistoryTable, alignerCoursesTable, alignerTraysTable,
  prescriptionsTable, prescriptionAmendmentsTable, marketingCampaignsTable,
} from "@workspace/db";