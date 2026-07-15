import express from "express";
import { requireAuth, requirePermission } from "../middleware.js";
import { setFlash } from "../security.js";
import { loadAssetTypes } from "../service-config.js";
import { hasPermission } from "../access-control.js";

export const assetStatuses = ["active", "stock", "repair", "retired", "lost"];

function positiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function sameOptionalId(left, right) {
  return (positiveInt(left) ?? null) === (positiveInt(right) ?? null);
}

async function formOptions(pool) {
  const [customers, contacts] = await Promise.all([
    pool.query("SELECT id, name, customer_number FROM customers WHERE status <> 'inactive' ORDER BY name"),
    pool.query(
      `SELECT u.id, u.name, u.email, cp.customer_id, c.name AS customer_name
       FROM customer_profiles cp JOIN users u ON u.id = cp.user_id JOIN customers c ON c.id = cp.customer_id
       WHERE u.active = TRUE ORDER BY c.name, u.name`
    )
  ]);
  return { customers: customers.rows, contacts: contacts.rows };
}

async function getAsset(pool, id, user) {
  const params = [id];
  let visibility = "";
  if (!hasPermission(user, "assets.manage")) {
    params.push(user.id);
    visibility = "AND a.assigned_user_id = $2";
  }
  const result = await pool.query(
    `SELECT a.*, c.name AS customer_name, c.customer_number, u.name AS assigned_user_name, u.email AS assigned_user_email
     FROM assets a LEFT JOIN customers c ON c.id = a.customer_id LEFT JOIN users u ON u.id = a.assigned_user_id
     WHERE a.id = $1 ${visibility}`,
    params
  );
  return result.rows[0] ?? null;
}

function assetPayload(body, assetTypes) {
  const attributes = {
    cpu: String(body.cpu ?? "").trim(),
    memory: String(body.memory ?? "").trim(),
    ip_address: String(body.ip_address ?? "").trim(),
    mac_address: String(body.mac_address ?? "").trim()
  };
  return {
    assetType: assetTypes.includes(body.asset_type) ? body.asset_type : assetTypes[0],
    name: String(body.name ?? "").trim(),
    status: assetStatuses.includes(body.status) ? body.status : "active",
    manufacturer: String(body.manufacturer ?? "").trim() || null,
    model: String(body.model ?? "").trim() || null,
    serialNumber: String(body.serial_number ?? "").trim() || null,
    operatingSystem: String(body.operating_system ?? "").trim() || null,
    location: String(body.location ?? "").trim() || null,
    customerId: positiveInt(body.customer_id),
    assignedUserId: positiveInt(body.assigned_user_id),
    purchaseDate: body.purchase_date || null,
    warrantyUntil: body.warranty_until || null,
    notes: String(body.notes ?? "").trim() || null,
    attributes
  };
}

async function normalizedAssignment(pool, customerId, assignedUserId) {
  if (!assignedUserId) return { customerId, assignedUserId: null };
  const profile = await pool.query("SELECT customer_id FROM customer_profiles WHERE user_id = $1", [assignedUserId]);
  if (!profile.rowCount) return { customerId, assignedUserId: null };
  const contactCustomerId = profile.rows[0].customer_id;
  if (customerId && customerId !== contactCustomerId) return { customerId, assignedUserId: null };
  return { customerId: contactCustomerId, assignedUserId };
}

export function assetsRouter({ pool }) {
  const router = express.Router();
  router.use(requireAuth);
  router.use(requirePermission("assets.view"));

  router.get("/", async (req, res) => {
    const { assetTypes } = await loadAssetTypes(pool);
    const clauses = [];
    const params = [];
    if (!hasPermission(req.user, "assets.manage")) {
      params.push(req.user.id);
      clauses.push(`a.assigned_user_id = $${params.length}`);
    }
    const query = String(req.query.q ?? "").trim();
    if (query) {
      params.push(`%${query}%`);
      clauses.push(`(a.asset_number ILIKE $${params.length} OR a.name ILIKE $${params.length} OR a.serial_number ILIKE $${params.length} OR c.name ILIKE $${params.length})`);
    }
    if (assetTypes.includes(req.query.type)) {
      params.push(req.query.type);
      clauses.push(`a.asset_type = $${params.length}`);
    }
    if (assetStatuses.includes(req.query.status)) {
      params.push(req.query.status);
      clauses.push(`a.status = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT a.*, c.name AS customer_name, u.name AS assigned_user_name,
              COALESCE(ta.ticket_count, 0)::int AS ticket_count
       FROM assets a LEFT JOIN customers c ON c.id = a.customer_id LEFT JOIN users u ON u.id = a.assigned_user_id
       LEFT JOIN (SELECT asset_id, COUNT(*)::int AS ticket_count FROM ticket_assets GROUP BY asset_id) ta ON ta.asset_id = a.id
       ${where}
       ORDER BY CASE a.status WHEN 'active' THEN 1 WHEN 'repair' THEN 2 WHEN 'stock' THEN 3 ELSE 4 END, a.name ASC`,
      params
    );
    res.render("assets/index", {
      title: "Ressourcen",
      assets: result.rows,
      assetTypes,
      assetStatuses,
      filters: { q: query, type: req.query.type ?? "", status: req.query.status ?? "" }
    });
  });

  router.get("/new", requirePermission("assets.manage"), async (_req, res) => {
    const [options, { assetTypes }] = await Promise.all([formOptions(pool), loadAssetTypes(pool)]);
    res.render("assets/form", { title: "Ressource anlegen", asset: null, ...options, assetTypes, assetStatuses, error: null, values: {} });
  });

  router.post("/", requirePermission("assets.manage"), async (req, res) => {
    const [options, { assetTypes }] = await Promise.all([formOptions(pool), loadAssetTypes(pool)]);
    const payload = assetPayload(req.body, assetTypes);
    if (payload.name.length < 2) {
      return res.status(422).render("assets/form", {
        title: "Ressource anlegen", asset: null, ...options, assetTypes, assetStatuses,
        error: "Bitte gib eine aussagekräftige Bezeichnung ein.", values: req.body
      });
    }
    const temporaryNumber = `TEMP-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const client = await pool.connect();
    let assetId;
    let assetNumber;
    try {
      await client.query("BEGIN");
      const assignment = await normalizedAssignment(client, payload.customerId, payload.assignedUserId);
      const result = await client.query(
        `INSERT INTO assets (asset_number, asset_type, name, status, manufacturer, model, serial_number,
         operating_system, location, customer_id, assigned_user_id, purchase_date, warranty_until, notes, attributes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
        [temporaryNumber, payload.assetType, payload.name, payload.status, payload.manufacturer, payload.model,
          payload.serialNumber, payload.operatingSystem, payload.location, assignment.customerId, assignment.assignedUserId,
          payload.purchaseDate, payload.warrantyUntil, payload.notes, JSON.stringify(payload.attributes)]
      );
      assetId = result.rows[0].id;
      assetNumber = `AST-${String(assetId).padStart(6, "0")}`;
      await client.query("UPDATE assets SET asset_number = $1 WHERE id = $2", [assetNumber, assetId]);
      await client.query(
        `INSERT INTO asset_assignment_history
         (asset_id, customer_id, assigned_user_id, location, asset_status, changed_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [assetId, assignment.customerId, assignment.assignedUserId, payload.location, payload.status, req.user.id]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    setFlash(req, "success", `${assetNumber} wurde angelegt.`);
    res.redirect(`/assets/${assetId}`);
  });

  router.get("/:id", async (req, res) => {
    const id = positiveInt(req.params.id);
    const asset = id ? await getAsset(pool, id, req.user) : null;
    if (!asset) return res.status(404).render("error", { title: "Ressource nicht gefunden", message: "Die Ressource existiert nicht oder ist nicht sichtbar." });

    const ticketParams = [asset.id];
    const ticketVisibility = [];
    if (!hasPermission(req.user, "tickets.view_all")) {
      if (hasPermission(req.user, "tickets.view_own")) {
        ticketParams.push(req.user.id);
        ticketVisibility.push(`t.requester_id = $${ticketParams.length}`);
      }
      const accessibleQueues = Object.keys(req.user.queuePermissions ?? {});
      if (accessibleQueues.length) {
        const placeholders = accessibleQueues.map((queueName) => {
          ticketParams.push(queueName);
          return `$${ticketParams.length}`;
        });
        ticketVisibility.push(`t.category IN (${placeholders.join(", ")})`);
      }
    }
    const visibilityClause = hasPermission(req.user, "tickets.view_all")
      ? "" : `AND (${ticketVisibility.length ? ticketVisibility.join(" OR ") : "FALSE"})`;
    const tickets = await pool.query(
      `SELECT t.*, requester.name AS requester_name, assignee.name AS assignee_name
       FROM ticket_assets ta JOIN tickets t ON t.id = ta.ticket_id
       JOIN users requester ON requester.id = t.requester_id LEFT JOIN users assignee ON assignee.id = t.assignee_id
       WHERE ta.asset_id = $1 ${visibilityClause} ORDER BY t.updated_at DESC`,
      ticketParams
    );
    const [options, { assetTypes }, history] = await Promise.all([
      !hasPermission(req.user, "assets.manage") ? Promise.resolve({ customers: [], contacts: [] }) : formOptions(pool),
      loadAssetTypes(pool, { includeInactive: true }),
      !hasPermission(req.user, "assets.manage") ? Promise.resolve({ rows: [] }) : pool.query(
        `SELECT h.*, c.name AS customer_name, u.name AS assigned_user_name, changer.name AS changed_by_name
         FROM asset_assignment_history h
         LEFT JOIN customers c ON c.id = h.customer_id
         LEFT JOIN users u ON u.id = h.assigned_user_id
         LEFT JOIN users changer ON changer.id = h.changed_by
         WHERE h.asset_id = $1 ORDER BY h.valid_from DESC`,
        [asset.id]
      )
    ]);
    res.render("assets/show", {
      title: asset.asset_number,
      asset,
      tickets: tickets.rows,
      assignmentHistory: history.rows,
      ...options,
      assetTypes,
      assetStatuses
    });
  });

  router.post("/:id/update", requirePermission("assets.manage"), async (req, res) => {
    const id = positiveInt(req.params.id);
    const asset = id ? await getAsset(pool, id, req.user) : null;
    if (!asset) return res.status(404).render("error", { title: "Ressource nicht gefunden", message: "Die Ressource existiert nicht." });
    const { assetTypes } = await loadAssetTypes(pool, { includeInactive: true });
    const payload = assetPayload(req.body, assetTypes);
    if (payload.name.length < 2) {
      setFlash(req, "error", "Bitte gib eine aussagekräftige Bezeichnung ein.");
      return res.redirect(`/assets/${asset.id}`);
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const assignment = await normalizedAssignment(client, payload.customerId, payload.assignedUserId);
      const assignmentChanged = !sameOptionalId(asset.customer_id, assignment.customerId)
        || !sameOptionalId(asset.assigned_user_id, assignment.assignedUserId)
        || (asset.location ?? null) !== payload.location
        || asset.status !== payload.status;

      await client.query(
        `UPDATE assets SET asset_type = $1, name = $2, status = $3, manufacturer = $4, model = $5,
         serial_number = $6, operating_system = $7, location = $8, customer_id = $9, assigned_user_id = $10,
         purchase_date = $11, warranty_until = $12, notes = $13, attributes = $14, updated_at = NOW() WHERE id = $15`,
        [payload.assetType, payload.name, payload.status, payload.manufacturer, payload.model, payload.serialNumber,
          payload.operatingSystem, payload.location, assignment.customerId, assignment.assignedUserId, payload.purchaseDate,
          payload.warrantyUntil, payload.notes, JSON.stringify(payload.attributes), asset.id]
      );

      if (assignmentChanged) {
        const effectiveAt = new Date();
        const openHistory = await client.query(
          "SELECT id FROM asset_assignment_history WHERE asset_id = $1 AND valid_until IS NULL ORDER BY valid_from DESC LIMIT 1",
          [asset.id]
        );
        if (openHistory.rowCount) {
          await client.query("UPDATE asset_assignment_history SET valid_until = $1 WHERE id = $2", [effectiveAt, openHistory.rows[0].id]);
        } else {
          await client.query(
            `INSERT INTO asset_assignment_history
             (asset_id, customer_id, assigned_user_id, location, asset_status, valid_from, valid_until)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [asset.id, asset.customer_id, asset.assigned_user_id, asset.location, asset.status, asset.created_at, effectiveAt]
          );
        }
        await client.query(
          `INSERT INTO asset_assignment_history
           (asset_id, customer_id, assigned_user_id, location, asset_status, valid_from, changed_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [asset.id, assignment.customerId, assignment.assignedUserId, payload.location, payload.status, effectiveAt, req.user.id]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    setFlash(req, "success", "Ressource wurde aktualisiert.");
    res.redirect(`/assets/${asset.id}`);
  });

  return router;
}
