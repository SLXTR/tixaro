import { domainToASCII } from "node:url";

const sharedEmailDomains = new Set([
  "aol.com",
  "gmail.com",
  "googlemail.com",
  "gmx.de",
  "gmx.net",
  "hotmail.com",
  "icloud.com",
  "mail.com",
  "outlook.com",
  "proton.me",
  "protonmail.com",
  "t-online.de",
  "web.de",
  "yahoo.com",
  "yahoo.de"
]);

export function emailDomain(value) {
  const email = String(value ?? "").trim().toLowerCase();
  const separator = email.lastIndexOf("@");
  if (separator <= 0 || separator === email.length - 1) return null;
  return normalizeCustomerDomain(email.slice(separator + 1));
}

export function isCompanyEmailDomain(domain) {
  return Boolean(domain) && !sharedEmailDomains.has(domain);
}

export function normalizeCustomerDomain(value) {
  const raw = String(value ?? "").trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");
  if (!raw || raw.length > 253 || raw.includes(":") || raw.includes("/") || raw.includes("@") || /\s/.test(raw)) return null;
  const domain = domainToASCII(raw).toLowerCase();
  if (!domain || !domain.includes(".") || !/^[a-z0-9.-]+$/.test(domain)) return null;
  const labels = domain.split(".");
  if (labels.some((label) => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) return null;
  return domain;
}

async function activeCustomers(client) {
  const result = await client.query(
    "SELECT id, name, domain FROM customers WHERE status <> 'inactive' AND domain IS NOT NULL ORDER BY id"
  );
  return result.rows;
}

function uniqueCustomersByDomain(customers) {
  const domains = new Map();
  for (const customer of customers) {
    const domain = normalizeCustomerDomain(customer.domain);
    if (!isCompanyEmailDomain(domain)) continue;
    const matches = domains.get(domain) ?? [];
    matches.push(customer);
    domains.set(domain, matches);
  }
  return new Map(Array.from(domains.entries()).filter(([, matches]) => matches.length === 1));
}

export async function assignCustomerUser(client, { userId, customerId }) {
  await client.query(
    `INSERT INTO customer_profiles (user_id, customer_id) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET customer_id = EXCLUDED.customer_id, updated_at = NOW()`,
    [userId, customerId]
  );
}

export async function migrateCustomerDomains(client) {
  const result = await client.query("SELECT id, email, domain FROM customers ORDER BY id");
  const usedDomains = new Set(result.rows.map((customer) => normalizeCustomerDomain(customer.domain)).filter(Boolean));
  for (const customer of result.rows) {
    if (normalizeCustomerDomain(customer.domain)) continue;
    const domain = emailDomain(customer.email);
    if (!isCompanyEmailDomain(domain) || usedDomains.has(domain)) continue;
    await client.query("UPDATE customers SET domain = $1 WHERE id = $2 AND domain IS NULL", [domain, customer.id]);
    usedDomains.add(domain);
  }
}

export async function autoAssignCustomerUser(client, { userId, email }) {
  const existing = await client.query("SELECT customer_id FROM customer_profiles WHERE user_id = $1", [userId]);
  if (existing.rowCount) return { assigned: false, reason: "already_assigned" };

  const domain = emailDomain(email);
  if (!isCompanyEmailDomain(domain)) return { assigned: false, reason: "shared_domain" };

  const domains = uniqueCustomersByDomain(await activeCustomers(client));
  const matches = domains.get(domain);
  if (!matches) return { assigned: false, reason: "no_unique_customer" };

  const customer = matches[0];
  await client.query(
    "INSERT INTO customer_profiles (user_id, customer_id) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING",
    [userId, customer.id]
  );
  return { assigned: true, customer };
}

export async function backfillCustomerUsers(client, { customerId = null } = {}) {
  const domains = uniqueCustomersByDomain(await activeCustomers(client));
  const users = await client.query(
    `SELECT u.id, u.email
     FROM users u LEFT JOIN customer_profiles cp ON cp.user_id = u.id
     WHERE u.role = 'requester' AND cp.user_id IS NULL`
  );

  let assignedCount = 0;
  for (const user of users.rows) {
    const domain = emailDomain(user.email);
    const matches = domains.get(domain);
    const customer = matches?.[0];
    if (!customer || (customerId && Number(customer.id) !== Number(customerId))) continue;
    const inserted = await client.query(
      "INSERT INTO customer_profiles (user_id, customer_id) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING",
      [user.id, customer.id]
    );
    assignedCount += inserted.rowCount;
  }
  return assignedCount;
}
