const statusLabels = {
  open: "Offen",
  in_progress: "In Bearbeitung",
  waiting: "Wartet",
  resolved: "Gelöst",
  closed: "Geschlossen"
};

const priorityLabels = { low: "Niedrig", normal: "Normal", high: "Hoch", urgent: "Dringend" };
const roleLabels = { admin: "Administrator", agent: "Mitarbeiter", requester: "Anfragende Person" };

export function statusLabel(value) {
  return statusLabels[value] ?? value;
}

export function priorityLabel(value) {
  return priorityLabels[value] ?? value;
}

export function roleLabel(value) {
  return roleLabels[value] ?? value;
}

export function formatDate(value) {
  if (!value) return "–";
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium" }).format(new Date(value));
}

export function formatDateTime(value) {
  if (!value) return "–";
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function initials(name = "") {
  return String(name ?? "").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

export const helpers = { statusLabel, priorityLabel, roleLabel, formatDate, formatDateTime, initials };
