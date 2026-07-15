import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase, seedAdmin } from "./db.js";

const config = loadConfig();
const pool = await createDatabase(config);
await seedAdmin(pool, config);

const app = createApp({ pool, config });
const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`${config.companyName} läuft auf Port ${config.port}`);
});

async function shutdown(signal) {
  console.log(`${signal} empfangen, Tixaro wird beendet …`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
