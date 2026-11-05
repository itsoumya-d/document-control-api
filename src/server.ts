import { migrate, poolDatabase } from "./db.js";
import { buildApp } from "./app.js";

const databaseUrl = process.env.DATABASE_URL;
const apiKey = process.env.API_KEY;
if (!databaseUrl || !apiKey) { console.error("DATABASE_URL and API_KEY are required"); process.exit(1); }
const db = poolDatabase(databaseUrl);
await migrate(db);
const app = buildApp(db, apiKey);
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8000) });
