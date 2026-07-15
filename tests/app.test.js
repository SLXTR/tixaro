import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDatabase, seedAdmin } from "../src/db.js";

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
    category: "IT"
  }).expect(302);

  const result = await pool.query("SELECT ticket_number, subject, priority FROM tickets");
  assert.equal(result.rowCount, 1);
  assert.match(result.rows[0].ticket_number, /^TIX-\d{4}-000001$/);
  assert.equal(result.rows[0].priority, "high");
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
  assert.equal(requester.rowCount, 1);
});

test("CSRF-Schutz blockiert veränderte Formulare", async () => {
  await request(app).post("/login").type("form").send({ email: "admin@example.com", password: "VerySecure123!" }).expect(403);
});
