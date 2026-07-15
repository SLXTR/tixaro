import { randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import Pop3Command from "node-pop3";
import { assignSystemRoleForLegacyRole } from "./access-control.js";
import { autoAssignCustomerUser } from "./customer-assignment.js";
import { decryptSecret } from "./secret-store.js";
import { defaultSlaCode, loadTicketConfiguration } from "./service-config.js";
import { createTicketNumber } from "./number-formats.js";
import { splitUserName, userName } from "./user-names.js";

const MAX_MESSAGES_PER_POLL = 25;
const connectionTimeout = 12_000;

function emailAddress(value) {
  const match = String(value ?? "").trim().toLowerCase().match(/<?([^<>\s]+@[^<>\s]+)>?$/);
  return match?.[1] ?? "";
}

function plainText(value) {
  return String(value ?? "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 100_000);
}

function ticketDeadlines(configuration, sla, start = new Date()) {
  const definition = configuration.slaDefinitions[sla] ?? configuration.slaOptions[0] ?? { responseMinutes: 480, resolutionMinutes: 2880 };
  return {
    responseDueAt: new Date(start.getTime() + Number(definition.responseMinutes) * 60_000),
    resolutionDueAt: new Date(start.getTime() + Number(definition.resolutionMinutes) * 60_000)
  };
}

function channelSecrets(channel, config) {
  return {
    ...channel,
    inboundPassword: decryptSecret(channel.inbound_secret, config.mailSecretKey),
    outboundPassword: decryptSecret(channel.outbound_secret, config.mailSecretKey),
    graphClientSecret: decryptSecret(channel.graph_client_secret, config.mailSecretKey)
  };
}

async function loadChannel(pool, config, channelId) {
  const result = await pool.query(
    `SELECT m.*, q.name AS queue_name, q.default_sla_code
     FROM mail_channels m LEFT JOIN ticket_queues q ON q.id = m.queue_id WHERE m.id = $1`,
    [channelId]
  );
  return result.rowCount ? channelSecrets(result.rows[0], config) : null;
}

async function graphToken(channel, fetchImpl = globalThis.fetch) {
  const body = new URLSearchParams({
    client_id: channel.graph_client_id,
    client_secret: channel.graphClientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials"
  });
  const response = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(channel.graph_tenant_id)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(connectionTimeout)
  });
  const payload = await response.json();
  if (!response.ok || !payload.access_token) throw new Error(payload.error_description || `Graph-Anmeldung fehlgeschlagen (${response.status}).`);
  return payload.access_token;
}

async function graphRequest(channel, path, options = {}, fetchImpl = globalThis.fetch) {
  const token = await graphToken(channel, fetchImpl);
  const response = await fetchImpl(`https://graph.microsoft.com/v1.0${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
    signal: AbortSignal.timeout(connectionTimeout)
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error?.message || `Microsoft Graph antwortet mit ${response.status}.`);
  }
  return response;
}

async function findOrCreateRequester(client, senderAddress, senderName) {
  const existing = await client.query("SELECT id FROM users WHERE email = $1", [senderAddress]);
  if (existing.rowCount) return existing.rows[0].id;
  const fallbackName = senderAddress.split("@")[0].replace(/[._-]+/g, " ");
  const name = String(senderName || fallbackName || "E-Mail-Anfragende Person").trim().slice(0, 120);
  const { firstName, lastName } = splitUserName(name);
  const displayName = userName(firstName, lastName);
  const passwordHash = await bcrypt.hash(randomBytes(32).toString("base64url"), 10);
  const created = await client.query(
    "INSERT INTO users (first_name, last_name, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5, 'requester') RETURNING id",
    [firstName, lastName, displayName, senderAddress, passwordHash]
  );
  await assignSystemRoleForLegacyRole(client, created.rows[0].id, "requester");
  await autoAssignCustomerUser(client, { userId: created.rows[0].id, email: senderAddress });
  return created.rows[0].id;
}

export async function ingestInboundMessage({ pool, channel, message }) {
  const externalId = String(message.externalId || message.internetMessageId || randomUUID()).slice(0, 512);
  const duplicate = await pool.query(
    "SELECT ticket_id FROM mail_events WHERE channel_id = $1 AND direction = 'inbound' AND external_id = $2",
    [channel.id, externalId]
  );
  if (duplicate.rowCount) return { duplicate: true, ticketId: duplicate.rows[0].ticket_id };

  const sender = emailAddress(message.fromAddress);
  if (!sender || sender === emailAddress(channel.email_address)) {
    await pool.query(
      `INSERT INTO mail_events (channel_id, direction, external_id, internet_message_id, sender, recipients, subject, status, received_at)
       VALUES ($1, 'inbound', $2, $3, $4, $5, $6, 'skipped', $7)
       ON CONFLICT (channel_id, direction, external_id) DO NOTHING`,
      [channel.id, externalId, message.internetMessageId || null, sender || null, message.to || null, message.subject || null, message.receivedAt || new Date()]
    );
    return { skipped: true };
  }

  const configuration = await loadTicketConfiguration(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const requesterId = await findOrCreateRequester(client, sender, message.fromName);
    const referencedNumber = String(message.subject ?? "").match(/\[([^\]]{3,32})\]/)?.[1]?.trim().toUpperCase();
    const referenced = referencedNumber
      ? await client.query("SELECT id FROM tickets WHERE UPPER(ticket_number) = $1 AND requester_id = $2", [referencedNumber, requesterId])
      : { rowCount: 0, rows: [] };
    const content = plainText(message.text || message.html) || "E-Mail ohne Textinhalt";
    let ticketId;

    if (referenced.rowCount) {
      ticketId = referenced.rows[0].id;
      await client.query(
        "INSERT INTO comments (ticket_id, author_id, body, is_internal) VALUES ($1, $2, $3, FALSE)",
        [ticketId, requesterId, content]
      );
      await client.query("UPDATE tickets SET updated_at = NOW() WHERE id = $1", [ticketId]);
      await client.query(
        "INSERT INTO activity_log (ticket_id, actor_id, action, details) VALUES ($1, $2, 'email_received', $3)",
        [ticketId, requesterId, JSON.stringify({ channelId: channel.id, sender })]
      );
    } else {
      const queue = configuration.queueRecords.find((item) => item.id === channel.queue_id)
        ?? configuration.queueRecords.find((item) => item.name === channel.queue_name)
        ?? configuration.queueRecords[0];
      const category = queue?.name ?? "Allgemeiner Support";
      const sla = configuration.slaDefinitions[queue?.default_sla_code]
        ? queue.default_sla_code
        : defaultSlaCode(configuration);
      const ticketType = configuration.ticketTypes.includes("Anfrage") ? "Anfrage" : configuration.ticketTypes[0] ?? "Anfrage";
      const receivedAt = message.receivedAt ? new Date(message.receivedAt) : new Date();
      const deadlines = ticketDeadlines(configuration, sla, receivedAt);
      const profile = await client.query("SELECT customer_id FROM customer_profiles WHERE user_id = $1", [requesterId]);
      const created = await client.query(
        `INSERT INTO tickets (subject, description, category, ticket_type, channel, sla, response_due_at, resolution_due_at, requester_id, customer_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'email', $5, $6, $7, $8, $9, $10, $10) RETURNING id`,
        [String(message.subject || "Anfrage per E-Mail").trim().slice(0, 180), content, category, ticketType, sla,
          deadlines.responseDueAt, deadlines.resolutionDueAt, requesterId, profile.rows[0]?.customer_id ?? null, receivedAt]
      );
      ticketId = created.rows[0].id;
      const ticketNumber = await createTicketNumber(client, ticketId, receivedAt);
      await client.query("UPDATE tickets SET ticket_number = $1 WHERE id = $2", [ticketNumber, ticketId]);
      await client.query(
        "INSERT INTO activity_log (ticket_id, actor_id, action, details) VALUES ($1, $2, 'email_ticket_created', $3)",
        [ticketId, requesterId, JSON.stringify({ channelId: channel.id, sender })]
      );
    }

    await client.query(
      `INSERT INTO mail_events
       (channel_id, ticket_id, direction, external_id, internet_message_id, sender, recipients, subject, status, received_at)
       VALUES ($1, $2, 'inbound', $3, $4, $5, $6, $7, 'imported', $8)`,
      [channel.id, ticketId, externalId, message.internetMessageId || null, sender, message.to || null,
        String(message.subject ?? "").slice(0, 1000), message.receivedAt || new Date()]
    );
    await client.query("COMMIT");
    return { imported: true, ticketId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function parsedMessage(parsed, externalId) {
  const from = parsed.from?.value?.[0] ?? {};
  return {
    externalId,
    internetMessageId: parsed.messageId || null,
    fromAddress: from.address,
    fromName: from.name,
    to: parsed.to?.text,
    subject: parsed.subject,
    text: parsed.text,
    html: parsed.html,
    receivedAt: parsed.date || new Date()
  };
}

async function pollImap(pool, channel) {
  const client = new ImapFlow({
    host: channel.inbound_host,
    port: channel.inbound_port || (channel.inbound_secure ? 993 : 143),
    secure: channel.inbound_secure,
    doSTARTTLS: !channel.inbound_secure,
    auth: { user: channel.inbound_username, pass: channel.inboundPassword },
    logger: false,
    socketTimeout: 30_000
  });
  let imported = 0;
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    let processed = 0;
    for await (const item of client.fetch({ seen: false }, { uid: true, source: true })) {
      if (processed++ >= MAX_MESSAGES_PER_POLL) break;
      const parsed = await simpleParser(item.source);
      const result = await ingestInboundMessage({ pool, channel, message: parsedMessage(parsed, `imap:${item.uid}`) });
      await client.messageFlagsAdd(item.uid, ["\\Seen"], { uid: true });
      if (result.imported) imported += 1;
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return imported;
}

async function pollPop3(pool, channel) {
  const client = new Pop3Command({
    host: channel.inbound_host,
    port: channel.inbound_port || (channel.inbound_secure ? 995 : 110),
    tls: channel.inbound_secure,
    user: channel.inbound_username,
    password: channel.inboundPassword,
    timeout: 30_000
  });
  let imported = 0;
  try {
    const messages = await client.UIDL();
    for (const [messageNumber, uid] of messages.slice(-MAX_MESSAGES_PER_POLL)) {
      const parsed = await simpleParser(await client.RETR(messageNumber));
      const result = await ingestInboundMessage({ pool, channel, message: parsedMessage(parsed, `pop3:${uid}`) });
      if (result.imported) imported += 1;
    }
  } finally {
    await client.QUIT().catch(() => {});
  }
  return imported;
}

async function pollGraph(pool, channel, fetchImpl) {
  const mailbox = encodeURIComponent(channel.graph_mailbox || channel.email_address);
  const params = new URLSearchParams({
    "$filter": "isRead eq false",
    "$top": String(MAX_MESSAGES_PER_POLL),
    "$select": "id,internetMessageId,subject,from,toRecipients,receivedDateTime,body"
  });
  const response = await graphRequest(channel, `/users/${mailbox}/mailFolders/inbox/messages?${params}`, {}, fetchImpl);
  const payload = await response.json();
  let imported = 0;
  for (const item of [...(payload.value ?? [])].reverse()) {
    const result = await ingestInboundMessage({
      pool,
      channel,
      message: {
        externalId: `graph:${item.id}`,
        internetMessageId: item.internetMessageId,
        fromAddress: item.from?.emailAddress?.address,
        fromName: item.from?.emailAddress?.name,
        to: (item.toRecipients ?? []).map((entry) => entry.emailAddress?.address).filter(Boolean).join(", "),
        subject: item.subject,
        text: item.body?.contentType === "text" ? item.body.content : null,
        html: item.body?.contentType === "html" ? item.body.content : null,
        receivedAt: item.receivedDateTime
      }
    });
    await graphRequest(channel, `/users/${mailbox}/messages/${encodeURIComponent(item.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isRead: true })
    }, fetchImpl);
    if (result.imported) imported += 1;
  }
  return imported;
}

export async function pollMailChannel({ pool, config, channelId, fetchImpl = globalThis.fetch }) {
  const channel = await loadChannel(pool, config, channelId);
  if (!channel || !channel.active || channel.inbound_type === "none") return { imported: 0, skipped: true };
  await pool.query("UPDATE mail_channels SET last_checked_at = NOW(), last_error = NULL WHERE id = $1", [channel.id]);
  try {
    const imported = channel.inbound_type === "imap" ? await pollImap(pool, channel)
      : channel.inbound_type === "pop3" ? await pollPop3(pool, channel)
        : await pollGraph(pool, channel, fetchImpl);
    await pool.query("UPDATE mail_channels SET last_success_at = NOW(), last_error = NULL WHERE id = $1", [channel.id]);
    return { imported };
  } catch (error) {
    await pool.query("UPDATE mail_channels SET last_error = $1 WHERE id = $2", [String(error.message ?? error).slice(0, 2000), channel.id]);
    throw error;
  }
}

async function outboundChannel(pool, config, ticket) {
  const result = await pool.query(
    `SELECT m.*, q.name AS queue_name
     FROM mail_channels m
     LEFT JOIN ticket_queues q ON q.id = m.queue_id
     WHERE m.active = TRUE AND m.outbound_type <> 'none'
     ORDER BY CASE
       WHEN m.id = (SELECT channel_id FROM mail_events WHERE ticket_id = $1 AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1) THEN 1
       WHEN q.name = $2 THEN 2 ELSE 3 END, m.id
     LIMIT 1`,
    [ticket.id, ticket.category]
  );
  return result.rowCount ? channelSecrets(result.rows[0], config) : null;
}

export async function sendTicketEmail({ pool, config, ticketId, body, fetchImpl = globalThis.fetch }) {
  const ticketResult = await pool.query(
    `SELECT t.id, t.ticket_number, t.subject, t.category, u.email AS requester_email
     FROM tickets t JOIN users u ON u.id = t.requester_id WHERE t.id = $1`,
    [ticketId]
  );
  if (!ticketResult.rowCount) return { skipped: true, reason: "ticket_missing" };
  const ticket = ticketResult.rows[0];
  const channel = await outboundChannel(pool, config, ticket);
  if (!channel || !ticket.requester_email) return { skipped: true, reason: "channel_missing" };
  const subject = `[${ticket.ticket_number}] ${ticket.subject}`;
  const text = `${plainText(body)}\n\nTicket: ${config.appBaseUrl}/tickets/${ticket.id}`;
  const eventId = randomUUID();
  try {
    let externalId = eventId;
    if (channel.outbound_type === "smtp") {
      const transport = nodemailer.createTransport({
        host: channel.outbound_host,
        port: channel.outbound_port || (channel.outbound_secure ? 465 : 587),
        secure: channel.outbound_secure,
        requireTLS: !channel.outbound_secure,
        auth: { user: channel.outbound_username, pass: channel.outboundPassword },
        connectionTimeout,
        greetingTimeout: connectionTimeout,
        socketTimeout: 30_000
      });
      const info = await transport.sendMail({
        from: { name: channel.name, address: channel.email_address },
        to: ticket.requester_email,
        replyTo: channel.email_address,
        subject,
        text
      });
      externalId = info.messageId || eventId;
    } else {
      const mailbox = encodeURIComponent(channel.graph_mailbox || channel.email_address);
      await graphRequest(channel, `/users/${mailbox}/sendMail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            subject,
            body: { contentType: "Text", content: text },
            toRecipients: [{ emailAddress: { address: ticket.requester_email } }]
          },
          saveToSentItems: true
        })
      }, fetchImpl);
    }
    await pool.query(
      `INSERT INTO mail_events (channel_id, ticket_id, direction, external_id, sender, recipients, subject, status)
       VALUES ($1, $2, 'outbound', $3, $4, $5, $6, 'sent')`,
      [channel.id, ticket.id, String(externalId).slice(0, 512), channel.email_address, ticket.requester_email, subject]
    );
    return { sent: true, channelId: channel.id };
  } catch (error) {
    await pool.query(
      `INSERT INTO mail_events (channel_id, ticket_id, direction, external_id, sender, recipients, subject, status, error)
       VALUES ($1, $2, 'outbound', $3, $4, $5, $6, 'failed', $7)`,
      [channel.id, ticket.id, eventId, channel.email_address, ticket.requester_email, subject, String(error.message ?? error).slice(0, 2000)]
    );
    throw error;
  }
}

export async function testMailChannel({ pool, config, channelId, fetchImpl = globalThis.fetch }) {
  const channel = await loadChannel(pool, config, channelId);
  if (!channel) throw new Error("Mailkonto wurde nicht gefunden.");
  const tested = [];
  if (channel.inbound_type === "imap") {
    const client = new ImapFlow({ host: channel.inbound_host, port: channel.inbound_port || (channel.inbound_secure ? 993 : 143), secure: channel.inbound_secure, doSTARTTLS: !channel.inbound_secure, auth: { user: channel.inbound_username, pass: channel.inboundPassword }, logger: false, socketTimeout: 30_000 });
    await client.connect();
    await client.logout();
    tested.push("IMAP");
  } else if (channel.inbound_type === "pop3") {
    const client = new Pop3Command({ host: channel.inbound_host, port: channel.inbound_port || (channel.inbound_secure ? 995 : 110), tls: channel.inbound_secure, user: channel.inbound_username, password: channel.inboundPassword, timeout: 30_000 });
    await client.UIDL();
    await client.QUIT();
    tested.push("POP3");
  } else if (channel.inbound_type === "graph") {
    const mailbox = encodeURIComponent(channel.graph_mailbox || channel.email_address);
    await graphRequest(channel, `/users/${mailbox}/mailFolders/inbox?$select=id,displayName`, {}, fetchImpl);
    tested.push("Graph-Eingang");
  }
  if (channel.outbound_type === "smtp") {
    const transport = nodemailer.createTransport({ host: channel.outbound_host, port: channel.outbound_port || (channel.outbound_secure ? 465 : 587), secure: channel.outbound_secure, requireTLS: !channel.outbound_secure, auth: { user: channel.outbound_username, pass: channel.outboundPassword }, connectionTimeout, greetingTimeout: connectionTimeout });
    await transport.verify();
    tested.push("SMTP");
  } else if (channel.outbound_type === "graph") {
    await graphToken(channel, fetchImpl);
    tested.push("Graph-Ausgang");
  }
  return tested;
}

export function startMailPolling({ pool, config, intervalMs = 60_000 }) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const channels = await pool.query("SELECT id, poll_interval_minutes, last_checked_at FROM mail_channels WHERE active = TRUE AND inbound_type <> 'none'");
      const now = Date.now();
      for (const channel of channels.rows) {
        const last = channel.last_checked_at ? new Date(channel.last_checked_at).getTime() : 0;
        if (now - last >= Number(channel.poll_interval_minutes) * 60_000) {
          await pollMailChannel({ pool, config, channelId: channel.id }).catch((error) => console.error(`Mailabruf ${channel.id}:`, error.message));
        }
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  setTimeout(run, 5_000).unref?.();
  return () => clearInterval(timer);
}
