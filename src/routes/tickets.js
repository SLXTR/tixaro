import express from "express";
import { requireAuth, requirePermission } from "../middleware.js";
import { setFlash } from "../security.js";
import { defaultSlaCode, loadTicketConfiguration } from "../service-config.js";
import { canAccessQueue, hasPermission } from "../access-control.js";
import { sendTicketEmail } from "../mail-service.js";
import { createTicketNumber } from "../number-formats.js";
import { renderTemplate } from "../template-engine.js";

const statuses = ["open", "in_progress", "waiting", "resolved", "closed"];
const priorities = ["low", "normal", "high", "urgent"];
const tickOptions = Array.from({ length: 32 }, (_item, index) => index + 1);
const manualTicketChannels = [
  { value: "email", label: "E-Mail-Ticket" },
  { value: "phone_outbound", label: "Ausgehender Anruf" },
  { value: "phone_inbound", label: "Ankommender Anruf" }
];

function positiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function slaDates(slaDefinitions, sla, start = new Date()) {
  const definition = slaDefinitions[sla] ?? Object.values(slaDefinitions)[0] ?? { responseMinutes: 480, resolutionMinutes: 2880 };
  return {
    responseDueAt: new Date(start.getTime() + definition.responseMinutes * 60_000),
    resolutionDueAt: new Date(start.getTime() + definition.resolutionMinutes * 60_000)
  };
}

async function getTicket(pool, id, user, queueAccess = "read") {
  const result = await pool.query(
    `SELECT t.*, requester.first_name AS requester_first_name, requester.last_name AS requester_last_name,
            requester.name AS requester_name, requester.email AS requester_email,
            assignee.name AS assignee_name, customer.name AS customer_name, customer.customer_number,
            COALESCE(t.customer_id, cp.customer_id) AS effective_customer_id
     FROM tickets t
     JOIN users requester ON requester.id = t.requester_id
     LEFT JOIN users assignee ON assignee.id = t.assignee_id
     LEFT JOIN customer_profiles cp ON cp.user_id = t.requester_id
     LEFT JOIN customers customer ON customer.id = COALESCE(t.customer_id, cp.customer_id)
     WHERE t.id = $1`,
    [id]
  );
  const ticket = result.rows[0];
  if (!ticket) return null;
  const ownsTicket = ticket.requester_id === user.id && hasPermission(user, "tickets.view_own");
  if (!ownsTicket && !canAccessQueue(user, ticket.category, queueAccess)) return null;
  ticket.billed_ticks = Number(ticket.billed_ticks ?? 0);
  return ticket;
}

async function ticketFormData(pool, user) {
  const canManage = hasPermission(user, "tickets.manage");
  const [requesters, agents, assets] = await Promise.all([
    !canManage
      ? Promise.resolve({ rows: [] })
      : pool.query(
          `SELECT u.id, u.name, u.email, c.name AS customer_name
           FROM users u LEFT JOIN customer_profiles cp ON cp.user_id = u.id LEFT JOIN customers c ON c.id = cp.customer_id
           WHERE u.active = TRUE AND u.role = 'requester' ORDER BY c.name NULLS LAST, u.name`
        ),
    !canManage ? Promise.resolve({ rows: [] }) : pool.query("SELECT id, name FROM users WHERE active = TRUE AND role IN ('admin', 'agent') ORDER BY name"),
    pool.query(
      `SELECT a.id, a.asset_number, a.asset_type, a.name, a.assigned_user_id, a.status,
              c.name AS customer_name, u.name AS assigned_user_name
       FROM assets a LEFT JOIN customers c ON c.id = a.customer_id LEFT JOIN users u ON u.id = a.assigned_user_id
       WHERE a.status NOT IN ('retired', 'lost') ${canManage ? "" : "AND a.assigned_user_id = $1"}
       ORDER BY c.name NULLS LAST, u.name NULLS LAST, a.name`,
      canManage ? [] : [user.id]
    )
  ]);
  return { requesters: requesters.rows, agents: agents.rows, assets: assets.rows };
}

export function ticketsRouter({ pool, config }) {
  const router = express.Router();
  router.use(requireAuth);

  router.get("/", async (req, res) => {
    const configuration = await loadTicketConfiguration(pool);
    const { queues, slaOptions } = configuration;
    const clauses = [];
    const params = [];
    if (!hasPermission(req.user, "tickets.view_all")) {
      const visibility = [];
      if (hasPermission(req.user, "tickets.view_own")) {
        params.push(req.user.id);
        visibility.push(`t.requester_id = $${params.length}`);
      }
      const accessibleQueues = Object.keys(req.user.queuePermissions ?? {});
      if (accessibleQueues.length) {
        const placeholders = accessibleQueues.map((queueName) => {
          params.push(queueName);
          return `$${params.length}`;
        });
        visibility.push(`t.category IN (${placeholders.join(", ")})`);
      }
      clauses.push(visibility.length ? `(${visibility.join(" OR ")})` : "FALSE");
    }
    if (statuses.includes(req.query.status)) {
      params.push(req.query.status);
      clauses.push(`t.status = $${params.length}`);
    }
    if (priorities.includes(req.query.priority)) {
      params.push(req.query.priority);
      clauses.push(`t.priority = $${params.length}`);
    }
    const mine = req.query.mine === "1" && hasPermission(req.user, "tickets.manage");
    if (mine) {
      params.push(req.user.id);
      clauses.push(`t.assignee_id = $${params.length}`);
    }
    const escalated = req.query.escalated === "1";
    if (escalated) {
      clauses.push(`t.status NOT IN ('waiting', 'resolved', 'closed') AND (
        (t.first_response_at IS NULL AND t.response_due_at < NOW()) OR t.resolution_due_at < NOW()
      )`);
    }
    const queue = String(req.query.queue ?? "").trim();
    if (queues.includes(queue)) {
      params.push(queue);
      clauses.push(`t.category = $${params.length}`);
    }
    const query = String(req.query.q ?? "").trim();
    if (query) {
      params.push(`%${query}%`);
      clauses.push(`(t.ticket_number ILIKE $${params.length} OR t.subject ILIKE $${params.length} OR requester.name ILIKE $${params.length})`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT t.*, requester.name AS requester_name, assignee.name AS assignee_name
       FROM tickets t
       JOIN users requester ON requester.id = t.requester_id
       LEFT JOIN users assignee ON assignee.id = t.assignee_id
       ${where}
       ORDER BY CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
                t.updated_at DESC LIMIT 100`,
      params
    );
    res.render("tickets/index", {
      title: "Tickets",
      tickets: result.rows,
      queues,
      slaOptions,
      filters: { q: query, status: req.query.status ?? "", priority: req.query.priority ?? "", queue, mine, escalated }
    });
  });

  router.get("/new", requirePermission("tickets.create"), async (req, res) => {
    const [formData, configuration] = await Promise.all([ticketFormData(pool, req.user), loadTicketConfiguration(pool)]);
    res.render("tickets/new", { title: req.user.role === "requester" ? "Neue Anfrage" : "Neues Ticket", ...formData, ...configuration, ticketChannels: manualTicketChannels, error: null, values: {} });
  });

  router.post("/", requirePermission("tickets.create"), async (req, res) => {
    const configuration = await loadTicketConfiguration(pool);
    const { queues, ticketTypes, slaOptions, slaDefinitions } = configuration;
    const subject = String(req.body.subject ?? "").trim();
    const description = String(req.body.description ?? "").trim();
    const priority = priorities.includes(req.body.priority) ? req.body.priority : "normal";
    const category = queues.includes(req.body.category) ? req.body.category : queues[0];
    const ticketType = ticketTypes.includes(req.body.ticket_type) ? req.body.ticket_type : ticketTypes[0];
    const queueDefaultSla = configuration.queueRecords.find((item) => item.name === category)?.default_sla_code;
    const sla = slaDefinitions[req.body.sla]
      ? req.body.sla
      : (slaDefinitions[queueDefaultSla] ? queueDefaultSla : defaultSlaCode(configuration, priority === "urgent" ? "critical" : "standard"));
    const requestedRequester = positiveInt(req.body.requester_id);
    const canManage = hasPermission(req.user, "tickets.manage");
    const channel = req.user.role === "requester" ? "portal"
      : (manualTicketChannels.some((item) => item.value === req.body.channel) ? req.body.channel : "email");
    const requesterId = canManage ? (requestedRequester ?? req.user.id) : req.user.id;
    const assigneeId = canManage ? positiveInt(req.body.assignee_id) : null;
    const requestedAssetId = positiveInt(req.body.asset_id);

    if (subject.length < 4 || description.length < 10 || (canManage && !canAccessQueue(req.user, category, "write"))) {
      const formData = await ticketFormData(pool, req.user);
      return res.status(422).render("tickets/new", {
        title: req.user.role === "requester" ? "Neue Anfrage" : "Neues Ticket",
        ...formData,
        queues,
        ticketTypes,
        slaOptions,
        queueRecords: configuration.queueRecords,
        ticketChannels: manualTicketChannels,
        error: canManage && !canAccessQueue(req.user, category, "write") ? "Für diese Queue besitzt du keinen Schreibzugriff." : "Bitte gib einen aussagekräftigen Betreff und mindestens 10 Zeichen Beschreibung ein.",
        values: req.body
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const deadlines = slaDates(slaDefinitions, sla);
      const profile = await client.query("SELECT customer_id FROM customer_profiles WHERE user_id = $1", [requesterId]);
      let customerId = profile.rows[0]?.customer_id ?? null;
      let assetId = null;
      if (requestedAssetId) {
        const asset = await client.query(
          "SELECT id, customer_id FROM assets WHERE id = $1 AND assigned_user_id = $2 AND status NOT IN ('retired', 'lost')",
          [requestedAssetId, requesterId]
        );
        if (asset.rowCount) {
          assetId = asset.rows[0].id;
          customerId = customerId ?? asset.rows[0].customer_id;
        }
      }
      const created = await client.query(
        `INSERT INTO tickets (subject, description, priority, category, ticket_type, channel, sla, response_due_at, resolution_due_at, requester_id, customer_id, assignee_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [subject, description, priority, category, ticketType, channel, sla, deadlines.responseDueAt, deadlines.resolutionDueAt, requesterId, customerId, assigneeId]
      );
      const ticket = created.rows[0];
      const ticketNumber = await createTicketNumber(client, ticket.id, new Date(ticket.created_at));
      await client.query("UPDATE tickets SET ticket_number = $1 WHERE id = $2", [ticketNumber, ticket.id]);
      if (assetId) {
        await client.query(
          "INSERT INTO ticket_assets (ticket_id, asset_id, is_primary, created_by) VALUES ($1, $2, TRUE, $3)",
          [ticket.id, assetId, req.user.id]
        );
      }
      await client.query(
        "INSERT INTO activity_log (ticket_id, actor_id, action, details) VALUES ($1, $2, 'ticket_created', $3)",
        [ticket.id, req.user.id, JSON.stringify({ priority, queue: category, ticketType, channel, sla, customerId, assetId })]
      );
      await client.query("COMMIT");
      setFlash(req, "success", `${ticketNumber} wurde erstellt.`);
      res.redirect(`/tickets/${ticket.id}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  router.get("/:id", async (req, res) => {
    const id = positiveInt(req.params.id);
    const ticket = id ? await getTicket(pool, id, req.user) : null;
    if (!ticket) return res.status(404).render("error", { title: "Ticket nicht gefunden", message: "Das Ticket existiert nicht oder ist für dich nicht sichtbar." });
    const configuration = await loadTicketConfiguration(pool, { includeInactive: true });
    const { queues, ticketTypes, slaOptions } = configuration;

    const commentParams = [ticket.id];
    const internalClause = hasPermission(req.user, "tickets.internal") ? "" : "AND c.is_internal = FALSE";
    const [comments, agents, activity, workLogs, assets, templates] = await Promise.all([
      pool.query(
        `SELECT c.*, u.name AS author_name, u.role AS author_role
         FROM comments c JOIN users u ON u.id = c.author_id
         WHERE c.ticket_id = $1 ${internalClause} ORDER BY c.created_at ASC`,
        commentParams
      ),
      pool.query("SELECT id, name FROM users WHERE active = TRUE AND role IN ('admin', 'agent') ORDER BY name"),
      !hasPermission(req.user, "tickets.internal")
        ? Promise.resolve({ rows: [] })
        : pool.query(
            `SELECT a.*, u.name AS actor_name FROM activity_log a
             LEFT JOIN users u ON u.id = a.actor_id WHERE a.ticket_id = $1 ORDER BY a.created_at DESC LIMIT 20`,
            [ticket.id]
          ),
      !hasPermission(req.user, "tickets.worklog")
        ? Promise.resolve({ rows: [] })
        : pool.query(
            `SELECT w.*, u.name AS author_name
             FROM ticket_work_logs w JOIN users u ON u.id = w.author_id
             WHERE w.ticket_id = $1 ORDER BY w.created_at DESC, w.id DESC LIMIT 50`,
            [ticket.id]
          ),
      pool.query(
        `SELECT a.*, c.name AS customer_name, u.name AS assigned_user_name,
                CASE WHEN ta.ticket_id IS NULL THEN FALSE ELSE TRUE END AS is_linked
         FROM assets a
         LEFT JOIN customers c ON c.id = a.customer_id
         LEFT JOIN users u ON u.id = a.assigned_user_id
         LEFT JOIN ticket_assets ta ON ta.asset_id = a.id AND ta.ticket_id = $1
         WHERE a.assigned_user_id = $2 OR ta.ticket_id = $1
         ORDER BY CASE WHEN ta.ticket_id IS NULL THEN 1 ELSE 0 END, a.name`,
        [ticket.id, ticket.requester_id]
      ),
      hasPermission(req.user, "tickets.internal")
        ? pool.query("SELECT id, name, template_type, body FROM response_templates WHERE active = TRUE ORDER BY sort_order, name")
        : Promise.resolve({ rows: [] })
    ]);
    res.render("tickets/show", {
      title: ticket.ticket_number,
      ticket,
      comments: comments.rows,
      agents: agents.rows,
      activity: activity.rows,
      workLogs: workLogs.rows,
      assets: assets.rows,
      responseTemplates: templates.rows.map((template) => ({
        ...template,
        content: renderTemplate(template.body, { company: { name: res.locals.companyName }, ticket, agent: req.user })
      })),
      queues,
      ticketTypes,
      slaOptions,
      tickOptions
    });
  });

  router.post("/:id/assets", requirePermission("tickets.manage"), async (req, res) => {
    const id = positiveInt(req.params.id);
    const ticket = id ? await getTicket(pool, id, req.user, "write") : null;
    if (!ticket) return res.status(404).render("error", { title: "Ticket nicht gefunden", message: "Das Ticket konnte nicht gefunden werden." });
    const assetId = positiveInt(req.body.asset_id);
    const asset = assetId
      ? await pool.query("SELECT id, customer_id, name FROM assets WHERE id = $1 AND assigned_user_id = $2", [assetId, ticket.requester_id])
      : { rows: [], rowCount: 0 };
    if (!asset.rowCount) {
      setFlash(req, "error", "Diese Ressource ist der anfragenden Person nicht zugeordnet.");
      return res.redirect(`/tickets/${ticket.id}`);
    }
    await pool.query(
      `INSERT INTO ticket_assets (ticket_id, asset_id, is_primary, created_by)
       VALUES ($1, $2, FALSE, $3) ON CONFLICT (ticket_id, asset_id) DO NOTHING`,
      [ticket.id, assetId, req.user.id]
    );
    await pool.query("UPDATE tickets SET customer_id = COALESCE(customer_id, $1), updated_at = NOW() WHERE id = $2", [asset.rows[0].customer_id, ticket.id]);
    await pool.query(
      "INSERT INTO activity_log (ticket_id, actor_id, action, details) VALUES ($1, $2, 'asset_linked', $3)",
      [ticket.id, req.user.id, JSON.stringify({ assetId, assetName: asset.rows[0].name })]
    );
    setFlash(req, "success", "Ressource wurde mit dem Ticket verknüpft.");
    res.redirect(`/tickets/${ticket.id}`);
  });

  router.post("/:id/assets/:assetId/remove", requirePermission("tickets.manage"), async (req, res) => {
    const id = positiveInt(req.params.id);
    const assetId = positiveInt(req.params.assetId);
    const ticket = id ? await getTicket(pool, id, req.user, "write") : null;
    if (!ticket || !assetId) return res.status(404).render("error", { title: "Verknüpfung nicht gefunden", message: "Die Ressourcenverknüpfung konnte nicht gefunden werden." });
    await pool.query("DELETE FROM ticket_assets WHERE ticket_id = $1 AND asset_id = $2", [ticket.id, assetId]);
    await pool.query(
      "INSERT INTO activity_log (ticket_id, actor_id, action, details) VALUES ($1, $2, 'asset_unlinked', $3)",
      [ticket.id, req.user.id, JSON.stringify({ assetId })]
    );
    setFlash(req, "success", "Ressourcenverknüpfung wurde entfernt.");
    res.redirect(`/tickets/${ticket.id}`);
  });

  router.post("/:id/update", requirePermission("tickets.manage"), async (req, res) => {
    const id = positiveInt(req.params.id);
    const ticket = id ? await getTicket(pool, id, req.user, "write") : null;
    if (!ticket) return res.status(404).render("error", { title: "Ticket nicht gefunden", message: "Das Ticket konnte nicht gefunden werden." });
    const configuration = await loadTicketConfiguration(pool, { includeInactive: true });
    const { queues, ticketTypes, slaDefinitions } = configuration;

    const status = statuses.includes(req.body.status) ? req.body.status : ticket.status;
    const priority = priorities.includes(req.body.priority) ? req.body.priority : ticket.priority;
    const category = queues.includes(req.body.category) ? req.body.category : ticket.category;
    if (!canAccessQueue(req.user, category, "write")) {
      setFlash(req, "error", "Für die Ziel-Queue besitzt du keinen Schreibzugriff.");
      return res.redirect(`/tickets/${ticket.id}`);
    }
    const ticketType = ticketTypes.includes(req.body.ticket_type) ? req.body.ticket_type : ticket.ticket_type;
    const sla = slaDefinitions[req.body.sla] ? req.body.sla : ticket.sla;
    const assigneeId = positiveInt(req.body.assignee_id);
    const dueAt = req.body.due_at ? new Date(req.body.due_at) : null;
    const safeDueAt = dueAt && !Number.isNaN(dueAt.valueOf()) ? dueAt : null;

    let responseDueAt = ticket.response_due_at;
    let resolutionDueAt = ticket.resolution_due_at;
    let slaPausedAt = ticket.sla_paused_at;

    if (sla !== ticket.sla) {
      const deadlines = slaDates(slaDefinitions, sla);
      responseDueAt = deadlines.responseDueAt;
      resolutionDueAt = deadlines.resolutionDueAt;
      slaPausedAt = status === "waiting" ? new Date() : null;
    } else if (status === "waiting" && ticket.status !== "waiting") {
      slaPausedAt = new Date();
    } else if (ticket.status === "waiting" && status !== "waiting" && ticket.sla_paused_at) {
      const pausedFor = Date.now() - new Date(ticket.sla_paused_at).getTime();
      if (responseDueAt && !ticket.first_response_at) responseDueAt = new Date(new Date(responseDueAt).getTime() + pausedFor);
      if (resolutionDueAt) resolutionDueAt = new Date(new Date(resolutionDueAt).getTime() + pausedFor);
      slaPausedAt = null;
    }

    await pool.query(
      `UPDATE tickets SET status = $1, priority = $2, category = $3, ticket_type = $4, sla = $5, assignee_id = $6, due_at = $7,
       response_due_at = $8, resolution_due_at = $9, sla_paused_at = $10,
       closed_at = CASE WHEN $1 IN ('resolved', 'closed') THEN COALESCE(closed_at, NOW()) ELSE NULL END,
       updated_at = NOW() WHERE id = $11`,
      [status, priority, category, ticketType, sla, assigneeId, safeDueAt, responseDueAt, resolutionDueAt, slaPausedAt, ticket.id]
    );
    await pool.query(
      "INSERT INTO activity_log (ticket_id, actor_id, action, details) VALUES ($1, $2, 'ticket_updated', $3)",
      [ticket.id, req.user.id, JSON.stringify({ status, priority, queue: category, ticketType, sla, assigneeId })]
    );
    setFlash(req, "success", "Ticket wurde aktualisiert.");
    res.redirect(`/tickets/${ticket.id}`);
  });

  router.post("/:id/take", requirePermission("tickets.manage"), async (req, res) => {
    const id = positiveInt(req.params.id);
    const ticket = id ? await getTicket(pool, id, req.user, "write") : null;
    if (!ticket) return res.status(404).render("error", { title: "Ticket nicht gefunden", message: "Das Ticket konnte nicht gefunden werden." });

    await pool.query("UPDATE tickets SET assignee_id = $1, status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END, updated_at = NOW() WHERE id = $2", [req.user.id, ticket.id]);
    await pool.query(
      "INSERT INTO activity_log (ticket_id, actor_id, action, details) VALUES ($1, $2, 'ticket_taken', $3)",
      [ticket.id, req.user.id, JSON.stringify({ previousAssigneeId: ticket.assignee_id })]
    );
    setFlash(req, "success", "Ticket wurde dir zugewiesen.");
    res.redirect(`/tickets/${ticket.id}`);
  });

  router.post("/:id/work-log", requirePermission("tickets.worklog"), async (req, res) => {
    const id = positiveInt(req.params.id);
    const ticket = id ? await getTicket(pool, id, req.user, "write") : null;
    if (!ticket) return res.status(404).render("error", { title: "Ticket nicht gefunden", message: "Das Ticket konnte nicht gefunden werden." });

    const description = String(req.body.description ?? "").trim().slice(0, 2000);
    const ticks = positiveInt(req.body.ticks);
    const direction = req.body.direction === "subtract" ? "subtract" : "add";
    if (description.length < 3 || !ticks || ticks > 32) {
      setFlash(req, "error", "Bitte dokumentiere die Arbeit und wähle zwischen 1 und 32 Takten.");
      return res.redirect(`/tickets/${ticket.id}`);
    }

    const delta = direction === "subtract" ? -ticks : ticks;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE tickets SET billed_ticks = billed_ticks + $1, updated_at = NOW()
         WHERE id = $2 AND billed_ticks + $1 >= 0 RETURNING billed_ticks`,
        [delta, ticket.id]
      );
      if (!updated.rowCount) {
        await client.query("ROLLBACK");
        setFlash(req, "error", "Es können nicht mehr Takte abgezogen werden, als aktuell vorhanden sind.");
        return res.redirect(`/tickets/${ticket.id}`);
      }
      await client.query(
        "INSERT INTO ticket_work_logs (ticket_id, author_id, description, ticks) VALUES ($1, $2, $3, $4)",
        [ticket.id, req.user.id, description, delta]
      );
      await client.query(
        "INSERT INTO activity_log (ticket_id, actor_id, action, details) VALUES ($1, $2, 'work_logged', $3)",
        [ticket.id, req.user.id, JSON.stringify({ ticks: delta, minutes: delta * 15 })]
      );
      await client.query("COMMIT");
      setFlash(req, "success", `${Math.abs(delta)} ${Math.abs(delta) === 1 ? "Takt wurde" : "Takte wurden"} ${delta > 0 ? "hinzugefügt" : "abgezogen"}.`);
      res.redirect(`/tickets/${ticket.id}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  router.post("/:id/comments", requirePermission("tickets.comment"), async (req, res) => {
    const id = positiveInt(req.params.id);
    const ticket = id ? await getTicket(pool, id, req.user) : null;
    if (!ticket) return res.status(404).render("error", { title: "Ticket nicht gefunden", message: "Das Ticket konnte nicht gefunden werden." });
    const body = String(req.body.body ?? "").trim();
    if (body.length < 2) {
      setFlash(req, "error", "Bitte gib eine Nachricht ein.");
      return res.redirect(`/tickets/${ticket.id}`);
    }
    const isInternal = hasPermission(req.user, "tickets.internal") && req.body.is_internal === "on";
    const workMinutes = 0;
    await pool.query(
      "INSERT INTO comments (ticket_id, author_id, body, is_internal, work_minutes) VALUES ($1, $2, $3, $4, $5)",
      [ticket.id, req.user.id, body, isInternal, workMinutes]
    );
    const recordsFirstResponse = hasPermission(req.user, "tickets.manage") && !isInternal && !ticket.first_response_at;
    await pool.query(
      "UPDATE tickets SET updated_at = NOW(), first_response_at = CASE WHEN $2 THEN COALESCE(first_response_at, NOW()) ELSE first_response_at END WHERE id = $1",
      [ticket.id, recordsFirstResponse]
    );
    await pool.query(
      "INSERT INTO activity_log (ticket_id, actor_id, action, details) VALUES ($1, $2, 'comment_added', $3)",
      [ticket.id, req.user.id, JSON.stringify({ internal: isInternal, workMinutes, firstResponse: recordsFirstResponse })]
    );
    if (!isInternal && hasPermission(req.user, "tickets.manage")) {
      try {
        const delivery = await sendTicketEmail({ pool, config, ticketId: ticket.id, body });
        setFlash(req, "success", delivery.sent ? "Antwort gespeichert und per E-Mail versendet." : "Antwort gespeichert. Für diese Queue ist noch kein Ausgangskanal eingerichtet.");
      } catch {
        setFlash(req, "error", "Antwort wurde im Ticket gespeichert, der E-Mail-Versand ist jedoch fehlgeschlagen. Details stehen im Mailprotokoll.");
      }
    } else {
      setFlash(req, "success", isInternal ? "Interne Notiz gespeichert." : "Antwort gespeichert.");
    }
    res.redirect(`/tickets/${ticket.id}`);
  });

  return router;
}
