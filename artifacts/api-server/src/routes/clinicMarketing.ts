import { Router, type IRouter } from "express";
import { allowRoles, currentStaff } from "../middlewares/clinicStaff";
import { pool } from "@workspace/db";

const router: IRouter = Router();
const managers = allowRoles("owner", "manager");
type CampaignFields = {
  code?: string;
  channel?: string;
  startDate?: string | null;
  endDate?: string | null;
  status?: "active" | "paused" | "ended";
};
const campaignFieldNames = new Set(["code", "channel", "startDate", "endDate", "status"]);

type CampaignRow = {
  id: number;
  code: string;
  channel: string;
  start_date: string | null;
  end_date: string | null;
  status: "active" | "paused" | "ended" | "disabled";
  created_at: Date;
  updated_at: Date;
};

function campaignDto(row: CampaignRow) {
  return {
    id: Number(row.id),
    code: row.code,
    channel: row.channel,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseCampaignFields(raw: unknown, partial: boolean): CampaignFields | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.some((key) => !campaignFieldNames.has(key)) || (partial && keys.length === 0)) return null;
  if (!partial && (typeof body.code !== "string" || typeof body.channel !== "string")) return null;

  const parsed: CampaignFields = {};
  if (body.code !== undefined) {
    if (typeof body.code !== "string" || !body.code.trim() || body.code.trim().length > 120) return null;
    parsed.code = body.code.trim();
  }
  if (body.channel !== undefined) {
    if (typeof body.channel !== "string" || !body.channel.trim() || body.channel.trim().length > 80) return null;
    parsed.channel = body.channel.trim();
  }
  for (const field of ["startDate", "endDate"] as const) {
    const value = body[field];
    if (value !== undefined) {
      if (value !== null && !isCalendarDate(value)) return null;
      parsed[field] = value;
    }
  }
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "paused" && body.status !== "ended") return null;
    parsed.status = body.status;
  }
  return parsed;
}

function validDateRange(startDate: string | null | undefined, endDate: string | null | undefined): boolean {
  return !(startDate && endDate) || startDate <= endDate;
}

router.get("/clinic/marketing/campaigns", managers, async (_req, res): Promise<void> => {
  const result = await pool.query<CampaignRow>(
    `SELECT id, code, channel, start_date, end_date, status, created_at, updated_at
       FROM marketing_campaigns ORDER BY created_at DESC, id DESC`,
  );
  res.json(result.rows.map(campaignDto));
});

router.post("/clinic/marketing/campaigns", managers, async (req, res): Promise<void> => {
  const parsed = parseCampaignFields(req.body, false);
  if (!parsed || typeof parsed.code !== "string" || typeof parsed.channel !== "string") {
    res.status(400).json({ error: "Invalid campaign details" });
    return;
  }
  const { code, channel, startDate = null, endDate = null, status = "active" } = parsed;
  if (!validDateRange(startDate, endDate)) {
    res.status(400).json({ error: "Campaign endDate must not precede startDate" });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query<CampaignRow>(
      `INSERT INTO marketing_campaigns (code, channel, start_date, end_date, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, code, channel, start_date, end_date, status, created_at, updated_at`,
      [code, channel, startDate, endDate, status],
    );
    const campaign = inserted.rows[0];
    const actor = currentStaff(res);
    await client.query(
      `INSERT INTO clinic_audit_log
         (actor_staff_id, actor_name, action, entity_type, entity_id, summary)
       VALUES ($1, $2, 'create', 'marketing_campaign', $3, $4)`,
      [actor.id, actor.name, campaign.id, `Marketing campaign ${campaign.id} created`],
    );
    await client.query("COMMIT");
    res.status(201).json(campaignDto(campaign));
  } catch (error) {
    await client.query("ROLLBACK");
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      res.status(409).json({ error: "A campaign with this code or source identifier already exists" });
      return;
    }
    throw error;
  } finally {
    client.release();
  }
});

router.patch("/clinic/marketing/campaigns/:campaignId", managers, async (req, res): Promise<void> => {
  const id = Number(req.params.campaignId);
  if (!Number.isSafeInteger(id) || id < 1) {
    res.status(400).json({ error: "campaignId must be a positive integer" });
    return;
  }
  const parsed = parseCampaignFields(req.body, true);
  if (!parsed) {
    res.status(400).json({ error: "Invalid campaign update" });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existingResult = await client.query<CampaignRow>(
      `SELECT id, code, channel, start_date, end_date, status, created_at, updated_at
         FROM marketing_campaigns WHERE id = $1 FOR UPDATE`, [id],
    );
    const existing = existingResult.rows[0];
    if (!existing) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    const changes = parsed;
    const startDate = changes.startDate === undefined ? existing.start_date : changes.startDate;
    const endDate = changes.endDate === undefined ? existing.end_date : changes.endDate;
    if (!validDateRange(startDate, endDate)) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Campaign endDate must not precede startDate" });
      return;
    }
    const updatedResult = await client.query<CampaignRow>(
      `UPDATE marketing_campaigns
          SET code = $2, channel = $3, start_date = $4, end_date = $5,
              status = $6, updated_at = now()
        WHERE id = $1
        RETURNING id, code, channel, start_date, end_date, status, created_at, updated_at`,
      [id, changes.code ?? existing.code, changes.channel ?? existing.channel, startDate, endDate,
        changes.status ?? existing.status],
    );
    const campaign = updatedResult.rows[0];
    const actor = currentStaff(res);
    await client.query(
      `INSERT INTO clinic_audit_log
         (actor_staff_id, actor_name, action, entity_type, entity_id, summary)
       VALUES ($1, $2, 'update', 'marketing_campaign', $3, $4)`,
      [actor.id, actor.name, id, `Marketing campaign ${id} updated`],
    );
    await client.query("COMMIT");
    res.json(campaignDto(campaign));
  } catch (error) {
    await client.query("ROLLBACK");
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      res.status(409).json({ error: "A campaign with this code or source identifier already exists" });
      return;
    }
    throw error;
  } finally {
    client.release();
  }
});

router.post("/clinic/marketing/campaigns/:campaignId/disable", managers, async (req, res): Promise<void> => {
  const id = Number(req.params.campaignId);
  if (!Number.isSafeInteger(id) || id < 1) {
    res.status(400).json({ error: "campaignId must be a positive integer" });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<CampaignRow>(
      `UPDATE marketing_campaigns SET status = 'disabled', updated_at = now()
        WHERE id = $1
        RETURNING id, code, channel, start_date, end_date, status, created_at, updated_at`, [id],
    );
    const campaign = result.rows[0];
    if (!campaign) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    const actor = currentStaff(res);
    await client.query(
      `INSERT INTO clinic_audit_log
         (actor_staff_id, actor_name, action, entity_type, entity_id, summary)
       VALUES ($1, $2, 'disable', 'marketing_campaign', $3, $4)`,
      [actor.id, actor.name, id, `Marketing campaign ${id} disabled`],
    );
    await client.query("COMMIT");
    res.json(campaignDto(campaign));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

router.get("/clinic/marketing/report", managers, async (req, res): Promise<void> => {
  const { from, to } = req.query;
  if ((from === undefined) !== (to === undefined)) {
    res.status(400).json({ error: "Provide both from and to, or neither" });
    return;
  }
  let reportFrom: string | undefined;
  let reportTo: string | undefined;
  if (from !== undefined && to !== undefined) {
    if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) {
      res.status(400).json({ error: "from and to must be ordered valid YYYY-MM-DD dates" });
      return;
    }
    reportFrom = from;
    reportTo = to;
  }
  const query = reportFrom === undefined
    ? `SELECT upper(btrim(referral_source)) AS source, count(*)::int AS total
         FROM patients WHERE referral_source IS NOT NULL AND btrim(referral_source) <> ''
         GROUP BY upper(btrim(referral_source))`
    : `SELECT upper(btrim(referral_source)) AS source, count(*)::int AS total
         FROM patients
        WHERE referral_source IS NOT NULL AND btrim(referral_source) <> ''
          AND (registration_date AT TIME ZONE 'Africa/Cairo')::date BETWEEN $1::date AND $2::date
        GROUP BY upper(btrim(referral_source))`;
  const sources = await pool.query<{ source: string; total: number }>(
    query, reportFrom === undefined ? [] : [reportFrom, reportTo],
  );
  const campaignsResult = await pool.query<CampaignRow>(
    `SELECT id, code, channel, start_date, end_date, status, created_at, updated_at
       FROM marketing_campaigns ORDER BY code`,
  );
  const totals = new Map(sources.rows.map((row) => [row.source, Number(row.total)]));
  const codes = new Set(campaignsResult.rows.map((row) => row.code.trim().toUpperCase()));
  const campaigns = campaignsResult.rows.map((row) => ({
    ...campaignDto(row),
    referrals: totals.get(row.code.trim().toUpperCase()) ?? 0,
  }));
  const unattributedSources = sources.rows
    .filter((row) => !codes.has(row.source))
    .map((row) => ({ source: row.source, referrals: Number(row.total) }))
    .sort((a, b) => a.source.localeCompare(b.source));
  res.json({
    ...(reportFrom === undefined ? {} : { from: reportFrom, to: reportTo }),
    campaigns,
    unattributedSources,
    totalReferrals: sources.rows.reduce((total, row) => total + Number(row.total), 0),
  });
});

export default router;