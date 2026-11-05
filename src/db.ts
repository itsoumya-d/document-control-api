import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

export interface Row { [key: string]: unknown }
export interface Database {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export function poolDatabase(url: string): Database {
  const pool = new Pool({ connectionString: url });
  return {
    async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
      const result = await pool.query(sql, params);
      return result.rows as T[];
    },
    async close() { await pool.end(); }
  };
}

export async function migrate(db: Database): Promise<void> {
  const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));
  await db.query(await readFile(schemaPath, "utf8"));
}
