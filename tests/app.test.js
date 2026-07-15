import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDatabase, seedAdmin } from "../src/db.js";
import { assignSystemRoleForLegacyRole } from "../src/access-control.js";
import { searchAddresses } from "../src/address-search.js";
import { ingestInboundMessage, sendTicketEmail } from "../src/mail-service.js";
import { compareVersions, fetchLatestRelease } from "../src/system-update.js";
import { loadSystemConfiguration } from "../src/system-configuration.js";

let pool;
let app;

const config = loadConfig({
  nodeEnv: "test",
  databaseUrl: "memory://tests",
  sessionSecret: "test-session-secret-with-at-least-32-characters",
  adminName: "Test Admin",
  adminEmail: "admin@example.com",
  adminPassword: "VerySecure123!",
  companyName: "Testfirma"
});

function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([a-f0-9]+)"/);
  assert.ok(match, "CSRF-Token fehlt im Formular");
  return match[1];
}

before(async () => {
  pool = await createDatabase(config);
  await seedAdmin(pool, config);
  app = createApp({ pool, config });
});

after(async () => pool.end());

test("Healthcheck meldet eine erreichbare Anwendung", async () => {
  const response = await request(app).get("/health").expect(200);
  assert.deepEqual(response.body, { status: "ok" });
});

test("geschützte Seiten leiten zur Anmeldung um", async () => {
  await request(app).get("/tickets").expect(302).expect("Location", "/login");
});

test("Updateprüfung wertet veröffentlichte GitHub-Releases aus", async () => {
  assert.equal(compareVersions("1.1.0", "1.0.0"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  const release = await fetchLatestRelease("SLXTR/tixaro", {
    githubToken: "test-token",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.github.com/repos/SLXTR/tixaro/releases/latest");
      assert.equal(options.headers.Authorization, "Bearer test-token");
      return {
        ok: true,
        status: 200,
        json: async () => ({ tag_name: "v1.2.0", name: "Tixaro 1.2.0", body: "Neue Funktionen", html_url: "https://github.com/SLXTR/tixaro/releases/tag/v1.2.0", published_at: "2026-07-15T10:00:00Z" })
      };
    }
  });
  assert.equal(release.version, "1.2.0");
  assert.equal(release.tagName, "v1.2.0");
});

test("Ersteinrichtung setzt alle zentralen Werte und sperrt sich danach", async () => {
  const setupConfig = loadConfig({
    nodeEnv: "test",
    databaseUrl: "memory://initial-setup",
    sessionSecret: "setup-session-secret-with-at-least-32-characters",
    adminPassword: "",
    companyName: "Tixaro",
    appBaseUrl: "http://localhost:3000"
  });
  const setupPool = await createDatabase(setupConfig);
  const setupApp = createApp({ pool: setupPool, config: setupConfig });
  const setupAgent = request.agent(setupApp);

  await setupAgent.get("/login").expect(302).expect("Location", "/setup");
  let page = await setupAgent.get("/setup").expect(200);
  assert.match(page.text, /Service Desk startklar machen/);
  assert.match(page.text, /Zentrale Queue/);
  assert.match(page.text, /Administratorkonto/);

  await setupAgent.post("/setup").type("form").send({
    _csrf: csrfFrom(page.text),
    company_name: "Muster Service GmbH",
    app_base_url: "https://support.muster.test",
    time_zone: "Europe/Berlin",
    queue_name: "Service Desk",
    response_hours: "4",
    resolution_hours: "24",
    first_name: "Mara",
    last_name: "Admin",
    email: "mara@muster.test",
    password: "InitialSetup123!",
    password_confirmation: "InitialSetup123!"
  }).expect(302).expect("Location", "/");

  page = await setupAgent.get("/").expect(200);
  assert.match(page.text, /Muster Service GmbH/);
  assert.match(page.text, /Ersteinrichtung ist abgeschlossen/);
  const admin = await setupPool.query("SELECT first_name, last_name, email, role FROM users");
  assert.deepEqual(admin.rows[0], { first_name: "Mara", last_name: "Admin", email: "mara@muster.test", role: "admin" });
  const queue = await setupPool.query("SELECT name FROM ticket_queues WHERE description = 'Zentrale Eingangsqueue'");
  assert.equal(queue.rows[0].name, "Service Desk");
  const sla = await setupPool.query("SELECT response_minutes, resolution_minutes FROM sla_policies WHERE code = 'standard'");
  assert.deepEqual(sla.rows[0], { response_minutes: 240, resolution_minutes: 1440 });
  const stored = await loadSystemConfiguration(setupPool, setupConfig);
  assert.deepEqual(stored, { appBaseUrl: "https://support.muster.test", timeZone: "Europe/Berlin" });
  page = await setupAgent.get("/settings?section=system").expect(200);
  assert.match(page.text, /https:\/\/support\.muster\.test/);
  await setupAgent.post("/settings/system").type("form").send({
    _csrf: csrfFrom(page.text), app_base_url: "https://hilfe.muster.test", time_zone: "Europe/Zurich"
  }).expect(302).expect("Location", "/settings?section=system");
  assert.deepEqual(await loadSystemConfiguration(setupPool, setupConfig), { appBaseUrl: "https://hilfe.muster.test", timeZone: "Europe/Zurich" });
  await setupAgent.get("/setup").expect(302).expect("Location", "/");
  await request(setupApp).get("/setup").expect(302).expect("Location", "/login");
  await setupPool.end();
});

test("Adresssuche normalisiert Photon-Ergebnisse für die Kundeneingabe", async () => {
  let requestedUrl;
  const suggestions = await searchAddresses(`Pariser Platz Test ${Date.now()}`, {
    baseUrl: "https://adresse.example/api/",
    fetchImpl: async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        json: async () => ({
          features: [{
            geometry: { coordinates: [13.3777, 52.5163] },
            properties: { street: "Pariser Platz", housenumber: "1", postcode: "10117", city: "Berlin", country: "Deutschland" }
          }]
        })
      };
    }
  });
  assert.equal(requestedUrl.searchParams.get("lang"), "de");
  assert.equal(requestedUrl.searchParams.get("limit"), "6");
  assert.deepEqual(suggestions[0], {
    label: "Pariser Platz 1, 10117 Berlin, Deutschland",
    address: "Pariser Platz 1",
    city: "Berlin",
    postcode: "10117",
    country: "Deutschland",
    latitude: 52.5163,
    longitude: 13.3777
  });
});

test("Administrator kann sich anmelden und ein Ticket erstellen", async () => {
  const agent = request.agent(app);
  const loginPage = await agent.get("/login").expect(200);
  await agent.post("/login").type("form").send({
    _csrf: csrfFrom(loginPage.text),
    email: config.adminEmail,
    password: config.adminPassword
  }).expect(302).expect("Location", "/");

  await agent.get("/").expect(200);
  await agent.get("/users").expect(200);

  const createPage = await agent.get("/tickets/new").expect(200);
  await agent.post("/tickets").type("form").send({
    _csrf: csrfFrom(createPage.text),
    subject: "Drucker im Büro funktioniert nicht",
    description: "Der Drucker zeigt seit heute Morgen einen Papierfehler an.",
    priority: "high",
    category: "Arbeitsplätze & Geräte",
    ticket_type: "Störung",
    sla: "critical"
  }).expect(302);

  const result = await pool.query("SELECT ticket_number, subject, priority, category, ticket_type, sla, response_due_at, resolution_due_at FROM tickets");
  assert.equal(result.rowCount, 1);
  assert.match(result.rows[0].ticket_number, /^TIX-\d{4}-000001$/);
  assert.equal(result.rows[0].priority, "high");
  assert.equal(result.rows[0].category, "Arbeitsplätze & Geräte");
  assert.equal(result.rows[0].ticket_type, "Störung");
  assert.equal(result.rows[0].sla, "critical");
  assert.ok(result.rows[0].response_due_at);
  assert.ok(result.rows[0].resolution_due_at);
});

test("Administration verwaltet Queues, SLA-Zeiten und Ressourcenarten systemweit", async () => {
  const agent = request.agent(app);
  let page = await agent.get("/login").expect(200);
  await agent.post("/login").type("form").send({
    _csrf: csrfFrom(page.text),
    email: config.adminEmail,
    password: config.adminPassword
  }).expect(302);

  page = await agent.get("/settings?section=sla").expect(200);
  assert.match(page.text, /Admin-Center/);
  const overview = await agent.get("/settings?q=Queue").expect(200);
  assert.match(overview.text, /Suchergebnisse für „Queue“/);
  assert.match(overview.text, /Queues/);
  await agent.post("/settings/sla").type("form").send({
    _csrf: csrfFrom(page.text),
    name: "Vor-Ort Express",
    response_minutes: "120",
    resolution_minutes: "720",
    sort_order: "45"
  }).expect(302).expect("Location", "/settings?section=sla");
  const sla = await pool.query("SELECT code FROM sla_policies WHERE name = 'Vor-Ort Express'");
  assert.equal(sla.rowCount, 1);

  page = await agent.get("/settings?section=queues").expect(200);
  await agent.post("/settings/queues").type("form").send({
    _csrf: csrfFrom(page.text),
    name: "Vor-Ort-Service",
    default_sla_code: sla.rows[0].code,
    description: "Einsätze beim Kunden",
    sort_order: "45"
  }).expect(302).expect("Location", "/settings?section=queues");

  page = await agent.get("/settings?section=asset-types").expect(200);
  await agent.post("/settings/asset-types").type("form").send({
    _csrf: csrfFrom(page.text),
    name: "Firewall",
    sort_order: "75"
  }).expect(302).expect("Location", "/settings?section=asset-types");

  page = await agent.get("/tickets/new").expect(200);
  assert.match(page.text, /Vor-Ort-Service/);
  assert.match(page.text, new RegExp(`data-default-sla="${sla.rows[0].code}"`));
  await agent.post("/tickets").type("form").send({
    _csrf: csrfFrom(page.text),
    subject: "Technikertermin vor Ort",
    description: "Für die Netzwerkanalyse wird ein Vor-Ort-Termin benötigt.",
    priority: "normal",
    category: "Vor-Ort-Service",
    ticket_type: "Serviceauftrag",
    sla: sla.rows[0].code
  }).expect(302);
  const ticket = await pool.query("SELECT category, sla FROM tickets WHERE subject = 'Technikertermin vor Ort'");
  assert.equal(ticket.rows[0].category, "Vor-Ort-Service");
  assert.equal(ticket.rows[0].sla, sla.rows[0].code);

  const assetPage = await agent.get("/assets/new").expect(200);
  assert.match(assetPage.text, /Firewall/);
});

test("Agenten wählen den Ticketkanal und Administratoren konfigurieren Nummernkreise", async () => {
  const agent = request.agent(app);
  let page = await agent.get("/login").expect(200);
  await agent.post("/login").type("form").send({
    _csrf: csrfFrom(page.text), email: config.adminEmail, password: config.adminPassword
  }).expect(302);

  page = await agent.get("/tickets/new").expect(200);
  assert.match(page.text, /E-Mail-Ticket/);
  assert.match(page.text, /Ausgehender Anruf/);
  assert.match(page.text, /Ankommender Anruf/);
  await agent.post("/tickets").type("form").send({
    _csrf: csrfFrom(page.text),
    channel: "phone_inbound",
    subject: "Telefonische Störungsmeldung",
    description: "Der Kunde meldet telefonisch eine Störung am Arbeitsplatz.",
    priority: "normal",
    category: "Allgemeiner Support",
    ticket_type: "Störung",
    sla: "standard"
  }).expect(302);
  const phoneTicket = await pool.query("SELECT channel FROM tickets WHERE subject = 'Telefonische Störungsmeldung'");
  assert.equal(phoneTicket.rows[0].channel, "phone_inbound");

  page = await agent.get("/settings?section=numbers").expect(200);
  assert.match(page.text, /Nummernkreise/);
  await agent.post("/settings/numbers").type("form").send({
    _csrf: csrfFrom(page.text), ticket_format: "tix_sequence", customer_format: "knd_year_sequence"
  }).expect(302).expect("Location", "/settings?section=numbers");

  page = await agent.get("/customers").expect(200);
  await agent.post("/customers").type("form").send({
    _csrf: csrfFrom(page.text), name: "Nummernkreis Kunde GmbH", email: "kontakt@nummernkreis.test", status: "active"
  }).expect(302);
  const customer = await pool.query("SELECT customer_number FROM customers WHERE name = 'Nummernkreis Kunde GmbH'");
  assert.match(customer.rows[0].customer_number, /^KND-\d{4}-\d{5}$/);

  page = await agent.get("/tickets/new").expect(200);
  await agent.post("/tickets").type("form").send({
    _csrf: csrfFrom(page.text), channel: "email", subject: "Nummernformat prüfen",
    description: "Dieses Ticket prüft den konfigurierten Nummernkreis.", priority: "low",
    category: "Allgemeiner Support", ticket_type: "Anfrage", sla: "standard"
  }).expect(302);
  const formattedTicket = await pool.query("SELECT ticket_number FROM tickets WHERE subject = 'Nummernformat prüfen'");
  assert.match(formattedTicket.rows[0].ticket_number, /^TIX-\d{6}$/);

  page = await agent.get("/settings?section=numbers").expect(200);
  await agent.post("/settings/numbers").type("form").send({
    _csrf: csrfFrom(page.text), ticket_format: "tix_year_sequence", customer_format: "knd_sequence"
  }).expect(302);
});

test("Benutzer enthalten getrennte Namen und können bearbeitet werden", async () => {
  const agent = request.agent(app);
  let page = await agent.get("/login").expect(200);
  await agent.post("/login").type("form").send({
    _csrf: csrfFrom(page.text), email: config.adminEmail, password: config.adminPassword
  }).expect(302);

  page = await agent.get("/users").expect(200);
  assert.match(page.text, /Test Admin/);
  assert.match(page.text, /name="first_name"/);
  assert.match(page.text, /name="last_name"/);
  await agent.post("/users").type("form").send({
    _csrf: csrfFrom(page.text), first_name: "Lena", last_name: "Beispiel",
    email: "lena.beispiel@example.com", role: "requester", password: "VerySecure123!"
  }).expect(302);
  let user = await pool.query("SELECT id, first_name, last_name, name FROM users WHERE email = 'lena.beispiel@example.com'");
  assert.deepEqual({ first: user.rows[0].first_name, last: user.rows[0].last_name, name: user.rows[0].name },
    { first: "Lena", last: "Beispiel", name: "Lena Beispiel" });

  page = await agent.get(`/users/${user.rows[0].id}/edit`).expect(200);
  await agent.post(`/users/${user.rows[0].id}/update`).type("form").send({
    _csrf: csrfFrom(page.text), first_name: "Lena", last_name: "Musterfrau",
    email: "lena.musterfrau@example.com", role: "agent", password: ""
  }).expect(302).expect("Location", "/users");
  user = await pool.query("SELECT first_name, last_name, name, email, role FROM users WHERE id = $1", [user.rows[0].id]);
  assert.equal(user.rows[0].last_name, "Musterfrau");
  assert.equal(user.rows[0].name, "Lena Musterfrau");
  assert.equal(user.rows[0].role, "agent");
});

test("Administratoren können das Kundenportal sicher als Benutzer ansehen", async () => {
  const agent = request.agent(app);
  let page = await agent.get("/login").expect(200);
  await agent.post("/login").type("form").send({
    _csrf: csrfFrom(page.text), email: config.adminEmail, password: config.adminPassword
  }).expect(302);

  page = await agent.get("/users").expect(200);
  assert.match(page.text, /Eigene Einstellungen/);
  await agent.post("/users").type("form").send({
    _csrf: csrfFrom(page.text), first_name: "Petra", last_name: "Portalvorschau",
    email: "petra.portalvorschau@example.com", role: "requester", password: "PortalPreview123!"
  }).expect(302);
  const requester = await pool.query("SELECT id FROM users WHERE email = 'petra.portalvorschau@example.com'");

  page = await agent.get(`/users/${requester.rows[0].id}/edit`).expect(200);
  assert.match(page.text, /Portal als Benutzer ansehen/);
  await agent.post(`/users/${requester.rows[0].id}/preview`).type("form").send({ _csrf: csrfFrom(page.text) })
    .expect(302).expect("Location", "/portal");

  page = await agent.get("/portal").expect(200);
  assert.match(page.text, /Portalvorschau/);
  assert.match(page.text, /Ansicht von Petra Portalvorschau/);
  assert.match(page.text, /Zur Admin-Ansicht/);
  await agent.get("/settings").expect(403);
  await agent.post("/users/preview/stop").type("form").send({ _csrf: csrfFrom(page.text) })
    .expect(302).expect("Location", "/users");
  await agent.get("/settings").expect(200);
  const audit = await pool.query("SELECT details FROM activity_log WHERE action = 'portal_preview_started' AND actor_id IS NOT NULL ORDER BY id DESC LIMIT 1");
  assert.equal(audit.rows[0].details.previewedUserId, requester.rows[0].id);
});

test("Textvorlagen rendern Ticket-, Kunden- und Agentenvariablen", async () => {
  const agent = request.agent(app);
  let page = await agent.get("/login").expect(200);
  await agent.post("/login").type("form").send({
    _csrf: csrfFrom(page.text), email: config.adminEmail, password: config.adminPassword
  }).expect(302);
  page = await agent.get("/settings?section=templates").expect(200);
  assert.match(page.text, /\{\{ticket.number\}\}/);
  assert.match(page.text, /\{\{requester.first_name\}\}/);
  await agent.post("/settings/templates").type("form").send({
    _csrf: csrfFrom(page.text), name: "Persönliche Rückmeldung", template_type: "reply",
    subject: "", body: "Guten Tag {{requester.first_name}}, Ticket {{ticket.number}} wird von {{agent.first_name}} bearbeitet.", sort_order: "15"
  }).expect(302).expect("Location", "/settings?section=templates");
  const template = await pool.query("SELECT body FROM response_templates WHERE name = 'Persönliche Rückmeldung'");
  assert.match(template.rows[0].body, /\{\{agent.first_name\}\}/);

  const ticket = await pool.query("SELECT id FROM tickets WHERE subject = 'Telefonische Störungsmeldung'");
  page = await agent.get(`/tickets/${ticket.rows[0].id}`).expect(200);
  assert.match(page.text, /Persönliche Rückmeldung/);
  assert.match(page.text, /wird von Test bearbeitet/);
});

test("Update-Center ist mit den GitHub-Releases verbunden", async () => {
  const agent = request.agent(app);
  let page = await agent.get("/login").expect(200);
  await agent.post("/login").type("form").send({
    _csrf: csrfFrom(page.text), email: config.adminEmail, password: config.adminPassword
  }).expect(302);
  page = await agent.get("/settings?section=updates").expect(200);
  assert.match(page.text, /GitHub-Releases/);
  assert.match(page.text, /SLXTR\/tixaro/);
  assert.match(page.text, /Neuestes Release prüfen/);
});

test("Farben werden per Farbwähler gespeichert und als Theme ausgeliefert", async () => {
  const agent = request.agent(app);
  let page = await agent.get("/login").expect(200);
  await agent.post("/login").type("form").send({
    _csrf: csrfFrom(page.text), email: config.adminEmail, password: config.adminPassword
  }).expect(302);

  page = await agent.get("/settings?section=appearance").expect(200);
  assert.match(page.text, /name="company_name" value="Testfirma"/);
  assert.match(page.text, /type="color" name="accent"/);
  assert.match(page.text, /type="color" name="sidebar"/);

  await agent.post("/settings/appearance/brand").type("form").send({
    _csrf: csrfFrom(page.text), company_name: "Nordstern Service GmbH"
  }).expect(302).expect("Location", "/settings?section=appearance");
  page = await agent.get("/settings?section=appearance").expect(200);
  assert.match(page.text, /name="company_name" value="Nordstern Service GmbH"/);
  assert.match(page.text, /<title>Einstellungen · Nordstern Service GmbH<\/title>/);
  await agent.post("/settings/appearance/brand/reset").type("form").send({ _csrf: csrfFrom(page.text) }).expect(302);
  page = await agent.get("/settings?section=appearance").expect(200);
  assert.match(page.text, /name="company_name" value="Testfirma"/);

  await agent.post("/settings/appearance").type("form").send({
    _csrf: csrfFrom(page.text),
    accent: "#336699",
    accentDark: "#24486d",
    canvas: "#f2f4f6",
    surface: "#ffffff",
    sage: "#556b62",
    sidebar: "#142536",
    sidebarText: "#edf2f7"
  }).expect(302).expect("Location", "/settings?section=appearance");

  const theme = await agent.get("/theme.css").expect(200);
  assert.match(theme.text, /--accent:#336699/);
  assert.match(theme.text, /--sidebar:#142536/);

  page = await agent.get("/settings?section=appearance").expect(200);
  await agent.post("/settings/appearance/reset").type("form").send({ _csrf: csrfFrom(page.text) }).expect(302);
  const resetTheme = await agent.get("/theme.css").expect(200);
  assert.match(resetTheme.text, /--accent:#16b8a6/);
  assert.match(resetTheme.text, /--brand-coral:#ff6b5e/);
  assert.match(resetTheme.text, /--sidebar:#101828/);

  page = await agent.get("/settings?section=appearance").expect(200);
  assert.match(page.text, /Eigenes Logo auswählen/);
  const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  await agent.post("/settings/appearance/logo").type("form").send({
    _csrf: csrfFrom(page.text),
    logo_data: `data:image/png;base64,${tinyPng}`
  }).expect(302).expect("Location", "/settings?section=appearance");
  await agent.get("/brand-logo").expect("Content-Type", /image\/png/).expect(200);
  page = await agent.get("/settings?section=appearance").expect(200);
  assert.match(page.text, /Individuell hinterlegt/);
  await agent.post("/settings/appearance/logo/reset").type("form").send({ _csrf: csrfFrom(page.text) }).expect(302);
  await agent.get("/brand-logo").expect("Content-Type", /image\/webp/).expect(200);
});

test("Rollen und Gruppen kombinieren Rechte mit Queue-Zugriffen", async () => {
  const admin = request.agent(app);
  let page = await admin.get("/login").expect(200);
  await admin.post("/login").type("form").send({
    _csrf: csrfFrom(page.text), email: config.adminEmail, password: config.adminPassword
  }).expect(302);

  const passwordHash = await bcrypt.hash("QueueAgent123!", 4);
  const member = await pool.query(
    "INSERT INTO users (name, email, password_hash, role) VALUES ('Queue Spezialist', 'queue-agent@example.com', $1, 'requester') RETURNING id",
    [passwordHash]
  );
  await assignSystemRoleForLegacyRole(pool, member.rows[0].id, "requester");

  page = await admin.get("/settings?section=roles").expect(200);
  assert.match(page.text, /Geschützte Systemrolle/);
  await admin.post("/settings/roles").type("form").send({
    _csrf: csrfFrom(page.text), name: "Queue-Bearbeitung", description: "Bearbeitet ausschließlich freigegebene Queues"
  }).expect(302);
  const role = await pool.query("SELECT id FROM access_roles WHERE name = 'Queue-Bearbeitung'");

  page = await admin.get("/settings?section=roles").expect(200);
  await admin.post(`/settings/roles/${role.rows[0].id}/update`).type("form").send({
    _csrf: csrfFrom(page.text),
    name: "Queue-Bearbeitung",
    description: "Bearbeitet ausschließlich freigegebene Queues",
    permissions: ["tickets.manage", "tickets.internal", "tickets.worklog", "statistics.view"]
  }).expect(302);

  page = await admin.get("/settings?section=groups").expect(200);
  await admin.post("/settings/groups").type("form").send({
    _csrf: csrfFrom(page.text), name: "Netzwerk-Team", description: "Zuständig für Netzwerk-Tickets"
  }).expect(302);
  const group = await pool.query("SELECT id FROM access_groups WHERE name = 'Netzwerk-Team'");
  const networkQueue = await pool.query("SELECT id FROM ticket_queues WHERE name = 'Netzwerk'");

  page = await admin.get("/settings?section=groups").expect(200);
  await admin.post(`/settings/groups/${group.rows[0].id}/update`).type("form").send({
    _csrf: csrfFrom(page.text),
    name: "Netzwerk-Team",
    description: "Zuständig für Netzwerk-Tickets",
    users: String(member.rows[0].id),
    roles: String(role.rows[0].id),
    [`queue_${networkQueue.rows[0].id}`]: "write"
  }).expect(302);

  const adminUser = await pool.query("SELECT id FROM users WHERE email = $1", [config.adminEmail]);
  const deadlines = [new Date(Date.now() + 60_000), new Date(Date.now() + 120_000)];
  const allowed = await pool.query(
    `INSERT INTO tickets (ticket_number, subject, description, category, requester_id, response_due_at, resolution_due_at)
     VALUES ('RBAC-001', 'Netzwerkfreigabe prüfen', 'Dieses Ticket gehört in die freigegebene Queue.', 'Netzwerk', $1, $2, $3) RETURNING id`,
    [adminUser.rows[0].id, ...deadlines]
  );
  const blocked = await pool.query(
    `INSERT INTO tickets (ticket_number, subject, description, category, requester_id, response_due_at, resolution_due_at)
     VALUES ('RBAC-002', 'Cloudzugriff prüfen', 'Dieses Ticket gehört in eine nicht freigegebene Queue.', 'Microsoft 365 & Cloud', $1, $2, $3) RETURNING id`,
    [adminUser.rows[0].id, ...deadlines]
  );

  const specialist = request.agent(app);
  page = await specialist.get("/login").expect(200);
  await specialist.post("/login").type("form").send({
    _csrf: csrfFrom(page.text), email: "queue-agent@example.com", password: "QueueAgent123!"
  }).expect(302);
  const list = await specialist.get("/tickets").expect(200);
  assert.match(list.text, /Netzwerkfreigabe prüfen/);
  assert.doesNotMatch(list.text, /Cloudzugriff prüfen/);
  await specialist.get(`/tickets/${allowed.rows[0].id}`).expect(200);
  await specialist.get(`/tickets/${blocked.rows[0].id}`).expect(404);
  await specialist.get("/statistics").expect(200);
  await specialist.get("/settings").expect(403);

  page = await specialist.get(`/tickets/${allowed.rows[0].id}`).expect(200);
  await specialist.post(`/tickets/${allowed.rows[0].id}/update`).type("form").send({
    _csrf: csrfFrom(page.text), status: "in_progress", priority: "normal", category: "Netzwerk", ticket_type: "Anfrage", sla: "standard"
  }).expect(302);
  const updated = await pool.query("SELECT status FROM tickets WHERE id = $1", [allowed.rows[0].id]);
  assert.equal(updated.rows[0].status, "in_progress");
});

test("Kundenbenutzer werden über eindeutige Firmendomains automatisch zugeordnet", async () => {
  const agent = request.agent(app);
  let page = await agent.get("/login").expect(200);
  await agent.post("/login").type("form").send({
    _csrf: csrfFrom(page.text),
    email: config.adminEmail,
    password: config.adminPassword
  }).expect(302);

  page = await agent.get("/customers").expect(200);
  await agent.post("/customers").type("form").send({
    _csrf: csrfFrom(page.text),
    name: "Domain Automatik GmbH",
    email: "kontakt@domain-automatik.test",
    status: "active"
  }).expect(302);
  const automaticCustomer = await pool.query("SELECT id FROM customers WHERE name = 'Domain Automatik GmbH'");

  page = await agent.get("/users").expect(200);
  await agent.post("/users").type("form").send({
    _csrf: csrfFrom(page.text),
    name: "Dana Domain",
    email: "dana@domain-automatik.test",
    role: "requester",
    password: "Customer123!"
  }).expect(302);
  const directAssignment = await pool.query(
    `SELECT cp.customer_id FROM customer_profiles cp JOIN users u ON u.id = cp.user_id
     WHERE u.email = 'dana@domain-automatik.test'`
  );
  assert.equal(directAssignment.rows[0].customer_id, automaticCustomer.rows[0].id);

  page = await agent.get("/users").expect(200);
  await agent.post("/users").type("form").send({
    _csrf: csrfFrom(page.text),
    name: "Ben Vorab",
    email: "ben@spaeterer-kunde.test",
    role: "requester",
    password: "Customer123!"
  }).expect(302);
  let delayedAssignment = await pool.query(
    `SELECT cp.customer_id FROM customer_profiles cp JOIN users u ON u.id = cp.user_id
     WHERE u.email = 'ben@spaeterer-kunde.test'`
  );
  assert.equal(delayedAssignment.rowCount, 0);

  page = await agent.get("/customers").expect(200);
  await agent.post("/customers").type("form").send({
    _csrf: csrfFrom(page.text),
    name: "Späterer Kunde GmbH",
    email: "service@spaeterer-kunde.test",
    status: "active"
  }).expect(302);
  delayedAssignment = await pool.query(
    `SELECT cp.customer_id, c.name FROM customer_profiles cp
     JOIN users u ON u.id = cp.user_id JOIN customers c ON c.id = cp.customer_id
     WHERE u.email = 'ben@spaeterer-kunde.test'`
  );
  assert.equal(delayedAssignment.rows[0].name, "Späterer Kunde GmbH");

  page = await agent.get("/customers").expect(200);
  await agent.post("/customers").type("form").send({
    _csrf: csrfFrom(page.text),
    name: "Freie Mailadresse GmbH",
    email: "firma@gmail.com",
    status: "active"
  }).expect(302);
  page = await agent.get("/users").expect(200);
  await agent.post("/users").type("form").send({
    _csrf: csrfFrom(page.text),
    name: "Privater Nutzer",
    email: "privat@gmail.com",
    role: "requester",
    password: "Customer123!"
  }).expect(302);
  const sharedDomainAssignment = await pool.query(
    `SELECT cp.customer_id FROM customer_profiles cp JOIN users u ON u.id = cp.user_id
     WHERE u.email = 'privat@gmail.com'`
  );
  assert.equal(sharedDomainAssignment.rowCount, 0);

  page = await agent.get("/customers").expect(200);
  const customerToken = csrfFrom(page.text);
  await agent.post("/customers").type("form").send({
    _csrf: customerToken,
    name: "Geteilte Domain Nord GmbH",
    email: "nord@geteilte-domain.test",
    status: "active"
  }).expect(302);
  await agent.post("/customers").type("form").send({
    _csrf: customerToken,
    name: "Geteilte Domain Süd GmbH",
    email: "sued@geteilte-domain.test",
    status: "active"
  }).expect(302);
  page = await agent.get("/users").expect(200);
  await agent.post("/users").type("form").send({
    _csrf: csrfFrom(page.text),
    name: "Nicht eindeutig",
    email: "kontakt@geteilte-domain.test",
    role: "requester",
    password: "Customer123!"
  }).expect(302);
  const ambiguousAssignment = await pool.query(
    `SELECT cp.customer_id FROM customer_profiles cp JOIN users u ON u.id = cp.user_id
     WHERE u.email = 'kontakt@geteilte-domain.test'`
  );
  assert.equal(ambiguousAssignment.rowCount, 0);
});

test("OTRS-Ablauf unterstützt Übernahme, SLA-Pause und getrennte Taktabrechnung", async () => {
  const agent = request.agent(app);
  const loginPage = await agent.get("/login");
  await agent.post("/login").type("form").send({
    _csrf: csrfFrom(loginPage.text),
    email: config.adminEmail,
    password: config.adminPassword
  }).expect(302);

  const ticketResult = await pool.query("SELECT id FROM tickets WHERE subject = 'Drucker im Büro funktioniert nicht'");
  const ticketId = ticketResult.rows[0].id;

  let detailPage = await agent.get(`/tickets/${ticketId}`).expect(200);
  await agent.post(`/tickets/${ticketId}/take`).type("form").send({ _csrf: csrfFrom(detailPage.text) }).expect(302);

  const owner = await pool.query("SELECT assignee_id, status FROM tickets WHERE id = $1", [ticketId]);
  assert.ok(owner.rows[0].assignee_id);
  assert.equal(owner.rows[0].status, "in_progress");

  detailPage = await agent.get(`/tickets/${ticketId}`).expect(200);
  await agent.post(`/tickets/${ticketId}/comments`).type("form").send({
    _csrf: csrfFrom(detailPage.text),
    body: "Der Fehler wurde analysiert und die Rückmeldung an den Kunden gesendet."
  }).expect(302);

  const comment = await pool.query("SELECT work_minutes FROM comments WHERE ticket_id = $1", [ticketId]);
  const firstResponse = await pool.query("SELECT first_response_at FROM tickets WHERE id = $1", [ticketId]);
  assert.equal(comment.rows[0].work_minutes, 0);
  assert.ok(firstResponse.rows[0].first_response_at);

  detailPage = await agent.get(`/tickets/${ticketId}`).expect(200);
  await agent.post(`/tickets/${ticketId}/work-log`).type("form").send({
    _csrf: csrfFrom(detailPage.text),
    description: "Druckertreiber aktualisiert und Testseite erfolgreich gedruckt.",
    direction: "add",
    ticks: "4"
  }).expect(302);

  detailPage = await agent.get(`/tickets/${ticketId}`).expect(200);
  assert.match(detailPage.text, /Druckertreiber aktualisiert/);
  await agent.post(`/tickets/${ticketId}/work-log`).type("form").send({
    _csrf: csrfFrom(detailPage.text),
    description: "Einen versehentlich zu viel erfassten Takt korrigiert.",
    direction: "subtract",
    ticks: "1"
  }).expect(302);

  let timeBalance = await pool.query("SELECT billed_ticks FROM tickets WHERE id = $1", [ticketId]);
  const workLogs = await pool.query("SELECT ticks FROM ticket_work_logs WHERE ticket_id = $1 ORDER BY id", [ticketId]);
  assert.equal(timeBalance.rows[0].billed_ticks, 3);
  assert.deepEqual(workLogs.rows.map((entry) => entry.ticks), [4, -1]);

  detailPage = await agent.get(`/tickets/${ticketId}`).expect(200);
  await agent.post(`/tickets/${ticketId}/work-log`).type("form").send({
    _csrf: csrfFrom(detailPage.text),
    description: "Ungültiger Abzug darf den Gesamtstand nicht negativ machen.",
    direction: "subtract",
    ticks: "4"
  }).expect(302);
  timeBalance = await pool.query("SELECT billed_ticks FROM tickets WHERE id = $1", [ticketId]);
  assert.equal(timeBalance.rows[0].billed_ticks, 3);

  detailPage = await agent.get(`/tickets/${ticketId}`).expect(200);
  await agent.post(`/tickets/${ticketId}/update`).type("form").send({
    _csrf: csrfFrom(detailPage.text),
    status: "waiting",
    priority: "high",
    category: "Arbeitsplätze & Geräte",
    ticket_type: "Störung",
    sla: "critical",
    assignee_id: owner.rows[0].assignee_id,
    due_at: "2026-07-16T10:00"
  }).expect(302);

  const paused = await pool.query("SELECT status, sla_paused_at, due_at FROM tickets WHERE id = $1", [ticketId]);
  assert.equal(paused.rows[0].status, "waiting");
  assert.ok(paused.rows[0].sla_paused_at);
  assert.ok(paused.rows[0].due_at);
  await agent.get("/tickets?escalated=1").expect(200);
});

test("CRM-Ressource wird einem Kundenbenutzer zugeordnet und im Ticket angezeigt", async () => {
  const agent = request.agent(app);
  let page = await agent.get("/login");
  await agent.post("/login").type("form").send({
    _csrf: csrfFrom(page.text),
    email: config.adminEmail,
    password: config.adminPassword
  }).expect(302);

  page = await agent.get("/customers").expect(200);
  await agent.post("/customers").type("form").send({
    _csrf: csrfFrom(page.text),
    name: "Beispiel & Partner GmbH",
    industry: "Beratung",
    email: "kontakt@beispiel.test",
    status: "active"
  }).expect(302);
  const customer = await pool.query("SELECT id, customer_number FROM customers WHERE name = 'Beispiel & Partner GmbH'");
  assert.match(customer.rows[0].customer_number, /^KND-\d{5}$/);

  page = await agent.get(`/customers/${customer.rows[0].id}`).expect(200);
  await agent.post(`/customers/${customer.rows[0].id}/contacts`).type("form").send({
    _csrf: csrfFrom(page.text),
    name: "Erika Beispiel",
    email: "erika@beispiel.test",
    password: "Customer123!",
    job_title: "Office Management",
    site: "Berlin"
  }).expect(302);
  const contact = await pool.query("SELECT id FROM users WHERE email = 'erika@beispiel.test'");

  page = await agent.get("/assets/new").expect(200);
  await agent.post("/assets").type("form").send({
    _csrf: csrfFrom(page.text),
    asset_type: "Notebook",
    name: "ThinkPad Erika",
    status: "active",
    manufacturer: "Lenovo",
    model: "T14",
    serial_number: "SN-CRM-001",
    operating_system: "Windows 11",
    customer_id: customer.rows[0].id,
    assigned_user_id: contact.rows[0].id,
    warranty_until: "2027-12-31"
  }).expect(302);
  const asset = await pool.query("SELECT id, asset_number, assigned_user_id FROM assets WHERE serial_number = 'SN-CRM-001'");
  assert.match(asset.rows[0].asset_number, /^AST-\d{6}$/);
  assert.equal(asset.rows[0].assigned_user_id, contact.rows[0].id);

  page = await agent.get("/tickets/new").expect(200);
  const createResponse = await agent.post("/tickets").type("form").send({
    _csrf: csrfFrom(page.text),
    subject: "Notebook startet nicht mehr",
    description: "Das zugeordnete Notebook bleibt beim Einschalten schwarz.",
    priority: "high",
    category: "Arbeitsplätze & Geräte",
    ticket_type: "Störung",
    sla: "priority",
    requester_id: contact.rows[0].id,
    asset_id: asset.rows[0].id
  }).expect(302);
  const ticketPath = createResponse.headers.location;
  const ticketPage = await agent.get(ticketPath).expect(200);
  assert.match(ticketPage.text, /ThinkPad Erika/);
  assert.match(ticketPage.text, /Beispiel &amp; Partner GmbH/);
  assert.match(ticketPage.text, /Verknüpft/);

  const relation = await pool.query("SELECT * FROM ticket_assets WHERE asset_id = $1", [asset.rows[0].id]);
  assert.equal(relation.rowCount, 1);
  assert.equal(relation.rows[0].is_primary, true);
  await agent.get(`/assets/${asset.rows[0].id}`).expect(200);
  await agent.get(`/customers/${customer.rows[0].id}`).expect(200);
});

test("Kundenkarte und Ressourcenhistorie liefern Standort und Zuordnung zum Stichtag", async () => {
  const agent = request.agent(app);
  let page = await agent.get("/login").expect(200);
  await agent.post("/login").type("form").send({
    _csrf: csrfFrom(page.text), email: config.adminEmail, password: config.adminPassword
  }).expect(302);

  page = await agent.get("/customers").expect(200);
  await agent.post("/customers").type("form").send({
    _csrf: csrfFrom(page.text),
    name: "Kartenkunde GmbH",
    email: "kontakt@kartenkunde.test",
    address: "Pariser Platz 1",
    city: "Berlin",
    latitude: "52.5163",
    longitude: "13.3777",
    status: "active"
  }).expect(302);
  const customer = await pool.query("SELECT id, latitude, longitude FROM customers WHERE name = 'Kartenkunde GmbH'");
  assert.equal(Number(customer.rows[0].latitude), 52.5163);
  const customerPage = await agent.get(`/customers/${customer.rows[0].id}`).expect(200);
  assert.match(customerPage.text, /openstreetmap\.org\/export\/embed\.html/);
  assert.match(customerPage.text, /Pariser Platz 1/);

  await agent.post(`/customers/${customer.rows[0].id}/contacts`).type("form").send({
    _csrf: csrfFrom(customerPage.text),
    name: "Kim Kartenkunde",
    email: "kim@kartenkunde.test",
    password: "Customer123!",
    site: "Berlin"
  }).expect(302);
  const contact = await pool.query("SELECT id FROM users WHERE email = 'kim@kartenkunde.test'");

  page = await agent.get("/assets/new").expect(200);
  const created = await agent.post("/assets").type("form").send({
    _csrf: csrfFrom(page.text),
    asset_type: "Computer",
    name: "Arbeitsplatz Kartenkunde",
    status: "active",
    customer_id: customer.rows[0].id,
    assigned_user_id: contact.rows[0].id,
    location: "Berlin Hauptbüro"
  }).expect(302);
  const assetPath = created.headers.location;
  const assetId = Number(assetPath.split("/").pop());
  let history = await pool.query("SELECT * FROM asset_assignment_history WHERE asset_id = $1 ORDER BY valid_from", [assetId]);
  assert.equal(history.rowCount, 1);
  assert.equal(history.rows[0].location, "Berlin Hauptbüro");

  page = await agent.get(assetPath).expect(200);
  assert.match(page.text, /Zuordnungshistorie/);
  await agent.post(`${assetPath}/update`).type("form").send({
    _csrf: csrfFrom(page.text),
    asset_type: "Computer",
    name: "Arbeitsplatz Kartenkunde",
    status: "repair",
    customer_id: customer.rows[0].id,
    assigned_user_id: contact.rows[0].id,
    location: "Potsdam Werkstatt"
  }).expect(302);

  history = await pool.query("SELECT * FROM asset_assignment_history WHERE asset_id = $1 ORDER BY id", [assetId]);
  assert.equal(history.rowCount, 2);
  assert.ok(history.rows[0].valid_until);
  assert.equal(history.rows[1].location, "Potsdam Werkstatt");
  assert.equal(history.rows[1].asset_status, "repair");

  await pool.query("UPDATE asset_assignment_history SET valid_from = $1, valid_until = $2 WHERE id = $3", [
    new Date("2025-01-01T08:00:00Z"), new Date("2025-06-01T08:00:00Z"), history.rows[0].id
  ]);
  await pool.query("UPDATE asset_assignment_history SET valid_from = $1 WHERE id = $2", [
    new Date("2025-06-01T08:00:00Z"), history.rows[1].id
  ]);

  const oldStock = await agent.get("/statistics?at=2025-03-01").expect(200);
  assert.match(oldStock.text, /Berlin Hauptbüro/);
  assert.doesNotMatch(oldStock.text, /Potsdam Werkstatt/);
  const newStock = await agent.get("/statistics?at=2025-07-01").expect(200);
  assert.match(newStock.text, /Potsdam Werkstatt/);
  assert.match(newStock.text, /Kim Kartenkunde/);
  assert.match(newStock.text, /Kartenkunde GmbH/);
  assert.match(newStock.text, /data-customer-map/);
});

test("Mailkonten unterstützen Graph, IMAP, POP3 und SMTP mit verschlüsselten Zugangsdaten", async () => {
  const agent = request.agent(app);
  let page = await agent.get("/login").expect(200);
  await agent.post("/login").type("form").send({
    _csrf: csrfFrom(page.text), email: config.adminEmail, password: config.adminPassword
  }).expect(302);

  page = await agent.get("/settings?section=mail").expect(200);
  assert.match(page.text, /Geführte Einrichtung/);
  assert.match(page.text, /name="connection_mode"/);
  assert.match(page.text, /Microsoft Graph/);
  assert.match(page.text, /IMAP/);
  assert.match(page.text, /POP3/);
  assert.match(page.text, /SMTP/);
  const queue = await pool.query("SELECT id FROM ticket_queues WHERE name = 'Allgemeiner Support'");
  await agent.post("/settings/mail").type("form").send({
    _csrf: csrfFrom(page.text),
    name: "Microsoft 365 Support",
    email_address: "support@graph-mail.test",
    queue_id: queue.rows[0].id,
    inbound_type: "graph",
    outbound_type: "graph",
    graph_tenant_id: "tenant-test",
    graph_client_id: "client-test",
    graph_client_secret: "ExtremGeheim123!",
    graph_mailbox: "support@graph-mail.test",
    poll_interval_minutes: "5",
    active: "on"
  }).expect(302).expect("Location", "/settings?section=mail");

  const stored = await pool.query("SELECT * FROM mail_channels WHERE name = 'Microsoft 365 Support'");
  assert.equal(stored.rowCount, 1);
  assert.notEqual(stored.rows[0].graph_client_secret, "ExtremGeheim123!");
  assert.match(stored.rows[0].graph_client_secret, /^v1\./);
  page = await agent.get("/settings?section=mail").expect(200);
  assert.match(page.text, /Microsoft 365 Support/);
  assert.doesNotMatch(page.text, /ExtremGeheim123/);

  await agent.post("/settings/mail").type("form").send({
    _csrf: csrfFrom(page.text),
    connection_mode: "imap_smtp",
    name: "Einfaches Supportpostfach",
    email_address: "hilfe@mailserver.test",
    queue_id: queue.rows[0].id,
    inbound_host: "imap.mailserver.test",
    outbound_host: "smtp.mailserver.test",
    mail_password: "PostfachPasswort123!",
    inbound_secure: "on",
    active: "on"
  }).expect(302);
  const simpleChannel = await pool.query("SELECT * FROM mail_channels WHERE name = 'Einfaches Supportpostfach'");
  assert.equal(simpleChannel.rows[0].inbound_type, "imap");
  assert.equal(simpleChannel.rows[0].outbound_type, "smtp");
  assert.equal(simpleChannel.rows[0].inbound_username, "hilfe@mailserver.test");
  assert.match(simpleChannel.rows[0].inbound_secret, /^v1\./);
  assert.match(simpleChannel.rows[0].outbound_secret, /^v1\./);
});

test("E-Mail-Abruf erzeugt Tickets und Antworten, Graph versendet Ticketantworten", async () => {
  const channelResult = await pool.query(
    `SELECT m.*, q.name AS queue_name, q.default_sla_code
     FROM mail_channels m LEFT JOIN ticket_queues q ON q.id = m.queue_id
     WHERE m.name = 'Microsoft 365 Support'`
  );
  const channel = channelResult.rows[0];
  const imported = await ingestInboundMessage({
    pool,
    channel,
    message: {
      externalId: "graph:test-message-1",
      internetMessageId: "<message-1@graph-mail.test>",
      fromAddress: "kunde@graph-kunde.test",
      fromName: "Klara Graph",
      to: "support@graph-mail.test",
      subject: "VPN funktioniert nicht",
      text: "Seit heute Morgen kann keine VPN-Verbindung mehr aufgebaut werden.",
      receivedAt: new Date("2026-07-15T08:00:00Z")
    }
  });
  assert.equal(imported.imported, true);
  const ticket = await pool.query("SELECT id, ticket_number, subject FROM tickets WHERE id = $1", [imported.ticketId]);
  assert.match(ticket.rows[0].ticket_number, /^TIX-2026-/);
  assert.equal(ticket.rows[0].subject, "VPN funktioniert nicht");
  const requester = await pool.query("SELECT role FROM users WHERE email = 'kunde@graph-kunde.test'");
  assert.equal(requester.rows[0].role, "requester");

  const duplicate = await ingestInboundMessage({
    pool,
    channel,
    message: { externalId: "graph:test-message-1", fromAddress: "kunde@graph-kunde.test", subject: "VPN funktioniert nicht", text: "Doppelt" }
  });
  assert.equal(duplicate.duplicate, true);

  await ingestInboundMessage({
    pool,
    channel,
    message: {
      externalId: "graph:test-message-2",
      fromAddress: "kunde@graph-kunde.test",
      subject: `Re: [${ticket.rows[0].ticket_number}] VPN funktioniert nicht`,
      text: "Der Fehler tritt auch über den Hotspot auf."
    }
  });
  const comments = await pool.query("SELECT body FROM comments WHERE ticket_id = $1", [ticket.rows[0].id]);
  assert.equal(comments.rowCount, 1);
  assert.match(comments.rows[0].body, /Hotspot/);

  const graphRequests = [];
  const delivery = await sendTicketEmail({
    pool,
    config,
    ticketId: ticket.rows[0].id,
    body: "Wir haben den VPN-Zugang zurückgesetzt. Bitte erneut testen.",
    fetchImpl: async (url, options) => {
      graphRequests.push({ url: String(url), options });
      if (String(url).includes("login.microsoftonline.com")) return { ok: true, json: async () => ({ access_token: "token-test" }) };
      return { ok: true, status: 202, json: async () => ({}) };
    }
  });
  assert.equal(delivery.sent, true);
  assert.ok(graphRequests.some((entry) => entry.url.includes("/users/support%40graph-mail.test/sendMail")));
  const outbound = await pool.query("SELECT status FROM mail_events WHERE ticket_id = $1 AND direction = 'outbound'", [ticket.rows[0].id]);
  assert.equal(outbound.rows[0].status, "sent");
});

test("Anfragende sehen keine fremden Tickets", async () => {
  const passwordHash = await bcrypt.hash("Requester123!", 4);
  const requester = await pool.query(
    "INSERT INTO users (name, email, password_hash, role) VALUES ('Max Mustermann', 'max@example.com', $1, 'requester') RETURNING id",
    [passwordHash]
  );
  const agent = request.agent(app);
  const loginPage = await agent.get("/login");
  await agent.post("/login").type("form").send({ _csrf: csrfFrom(loginPage.text), email: "max@example.com", password: "Requester123!" }).expect(302);
  const response = await agent.get("/tickets").expect(200);
  assert.doesNotMatch(response.text, /Drucker im Büro/);
  await agent.get("/users").expect(403);
  await agent.get("/settings").expect(403);
  await agent.get("/statistics").expect(403);
  assert.equal(requester.rowCount, 1);
});

test("Kundenbenutzer landen in einer eigenen, vereinfachten Portalansicht", async () => {
  const passwordHash = await bcrypt.hash("PortalKunde123!", 4);
  const customer = await pool.query(
    "INSERT INTO customers (customer_number, name, email) VALUES ('CUS-PORTAL', 'Portal Kunde GmbH', 'info@portal-kunde.test') RETURNING id"
  );
  const requester = await pool.query(
    "INSERT INTO users (name, email, password_hash, role) VALUES ('Paula Portal', 'paula@portal-kunde.test', $1, 'requester') RETURNING id",
    [passwordHash]
  );
  await assignSystemRoleForLegacyRole(pool, requester.rows[0].id, "requester");
  await pool.query("INSERT INTO customer_profiles (user_id, customer_id, department) VALUES ($1, $2, 'Einkauf')", [requester.rows[0].id, customer.rows[0].id]);
  await pool.query(
    "INSERT INTO assets (asset_number, asset_type, name, customer_id, assigned_user_id) VALUES ('AST-PORTAL', 'Notebook', 'Paulas Notebook', $1, $2)",
    [customer.rows[0].id, requester.rows[0].id]
  );
  await pool.query(
    "INSERT INTO tickets (ticket_number, subject, description, category, requester_id, customer_id) VALUES ('TIX-2026-PORTAL', 'Portal-Testanfrage', 'Eine bestehende Anfrage im Portal.', 'Allgemeiner Support', $1, $2)",
    [requester.rows[0].id, customer.rows[0].id]
  );

  const portalAgent = request.agent(app);
  let page = await portalAgent.get("/login").expect(200);
  await portalAgent.post("/login").type("form").send({
    _csrf: csrfFrom(page.text), email: "paula@portal-kunde.test", password: "PortalKunde123!"
  }).expect(302).expect("Location", "/portal");
  await portalAgent.get("/").expect(302).expect("Location", "/portal");
  page = await portalAgent.get("/portal").expect(200);
  assert.match(page.text, /Testfirma Kundenportal/);
  assert.match(page.text, /Portal Kunde GmbH/);
  assert.match(page.text, /Paulas Notebook/);
  assert.match(page.text, /Portal-Testanfrage/);
  assert.match(page.text, /Meine Geräte/);

  page = await portalAgent.get("/tickets/new").expect(200);
  assert.match(page.text, /Neue Anfrage/);
  assert.doesNotMatch(page.text, /name="sla"/);
  assert.doesNotMatch(page.text, /name="category"/);
  page = await portalAgent.get("/tickets").expect(200);
  assert.match(page.text, /Meine Anfragen/);
  assert.doesNotMatch(page.text, /Eskalationen/);
  page = await portalAgent.get("/assets").expect(200);
  assert.match(page.text, /Meine Geräte/);
  assert.match(page.text, /Paulas Notebook/);
  assert.doesNotMatch(page.text, /Inventar &amp; CMDB/);
  await portalAgent.get("/settings").expect(403);
});

test("CSRF-Schutz blockiert veränderte Formulare", async () => {
  await request(app).post("/login").type("form").send({ email: "admin@example.com", password: "VerySecure123!" }).expect(403);
});
