import bcrypt from "bcryptjs";
import express from "express";
import { requirePermission } from "../middleware.js";
import { setFlash } from "../security.js";
import { backfillCustomerUsers } from "../customer-assignment.js";
import { assignSystemRoleForLegacyRole } from "../access-control.js";
import { searchAddresses } from "../address-search.js";
import { createCustomerNumber } from "../number-formats.js";
import { userNamesFromBody, validUserNames } from "../user-names.js";

const customerStatuses = ["active", "prospect", "inactive"];

function positiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function customerList(pool) {
  return pool.query(
    `SELECT c.*, COALESCE(cp.contact_count, 0)::int AS contact_count,
            COALESCE(a.asset_count, 0)::int AS asset_count,
            COALESCE(t.ticket_count, 0)::int AS ticket_count
     FROM customers c
     LEFT JOIN (SELECT customer_id, COUNT(*)::int AS contact_count FROM customer_profiles GROUP BY customer_id) cp ON cp.customer_id = c.id
     LEFT JOIN (SELECT customer_id, COUNT(*)::int AS asset_count FROM assets GROUP BY customer_id) a ON a.customer_id = c.id
     LEFT JOIN (SELECT customer_id, COUNT(*)::int AS ticket_count FROM tickets GROUP BY customer_id) t ON t.customer_id = c.id
     ORDER BY CASE c.status WHEN 'active' THEN 1 WHEN 'prospect' THEN 2 ELSE 3 END, c.name ASC`
  );
}

async function getCustomer(pool, id) {
  const result = await pool.query("SELECT * FROM customers WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

function coordinate(value, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

async function locationFromForm(body, addressSearchUrl) {
  const address = String(body.address ?? "").trim();
  const city = String(body.city ?? "").trim();
  let latitude = coordinate(body.latitude, -90, 90);
  let longitude = coordinate(body.longitude, -180, 180);

  if (address && (latitude === null || longitude === null)) {
    try {
      const [suggestion] = await searchAddresses([address, city].filter(Boolean).join(", "), { baseUrl: addressSearchUrl });
      latitude = suggestion?.latitude ?? null;
      longitude = suggestion?.longitude ?? null;
    } catch {
      // Die Stammdaten bleiben auch bei einem vorübergehend nicht erreichbaren Kartendienst speicherbar.
    }
  }
  return { address: address || null, city: city || null, latitude, longitude };
}

function customerMap(customer) {
  const latitude = coordinate(customer.latitude, -90, 90);
  const longitude = coordinate(customer.longitude, -180, 180);
  if (latitude === null || longitude === null) return { mapEmbedUrl: null, mapExternalUrl: null };
  const delta = 0.008;
  const bbox = [longitude - delta, latitude - delta, longitude + delta, latitude + delta].join(",");
  return {
    mapEmbedUrl: `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${encodeURIComponent(`${latitude},${longitude}`)}`,
    mapExternalUrl: `https://www.openstreetmap.org/?mlat=${encodeURIComponent(latitude)}&mlon=${encodeURIComponent(longitude)}#map=16/${latitude}/${longitude}`
  };
}

export function customersRouter({ pool, addressSearchUrl = "https://photon.komoot.io/api/" }) {
  const router = express.Router();
  router.use(requirePermission("customers.view"));

  router.get("/", async (_req, res) => {
    const result = await customerList(pool);
    res.render("customers/index", { title: "Kunden", customers: result.rows, error: null, values: {}, customerStatuses });
  });

  router.post("/", requirePermission("customers.manage"), async (req, res) => {
    const name = String(req.body.name ?? "").trim();
    const email = String(req.body.email ?? "").trim().toLowerCase();
    const phone = String(req.body.phone ?? "").trim();
    const industry = String(req.body.industry ?? "").trim();
    const status = customerStatuses.includes(req.body.status) ? req.body.status : "active";
    const location = await locationFromForm(req.body, addressSearchUrl);

    if (name.length < 2) {
      const result = await customerList(pool);
      return res.status(422).render("customers/index", {
        title: "Kunden",
        customers: result.rows,
        error: "Bitte gib einen Firmennamen mit mindestens zwei Zeichen ein.",
        values: req.body,
        customerStatuses
      });
    }

    const temporaryNumber = `TEMP-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const client = await pool.connect();
    let customerId;
    let assignedCount = 0;
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `INSERT INTO customers (customer_number, name, industry, email, phone, address, city, latitude, longitude, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [temporaryNumber, name, industry || null, email || null, phone || null, location.address, location.city,
          location.latitude, location.longitude, status]
      );
      customerId = result.rows[0].id;
      const customerNumber = await createCustomerNumber(client, customerId);
      await client.query("UPDATE customers SET customer_number = $1 WHERE id = $2", [customerNumber, customerId]);
      assignedCount = await backfillCustomerUsers(client, { customerId });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    setFlash(req, "success", assignedCount ? `${name} wurde angelegt und ${assignedCount} Kundenbenutzer automatisch zugeordnet.` : `${name} wurde als Kunde angelegt.`);
    res.redirect(`/customers/${customerId}`);
  });

  router.get("/address-search", requirePermission("customers.manage"), async (req, res) => {
    const query = String(req.query.q ?? "").trim();
    if (query.length < 3) return res.json({ suggestions: [] });
    try {
      const suggestions = await searchAddresses(query, { baseUrl: addressSearchUrl });
      return res.json({ suggestions });
    } catch {
      return res.status(503).json({ suggestions: [], unavailable: true });
    }
  });

  router.get("/:id", async (req, res) => {
    const id = positiveInt(req.params.id);
    const customer = id ? await getCustomer(pool, id) : null;
    if (!customer) return res.status(404).render("error", { title: "Kunde nicht gefunden", message: "Der Kundeneintrag existiert nicht." });

    const [contacts, assets, tickets] = await Promise.all([
      pool.query(
        `SELECT u.id, u.name, u.email, u.active, u.last_login_at, cp.job_title, cp.department, cp.phone, cp.site,
                COALESCE(t.ticket_count, 0)::int AS ticket_count, COALESCE(a.asset_count, 0)::int AS asset_count
         FROM customer_profiles cp
         JOIN users u ON u.id = cp.user_id
         LEFT JOIN (SELECT requester_id, COUNT(*)::int AS ticket_count FROM tickets GROUP BY requester_id) t ON t.requester_id = u.id
         LEFT JOIN (SELECT assigned_user_id, COUNT(*)::int AS asset_count FROM assets GROUP BY assigned_user_id) a ON a.assigned_user_id = u.id
         WHERE cp.customer_id = $1
         ORDER BY u.active DESC, u.name ASC`,
        [customer.id]
      ),
      pool.query(
        `SELECT a.*, u.name AS assigned_user_name
         FROM assets a LEFT JOIN users u ON u.id = a.assigned_user_id
         WHERE a.customer_id = $1 ORDER BY a.status = 'active' DESC, a.name ASC`,
        [customer.id]
      ),
      pool.query(
        `SELECT t.*, requester.name AS requester_name, assignee.name AS assignee_name
         FROM tickets t JOIN users requester ON requester.id = t.requester_id
         LEFT JOIN users assignee ON assignee.id = t.assignee_id
         WHERE t.customer_id = $1 ORDER BY t.updated_at DESC LIMIT 20`,
        [customer.id]
      )
    ]);

    res.render("customers/show", {
      title: customer.name,
      customer,
      contacts: contacts.rows,
      assets: assets.rows,
      tickets: tickets.rows,
      customerStatuses,
      contactError: null,
      contactValues: {},
      ...customerMap(customer)
    });
  });

  router.post("/:id/update", requirePermission("customers.manage"), async (req, res) => {
    const id = positiveInt(req.params.id);
    const customer = id ? await getCustomer(pool, id) : null;
    if (!customer) return res.status(404).render("error", { title: "Kunde nicht gefunden", message: "Der Kundeneintrag existiert nicht." });

    const name = String(req.body.name ?? "").trim();
    if (name.length < 2) {
      setFlash(req, "error", "Der Firmenname muss mindestens zwei Zeichen enthalten.");
      return res.redirect(`/customers/${customer.id}`);
    }
    const status = customerStatuses.includes(req.body.status) ? req.body.status : customer.status;
    const location = await locationFromForm(req.body, addressSearchUrl);
    const client = await pool.connect();
    let assignedCount = 0;
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE customers SET name = $1, industry = $2, email = $3, phone = $4, website = $5,
         address = $6, city = $7, latitude = $8, longitude = $9, notes = $10, status = $11,
         updated_at = NOW() WHERE id = $12`,
        [
          name,
          String(req.body.industry ?? "").trim() || null,
          String(req.body.email ?? "").trim().toLowerCase() || null,
          String(req.body.phone ?? "").trim() || null,
          String(req.body.website ?? "").trim() || null,
          location.address,
          location.city,
          location.latitude,
          location.longitude,
          String(req.body.notes ?? "").trim() || null,
          status,
          customer.id
        ]
      );
      assignedCount = await backfillCustomerUsers(client, { customerId: customer.id });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    setFlash(req, "success", assignedCount ? `Kundendaten wurden aktualisiert und ${assignedCount} Benutzer zugeordnet.` : "Kundendaten wurden aktualisiert.");
    res.redirect(`/customers/${customer.id}`);
  });

  router.post("/:id/contacts", requirePermission("customers.manage"), async (req, res) => {
    const id = positiveInt(req.params.id);
    const customer = id ? await getCustomer(pool, id) : null;
    if (!customer) return res.status(404).render("error", { title: "Kunde nicht gefunden", message: "Der Kundeneintrag existiert nicht." });

    const { firstName, lastName, name } = userNamesFromBody(req.body);
    const email = String(req.body.email ?? "").trim().toLowerCase();
    const password = String(req.body.password ?? "");
    if (!validUserNames(firstName, lastName) || !email.includes("@") || password.length < 10) {
      setFlash(req, "error", "Vorname, Nachname, gültige E-Mail-Adresse und ein Startpasswort mit mindestens 10 Zeichen sind erforderlich.");
      return res.redirect(`/customers/${customer.id}#contacts`);
    }
    const duplicate = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (duplicate.rowCount) {
      setFlash(req, "error", "Diese E-Mail-Adresse wird bereits verwendet.");
      return res.redirect(`/customers/${customer.id}#contacts`);
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const user = await client.query(
        "INSERT INTO users (first_name, last_name, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5, 'requester') RETURNING id",
        [firstName, lastName, name, email, passwordHash]
      );
      await assignSystemRoleForLegacyRole(client, user.rows[0].id, "requester");
      await client.query(
        `INSERT INTO customer_profiles (user_id, customer_id, job_title, department, phone, site)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          user.rows[0].id,
          customer.id,
          String(req.body.job_title ?? "").trim() || null,
          String(req.body.department ?? "").trim() || null,
          String(req.body.phone ?? "").trim() || null,
          String(req.body.site ?? "").trim() || null
        ]
      );
      await client.query("COMMIT");
      setFlash(req, "success", `${name} wurde als Kundenbenutzer angelegt.`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    res.redirect(`/customers/${customer.id}#contacts`);
  });

  return router;
}
