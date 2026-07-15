import express from "express";
import { requireAuth, requireRole } from "../middleware.js";
import { setFlash } from "../security.js";

const statuses = ["open", "in_progress", "waiting", "resolved", "closed"];
const priorities = ["low", "normal", "high", "urgent"];

function positiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function getTicket(pool, id, user) {
  const result = await pool.query(
    `SELECT t.*, requester.name AS requester_name, requester.email AS requester_email,
            assignee.name AS assignee_name
     FROM tickets t
     JOIN users requester ON requester.id = t.requester_id
     LEFT JOIN users assignee ON assignee.id = t.assignee_id
     WHERE t.id = $1`,
    [id]
  );
  const ticket = result.rows[0];
  if (!ticket) return null;
  if (user.role === "requester" && ticket.requester_id !== user.id) return null;
  return ticket;
}

export function ticketsRouter({ pool }) {
  const router = express.Router();
  router.use(requireAuth);

  router.get("/", async (req, res) => {
    const clauses = [];
    const params = [];
    if (req.user.role === "requester") {
      params.push(req.user.id);
      clauses.push(`t.requester_id = $${params.length}`);
    }
    if (statuses.includes(req.query.status)) {
      params.push(req.query.status);
      clauses.push(`t.status = $${params.length}`);
    }
    if (priorities.includes(req.query.priority)) {
      params.push(req.query.priority);
      clauses.push(`t.priority = $${params.length}`);
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
      filters: { q: query, status: req.query.status ?? "", priority: req.query.priority ?? "" }
    });
  });

  router.get("/new", async (req, res) => {
    const [requesters, agents] = await Promise.all([
      req.user.role === "requester" ? Promise.resolve({ rows: [] }) : pool.query("SELECT id, name, email FROM users WHERE active = TRUE ORDER BY name"),
      pool.query("SELECT id, name FROM users WHERE active = TRUE AND role IN ('admin', 'agent') ORDER BY name")
    ]);
    res.render("tickets/new", { title: "Neues Ticket", requesters: requesters.rows, agents: agents.rows, error: null, values: {} });
  });

  router.post("/", async (req, res) => {
    const subject = String(req.body.subject ?? "").trim();
    const description = String(req.body.description ?? "").trim();
    const priority = priorities.includes(req.body.priority) ? req.body.priority : "normal";
    const category = String(req.body.category ?? "Allgemein").trim().slice(0, 80) || "Allgemein";
    const requestedRequester = positiveInt(req.body.requester_id);
    const requesterId = req.user.role === "requester" ? req.user.id : (requestedRequester ?? req.user.id);
    const assigneeId = req.user.role === "requester" ? null : positiveInt(req.body.assignee_id);

    if (subject.length < 4 || description.length < 10) {
      const [requesters, agents] = await Promise.all([
        req.user.role === "requester" ? Promise.resolve({ rows: [] }) : pool.query("SELECT id, name, email FROM users WHERE active = TRUE ORDER BY name"),
        pool.query("SELECT id, name FROM users WHERE active = TRUE AND role IN ('admin', 'agent') ORDER BY name")
      ]);
      return res.status(422).render("tickets/new", {
        title: "Neues Ticket",
        requesters: requesters.rows,
        agents: agents.rows,
        error: "Bitte gib einen aussagekräftigen Betreff und mindestens 10 Zeichen Beschreibung ein.",
        values: req.body
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const created = await client.query(
        `INSERT INTO tickets (subject, description, priority, category, requester_id, assignee_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [subject, description, priority, category, requesterId, assigneeId]
      );
      const ticket = created.rows[0];
      const ticketNumber = `TIX-${new Date().getFullYear()}-${String(ticket.id).padStart(6, "0")}`;
      await client.query("UPDATE tickets SET ticket_number = $1 WHERE id = $2", [ticketNumber, ticket.id]);
      await client.query(
        "INSERT INTO activity_log (ticket_id, actor_id, action, details) VALUES ($1, $2, 'ticket_created', $3)",
        [ticket.id, req.user.id, JSON.stringify({ priority, category })]
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

    const commentParams = [ticket.id];
    const internalClause = req.user.role === "requester" ? "AND c.is_internal = FALSE" : "";
    const [comments, agents, activity] = await Promise.all([
      pool.query(
        `SELECT c.*, u.name AS author_name, u.role AS author_role
         FROM comments c JOIN users u ON u.id = c.author_id
         WHERE c.ticket_id = $1 ${internalClause} ORDER BY c.created_at ASC`,
        commentParams
      ),
      pool.query("SELECT id, name FROM users WHERE active = TRUE AND role IN ('admin', 'agent') ORDER BY name"),
      req.user.role === "requester"
        ? Promise.resolve({ rows: [] })
        : pool.query(
            `SELECT a.*, u.name AS actor_name FROM activity_log a
             LEFT JOIN users u ON u.id = a.actor_id WHERE a.ticket_id = $1 ORDER BY a.created_at DESC LIMIT 20`,
            [ticket.id]
          )
    ]);
    res.render("tickets/show", { title: ticket.ticket_number, ticket, comments: comments.rows, agents: agents.rows, activity: activity.rows });
  });

  router.post("/:id/update", requireRole("admin", "agent"), async (req, res) => {
    const id = positiveInt(req.params.id);
    const ticket = id ? await getTicket(pool, id, req.user) : null;
    if (!ticket) return res.status(404).render("error", { title: "Ticket nicht gefunden", message: "Das Ticket konnte nicht gefunden werden." });

    const status = statuses.includes(req.body.status) ? req.body.status : ticket.status;
    const priority = priorities.includes(req.body.priority) ? req.body.priority : ticket.priority;
    const category = String(req.body.category ?? ticket.category).trim().slice(0, 80) || "Allgemein";
    const assigneeId = positiveInt(req.body.assignee_id);
    const dueAt = req.body.due_at ? new Date(req.body.due_at) : null;
    const safeDueAt = dueAt && !Number.isNaN(dueAt.valueOf()) ? dueAt : null;

    await pool.query(
      `UPDATE tickets SET status = $1, priority = $2, category = $3, assignee_id = $4, due_at = $5,
       closed_at = CASE WHEN $1 IN ('resolved', 'closed') THEN COALESCE(closed_at, NOW()) ELSE NULL END,
       updated_at = NOW() WHERE id = $6`,
      [status, priority, category, assigneeId, safeDueAt, ticket.id]
    );
    await pool.query(
      "INSERT INTO activity_log (ticket_id, actor_id, action, details) VALUES ($1, $2, 'ticket_updated', $3)",
      [ticket.id, req.user.id, JSON.stringify({ status, priority, category, assigneeId })]
    );
    setFlash(req, "success", "Ticket wurde aktualisiert.");
    res.redirect(`/tickets/${ticket.id}`);
  });

  router.post("/:id/comments", async (req, res) => {
    const id = positiveInt(req.params.id);
    const ticket = id ? await getTicket(pool, id, req.user) : null;
    if (!ticket) return res.status(404).render("error", { title: "Ticket nicht gefunden", message: "Das Ticket konnte nicht gefunden werden." });
    const body = String(req.body.body ?? "").trim();
    if (body.length < 2) {
      setFlash(req, "error", "Bitte gib eine Nachricht ein.");
      return res.redirect(`/tickets/${ticket.id}`);
    }
    const isInternal = req.user.role !== "requester" && req.body.is_internal === "on";
    await pool.query(
      "INSERT INTO comments (ticket_id, author_id, body, is_internal) VALUES ($1, $2, $3, $4)",
      [ticket.id, req.user.id, body, isInternal]
    );
    await pool.query("UPDATE tickets SET updated_at = NOW() WHERE id = $1", [ticket.id]);
    await pool.query(
      "INSERT INTO activity_log (ticket_id, actor_id, action, details) VALUES ($1, $2, 'comment_added', $3)",
      [ticket.id, req.user.id, JSON.stringify({ internal: isInternal })]
    );
    setFlash(req, "success", isInternal ? "Interne Notiz gespeichert." : "Antwort gespeichert.");
    res.redirect(`/tickets/${ticket.id}`);
  });

  return router;
}
