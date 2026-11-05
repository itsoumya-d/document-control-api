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

describe("structured content governance", () => {
  let db: Database;
  let app: ReturnType<typeof buildApp>;
  const headers = { "x-api-key": "test-key" };
  let documentSequence = 0;

  beforeEach(() => {
    db = testDatabase();
    app = buildApp(db, "test-key");
    documentSequence = 0;
  });

  async function workspace(code = "PHARMA-1") {
    const response = await app.inject({ method: "POST", url: "/workspaces", headers, payload: { code, name: "Regulatory", client: "Acme Pharma", retention_years: 10 } });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  async function document(workspaceId: number) {
    documentSequence += 1;
    const response = await app.inject({ method: "POST", url: "/documents", headers, payload: {
      workspace_id: workspaceId,
      document_number: `DOC-${documentSequence}`,
      title: "Labeling document",
      filename: `doc-${documentSequence}.docx`,
      content: "draft content",
      actor: "writer"
    } });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  async function component(workspaceId: number, code = "COMP-1") {
    const response = await app.inject({ method: "POST", url: `/workspaces/${workspaceId}/components`, headers, payload: {
      code, title: "Approved indication", content: "Take one tablet daily", actor: "writer"
    } });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  async function approveComponent(componentId: number, version = 1) {
    const response = await app.inject({ method: "POST", url: `/components/${componentId}/versions/${version}/approve`, headers, payload: { actor: "reviewer" } });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  async function reference(documentId: number, componentId: number, version = 1) {
    return app.inject({ method: "POST", url: `/documents/${documentId}/components`, headers, payload: { component_id: componentId, component_version: version, actor: "writer" } });
  }

  it("creates a component with a draft first version", async () => {
    const w = await workspace();
    const c = await component(w.id);
    expect(c.code).toBe("COMP-1");
    expect(c.current_version).toBe(1);
    expect(c.version.status).toBe("draft");
    expect(c.version.content_sha256).toHaveLength(64);
  });

  it("rejects duplicate component codes in a workspace", async () => {
    const w = await workspace();
    await component(w.id);
    const response = await app.inject({ method: "POST", url: `/workspaces/${w.id}/components`, headers, payload: { code: "COMP-1", title: "Again", content: "x", actor: "writer" } });
    expect(response.statusCode).toBe(422);
  });

  it("adds a new version and moves the current version", async () => {
    const w = await workspace();
    const c = await component(w.id);
    const response = await app.inject({ method: "POST", url: `/components/${c.id}/versions`, headers, payload: { content: "Take two tablets daily", actor: "writer" } });
    expect(response.statusCode).toBe(201);
    expect(response.json().version).toBe(2);
    const list = await app.inject({ method: "GET", url: `/workspaces/${w.id}/components`, headers });
    expect(list.json().components[0].current_version).toBe(2);
  });

  it("approves a component version", async () => {
    const w = await workspace();
    const c = await component(w.id);
    const approved = await approveComponent(c.id, 1);
    expect(approved.status).toBe("approved");
    const list = await app.inject({ method: "GET", url: `/workspaces/${w.id}/components`, headers });
    expect(list.json().components[0].status).toBe("approved");
  });

  it("rejects a dependency cycle", async () => {
    const w = await workspace();
    const a = await component(w.id, "A");
    const b = await component(w.id, "B");
    const first = await app.inject({ method: "POST", url: `/components/${a.id}/dependencies`, headers, payload: { depends_on_id: b.id, actor: "writer" } });
    expect(first.statusCode).toBe(200);
    const cycle = await app.inject({ method: "POST", url: `/components/${b.id}/dependencies`, headers, payload: { depends_on_id: a.id, actor: "writer" } });
    expect(cycle.statusCode).toBe(422);
  });

  it("rejects self dependencies", async () => {
    const w = await workspace();
    const a = await component(w.id);
    const response = await app.inject({ method: "POST", url: `/components/${a.id}/dependencies`, headers, payload: { depends_on_id: a.id, actor: "writer" } });
    expect(response.statusCode).toBe(422);
  });

  it("references a component from a document", async () => {
    const w = await workspace();
    const d = await document(w.id);
    const c = await component(w.id);
    const response = await reference(d.id, c.id, 1);
    expect(response.statusCode).toBe(200);
    expect(response.json().component_version).toBe(1);
  });

  it("approves a document when every reference is approved and current", async () => {
    const w = await workspace();
    const d = await document(w.id);
    const c = await component(w.id);
    await approveComponent(c.id, 1);
    await reference(d.id, c.id, 1);
    const response = await app.inject({ method: "POST", url: `/documents/${d.id}/approve`, headers, payload: { actor: "qa" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("approved");
    const approval = await app.inject({ method: "GET", url: `/documents/${d.id}/approval`, headers });
    expect(approval.json().status).toBe("approved");
  });

  it("blocks document approval while a component is still draft", async () => {
    const w = await workspace();
    const d = await document(w.id);
    const c = await component(w.id);
    await reference(d.id, c.id, 1);
    const response = await app.inject({ method: "POST", url: `/documents/${d.id}/approve`, headers, payload: { actor: "qa" } });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain("not approved");
  });

  it("blocks document approval when a newer component version exists", async () => {
    const w = await workspace();
    const d = await document(w.id);
    const c = await component(w.id);
    await approveComponent(c.id, 1);
    await reference(d.id, c.id, 1);
    await app.inject({ method: "POST", url: `/components/${c.id}/versions`, headers, payload: { content: "Updated content", actor: "writer" } });
    const response = await app.inject({ method: "POST", url: `/documents/${d.id}/approve`, headers, payload: { actor: "qa" } });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain("newer version");
  });

  it("blocks document approval when a component is deprecated", async () => {
    const w = await workspace();
    const d = await document(w.id);
    const c = await component(w.id);
    await approveComponent(c.id, 1);
    await reference(d.id, c.id, 1);
    await app.inject({ method: "POST", url: `/components/${c.id}/deprecate`, headers, payload: { actor: "qa" } });
    const response = await app.inject({ method: "POST", url: `/documents/${d.id}/approve`, headers, payload: { actor: "qa" } });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain("deprecated");
  });

  it("computes direct and transitive impact", async () => {
    const w = await workspace();
    const d = await document(w.id);
    const a = await component(w.id, "A");
    const b = await component(w.id, "B");
    const c = await component(w.id, "C");
    await app.inject({ method: "POST", url: `/components/${b.id}/dependencies`, headers, payload: { depends_on_id: a.id, actor: "writer" } });
    await app.inject({ method: "POST", url: `/components/${c.id}/dependencies`, headers, payload: { depends_on_id: b.id, actor: "writer" } });
    await reference(d.id, c.id, 1);

    const response = await app.inject({ method: "GET", url: `/components/${a.id}/impact`, headers });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.direct_dependents).toEqual([b.id]);
    expect(body.transitive_dependents.sort()).toEqual([b.id, c.id].sort());
    expect(body.affected_document_ids).toContain(d.id);
  });

  it("flags stale references in impact analysis", async () => {
    const w = await workspace();
    const d = await document(w.id);
    const a = await component(w.id, "A");
    await approveComponent(a.id, 1);
    await reference(d.id, a.id, 1);
    await app.inject({ method: "POST", url: `/components/${a.id}/versions`, headers, payload: { content: "v2", actor: "writer" } });
    const response = await app.inject({ method: "GET", url: `/components/${a.id}/impact`, headers });
    expect(response.json().stale_references).toHaveLength(1);
    expect(response.json().stale_references[0].document_id).toBe(d.id);
  });

  it("reports reuse metrics", async () => {
    const w = await workspace();
    const d1 = await document(w.id);
    const d2 = await document(w.id);
    const d3 = await document(w.id);
    const a = await component(w.id, "A");
    const b = await component(w.id, "B");
    await reference(d1.id, a.id, 1);
    await reference(d2.id, a.id, 1);
    await reference(d3.id, b.id, 1);
    const response = await app.inject({ method: "GET", url: `/workspaces/${w.id}/reuse`, headers });
    const body = response.json();
    expect(body.document_references).toBe(3);
    expect(body.unique_components_referenced).toBe(2);
    expect(body.reused_references).toBe(1);
    expect(body.reuse_rate_percent).toBe(33.33);
  });

  it("rejects references to a version that does not exist", async () => {
    const w = await workspace();
    const d = await document(w.id);
    const c = await component(w.id);
    const response = await reference(d.id, c.id, 2);
    expect(response.statusCode).toBe(422);
  });

  it("rejects cross-workspace dependencies", async () => {
    const w1 = await workspace("WS-1");
    const w2 = await workspace("WS-2");
    const a = await component(w1.id, "A");
    const b = await component(w2.id, "B");
    const response = await app.inject({ method: "POST", url: `/components/${a.id}/dependencies`, headers, payload: { depends_on_id: b.id, actor: "writer" } });
    expect(response.statusCode).toBe(422);
  });

  it("defaults a document to unapproved", async () => {
    const w = await workspace();
    const d = await document(w.id);
    const response = await app.inject({ method: "GET", url: `/documents/${d.id}/approval`, headers });
    expect(response.json().status).toBe("unapproved");
  });

  it("rejects document approval when there are no component references", async () => {
    const w = await workspace();
    const d = await document(w.id);
    const response = await app.inject({ method: "POST", url: `/documents/${d.id}/approve`, headers, payload: { actor: "qa" } });
    expect(response.statusCode).toBe(422);
  });
});
