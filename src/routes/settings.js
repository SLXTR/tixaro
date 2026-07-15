import express from "express";
import { requireAuth, requirePermission } from "../middleware.js";
import { setFlash } from "../security.js";
import { loadAssetTypes, loadTicketConfiguration } from "../service-config.js";
import { hasPermission } from "../access-control.js";
import {
  defaultAppearance, loadAppearance, loadBrandLogo, resetAppearance, resetBrandLogo, resetBrandName,
  saveAppearance, saveBrandLogo, saveBrandName
} from "../appearance.js";
import { encryptSecret } from "../secret-store.js";
import { pollMailChannel, testMailChannel } from "../mail-service.js";
import { loadNumberFormats, numberFormatOptions, saveNumberFormats } from "../number-formats.js";
import { templateVariables } from "../template-engine.js";
import { checkForUpdate, installUpdate, updateOverview } from "../system-update.js";

const sections = ["overview", "queues", "ticket-types", "sla", "numbers", "templates", "asset-types", "mail", "roles", "groups", "appearance", "updates"];
const templateTypes = Object.freeze({ reply: "Antwort", signature: "Signatur", auto_reply: "Automatische Antwort" });

const sectionMeta = {
  overview: { group: "Admin-Center", title: "Admin-Center", description: "Wähle den Bereich, den du verwalten möchtest." },
  queues: { group: "Ticket-System", title: "Queues", description: "Arbeitsbereiche, Hierarchien und Standard-SLAs verwalten.", action: "Queue anlegen" },
  "ticket-types": { group: "Ticket-System", title: "Tickettypen", description: "Vorgänge einheitlich klassifizieren und sortieren.", action: "Tickettyp anlegen" },
  sla: { group: "Ticket-System", title: "SLA-Zeiten", description: "Ziele für Erstreaktion und vollständige Lösung definieren.", action: "SLA anlegen" },
  numbers: { group: "Ticket-System", title: "Nummernkreise", description: "Aufbau neuer Ticket- und Kundennummern festlegen." },
  templates: { group: "Kommunikation", title: "Textvorlagen", description: "Antworten, Signaturen und automatische Antworttexte mit Variablen verwalten.", action: "Vorlage anlegen" },
  "asset-types": { group: "Stammdaten", title: "Ressourcenarten", description: "Inventarklassen für Geräte, Lizenzen und Arbeitsplätze verwalten.", action: "Ressourcenart anlegen" },
  mail: { group: "Kommunikation", title: "E-Mail-Konten", description: "Postfächer für Ticketimport und Antworten per SMTP, IMAP, POP3 oder Microsoft Graph verwalten.", action: "Mailkonto anlegen" },
  roles: { group: "Rechte & System", title: "Rollen & Rechte", description: "Berechtigungsprofile erstellen und Benutzern direkt zuweisen.", action: "Rolle anlegen" },
  groups: { group: "Rechte & System", title: "Gruppen", description: "Teams, Gruppenrollen und Queue-Zugriffe zentral steuern.", action: "Gruppe anlegen" },
  appearance: { group: "Rechte & System", title: "Erscheinungsbild", description: "Firmenname, Logo und Farben an die eigene Marke anpassen." },
  updates: { group: "Rechte & System", title: "Systemupdate", description: "Tixaro sicher aus dem verbundenen GitHub-Repository aktualisieren." }
};

const sectionPermissions = {
  queues: "settings.manage", "ticket-types": "settings.manage", sla: "settings.manage", numbers: "settings.manage", templates: "settings.manage", "asset-types": "settings.manage",
  mail: "settings.manage", roles: "roles.manage", groups: "groups.manage", appearance: "appearance.manage", updates: "settings.manage"
};

function positiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeInt(value, fallback = 100) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function mailPort(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function mailChannelValues(body, config, existing = {}) {
  const connectionMode = ["graph", "imap_smtp", "pop3_smtp", "smtp_only", "custom"].includes(body.connection_mode)
    ? body.connection_mode : "custom";
  let inboundType = ["none", "imap", "pop3", "graph"].includes(body.inbound_type) ? body.inbound_type : "none";
  let outboundType = ["none", "smtp", "graph"].includes(body.outbound_type) ? body.outbound_type : "none";
  if (connectionMode === "graph") [inboundType, outboundType] = ["graph", "graph"];
  if (connectionMode === "imap_smtp") [inboundType, outboundType] = ["imap", "smtp"];
  if (connectionMode === "pop3_smtp") [inboundType, outboundType] = ["pop3", "smtp"];
  if (connectionMode === "smtp_only") [inboundType, outboundType] = ["none", "smtp"];
  const inboundSecure = body.inbound_secure === "on";
  const outboundSecure = body.outbound_secure === "on";
  const sharedPassword = String(body.mail_password ?? "");
  const inboundPassword = String(body.inbound_password ?? "") || sharedPassword;
  const outboundPassword = String(body.outbound_password ?? "") || sharedPassword;
  const graphClientSecret = String(body.graph_client_secret ?? "");
  const emailAddress = String(body.email_address ?? "").trim().toLowerCase().slice(0, 255);
  return {
    name: String(body.name ?? "").trim().slice(0, 120),
    emailAddress,
    queueId: positiveInt(body.queue_id),
    inboundType,
    outboundType,
    inboundHost: String(body.inbound_host ?? "").trim().slice(0, 255) || null,
    inboundPort: inboundType === "none" || inboundType === "graph" ? null : mailPort(body.inbound_port, inboundSecure ? (inboundType === "imap" ? 993 : 995) : (inboundType === "imap" ? 143 : 110)),
    inboundSecure,
    inboundUsername: String(body.inbound_username ?? "").trim().slice(0, 255) || (inboundType !== "none" && inboundType !== "graph" ? emailAddress : null),
    inboundSecret: inboundPassword ? encryptSecret(inboundPassword, config.mailSecretKey) : existing.inbound_secret ?? null,
    outboundHost: String(body.outbound_host ?? "").trim().slice(0, 255) || null,
    outboundPort: outboundType === "smtp" ? mailPort(body.outbound_port, outboundSecure ? 465 : 587) : null,
    outboundSecure,
    outboundUsername: String(body.outbound_username ?? "").trim().slice(0, 255) || (outboundType === "smtp" ? emailAddress : null),
    outboundSecret: outboundPassword ? encryptSecret(outboundPassword, config.mailSecretKey) : existing.outbound_secret ?? null,
    graphTenantId: String(body.graph_tenant_id ?? "").trim().slice(0, 120) || null,
    graphClientId: String(body.graph_client_id ?? "").trim().slice(0, 120) || null,
    graphClientSecret: graphClientSecret ? encryptSecret(graphClientSecret, config.mailSecretKey) : existing.graph_client_secret ?? null,
    graphMailbox: String(body.graph_mailbox ?? "").trim().toLowerCase().slice(0, 255) || (inboundType === "graph" || outboundType === "graph" ? emailAddress : null),
    pollIntervalMinutes: Math.min(1440, Math.max(1, positiveInt(body.poll_interval_minutes) ?? 5)),
    active: body.active === "on"
  };
}

async function mailChannelError(pool, values, excludedId = null) {
  if (values.name.length < 2 || !values.emailAddress.includes("@")) return "Name und gültige E-Mail-Adresse sind erforderlich.";
  if (await isDuplicate(pool, "mail_channels", values.name, excludedId)) return "Ein Mailkonto mit diesem Namen existiert bereits.";
  if (values.queueId && !(await pool.query("SELECT id FROM ticket_queues WHERE id = $1", [values.queueId])).rowCount) return "Die ausgewählte Queue existiert nicht.";
  if (["imap", "pop3"].includes(values.inboundType) && (!values.inboundHost || !values.inboundUsername || !values.inboundSecret)) return "Für IMAP oder POP3 werden Server, Benutzername und Passwort benötigt.";
  if (values.outboundType === "smtp" && (!values.outboundHost || !values.outboundUsername || !values.outboundSecret)) return "Für SMTP werden Server, Benutzername und Passwort benötigt.";
  if ((values.inboundType === "graph" || values.outboundType === "graph") && (!values.graphTenantId || !values.graphClientId || !values.graphClientSecret || !values.graphMailbox)) return "Für Microsoft Graph werden Tenant-ID, Client-ID, Client-Secret und Shared Mailbox benötigt.";
  if (values.inboundType === "none" && values.outboundType === "none") return "Aktiviere mindestens einen Ein- oder Ausgangskanal.";
  return null;
}

function redirectTo(res, section) {
  res.redirect(`/settings?section=${section}`);
}

function values(value) {
  if (Array.isArray(value)) return value.map(String);
  return value === undefined ? [] : [String(value)];
}

function slug(value) {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "rolle";
}

function denied(res) {
  return res.status(403).render("error", { title: "Kein Zugriff", message: "Du hast für diesen Administrationsbereich keine Berechtigung." });
}

async function isDuplicate(pool, table, name, excludedId = null) {
  const params = [name];
  let excluded = "";
  if (excludedId) {
    params.push(excludedId);
    excluded = "AND id <> $2";
  }
  const result = await pool.query(`SELECT id FROM ${table} WHERE LOWER(name) = LOWER($1) ${excluded}`, params);
  return result.rowCount > 0;
}

async function validQueueParent(pool, parentId, queueId = null) {
  if (!parentId) return true;
  const result = await pool.query("SELECT id, parent_id FROM ticket_queues");
  const parents = new Map(result.rows.map((row) => [Number(row.id), row.parent_id ? Number(row.parent_id) : null]));
  if (!parents.has(parentId)) return false;
  const visited = new Set();
  let current = parentId;
  while (current) {
    if (current === queueId || visited.has(current)) return false;
    visited.add(current);
    current = parents.get(current) ?? null;
  }
  return true;
}

async function validSlaCode(pool, code) {
  if (!code) return true;
  return (await pool.query("SELECT id FROM sla_policies WHERE code = $1", [code])).rowCount > 0;
}

async function toggleOption(pool, table, id) {
  const current = await pool.query(`SELECT id, active FROM ${table} WHERE id = $1`, [id]);
  if (!current.rowCount) return { found: false };
  if (current.rows[0].active) {
    const active = await pool.query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE active = TRUE`);
    if (Number(active.rows[0].count) <= 1) return { found: true, prevented: true };
  }
  await pool.query(`UPDATE ${table} SET active = NOT active, updated_at = NOW() WHERE id = $1`, [id]);
  return { found: true, prevented: false };
}

async function uniqueSlaCode(pool, name) {
  const base = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "sla";
  let code = base;
  let suffix = 2;
  while ((await pool.query("SELECT id FROM sla_policies WHERE code = $1", [code])).rowCount) {
    code = `${base.slice(0, 20)}-${suffix}`;
    suffix += 1;
  }
  return code;
}

export function settingsRouter({ pool, config }) {
  const router = express.Router();
  router.use(requireAuth);

  router.use((req, res, next) => {
    if (req.method !== "POST") return next();
    const permission = req.path.startsWith("/roles") ? "roles.manage"
      : req.path.startsWith("/groups") ? "groups.manage"
        : req.path.startsWith("/appearance") ? "appearance.manage" : "settings.manage";
    return requirePermission(permission)(req, res, next);
  });

  router.get("/", async (req, res) => {
    const section = sections.includes(req.query.section) ? req.query.section : "overview";
    const requestedPermission = sectionPermissions[section];
    const adminPermissions = ["settings.manage", "roles.manage", "groups.manage", "appearance.manage"];
    if ((requestedPermission && !hasPermission(req.user, requestedPermission)) || (section === "overview" && !adminPermissions.some((permission) => hasPermission(req.user, permission)))) return denied(res);
    const query = String(req.query.q ?? "").trim().slice(0, 80);
    const [ticketConfig, queues, ticketTypes, slaPolicies, assetTypes, rolesResult, permissionsResult, groupsResult, userRecords, rolePermissions, roleUsers, groupMembers, groupRoles, groupQueues, appearance, brandLogo, mailChannelsResult, mailEventsResult, numberFormats, responseTemplates, updateState] = await Promise.all([
      loadTicketConfiguration(pool, { includeInactive: true }),
      pool.query(
        `SELECT q.*, parent.name AS parent_name, COALESCE(t.ticket_count, 0)::int AS ticket_count,
                COALESCE(children.child_count, 0)::int AS child_count
         FROM ticket_queues q
         LEFT JOIN ticket_queues parent ON parent.id = q.parent_id
         LEFT JOIN (SELECT category, COUNT(*)::int AS ticket_count FROM tickets GROUP BY category) t ON t.category = q.name
         LEFT JOIN (SELECT parent_id, COUNT(*)::int AS child_count FROM ticket_queues GROUP BY parent_id) children ON children.parent_id = q.id
         ORDER BY q.sort_order, q.name`
      ),
      pool.query(
        `SELECT o.*, COALESCE(t.ticket_count, 0)::int AS usage_count
         FROM ticket_type_options o
         LEFT JOIN (SELECT ticket_type, COUNT(*)::int AS ticket_count FROM tickets GROUP BY ticket_type) t ON t.ticket_type = o.name
         ORDER BY o.sort_order, o.name`
      ),
      pool.query(
        `SELECT s.*, COALESCE(t.ticket_count, 0)::int AS usage_count, COALESCE(q.queue_count, 0)::int AS queue_count
         FROM sla_policies s
         LEFT JOIN (SELECT sla, COUNT(*)::int AS ticket_count FROM tickets GROUP BY sla) t ON t.sla = s.code
         LEFT JOIN (SELECT default_sla_code, COUNT(*)::int AS queue_count FROM ticket_queues GROUP BY default_sla_code) q ON q.default_sla_code = s.code
         ORDER BY s.sort_order, s.name`
      ),
      pool.query(
        `SELECT o.*, COALESCE(a.asset_count, 0)::int AS usage_count
         FROM asset_type_options o
         LEFT JOIN (SELECT asset_type, COUNT(*)::int AS asset_count FROM assets GROUP BY asset_type) a ON a.asset_type = o.name
         ORDER BY o.sort_order, o.name`
      ),
      pool.query("SELECT * FROM access_roles ORDER BY system_role DESC, name"),
      pool.query("SELECT * FROM permission_definitions ORDER BY category, sort_order, name"),
      pool.query("SELECT * FROM access_groups ORDER BY active DESC, name"),
      pool.query("SELECT id, name, email, role, active FROM users ORDER BY active DESC, name"),
      pool.query("SELECT role_id, permission_code FROM role_permissions"),
      pool.query("SELECT role_id, user_id FROM user_access_roles"),
      pool.query("SELECT group_id, user_id FROM group_members"),
      pool.query("SELECT group_id, role_id FROM group_access_roles"),
      pool.query("SELECT group_id, queue_id, permission_level FROM group_queue_permissions"),
      loadAppearance(pool),
      loadBrandLogo(pool),
      pool.query(
        `SELECT m.*, q.name AS queue_name,
                COALESCE(e.inbound_count, 0)::int AS inbound_count,
                COALESCE(e.outbound_count, 0)::int AS outbound_count
         FROM mail_channels m LEFT JOIN ticket_queues q ON q.id = m.queue_id
         LEFT JOIN (
           SELECT channel_id,
             SUM(CASE WHEN direction = 'inbound' AND status = 'imported' THEN 1 ELSE 0 END)::int AS inbound_count,
             SUM(CASE WHEN direction = 'outbound' AND status = 'sent' THEN 1 ELSE 0 END)::int AS outbound_count
           FROM mail_events GROUP BY channel_id
         ) e ON e.channel_id = m.id
         ORDER BY m.active DESC, m.name`
      ),
      pool.query(
        `SELECT e.*, m.name AS channel_name, t.ticket_number
         FROM mail_events e JOIN mail_channels m ON m.id = e.channel_id
         LEFT JOIN tickets t ON t.id = e.ticket_id
         ORDER BY e.created_at DESC LIMIT 30`
      ),
      loadNumberFormats(pool),
      pool.query("SELECT * FROM response_templates ORDER BY active DESC, sort_order, name"),
      section === "updates" ? updateOverview(config) : Promise.resolve(null)
    ]);

    const roles = rolesResult.rows.map((role) => ({
      ...role,
      permissionCodes: rolePermissions.rows.filter((item) => item.role_id === role.id).map((item) => item.permission_code),
      userIds: roleUsers.rows.filter((item) => item.role_id === role.id).map((item) => item.user_id),
      groupCount: groupRoles.rows.filter((item) => item.role_id === role.id).length
    }));
    const groups = groupsResult.rows.map((group) => ({
      ...group,
      userIds: groupMembers.rows.filter((item) => item.group_id === group.id).map((item) => item.user_id),
      roleIds: groupRoles.rows.filter((item) => item.group_id === group.id).map((item) => item.role_id),
      queuePermissions: Object.fromEntries(groupQueues.rows.filter((item) => item.group_id === group.id).map((item) => [item.queue_id, item.permission_level]))
    }));

    const adminModules = [
      { group: "Ticket-System", title: "Queues", description: "Arbeitsbereiche und Zuständigkeiten", href: "/settings?section=queues", permission: "settings.manage" },
      { group: "Ticket-System", title: "Tickettypen", description: "Arten von Anfragen und Vorgängen", href: "/settings?section=ticket-types", permission: "settings.manage" },
      { group: "Ticket-System", title: "SLA-Zeiten", description: "Reaktions- und Lösungszeiten", href: "/settings?section=sla", permission: "settings.manage" },
      { group: "Ticket-System", title: "Nummernkreise", description: "Ticket- und Kundennummern", href: "/settings?section=numbers", permission: "settings.manage" },
      { group: "Kommunikation", title: "E-Mail", description: "Postfächer verbinden und verwalten", href: "/settings?section=mail", permission: "settings.manage" },
      { group: "Kommunikation", title: "Textvorlagen", description: "Antworten, Signaturen und Variablen", href: "/settings?section=templates", permission: "settings.manage" },
      { group: "Benutzer & Kunden", title: "Benutzer", description: "Konten und Portalzugänge", href: "/users", permission: "users.manage" },
      { group: "Benutzer & Kunden", title: "Kunden", description: "Unternehmen und Ansprechpartner", href: "/customers", permission: "customers.view" },
      { group: "Benutzer & Kunden", title: "Ressourcenarten", description: "Arten von Geräten und Verträgen", href: "/settings?section=asset-types", permission: "settings.manage" },
      { group: "Rechte & System", title: "Rollen & Rechte", description: "Zugriffe und Berechtigungen", href: "/settings?section=roles", permission: "roles.manage" },
      { group: "Rechte & System", title: "Gruppen", description: "Teams und Queue-Zugriffe", href: "/settings?section=groups", permission: "groups.manage" },
      { group: "Rechte & System", title: "Erscheinungsbild", description: "Logo und Farben", href: "/settings?section=appearance", permission: "appearance.manage" },
      { group: "Rechte & System", title: "Systemupdate", description: "Updates direkt aus GitHub", href: "/settings?section=updates", permission: "settings.manage" }
    ].filter((module) => (!module.permission || hasPermission(req.user, module.permission)) && (!query || `${module.title} ${module.description} ${module.group}`.toLowerCase().includes(query.toLowerCase())));

    res.render("settings/index", {
      title: "Einstellungen",
      section,
      sections,
      sectionMeta,
      currentSection: sectionMeta[section],
      query,
      adminModules,
      queueOptions: ticketConfig.queueRecords,
      slaOptions: ticketConfig.slaOptions,
      queues: queues.rows,
      ticketTypes: ticketTypes.rows,
      slaPolicies: slaPolicies.rows,
      assetTypes: assetTypes.rows,
      numberFormats,
      ticketNumberFormats: numberFormatOptions("ticket"),
      customerNumberFormats: numberFormatOptions("customer"),
      responseTemplates: responseTemplates.rows,
      templateTypes,
      templateVariables,
      updateState,
      mailChannels: mailChannelsResult.rows.map(({ inbound_secret, outbound_secret, graph_client_secret, ...channel }) => ({
        ...channel,
        connectionMode: channel.inbound_type === "graph" && channel.outbound_type === "graph" ? "graph"
          : channel.inbound_type === "imap" && channel.outbound_type === "smtp" ? "imap_smtp"
            : channel.inbound_type === "pop3" && channel.outbound_type === "smtp" ? "pop3_smtp"
              : channel.inbound_type === "none" && channel.outbound_type === "smtp" ? "smtp_only" : "custom",
        hasInboundSecret: Boolean(inbound_secret),
        hasOutboundSecret: Boolean(outbound_secret),
        hasGraphSecret: Boolean(graph_client_secret)
      })),
      mailEvents: mailEventsResult.rows,
      roles,
      groups,
      permissions: permissionsResult.rows,
      userRecords: userRecords.rows,
      appearance,
      hasCustomLogo: Boolean(brandLogo),
      hasCustomBrandName: res.locals.companyName !== config.companyName,
      brandLogoVersion: brandLogo?.updatedAt ? new Date(brandLogo.updatedAt).getTime() : 0,
      defaultAppearance
    });
  });

  router.post("/numbers", async (req, res) => {
    await saveNumberFormats(pool, { ticket: req.body.ticket_format, customer: req.body.customer_format });
    setFlash(req, "success", "Nummernkreise wurden gespeichert. Die Änderung gilt für neu angelegte Datensätze.");
    redirectTo(res, "numbers");
  });

  router.post("/templates", async (req, res) => {
    const name = String(req.body.name ?? "").trim().slice(0, 120);
    const type = Object.hasOwn(templateTypes, req.body.template_type) ? req.body.template_type : "reply";
    const subject = String(req.body.subject ?? "").trim().slice(0, 180) || null;
    const body = String(req.body.body ?? "").trim().slice(0, 20_000);
    if (name.length < 2 || body.length < 2 || await isDuplicate(pool, "response_templates", name)) {
      setFlash(req, "error", "Name und Inhalt sind erforderlich; der Vorlagenname muss eindeutig sein.");
      return redirectTo(res, "templates");
    }
    await pool.query(
      `INSERT INTO response_templates (name, template_type, subject, body, sort_order, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [name, type, subject, body, nonNegativeInt(req.body.sort_order), req.user.id]
    );
    setFlash(req, "success", `Vorlage „${name}“ wurde angelegt.`);
    redirectTo(res, "templates");
  });

  router.post("/templates/:id/update", async (req, res) => {
    const id = positiveInt(req.params.id);
    const name = String(req.body.name ?? "").trim().slice(0, 120);
    const type = Object.hasOwn(templateTypes, req.body.template_type) ? req.body.template_type : "reply";
    const subject = String(req.body.subject ?? "").trim().slice(0, 180) || null;
    const body = String(req.body.body ?? "").trim().slice(0, 20_000);
    if (!id || name.length < 2 || body.length < 2 || await isDuplicate(pool, "response_templates", name, id)) {
      setFlash(req, "error", "Die Vorlage konnte nicht gespeichert werden. Prüfe Name und Inhalt.");
      return redirectTo(res, "templates");
    }
    await pool.query(
      `UPDATE response_templates SET name = $1, template_type = $2, subject = $3, body = $4,
       sort_order = $5, updated_at = NOW() WHERE id = $6`,
      [name, type, subject, body, nonNegativeInt(req.body.sort_order), id]
    );
    setFlash(req, "success", `Vorlage „${name}“ wurde gespeichert.`);
    redirectTo(res, "templates");
  });

  router.post("/templates/:id/toggle", async (req, res) => {
    const id = positiveInt(req.params.id);
    if (id) await pool.query("UPDATE response_templates SET active = NOT active, updated_at = NOW() WHERE id = $1", [id]);
    setFlash(req, "success", "Vorlagenstatus wurde geändert.");
    redirectTo(res, "templates");
  });

  router.post("/updates/check", async (req, res) => {
    try {
      const state = await checkForUpdate(config);
      setFlash(req, "success", state.lastCheck.available
        ? `Das Release ${state.lastCheck.tagName} ist verfügbar.`
        : `Tixaro ${state.version} ist das aktuelle Release.`);
    } catch (error) {
      setFlash(req, "error", error.message || "Die Update-Prüfung ist fehlgeschlagen.");
    }
    redirectTo(res, "updates");
  });

  router.post("/updates/install", async (req, res) => {
    if (req.body.confirm_update !== "on") {
      setFlash(req, "error", "Bestätige den Neustart, bevor das Update installiert wird.");
      return redirectTo(res, "updates");
    }
    try {
      const state = await installUpdate(config);
      setFlash(req, "success", `Tixaro ${state.version} wurde aus GitHub installiert. Die Anwendung wird neu gestartet.`);
      res.redirect("/settings?section=updates");
      if (config.updateAutoRestart) setTimeout(() => process.exit(0), 1500);
    } catch (error) {
      setFlash(req, "error", error.message || "Das Update konnte nicht installiert werden.");
      redirectTo(res, "updates");
    }
  });

  router.post("/queues", async (req, res) => {
    const name = String(req.body.name ?? "").trim();
    const parentId = positiveInt(req.body.parent_id);
    const slaCode = String(req.body.default_sla_code ?? "").trim() || null;
    if (name.length < 2 || name.length > 80 || await isDuplicate(pool, "ticket_queues", name) || !await validQueueParent(pool, parentId) || !await validSlaCode(pool, slaCode)) {
      setFlash(req, "error", name.length < 2 || name.length > 80 ? "Der Queue-Name muss zwischen 2 und 80 Zeichen lang sein." : "Queue konnte nicht angelegt werden. Prüfe Name, Eltern-Queue und SLA.");
      return redirectTo(res, "queues");
    }
    await pool.query(
      `INSERT INTO ticket_queues (name, parent_id, description, default_sla_code, sort_order)
       VALUES ($1, $2, $3, $4, $5)`,
      [name, parentId, String(req.body.description ?? "").trim() || null, slaCode, nonNegativeInt(req.body.sort_order)]
    );
    setFlash(req, "success", `Queue „${name}“ wurde angelegt.`);
    redirectTo(res, "queues");
  });

  router.post("/queues/:id/update", async (req, res) => {
    const id = positiveInt(req.params.id);
    const name = String(req.body.name ?? "").trim();
    let parentId = positiveInt(req.body.parent_id);
    if (parentId === id) parentId = null;
    const slaCode = String(req.body.default_sla_code ?? "").trim() || null;
    if (!id || name.length < 2 || name.length > 80 || await isDuplicate(pool, "ticket_queues", name, id) || !await validQueueParent(pool, parentId, id) || !await validSlaCode(pool, slaCode)) {
      setFlash(req, "error", "Queue konnte nicht gespeichert werden. Prüfe Name und Eindeutigkeit.");
      return redirectTo(res, "queues");
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query("SELECT name FROM ticket_queues WHERE id = $1", [id]);
      if (!existing.rowCount) {
        await client.query("ROLLBACK");
        setFlash(req, "error", "Queue wurde nicht gefunden.");
        return redirectTo(res, "queues");
      }
      await client.query(
        `UPDATE ticket_queues SET name = $1, parent_id = $2, description = $3, default_sla_code = $4,
         sort_order = $5, updated_at = NOW() WHERE id = $6`,
        [name, parentId, String(req.body.description ?? "").trim() || null, slaCode, nonNegativeInt(req.body.sort_order), id]
      );
      if (existing.rows[0].name !== name) {
        await client.query("UPDATE tickets SET category = $1 WHERE category = $2", [name, existing.rows[0].name]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    setFlash(req, "success", "Queue wurde aktualisiert.");
    redirectTo(res, "queues");
  });

  router.post("/queues/:id/toggle", async (req, res) => {
    const result = await toggleOption(pool, "ticket_queues", positiveInt(req.params.id));
    setFlash(req, result.prevented ? "error" : "success", result.prevented ? "Mindestens eine Queue muss aktiv bleiben." : "Queue-Status wurde geändert.");
    redirectTo(res, "queues");
  });

  async function createNamedOption(req, res, table, section, label, maxLength) {
    const name = String(req.body.name ?? "").trim();
    if (name.length < 2 || name.length > maxLength || await isDuplicate(pool, table, name)) {
      setFlash(req, "error", name.length < 2 || name.length > maxLength ? `${label} muss zwischen 2 und ${maxLength} Zeichen lang sein.` : `${label} existiert bereits.`);
      return redirectTo(res, section);
    }
    await pool.query(`INSERT INTO ${table} (name, sort_order) VALUES ($1, $2)`, [name, nonNegativeInt(req.body.sort_order)]);
    setFlash(req, "success", `${label} „${name}“ wurde angelegt.`);
    redirectTo(res, section);
  }

  async function updateNamedOption(req, res, table, section, label, maxLength, usageTable, usageColumn) {
    const id = positiveInt(req.params.id);
    const name = String(req.body.name ?? "").trim();
    if (!id || name.length < 2 || name.length > maxLength || await isDuplicate(pool, table, name, id)) {
      setFlash(req, "error", `${label} konnte nicht gespeichert werden.`);
      return redirectTo(res, section);
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(`SELECT name FROM ${table} WHERE id = $1`, [id]);
      if (!existing.rowCount) {
        await client.query("ROLLBACK");
        setFlash(req, "error", `${label} wurde nicht gefunden.`);
        return redirectTo(res, section);
      }
      await client.query(`UPDATE ${table} SET name = $1, sort_order = $2, updated_at = NOW() WHERE id = $3`, [name, nonNegativeInt(req.body.sort_order), id]);
      if (existing.rows[0].name !== name) {
        await client.query(`UPDATE ${usageTable} SET ${usageColumn} = $1 WHERE ${usageColumn} = $2`, [name, existing.rows[0].name]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    setFlash(req, "success", `${label} wurde aktualisiert.`);
    redirectTo(res, section);
  }

  async function toggleNamedOption(req, res, table, section, label) {
    const result = await toggleOption(pool, table, positiveInt(req.params.id));
    setFlash(req, result.prevented ? "error" : "success", result.prevented ? `Mindestens ein ${label} muss aktiv bleiben.` : `${label}-Status wurde geändert.`);
    redirectTo(res, section);
  }

  router.post("/ticket-types", (req, res) => createNamedOption(req, res, "ticket_type_options", "ticket-types", "Tickettyp", 40));
  router.post("/ticket-types/:id/update", (req, res) => updateNamedOption(req, res, "ticket_type_options", "ticket-types", "Tickettyp", 40, "tickets", "ticket_type"));
  router.post("/ticket-types/:id/toggle", (req, res) => toggleNamedOption(req, res, "ticket_type_options", "ticket-types", "Tickettyp"));
  router.post("/asset-types", (req, res) => createNamedOption(req, res, "asset_type_options", "asset-types", "Ressourcenart", 80));
  router.post("/asset-types/:id/update", (req, res) => updateNamedOption(req, res, "asset_type_options", "asset-types", "Ressourcenart", 80, "assets", "asset_type"));
  router.post("/asset-types/:id/toggle", (req, res) => toggleNamedOption(req, res, "asset_type_options", "asset-types", "Ressourcenart"));

  router.post("/sla", async (req, res) => {
    const name = String(req.body.name ?? "").trim();
    const responseMinutes = positiveInt(req.body.response_minutes);
    const resolutionMinutes = positiveInt(req.body.resolution_minutes);
    if (name.length < 2 || name.length > 80 || !responseMinutes || !resolutionMinutes || resolutionMinutes < responseMinutes || await isDuplicate(pool, "sla_policies", name)) {
      setFlash(req, "error", "SLA konnte nicht angelegt werden. Lösung muss mindestens so lang wie Erstreaktion sein.");
      return redirectTo(res, "sla");
    }
    const code = await uniqueSlaCode(pool, name);
    await pool.query(
      `INSERT INTO sla_policies (code, name, response_minutes, resolution_minutes, sort_order)
       VALUES ($1, $2, $3, $4, $5)`,
      [code, name, responseMinutes, resolutionMinutes, nonNegativeInt(req.body.sort_order)]
    );
    setFlash(req, "success", `SLA „${name}“ wurde angelegt.`);
    redirectTo(res, "sla");
  });

  router.post("/sla/:id/update", async (req, res) => {
    const id = positiveInt(req.params.id);
    const name = String(req.body.name ?? "").trim();
    const responseMinutes = positiveInt(req.body.response_minutes);
    const resolutionMinutes = positiveInt(req.body.resolution_minutes);
    if (!id || name.length < 2 || name.length > 80 || !responseMinutes || !resolutionMinutes || resolutionMinutes < responseMinutes || await isDuplicate(pool, "sla_policies", name, id)) {
      setFlash(req, "error", "SLA konnte nicht gespeichert werden.");
      return redirectTo(res, "sla");
    }
    await pool.query(
      `UPDATE sla_policies SET name = $1, response_minutes = $2, resolution_minutes = $3,
       sort_order = $4, updated_at = NOW() WHERE id = $5`,
      [name, responseMinutes, resolutionMinutes, nonNegativeInt(req.body.sort_order), id]
    );
    setFlash(req, "success", "SLA wurde aktualisiert.");
    redirectTo(res, "sla");
  });

  router.post("/sla/:id/toggle", async (req, res) => {
    const result = await toggleOption(pool, "sla_policies", positiveInt(req.params.id));
    setFlash(req, result.prevented ? "error" : "success", result.prevented ? "Mindestens ein SLA muss aktiv bleiben." : "SLA-Status wurde geändert.");
    redirectTo(res, "sla");
  });

  router.post("/mail", async (req, res) => {
    const values = mailChannelValues(req.body, config);
    const error = await mailChannelError(pool, values);
    if (error) {
      setFlash(req, "error", error);
      return redirectTo(res, "mail");
    }
    await pool.query(
      `INSERT INTO mail_channels
       (name, email_address, queue_id, inbound_type, outbound_type, inbound_host, inbound_port, inbound_secure,
        inbound_username, inbound_secret, outbound_host, outbound_port, outbound_secure, outbound_username,
        outbound_secret, graph_tenant_id, graph_client_id, graph_client_secret, graph_mailbox, poll_interval_minutes, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [values.name, values.emailAddress, values.queueId, values.inboundType, values.outboundType, values.inboundHost,
        values.inboundPort, values.inboundSecure, values.inboundUsername, values.inboundSecret, values.outboundHost,
        values.outboundPort, values.outboundSecure, values.outboundUsername, values.outboundSecret, values.graphTenantId,
        values.graphClientId, values.graphClientSecret, values.graphMailbox, values.pollIntervalMinutes, values.active]
    );
    setFlash(req, "success", `Mailkonto „${values.name}“ wurde angelegt. Prüfe die Verbindung vor dem ersten Abruf.`);
    redirectTo(res, "mail");
  });

  router.post("/mail/:id/update", async (req, res) => {
    const id = positiveInt(req.params.id);
    const stored = id ? await pool.query("SELECT * FROM mail_channels WHERE id = $1", [id]) : { rowCount: 0, rows: [] };
    if (!stored.rowCount) {
      setFlash(req, "error", "Mailkonto wurde nicht gefunden.");
      return redirectTo(res, "mail");
    }
    const values = mailChannelValues(req.body, config, stored.rows[0]);
    const error = await mailChannelError(pool, values, id);
    if (error) {
      setFlash(req, "error", error);
      return redirectTo(res, "mail");
    }
    await pool.query(
      `UPDATE mail_channels SET
       name=$1, email_address=$2, queue_id=$3, inbound_type=$4, outbound_type=$5, inbound_host=$6,
       inbound_port=$7, inbound_secure=$8, inbound_username=$9, inbound_secret=$10, outbound_host=$11,
       outbound_port=$12, outbound_secure=$13, outbound_username=$14, outbound_secret=$15,
       graph_tenant_id=$16, graph_client_id=$17, graph_client_secret=$18, graph_mailbox=$19,
       poll_interval_minutes=$20, active=$21, updated_at=NOW() WHERE id=$22`,
      [values.name, values.emailAddress, values.queueId, values.inboundType, values.outboundType, values.inboundHost,
        values.inboundPort, values.inboundSecure, values.inboundUsername, values.inboundSecret, values.outboundHost,
        values.outboundPort, values.outboundSecure, values.outboundUsername, values.outboundSecret, values.graphTenantId,
        values.graphClientId, values.graphClientSecret, values.graphMailbox, values.pollIntervalMinutes, values.active, id]
    );
    setFlash(req, "success", `Mailkonto „${values.name}“ wurde gespeichert.`);
    redirectTo(res, "mail");
  });

  router.post("/mail/:id/toggle", async (req, res) => {
    await pool.query("UPDATE mail_channels SET active = NOT active, updated_at = NOW() WHERE id = $1", [positiveInt(req.params.id)]);
    setFlash(req, "success", "Mailkonto-Status wurde geändert.");
    redirectTo(res, "mail");
  });

  router.post("/mail/:id/test", async (req, res) => {
    try {
      const tested = await testMailChannel({ pool, config, channelId: positiveInt(req.params.id) });
      setFlash(req, "success", `Verbindung erfolgreich geprüft: ${tested.join(" und ") || "Konfiguration"}.`);
    } catch (error) {
      setFlash(req, "error", `Verbindung fehlgeschlagen: ${String(error.message ?? error).slice(0, 300)}`);
    }
    redirectTo(res, "mail");
  });

  router.post("/mail/:id/fetch", async (req, res) => {
    try {
      const result = await pollMailChannel({ pool, config, channelId: positiveInt(req.params.id) });
      setFlash(req, "success", `${result.imported} neue ${result.imported === 1 ? "E-Mail wurde" : "E-Mails wurden"} verarbeitet.`);
    } catch (error) {
      setFlash(req, "error", `Mailabruf fehlgeschlagen: ${String(error.message ?? error).slice(0, 300)}`);
    }
    redirectTo(res, "mail");
  });

  router.post("/roles", async (req, res) => {
    const name = String(req.body.name ?? "").trim();
    const description = String(req.body.description ?? "").trim().slice(0, 1000) || null;
    if (name.length < 2 || name.length > 120 || await isDuplicate(pool, "access_roles", name)) {
      setFlash(req, "error", "Die Rolle benötigt einen eindeutigen Namen mit 2 bis 120 Zeichen.");
      return redirectTo(res, "roles");
    }
    const base = slug(name);
    let code = base;
    let suffix = 2;
    while ((await pool.query("SELECT id FROM access_roles WHERE code = $1", [code])).rowCount) code = `${base.slice(0, 55)}-${suffix++}`;
    await pool.query("INSERT INTO access_roles (code, name, description) VALUES ($1, $2, $3)", [code, name, description]);
    setFlash(req, "success", `Rolle „${name}“ wurde angelegt. Berechtigungen können jetzt zugewiesen werden.`);
    redirectTo(res, "roles");
  });

  router.post("/roles/:id/update", async (req, res) => {
    const id = positiveInt(req.params.id);
    const stored = id ? await pool.query("SELECT * FROM access_roles WHERE id = $1", [id]) : { rowCount: 0, rows: [] };
    if (!stored.rowCount) {
      setFlash(req, "error", "Rolle wurde nicht gefunden.");
      return redirectTo(res, "roles");
    }
    if (stored.rows[0].system_role) {
      setFlash(req, "error", "Systemrollen sind als sichere Grundprofile geschützt. Lege für Abweichungen eine eigene Rolle an.");
      return redirectTo(res, "roles");
    }
    const name = String(req.body.name ?? "").trim();
    if (name.length < 2 || name.length > 120 || await isDuplicate(pool, "access_roles", name, id)) {
      setFlash(req, "error", "Der Rollenname ist ungültig oder bereits vergeben.");
      return redirectTo(res, "roles");
    }
    const permissionCodes = new Set(values(req.body.permissions));
    const userIds = new Set(values(req.body.users).map(positiveInt).filter(Boolean));
    const validPermissions = new Set((await pool.query("SELECT code FROM permission_definitions")).rows.map((row) => row.code));
    const validUsers = new Set((await pool.query("SELECT id FROM users")).rows.map((row) => row.id));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE access_roles SET name = $1, description = $2, updated_at = NOW() WHERE id = $3", [name, String(req.body.description ?? "").trim().slice(0, 1000) || null, id]);
      await client.query("DELETE FROM role_permissions WHERE role_id = $1", [id]);
      for (const code of permissionCodes) if (validPermissions.has(code)) await client.query("INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2)", [id, code]);
      await client.query("DELETE FROM user_access_roles WHERE role_id = $1", [id]);
      for (const userId of userIds) if (validUsers.has(userId)) await client.query("INSERT INTO user_access_roles (user_id, role_id) VALUES ($1, $2)", [userId, id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    setFlash(req, "success", `Rolle „${name}“ wurde gespeichert.`);
    redirectTo(res, "roles");
  });

  router.post("/roles/:id/toggle", async (req, res) => {
    const id = positiveInt(req.params.id);
    const role = id ? await pool.query("SELECT system_role FROM access_roles WHERE id = $1", [id]) : { rowCount: 0, rows: [] };
    if (!role.rowCount || role.rows[0].system_role) setFlash(req, "error", "Systemrollen können nicht deaktiviert werden.");
    else {
      await pool.query("UPDATE access_roles SET active = NOT active, updated_at = NOW() WHERE id = $1", [id]);
      setFlash(req, "success", "Rollenstatus wurde geändert.");
    }
    redirectTo(res, "roles");
  });

  router.post("/groups", async (req, res) => {
    const name = String(req.body.name ?? "").trim();
    if (name.length < 2 || name.length > 120 || await isDuplicate(pool, "access_groups", name)) {
      setFlash(req, "error", "Die Gruppe benötigt einen eindeutigen Namen mit 2 bis 120 Zeichen.");
      return redirectTo(res, "groups");
    }
    await pool.query("INSERT INTO access_groups (name, description) VALUES ($1, $2)", [name, String(req.body.description ?? "").trim().slice(0, 1000) || null]);
    setFlash(req, "success", `Gruppe „${name}“ wurde angelegt.`);
    redirectTo(res, "groups");
  });

  router.post("/groups/:id/update", async (req, res) => {
    const id = positiveInt(req.params.id);
    const stored = id ? await pool.query("SELECT id FROM access_groups WHERE id = $1", [id]) : { rowCount: 0 };
    const name = String(req.body.name ?? "").trim();
    if (!stored.rowCount || name.length < 2 || name.length > 120 || await isDuplicate(pool, "access_groups", name, id)) {
      setFlash(req, "error", "Gruppe konnte nicht gespeichert werden. Prüfe den eindeutigen Namen.");
      return redirectTo(res, "groups");
    }
    const userIds = new Set(values(req.body.users).map(positiveInt).filter(Boolean));
    const roleIds = new Set(values(req.body.roles).map(positiveInt).filter(Boolean));
    const validUsers = new Set((await pool.query("SELECT id FROM users")).rows.map((row) => row.id));
    const validRoles = new Set((await pool.query("SELECT id FROM access_roles WHERE active = TRUE")).rows.map((row) => row.id));
    const queueRows = (await pool.query("SELECT id FROM ticket_queues")).rows;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE access_groups SET name = $1, description = $2, updated_at = NOW() WHERE id = $3", [name, String(req.body.description ?? "").trim().slice(0, 1000) || null, id]);
      await client.query("DELETE FROM group_members WHERE group_id = $1", [id]);
      for (const userId of userIds) if (validUsers.has(userId)) await client.query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)", [id, userId]);
      await client.query("DELETE FROM group_access_roles WHERE group_id = $1", [id]);
      for (const roleId of roleIds) if (validRoles.has(roleId)) await client.query("INSERT INTO group_access_roles (group_id, role_id) VALUES ($1, $2)", [id, roleId]);
      await client.query("DELETE FROM group_queue_permissions WHERE group_id = $1", [id]);
      for (const queue of queueRows) {
        const level = req.body[`queue_${queue.id}`];
        if (level === "read" || level === "write") await client.query("INSERT INTO group_queue_permissions (group_id, queue_id, permission_level) VALUES ($1, $2, $3)", [id, queue.id, level]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    setFlash(req, "success", `Gruppe „${name}“ wurde gespeichert.`);
    redirectTo(res, "groups");
  });

  router.post("/groups/:id/toggle", async (req, res) => {
    await pool.query("UPDATE access_groups SET active = NOT active, updated_at = NOW() WHERE id = $1", [positiveInt(req.params.id)]);
    setFlash(req, "success", "Gruppenstatus wurde geändert.");
    redirectTo(res, "groups");
  });

  router.post("/appearance", async (req, res) => {
    await saveAppearance(pool, req.body);
    setFlash(req, "success", "Die Farben wurden systemweit gespeichert.");
    redirectTo(res, "appearance");
  });

  router.post("/appearance/brand", async (req, res) => {
    try {
      await saveBrandName(pool, req.body.company_name);
      setFlash(req, "success", "Der Firmenname wurde systemweit gespeichert.");
    } catch (error) {
      setFlash(req, "error", error.message);
    }
    redirectTo(res, "appearance");
  });

  router.post("/appearance/brand/reset", async (req, res) => {
    await resetBrandName(pool);
    setFlash(req, "success", "Der Standardname ist wieder aktiv.");
    redirectTo(res, "appearance");
  });

  router.post("/appearance/reset", async (req, res) => {
    await resetAppearance(pool);
    setFlash(req, "success", "Das ursprüngliche Farbschema wurde wiederhergestellt.");
    redirectTo(res, "appearance");
  });

  router.post("/appearance/logo", async (req, res) => {
    const encoded = String(req.body.logo_data ?? "");
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=]+)$/i.exec(encoded);
    if (!match) {
      setFlash(req, "error", "Bitte wähle eine PNG-, JPG- oder WebP-Datei aus.");
      return redirectTo(res, "appearance");
    }
    try {
      await saveBrandLogo(pool, { mime: match[1].toLowerCase(), data: Buffer.from(match[2], "base64") });
      setFlash(req, "success", "Das eigene Logo wurde systemweit gespeichert.");
    } catch (error) {
      setFlash(req, "error", error.message);
    }
    redirectTo(res, "appearance");
  });

  router.post("/appearance/logo/reset", async (req, res) => {
    await resetBrandLogo(pool);
    setFlash(req, "success", "Das Standardlogo ist wieder aktiv.");
    redirectTo(res, "appearance");
  });

  return router;
}
