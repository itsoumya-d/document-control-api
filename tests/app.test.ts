import { readFileSync } from "node:fs";
import { newDb } from "pg-mem";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { Database } from "../src/db.js";

const schema = readFileSync(new URL("../src/schema.sql", import.meta.url), "utf8");

function testDatabase(): Database {
  const mem = newDb();
  mem.public.none(schema);
  const adapter = mem.adapters.createPg();
  const pool = new adapter.Pool();
  return {
    async query(sql: string, params: unknown[] = []) {
      const result = await pool.query(sql, params);
      return result.rows;
    },
    async close() { await pool.end(); }
  };
}

describe("document control API", () => {
  let db: Database;
  let app: ReturnType<typeof buildApp>;
  const headers = { "x-api-key": "test-key" };

  beforeEach(() => {
    db = testDatabase();
    app = buildApp(db, "test-key");
  });

  async function workspace() {
    const response = await app.inject({ method: "POST", url: "/workspaces", headers, payload: { code: "MAT-1", name: "Matter 1", client: "Acme Legal", retention_years: 7 } });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  async function document(workspaceId: number, number = "DOC-1") {
    const response = await app.inject({ method: "POST", url: "/documents", headers, payload: {
      workspace_id: workspaceId, document_number: number, title: "Affidavit", filename: "affidavit.docx", content: "draft content", actor: "sam"
    } });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  it("serves health without auth", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("rejects missing API key", async () => {
    expect((await app.inject({ method: "POST", url: "/workspaces", payload: {} })).statusCode).toBe(401);
  });

  it("creates a workspace", async () => {
    expect((await workspace()).code).toBe("MAT-1");
  });

  it("rejects duplicate workspace", async () => {
    await workspace();
    const response = await app.inject({ method: "POST", url: "/workspaces", headers, payload: { code: "MAT-1", name: "Again", client: "Acme" } });
    expect(response.statusCode).toBe(422);
  });

  it("creates a document and first version", async () => {
    const w = await workspace();
    const d = await document(w.id);
    expect(d.current_version).toBe(1);
    const versions = await app.inject({ method: "GET", url: `/documents/${d.id}/versions`, headers });
    expect(versions.json().versions).toHaveLength(1);
  });

  it("rejects duplicate document number", async () => {
    const w = await workspace();
    await document(w.id);
    const response = await app.inject({ method: "POST", url: "/documents", headers, payload: { workspace_id: w.id, document_number: "DOC-1", title: "Again", filename: "x.docx", content: "x", actor: "sam" } });
    expect(response.statusCode).toBe(422);
  });

  it("checks out a document", async () => {
    const w = await workspace();
    const d = await document(w.id);
    const response = await app.inject({ method: "POST", url: `/documents/${d.id}/checkout`, headers, payload: { actor: "sam" } });
    expect(response.json().status).toBe("checked_out");
  });

  it("prevents a second actor checking out", async () => {
    const w = await workspace();
    const d = await document(w.id);
    await app.inject({ method: "POST", url: `/documents/${d.id}/checkout`, headers, payload: { actor: "sam" } });
    const response = await app.inject({ method: "POST", url: `/documents/${d.id}/checkout`, headers, payload: { actor: "alex" } });
    expect(response.statusCode).toBe(422);
  });

  it("is idempotent for the same actor", async () => {
    const w = await workspace();
    const d = await document(w.id);
    await app.inject({ method: "POST", url: `/documents/${d.id}/checkout`, headers, payload: { actor: "sam" } });
    const response = await app.inject({ method: "POST", url: `/documents/${d.id}/checkout`, headers, payload: { actor: "sam" } });
    expect(response.json().unchanged).toBe(true);
  });

  it("checks in a new version", async () => {
    const w = await workspace();
    const d = await document(w.id);
    await app.inject({ method: "POST", url: `/documents/${d.id}/checkout`, headers, payload: { actor: "sam" } });
    const response = await app.inject({ method: "POST", url: `/documents/${d.id}/checkin`, headers, payload: { actor: "sam", filename: "affidavit-v2.docx", content: "final content" } });
    expect(response.json().version).toBe(2);
  });

  it("rejects check-in by another actor", async () => {
    const w = await workspace();
    const d = await document(w.id);
    await app.inject({ method: "POST", url: `/documents/${d.id}/checkout`, headers, payload: { actor: "sam" } });
    const response = await app.inject({ method: "POST", url: `/documents/${d.id}/checkin`, headers, payload: { actor: "alex", filename: "x", content: "x" } });
    expect(response.statusCode).toBe(422);
  });

  it("lists versions", async () => {
    const w = await workspace();
    const d = await document(w.id);
    await app.inject({ method: "POST", url: `/documents/${d.id}/checkout`, headers, payload: { actor: "sam" } });
    await app.inject({ method: "POST", url: `/documents/${d.id}/checkin`, headers, payload: { actor: "sam", filename: "v2", content: "v2" } });
    const response = await app.inject({ method: "GET", url: `/documents/${d.id}/versions`, headers });
    expect(response.json().versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
  });

  it("searches by title", async () => {
    const w = await workspace();
    await document(w.id);
    const response = await app.inject({ method: "GET", url: `/workspaces/${w.id}/search?q=affid`, headers });
    expect(response.json().results).toHaveLength(1);
  });

  it("archives a document", async () => {
    const w = await workspace();
    const d = await document(w.id);
    const response = await app.inject({ method: "POST", url: `/documents/${d.id}/archive`, headers, payload: { actor: "sam" } });
    expect(response.json().status).toBe("archived");
  });

  it("blocks archiving a checked-out document", async () => {
    const w = await workspace();
    const d = await document(w.id);
    await app.inject({ method: "POST", url: `/documents/${d.id}/checkout`, headers, payload: { actor: "sam" } });
    const response = await app.inject({ method: "POST", url: `/documents/${d.id}/archive`, headers, payload: { actor: "sam" } });
    expect(response.statusCode).toBe(422);
  });

  it("records activities", async () => {
    const w = await workspace();
    const d = await document(w.id);
    const response = await app.inject({ method: "GET", url: `/documents/${d.id}/activities`, headers });
    expect(response.json().activities[0].action).toBe("document_created");
  });

  it("returns 404 for missing document", async () => {
    const response = await app.inject({ method: "GET", url: "/documents/999/versions", headers });
    expect(response.statusCode).toBe(404);
  });

  it("runs the full document lifecycle", async () => {
    const w = await workspace();
    const d = await document(w.id, "DOC-FULL");
    await app.inject({ method: "POST", url: `/documents/${d.id}/checkout`, headers, payload: { actor: "sam" } });
    const checked = await app.inject({ method: "POST", url: `/documents/${d.id}/checkin`, headers, payload: { actor: "sam", filename: "final", content: "final" } });
    expect(checked.json().status).toBe("checked_in");
    const archived = await app.inject({ method: "POST", url: `/documents/${d.id}/archive`, headers, payload: { actor: "sam" } });
    expect(archived.json().status).toBe("archived");
  });
});
