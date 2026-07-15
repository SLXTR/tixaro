import express from "express";
import { requireAuth } from "../middleware.js";

export function dashboardRouter({ pool }) {
  const router = express.Router();

  router.get("/", requireAuth, async (req, res) => {
    const ownOnly = req.user.role === "requester";
    const where = ownOnly ? "WHERE t.requester_id = $1" : "";
    const params = ownOnly ? [req.user.id] : [];

    const [statsResult, recentResult, workloadResult] = await Promise.all([
      pool.query(
        `SELECT
          COUNT(*)::int AS total,
          SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END)::int AS open,
          SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END)::int AS in_progress,
          SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END)::int AS waiting,
          SUM(CASE WHEN status IN ('resolved', 'closed') THEN 1 ELSE 0 END)::int AS completed,
          SUM(CASE WHEN priority = 'urgent' AND status NOT IN ('resolved', 'closed') THEN 1 ELSE 0 END)::int AS urgent
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
      ownOnly
        ? Promise.resolve({ rows: [] })
        : pool.query(
            `SELECT u.id, u.name, COUNT(t.id)::int AS ticket_count
             FROM users u
             LEFT JOIN tickets t ON t.assignee_id = u.id AND t.status NOT IN ('resolved', 'closed')
             WHERE u.active = TRUE AND u.role IN ('admin', 'agent')
             GROUP BY u.id, u.name ORDER BY ticket_count DESC, u.name ASC LIMIT 6`
          )
    ]);

    const raw = statsResult.rows[0];
    const stats = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Number(value ?? 0)]));
    res.render("dashboard", { title: "Dashboard", stats, tickets: recentResult.rows, workload: workloadResult.rows });
  });

  return router;
}
