import express from "express";
import { requireAuth, requirePermission } from "../middleware.js";

function todayInputValue() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function asOfDate(value) {
  const input = /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")) ? String(value) : todayInputValue();
  const [year, month, day] = input.split("-").map(Number);
  const endOfDay = new Date(year, month - 1, day, 23, 59, 59, 999);
  if (endOfDay.getFullYear() !== year || endOfDay.getMonth() !== month - 1 || endOfDay.getDate() !== day) {
    return { input: todayInputValue(), date: new Date() };
  }
  return { input, date: endOfDay };
}

export function statisticsRouter({ pool, mapTileUrl }) {
  const router = express.Router();
  router.use(requireAuth);
  router.use(requirePermission("statistics.view"));

  router.get("/", async (req, res) => {
    const selected = asOfDate(req.query.at);
    const [customers, assignments, metrics] = await Promise.all([
      pool.query(
        `SELECT c.id, c.customer_number, c.name, c.address, c.city, c.latitude, c.longitude,
                COALESCE(a.asset_count, 0)::int AS asset_count,
                COALESCE(t.open_ticket_count, 0)::int AS open_ticket_count
         FROM customers c
         LEFT JOIN (SELECT customer_id, COUNT(*)::int AS asset_count FROM assets GROUP BY customer_id) a ON a.customer_id = c.id
         LEFT JOIN (
           SELECT customer_id, COUNT(*)::int AS open_ticket_count FROM tickets
           WHERE status <> 'resolved' AND status <> 'closed' GROUP BY customer_id
         ) t ON t.customer_id = c.id
         WHERE c.status <> 'inactive' ORDER BY c.name`
      ),
      pool.query(
        `SELECT h.*, a.asset_number, a.asset_type, a.name AS asset_name,
                c.name AS customer_name, u.name AS assigned_user_name
         FROM asset_assignment_history h
         JOIN assets a ON a.id = h.asset_id
         LEFT JOIN customers c ON c.id = h.customer_id
         LEFT JOIN users u ON u.id = h.assigned_user_id
         WHERE h.valid_from <= $1 AND (h.valid_until IS NULL OR h.valid_until > $1)
         ORDER BY c.name NULLS LAST, a.name ASC`,
        [selected.date]
      ),
      pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM customers WHERE status <> 'inactive') AS customers,
           (SELECT COUNT(*)::int FROM customers WHERE status <> 'inactive' AND latitude IS NOT NULL AND longitude IS NOT NULL) AS mapped_customers,
           (SELECT COUNT(*)::int FROM assets WHERE status <> 'retired' AND status <> 'lost') AS active_assets,
           (SELECT COUNT(*)::int FROM tickets WHERE status <> 'resolved' AND status <> 'closed') AS open_tickets`
      )
    ]);

    const customerLocations = customers.rows
      .filter((customer) => Number.isFinite(Number(customer.latitude)) && Number.isFinite(Number(customer.longitude)))
      .map((customer) => ({
        id: customer.id,
        number: customer.customer_number,
        name: customer.name,
        address: customer.address,
        city: customer.city,
        latitude: Number(customer.latitude),
        longitude: Number(customer.longitude),
        assets: Number(customer.asset_count),
        openTickets: Number(customer.open_ticket_count)
      }));

    res.render("statistics/index", {
      title: "Statistiken",
      customerLocations,
      assignments: assignments.rows,
      metrics: metrics.rows[0],
      selectedDate: selected.input,
      today: todayInputValue(),
      mapTileUrl
    });
  });

  return router;
}
