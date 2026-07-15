export async function loadTicketConfiguration(pool, { includeInactive = false } = {}) {
  const activeClause = includeInactive ? "" : "WHERE active = TRUE";
  const [queueResult, typeResult, slaResult] = await Promise.all([
    pool.query(
      `SELECT q.*, parent.name AS parent_name
       FROM ticket_queues q LEFT JOIN ticket_queues parent ON parent.id = q.parent_id
       ${includeInactive ? "" : "WHERE q.active = TRUE"}
       ORDER BY q.sort_order, q.name`
    ),
    pool.query(`SELECT * FROM ticket_type_options ${activeClause} ORDER BY sort_order, name`),
    pool.query(`SELECT * FROM sla_policies ${activeClause} ORDER BY sort_order, name`)
  ]);

  const queueRecords = queueResult.rows;
  const ticketTypeRecords = typeResult.rows;
  const slaRecords = slaResult.rows;
  const slaOptions = slaRecords.map((row) => ({
    value: row.code,
    label: row.name,
    responseMinutes: Number(row.response_minutes),
    resolutionMinutes: Number(row.resolution_minutes),
    active: row.active
  }));
  const slaDefinitions = Object.fromEntries(slaOptions.map((item) => [item.value, item]));

  return {
    queueRecords,
    queues: queueRecords.map((row) => row.name),
    ticketTypeRecords,
    ticketTypes: ticketTypeRecords.map((row) => row.name),
    slaRecords,
    slaOptions,
    slaDefinitions
  };
}

export async function loadAssetTypes(pool, { includeInactive = false } = {}) {
  const result = await pool.query(
    `SELECT * FROM asset_type_options ${includeInactive ? "" : "WHERE active = TRUE"} ORDER BY sort_order, name`
  );
  return {
    assetTypeRecords: result.rows,
    assetTypes: result.rows.map((row) => row.name)
  };
}

export function defaultSlaCode(configuration, preferred = "standard") {
  if (configuration.slaDefinitions[preferred]) return preferred;
  return configuration.slaOptions[0]?.value ?? "standard";
}
