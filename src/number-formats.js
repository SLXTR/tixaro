const definitions = Object.freeze({
  ticket: Object.freeze([
    { key: "tix_year_sequence", label: "TIX · Jahr · laufende Nummer", template: "TIX-{YYYY}-{000000}" },
    { key: "tix_sequence", label: "TIX · laufende Nummer", template: "TIX-{000000}" },
    { key: "year_sequence", label: "Jahr · laufende Nummer", template: "{YYYY}-{000000}" },
    { key: "tix_year_month_sequence", label: "TIX · Jahr · Monat · laufende Nummer", template: "TIX-{YYYY}-{MM}-{000000}" }
  ]),
  customer: Object.freeze([
    { key: "knd_sequence", label: "KND · laufende Nummer", template: "KND-{00000}" },
    { key: "knd_year_sequence", label: "KND · Jahr · laufende Nummer", template: "KND-{YYYY}-{00000}" },
    { key: "customer_sequence", label: "C · laufende Nummer", template: "C-{00000}" },
    { key: "numeric", label: "Nur laufende Nummer", template: "{00000}" }
  ])
});

export const defaultNumberFormats = Object.freeze({
  ticket: "tix_year_sequence",
  customer: "knd_sequence"
});

function definition(kind, key) {
  return definitions[kind].find((item) => item.key === key) ?? definitions[kind][0];
}

function formatTemplate(template, id, date = new Date()) {
  return template
    .replaceAll("{YYYY}", String(date.getFullYear()))
    .replaceAll("{YY}", String(date.getFullYear()).slice(-2))
    .replaceAll("{MM}", String(date.getMonth() + 1).padStart(2, "0"))
    .replace(/\{(0+)\}/g, (_match, zeros) => String(id).padStart(zeros.length, "0"));
}

export function numberFormatOptions(kind, date = new Date()) {
  if (!definitions[kind]) return [];
  return definitions[kind].map((item) => ({
    ...item,
    preview: formatTemplate(item.template, 42, date)
  }));
}

export function normalizeNumberFormats(value = {}) {
  return {
    ticket: definition("ticket", value.ticket).key,
    customer: definition("customer", value.customer).key
  };
}

export async function loadNumberFormats(client) {
  const result = await client.query("SELECT value_json FROM system_preferences WHERE key = 'number_formats'");
  return normalizeNumberFormats(result.rows[0]?.value_json ?? defaultNumberFormats);
}

export async function saveNumberFormats(client, value) {
  const formats = normalizeNumberFormats(value);
  await client.query(
    `INSERT INTO system_preferences (key, value_json, updated_at) VALUES ('number_formats', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
    [JSON.stringify(formats)]
  );
  return formats;
}

export async function createTicketNumber(client, id, date = new Date()) {
  const formats = await loadNumberFormats(client);
  return formatTemplate(definition("ticket", formats.ticket).template, id, date);
}

export async function createCustomerNumber(client, id, date = new Date()) {
  const formats = await loadNumberFormats(client);
  return formatTemplate(definition("customer", formats.customer).template, id, date);
}
