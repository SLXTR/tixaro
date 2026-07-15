import express from "express";
import { requireAuth } from "../middleware.js";

export function portalRouter({ pool }) {
  const router = express.Router();

  router.get("/", requireAuth, async (req, res) => {
    if (req.user.role !== "requester") return res.redirect("/");

    const [statsResult, ticketsResult, assetsResult, profileResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS total,
                SUM(CASE WHEN status IN ('open', 'in_progress', 'waiting') THEN 1 ELSE 0 END)::int AS active,
                SUM(CASE WHEN status IN ('resolved', 'closed') THEN 1 ELSE 0 END)::int AS completed,
                SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END)::int AS waiting,
                (SELECT COUNT(*) FROM assets
                 WHERE assigned_user_id = $1 AND status NOT IN ('retired', 'lost'))::int AS assets
         FROM tickets WHERE requester_id = $1`,
        [req.user.id]
      ),
      pool.query(
        `SELECT t.*, assignee.name AS assignee_name
         FROM tickets t LEFT JOIN users assignee ON assignee.id = t.assignee_id
         WHERE t.requester_id = $1 ORDER BY t.updated_at DESC LIMIT 6`,
        [req.user.id]
      ),
      pool.query(
        `SELECT a.*, COALESCE(ta.ticket_count, 0)::int AS ticket_count
         FROM assets a
         LEFT JOIN (SELECT asset_id, COUNT(*)::int AS ticket_count FROM ticket_assets GROUP BY asset_id) ta ON ta.asset_id = a.id
         WHERE a.assigned_user_id = $1 AND a.status NOT IN ('retired', 'lost')
         ORDER BY CASE a.status WHEN 'repair' THEN 1 WHEN 'active' THEN 2 ELSE 3 END, a.name LIMIT 6`,
        [req.user.id]
      ),
      pool.query(
        `SELECT cp.job_title, cp.department, cp.phone, cp.site,
                c.name AS customer_name, c.customer_number, c.email AS customer_email, c.phone AS customer_phone
         FROM customer_profiles cp JOIN customers c ON c.id = cp.customer_id
         WHERE cp.user_id = $1`,
        [req.user.id]
      )
    ]);

    const stats = Object.fromEntries(Object.entries(statsResult.rows[0] ?? {}).map(([key, value]) => [key, Number(value ?? 0)]));
    res.render("portal/index", {
      title: "Mein Portal",
      stats,
      tickets: ticketsResult.rows,
      assets: assetsResult.rows,
      profile: profileResult.rows[0] ?? null
    });
  });

  return router;
}
