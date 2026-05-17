import postgres from "postgres";

import { buildServer } from "./api/server";

const databaseUrl = process.env["DATABASE_URL"]?.trim();
const port = Number(process.env["PORT"] ?? "3010");
const host = process.env["HOST"] ?? "0.0.0.0";

if (!databaseUrl) throw new Error("DATABASE_URL must be set");

const sql = postgres(databaseUrl, { max: 8 });
const app = await buildServer(sql);

const close = async () => {
  await app.close();
  await sql.end();
  process.exit(0);
};

process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());

await app.listen({ host, port });
