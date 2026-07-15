export const templateVariables = Object.freeze([
  { key: "company.name", label: "Firmenname" },
  { key: "ticket.number", label: "Ticketnummer" },
  { key: "ticket.subject", label: "Betreff" },
  { key: "ticket.queue", label: "Queue" },
  { key: "ticket.type", label: "Tickettyp" },
  { key: "ticket.channel", label: "Kontaktkanal" },
  { key: "customer.name", label: "Kundenname" },
  { key: "customer.number", label: "Kundennummer" },
  { key: "requester.first_name", label: "Vorname der anfragenden Person" },
  { key: "requester.last_name", label: "Nachname der anfragenden Person" },
  { key: "requester.name", label: "Vollständiger Name der anfragenden Person" },
  { key: "requester.email", label: "E-Mail der anfragenden Person" },
  { key: "agent.first_name", label: "Vorname des Agenten" },
  { key: "agent.last_name", label: "Nachname des Agenten" },
  { key: "agent.name", label: "Vollständiger Name des Agenten" },
  { key: "agent.email", label: "E-Mail des Agenten" }
]);

function values(context) {
  return {
    "company.name": context.company?.name,
    "ticket.number": context.ticket?.ticket_number,
    "ticket.subject": context.ticket?.subject,
    "ticket.queue": context.ticket?.category,
    "ticket.type": context.ticket?.ticket_type,
    "ticket.channel": context.ticket?.channel,
    "customer.name": context.ticket?.customer_name,
    "customer.number": context.ticket?.customer_number,
    "requester.first_name": context.ticket?.requester_first_name,
    "requester.last_name": context.ticket?.requester_last_name,
    "requester.name": context.ticket?.requester_name,
    "requester.email": context.ticket?.requester_email,
    "agent.first_name": context.agent?.first_name,
    "agent.last_name": context.agent?.last_name,
    "agent.name": context.agent?.name,
    "agent.email": context.agent?.email
  };
}

export function renderTemplate(source, context = {}) {
  const replacements = values(context);
  return String(source ?? "").replace(/\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/gi, (match, key) => (
    Object.hasOwn(replacements, key.toLowerCase()) ? String(replacements[key.toLowerCase()] ?? "") : match
  ));
}
