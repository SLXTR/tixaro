const statusLabels = {
  open: "Neu",
  in_progress: "Offen",
  waiting: "Warten auf Rückmeldung",
  resolved: "Gelöst",
  closed: "Geschlossen"
};

const priorityLabels = { low: "1 – Niedrig", normal: "3 – Normal", high: "4 – Hoch", urgent: "5 – Sehr hoch" };
const roleLabels = { admin: "Administrator", agent: "Mitarbeiter", requester: "Kundenbenutzer" };
const slaLabels = { standard: "Standard", priority: "Priorität", critical: "Kritisch" };
const customerStatusLabels = { active: "Aktiv", prospect: "Interessent", inactive: "Inaktiv" };
const assetStatusLabels = { active: "Im Einsatz", stock: "Auf Lager", repair: "In Reparatur", retired: "Ausgemustert", lost: "Verloren" };
const ticketChannelLabels = { web: "Web", portal: "Kundenportal", email: "E-Mail", phone_outbound: "Ausgehender Anruf", phone_inbound: "Ankommender Anruf" };

export function statusLabel(value) {
  return statusLabels[value] ?? value;
}

export function priorityLabel(value) {
  return priorityLabels[value] ?? value;
}

export function roleLabel(value) {
  return roleLabels[value] ?? value;
}

export function slaLabel(value) {
  return slaLabels[value] ?? value;
}

export function customerStatusLabel(value) {
  return customerStatusLabels[value] ?? value;
}

export function assetStatusLabel(value) {
  return assetStatusLabels[value] ?? value;
}

export function ticketChannelLabel(value) {
  return ticketChannelLabels[value] ?? value;
}

export function warrantyState(value) {
  if (!value) return "neutral";
  const remaining = new Date(value).getTime() - Date.now();
  if (remaining < 0) return "expired";
  if (remaining < 90 * 24 * 60 * 60 * 1000) return "warning";
  return "valid";
}

export function slaState(ticket, type = "resolution") {
  if (["resolved", "closed"].includes(ticket.status)) return "done";
  if (type === "response" && ticket.first_response_at) return "done";
  if (ticket.status === "waiting" || ticket.sla_paused_at) return "paused";
  const dueAt = type === "response" ? ticket.response_due_at : ticket.resolution_due_at;
  if (!dueAt) return "neutral";
  const remaining = new Date(dueAt).getTime() - Date.now();
  if (remaining <= 0) return "escalated";
  if (remaining <= 60 * 60 * 1000) return "warning";
  return "ok";
}

export function deadlineText(value, state) {
  if (!value) return "Nicht festgelegt";
  if (state === "done") return `Erledigt · ${formatDateTime(value)}`;
  if (state === "paused") return `Pausiert · Ziel ${formatDateTime(value)}`;
  const minutes = Math.round((new Date(value).getTime() - Date.now()) / 60000);
  if (minutes < 0) return `${Math.abs(minutes)} Min. überschritten`;
  if (minutes < 60) return `noch ${minutes} Min.`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `noch ${hours} Std.`;
  return `noch ${Math.round(hours / 24)} Tage`;
}

export function formatMinutes(value) {
  const minutes = Number(value ?? 0);
  if (minutes < 60) return `${minutes} Min.`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} Std. ${rest} Min.` : `${hours} Std.`;
}

export function formatTicks(value) {
  const ticks = Number(value ?? 0);
  return `${ticks} ${ticks === 1 ? "Takt" : "Takte"}`;
}

export function formatDate(value) {
  if (!value) return "–";
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium" }).format(new Date(value));
}

export function formatDateTime(value) {
  if (!value) return "–";
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function formatDateTimeInput(value) {
  if (!value) return "";
  const date = new Date(value);
  const pad = (part) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function initials(name = "") {
  return String(name ?? "").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

export const helpers = { statusLabel, priorityLabel, roleLabel, slaLabel, customerStatusLabel, assetStatusLabel, ticketChannelLabel, warrantyState, slaState, deadlineText, formatMinutes, formatTicks, formatDate, formatDateTime, formatDateTimeInput, initials };
