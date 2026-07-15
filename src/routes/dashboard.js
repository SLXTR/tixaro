import express from "express";
import { requireAuth, requirePermission } from "../middleware.js";
import { hasPermission } from "../access-control.js";

export function dashboardRouter({ pool }) {
  const router = express.Router();

  router.get("/", requireAuth, requirePermission("dashboard.view"), async (req, res) => {
    if (req.user.role === "requester") return res.redirect("/portal");
    const params = [];
    const visibility = [];
    if (!hasPermission(req.user, "tickets.view_all")) {
      if (hasPermission(req.user, "tickets.view_own")) {
        params.push(req.user.id);
        visibility.push(`t.requester_id = $${params.length}`);
      }
      const queueNames = Object.keys(req.user.queuePermissions ?? {});
      if (queueNames.length) {
        const placeholders = queueNames.map((name) => {
          params.push(name);
          return `$${params.length}`;
        });
        visibility.push(`t.category IN (${placeholders.join(", ")})`);
      }
    }
    const where = hasPermission(req.user, "tickets.view_all") ? "" : `WHERE ${visibility.length ? visibility.join(" OR ") : "FALSE"}`;

    const [statsResult, recentResult, queueResult, workspaceResult] = await Promise.all([
      pool.query(
        `SELECT
          COUNT(*)::int AS total,
          SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END)::int AS open,
          SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END)::int AS in_progress,
          SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END)::int AS waiting,
          SUM(CASE WHEN status IN ('resolved', 'closed') THEN 1 ELSE 0 END)::int AS completed,
          SUM(CASE WHEN priority = 'urgent' AND status NOT IN ('resolved', 'closed') THEN 1 ELSE 0 END)::int AS urgent,
          SUM(CASE WHEN status NOT IN ('waiting', 'resolved', 'closed') AND (
            (first_response_at IS NULL AND response_due_at < NOW()) OR resolution_due_at < NOW()
          ) THEN 1 ELSE 0 END)::int AS escalated
         FROM tickets t ${where}`,
        params
      ),
      pool.query(
        `SELECT t.*, requester.name AS requester_name, assignee.name AS assignee_name
         FROM tickets t
         JOIN users requester ON requester.id = t.requester_id
         LEFT JOIN users assignee ON assignee.id = t.assignee_id
         ${where}
         ORDER BY t.updated_at DESC LIMIT 8`,
        params
      ),
      pool.query(
        `SELECT category AS queue,
          COUNT(*)::int AS total,
          SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END)::int AS new_count,
          SUM(CASE WHEN status IN ('in_progress', 'waiting') THEN 1 ELSE 0 END)::int AS active_count
         FROM tickets t ${where}
         GROUP BY category ORDER BY total DESC, category ASC LIMIT 6`,
        params
      ),
      !hasPermission(req.user, "assets.manage")
        ? pool.query(
            `SELECT 0::int AS customers,
                    COUNT(*)::int AS assets,
                    SUM(CASE WHEN status = 'repair' THEN 1 ELSE 0 END)::int AS assets_in_repair
             FROM assets WHERE assigned_user_id = $1`,
            [req.user.id]
          )
        : pool.query(
            `SELECT (SELECT COUNT(*) FROM customers WHERE status = 'active')::int AS customers,
                    COUNT(*)::int AS assets,
                    SUM(CASE WHEN status = 'repair' THEN 1 ELSE 0 END)::int AS assets_in_repair
             FROM assets`
          )
    ]);

    const raw = statsResult.rows[0];
    const stats = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Number(value ?? 0)]));
    Object.assign(stats, Object.fromEntries(Object.entries(workspaceResult.rows[0]).map(([key, value]) => [key, Number(value ?? 0)])));
    res.render("dashboard", { title: "Übersicht", stats, tickets: recentResult.rows, queues: queueResult.rows });
  });

  return router;
}
