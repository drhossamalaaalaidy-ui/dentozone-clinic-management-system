import { date, pgTable, serial, text, timestamp, uniqueIndex, check } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";

export const marketingCampaignsTable = pgTable("marketing_campaigns", {
  id: serial("id").primaryKey(),
  code: text("code").notNull(),
  channel: text("channel").notNull(),
  startDate: date("start_date", { mode: "string" }),
  endDate: date("end_date", { mode: "string" }),
  status: text("status").$type<"active" | "paused" | "ended" | "disabled">().notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("marketing_campaigns_code_normalized_unique").on(sql`upper(btrim(${table.code}))`),
  check("marketing_campaigns_code_not_empty", sql`length(btrim(${table.code})) > 0`),
  check("marketing_campaigns_channel_not_empty", sql`length(btrim(${table.channel})) > 0`),
  check("marketing_campaigns_status_valid", sql`${table.status} in ('active', 'paused', 'ended', 'disabled')`),
  check("marketing_campaigns_dates_ordered", sql`${table.startDate} is null or ${table.endDate} is null or ${table.startDate} <= ${table.endDate}`),
]);

export const insertMarketingCampaignSchema = createInsertSchema(marketingCampaignsTable).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertMarketingCampaign = z.infer<typeof insertMarketingCampaignSchema>;
export type MarketingCampaign = typeof marketingCampaignsTable.$inferSelect;