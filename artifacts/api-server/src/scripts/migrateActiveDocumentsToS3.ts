import { inArray } from "drizzle-orm";
import { db, pool, patientDocumentsTable } from "@workspace/db";
import { migrateLegacyDocumentToS3 } from "../lib/privateDocuments";

async function main() {
  const apply = process.argv.includes("--apply");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required to enumerate active documents");
  if (apply && process.env.STORAGE_PROVIDER?.toLowerCase() !== "s3") {
    throw new Error("Set STORAGE_PROVIDER=s3 before using --apply");
  }

  try {
    const documents = await db.select({
      id: patientDocumentsTable.id,
      objectKey: patientDocumentsTable.objectKey,
      sizeBytes: patientDocumentsTable.sizeBytes,
      contentType: patientDocumentsTable.contentType,
      status: patientDocumentsTable.status,
    }).from(patientDocumentsTable)
      .where(inArray(patientDocumentsTable.status, ["active", "pending", "withdrawn"]));

    const totalBytes = documents.reduce((sum, row) => sum + row.sizeBytes, 0);
    const counts = documents.reduce((summary, row) => {
      summary[row.status] = (summary[row.status] ?? 0) + 1;
      return summary;
    }, {} as Record<string, number>);
    console.log(`${apply ? "APPLY" : "DRY RUN"}: ${documents.length} documents (${counts.active ?? 0} active, ${counts.pending ?? 0} pending, ${counts.withdrawn ?? 0} withdrawn), ${totalBytes} bytes`);
    if (!apply) {
      console.log("No objects were read, written, or deleted. Re-run with --apply to copy; originals are retained.");
      return;
    }

    let copied = 0;
    let alreadyPresent = 0;
    let missingPending = 0;
    for (const row of documents) {
      const status = row.status as "active" | "pending" | "withdrawn";
      const result = await migrateLegacyDocumentToS3(row.objectKey, row.sizeBytes, row.contentType, status);
      if (result === "copied") copied += 1;
      else if (result === "already-present") alreadyPresent += 1;
      else missingPending += 1;
      console.log(`Processed ${status} document ${row.id}: ${result}`);
    }
    console.log(`Migration complete: ${copied} copied; ${alreadyPresent} already present; ${missingPending} pending uploads missing and retained in the database. Replit originals were not changed.`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});