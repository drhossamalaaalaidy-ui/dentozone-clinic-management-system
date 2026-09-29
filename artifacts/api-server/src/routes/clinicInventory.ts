import { Router, type IRouter } from "express";
import { asc, eq } from "drizzle-orm";
import {
  auditLogTable,
  db,
  inventoryItemsTable,
  staffTable,
  stockMovementsTable,
  suppliersTable,
  type Staff,
} from "@workspace/db";
import {
  CreateInventoryItemBody,
  CreateInventoryItemResponse,
  ListInventoryItemsResponse,
  ListStockMovementsParams,
  ListStockMovementsResponse,
  RecordStockMovementBody,
  RecordStockMovementParams,
  RecordStockMovementResponse,
  UpdateInventoryItemBody,
  UpdateInventoryItemParams,
  UpdateInventoryItemResponse,
} from "@workspace/api-zod";
import { allowRoles, currentStaff } from "../middlewares/clinicStaff";

const router: IRouter = Router();
const reader = allowRoles("owner", "manager", "accountant", "dentist", "assistant");
const financeStaff = allowRoles("owner", "manager", "accountant");
const financialRoles = new Set(["owner", "manager", "accountant"]);

function isFinancialStaff(staff: Staff): boolean {
  return financialRoles.has(staff.role);
}

function isUniqueViolation(error: unknown): boolean {
  let current = error;
  const visited = new Set<unknown>();
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    if ("code" in current && current.code === "23505") return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

function normalizeItemBody(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const normalized = { ...body } as Record<string, unknown>;
  for (const key of ["name", "sku", "unit"]) {
    if (typeof normalized[key] === "string") {
      const value = normalized[key].trim();
      normalized[key] = key === "sku" ? value.toUpperCase() : value;
    }
  }
  return normalized;
}

function itemDto(
  item: typeof inventoryItemsTable.$inferSelect,
  supplierName: string | null,
  includeCost: boolean,
) {
  return {
    id: item.id,
    name: item.name,
    sku: item.sku,
    unit: item.unit,
    quantityOnHand: item.quantityOnHand,
    reorderLevel: item.reorderLevel,
    unitCostCents: includeCost ? item.unitCostCents : null,
    supplierId: item.supplierId,
    supplierName,
    active: item.active,
    lowStock: item.quantityOnHand <= item.reorderLevel,
  };
}

async function validateSupplier(supplierId: number | null | undefined): Promise<
  { ok: true } | { ok: false; status: 400 | 404; message: string }
> {
  if (supplierId == null) return { ok: true };
  const [supplier] = await db.select({
    id: suppliersTable.id,
    active: suppliersTable.active,
  }).from(suppliersTable).where(eq(suppliersTable.id, supplierId));
  if (!supplier) return { ok: false, status: 404, message: "Supplier not found" };
  if (!supplier.active) return { ok: false, status: 400, message: "Supplier is inactive" };
  return { ok: true };
}

router.get("/inventory", reader, async (_req, res): Promise<void> => {
  const staff = currentStaff(res);
  const rows = await db.select({
    item: inventoryItemsTable,
    supplierName: suppliersTable.name,
  }).from(inventoryItemsTable)
    .leftJoin(suppliersTable, eq(inventoryItemsTable.supplierId, suppliersTable.id))
    .orderBy(asc(inventoryItemsTable.name), asc(inventoryItemsTable.id));
  const result = rows.map(({ item, supplierName }) =>
    itemDto(item, supplierName, isFinancialStaff(staff)),
  );
  res.json(ListInventoryItemsResponse.parse(result));
});

router.post("/inventory", financeStaff, async (req, res): Promise<void> => {
  const parsed = CreateInventoryItemBody.safeParse(normalizeItemBody(req.body));
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!parsed.data.name.trim() || !parsed.data.sku.trim() || !parsed.data.unit.trim()) {
    res.status(400).json({ error: "Name, SKU, and unit must be nonempty" });
    return;
  }
  const supplierCheck = await validateSupplier(parsed.data.supplierId);
  if (!supplierCheck.ok) {
    res.status(supplierCheck.status).json({ error: supplierCheck.message });
    return;
  }

  const actor = currentStaff(res);
  try {
    const item = await db.transaction(async (tx) => {
      const [created] = await tx.insert(inventoryItemsTable).values({
        name: parsed.data.name.trim(),
        sku: parsed.data.sku.trim().toUpperCase(),
        unit: parsed.data.unit.trim(),
        quantityOnHand: 0,
        reorderLevel: parsed.data.reorderLevel,
        unitCostCents: parsed.data.unitCostCents ?? null,
        supplierId: parsed.data.supplierId ?? null,
      }).returning();
      await tx.insert(auditLogTable).values({
        actorStaffId: actor.id,
        actorName: actor.name,
        action: "create",
        entityType: "inventory_item",
        entityId: created.id,
        summary: `Inventory item ${created.id} created`,
      });
      return created;
    });
    const [supplier] = item.supplierId == null
      ? []
      : await db.select({ name: suppliersTable.name }).from(suppliersTable)
        .where(eq(suppliersTable.id, item.supplierId));
    const result = itemDto(item, supplier?.name ?? null, true);
    res.status(201).json(CreateInventoryItemResponse.parse(result));
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "An inventory item with this SKU already exists" });
      return;
    }
    throw error;
  }
});

router.patch("/inventory/:itemId", financeStaff, async (req, res): Promise<void> => {
  const params = UpdateInventoryItemParams.safeParse(req.params);
  const rawBody = req.body;
  if (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) && "quantityOnHand" in rawBody) {
    res.status(400).json({ error: "Stock quantity must be changed through a stock movement" });
    return;
  }
  const parsed = UpdateInventoryItemBody.safeParse(normalizeItemBody(rawBody));
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Invalid inventory item update" });
    return;
  }
  if (!Object.keys(parsed.data).length) {
    res.status(400).json({ error: "No changes provided" });
    return;
  }
  const input = parsed.data;
  if (
    (input.name !== undefined && !input.name.trim()) ||
    (input.sku !== undefined && !input.sku.trim()) ||
    (input.unit !== undefined && !input.unit.trim())
  ) {
    res.status(400).json({ error: "Name, SKU, and unit must be nonempty" });
    return;
  }
  if ("supplierId" in input) {
    const supplierCheck = await validateSupplier(input.supplierId);
    if (!supplierCheck.ok) {
      res.status(supplierCheck.status).json({ error: supplierCheck.message });
      return;
    }
  }

  const actor = currentStaff(res);
  try {
    const item = await db.transaction(async (tx) => {
      const updateValues = {
        ...input,
        name: input.name?.trim(),
        sku: input.sku?.trim().toUpperCase(),
        unit: input.unit?.trim(),
      };
      const [updated] = await tx.update(inventoryItemsTable).set(updateValues)
        .where(eq(inventoryItemsTable.id, params.data.itemId)).returning();
      if (!updated) return null;
      await tx.insert(auditLogTable).values({
        actorStaffId: actor.id,
        actorName: actor.name,
        action: "update",
        entityType: "inventory_item",
        entityId: updated.id,
        summary: `Inventory item ${updated.id} updated`,
      });
      return updated;
    });
    if (!item) {
      res.status(404).json({ error: "Inventory item not found" });
      return;
    }
    const [supplier] = item.supplierId == null
      ? []
      : await db.select({ name: suppliersTable.name }).from(suppliersTable)
        .where(eq(suppliersTable.id, item.supplierId));
    const result = itemDto(item, supplier?.name ?? null, true);
    res.json(UpdateInventoryItemResponse.parse(result));
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "An inventory item with this SKU already exists" });
      return;
    }
    throw error;
  }
});

router.get("/inventory/:itemId/movements", reader, async (req, res): Promise<void> => {
  const params = ListStockMovementsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [item] = await db.select({
    id: inventoryItemsTable.id,
    active: inventoryItemsTable.active,
  }).from(inventoryItemsTable).where(eq(inventoryItemsTable.id, params.data.itemId));
  if (!item || !item.active) {
    res.status(404).json({ error: "Active inventory item not found" });
    return;
  }
  const rows = await db.select({
    movement: stockMovementsTable,
    staffName: staffTable.name,
  }).from(stockMovementsTable)
    .leftJoin(staffTable, eq(stockMovementsTable.staffId, staffTable.id))
    .where(eq(stockMovementsTable.itemId, params.data.itemId))
    .orderBy(asc(stockMovementsTable.occurredAt), asc(stockMovementsTable.id));
  const result = rows.map(({ movement, staffName }) => ({
    id: movement.id,
    itemId: movement.itemId,
    delta: movement.delta,
    reason: movement.reason,
    note: movement.note,
    staffName: staffName ?? "Unknown",
    occurredAt: movement.occurredAt.toISOString(),
  }));
  res.json(ListStockMovementsResponse.parse(result));
});

router.post("/inventory/:itemId/movements", reader, async (req, res): Promise<void> => {
  const params = RecordStockMovementParams.safeParse(req.params);
  const parsed = RecordStockMovementBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Invalid stock movement" });
    return;
  }
  const { delta, reason, note } = parsed.data;
  if (delta === 0) {
    res.status(400).json({ error: "Stock movement delta must be nonzero" });
    return;
  }
  const actor = currentStaff(res);
  if (
    (reason === "receive" && delta < 0) ||
    (reason === "consume" && delta > 0)
  ) {
    res.status(400).json({ error: "Movement reason does not match the delta direction" });
    return;
  }
  if (reason !== "consume" && !isFinancialStaff(actor)) {
    res.status(403).json({ error: "Only finance staff may receive or adjust stock" });
    return;
  }
  if (reason === "adjust" && !isFinancialStaff(actor)) {
    res.status(403).json({ error: "Only finance staff may adjust stock" });
    return;
  }

  const movement = await db.transaction(async (tx) => {
    const [item] = await tx.select().from(inventoryItemsTable)
      .where(eq(inventoryItemsTable.id, params.data.itemId))
      .for("update");
    if (!item || !item.active) return { error: "not-found" as const };
    const newQuantity = item.quantityOnHand + delta;
    if (newQuantity < 0) return { error: "negative" as const };
    if (newQuantity > 2_147_483_647) return { error: "overflow" as const };
    await tx.update(inventoryItemsTable).set({ quantityOnHand: newQuantity })
      .where(eq(inventoryItemsTable.id, item.id));
    const [created] = await tx.insert(stockMovementsTable).values({
      itemId: item.id,
      delta,
      reason,
      note: note ?? null,
      staffId: actor.id,
    }).returning();
    await tx.insert(auditLogTable).values({
      actorStaffId: actor.id,
      actorName: actor.name,
      action: "create",
      entityType: "stock_movement",
      entityId: created.id,
      summary: `Stock movement ${created.id} recorded for item ${item.id}`,
    });
    return { created };
  });
  if ("error" in movement) {
    if (movement.error === "not-found") {
      res.status(404).json({ error: "Active inventory item not found" });
      return;
    }
    if (movement.error === "overflow") {
      res.status(409).json({ error: "Stock movement would exceed the maximum inventory quantity" });
      return;
    }
    res.status(409).json({ error: "Stock movement would make inventory negative" });
    return;
  }
  const result = {
    id: movement.created.id,
    itemId: movement.created.itemId,
    delta: movement.created.delta,
    reason: movement.created.reason,
    note: movement.created.note,
    staffName: actor.name,
    occurredAt: movement.created.occurredAt.toISOString(),
  };
  res.status(201).json(RecordStockMovementResponse.parse(result));
});

export default router;