import pg from "pg";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const app = buildServer(pool, config, true);

await app.listen({ port: config.port, host: "127.0.0.1" });
