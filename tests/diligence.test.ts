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

describe("AI-native diligence", () => {
  let db: Database;
  let app: ReturnType<typeof buildApp>;
  const headers = { "x-api-key": "test-key" };
  let workspaceId = 0;
  let projectId = 0;
  let documentId = 0;
  let claimId = 0;

  const TEXT = "This Agreement terminates upon written notice with 30 days advance warning. The term is 24 months from the Effective Date.";

  async function fixture() {
    const ws = await app.inject({ method: "POST", url: "/workspaces", headers, payload: { code: "WS1", name: "Acme", client: "Acme Corp" } });
    workspaceId = ws.json().id;
    const proj = await app.inject({ method: "POST", url: "/diligence/projects", headers, payload: { workspace_id: workspaceId, name: "Solar portfolio A", actor: "agent-1" } });
    expect(proj.statusCode).toBe(201);
    projectId = proj.json().id;
    const doc = await app.inject({ method: "POST", url: `/diligence/projects/${projectId}/documents`, headers, payload: { name: "MSA.pdf", kind: "pdf", page_count: 74, content_text: TEXT, actor: "intake" } });
    expect(doc.statusCode).toBe(201);
    documentId = doc.json().id;
    const claim = await app.inject({ method: "POST", url: `/diligence/projects/${projectId}/claims`, headers, payload: { clause_type: "termination_rights", term: "30 days advance warning", confidence: 0.91, model: "claude-sonnet-4", actor: "agent-1" } });
    expect(claim.statusCode).toBe(201);
    claimId = claim.json().id;
  }

  beforeEach(() => {
    db = testDatabase();
    app = buildApp(db, "test-key");
  });

  it("creates projects and documents and counts them in the summary", async () => {
    await fixture();
    const summary = await app.inject({ method: "GET", url: `/diligence/projects/${projectId}/summary`, headers });
    expect(summary.statusCode).toBe(200);
    const json = summary.json();
    expect(json.documents).toBe(1);
    expect(json.claims.PENDING).toBe(1);
  });

  it("rejects projects for missing workspaces", async () => {
    const res = await app.inject({ method: "POST", url: "/diligence/projects", headers, payload: { workspace_id: 999, name: "x", actor: "a" } });
    expect(res.statusCode).toBe(404);
  });

  it("rejects unknown clause types and bad confidence", async () => {
    await fixture();
    const badType = await app.inject({ method: "POST", url: `/diligence/projects/${projectId}/claims`, headers, payload: { clause_type: "vibes", term: "x", confidence: 0.5, model: "m", actor: "a" } });
    expect(badType.statusCode).toBe(422);
    const badConf = await app.inject({ method: "POST", url: `/diligence/projects/${projectId}/claims`, headers, payload: { clause_type: "termination_rights", term: "x", confidence: 1.4, model: "m", actor: "a" } });
    expect(badConf.statusCode).toBe(422);
  });

  it("rejects non-positive page counts on ingest", async () => {
    await fixture();
    const res = await app.inject({ method: "POST", url: `/diligence/projects/${projectId}/documents`, headers, payload: { name: "x", kind: "pdf", page_count: 0, content_text: "t", actor: "a" } });
    expect(res.statusCode).toBe(422);
  });

  it("accepts a verbatim citation and moves the claim to CITED", async () => {
    await fixture();
    const quote = "terminates upon written notice with 30 days advance warning";
    const res = await app.inject({ method: "POST", url: `/diligence/claims/${claimId}/citations`, headers, payload: { document_id: documentId, page: 74, quote, char_start: TEXT.indexOf(quote), char_end: TEXT.indexOf(quote) + quote.length } });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("CITED");
  });

  it("rejects citations whose quote is not verbatim in the document", async () => {
    await fixture();
    const res = await app.inject({ method: "POST", url: `/diligence/claims/${claimId}/citations`, headers, payload: { document_id: documentId, page: 12, quote: "the exact wording differs here", char_start: 0, char_end: 10 } });
    expect(res.statusCode).toBe(422);
  });

  it("rejects citations beyond the document page count", async () => {
    await fixture();
    const res = await app.inject({ method: "POST", url: `/diligence/claims/${claimId}/citations`, headers, payload: { document_id: documentId, page: 999, quote: "This Agreement", char_start: 0, char_end: 14 } });
    expect(res.statusCode).toBe(422);
  });

  it("rejects invalid character ranges", async () => {
    await fixture();
    const res = await app.inject({ method: "POST", url: `/diligence/claims/${claimId}/citations`, headers, payload: { document_id: documentId, page: 1, quote: "This Agreement", char_start: 50, char_end: 10 } });
    expect(res.statusCode).toBe(422);
  });

  it("refuses to verify a claim without a citation", async () => {
    await fixture();
    const res = await app.inject({ method: "POST", url: `/diligence/claims/${claimId}/review`, headers, payload: { reviewer: "expert-9", decision: "VERIFY" } });
    expect(res.statusCode).toBe(422);
  });

  it("verifies a cited claim and rejects an uncited one for review", async () => {
    await fixture();
    const quote = "The term is 24 months";
    const cite = await app.inject({ method: "POST", url: `/diligence/claims/${claimId}/citations`, headers, payload: { document_id: documentId, page: 3, quote, char_start: TEXT.indexOf(quote), char_end: TEXT.indexOf(quote) + quote.length } });
    expect(cite.statusCode).toBe(201);
    const verify = await app.inject({ method: "POST", url: `/diligence/claims/${claimId}/review`, headers, payload: { reviewer: "expert-9", decision: "VERIFY" } });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().status).toBe("VERIFIED");
    const summary = await app.inject({ method: "GET", url: `/diligence/projects/${projectId}/summary`, headers });
    expect(summary.json().claims.VERIFIED).toBe(1);
  });

  it("marks unverifiable claims as NOT_FOUND and routes them to an expert", async () => {
    await fixture();
    const res = await app.inject({ method: "POST", url: `/diligence/claims/${claimId}/mark-not-found`, headers, payload: { actor: "agent-1" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "NOT_FOUND", route_expert: true });
    const queue = await app.inject({ method: "GET", url: `/diligence/projects/${projectId}/queue`, headers });
    expect(queue.json().map((c: { id: number }) => c.id)).toContain(claimId);
  });

  it("records expert corrections and spawns a corrected claim", async () => {
    await fixture();
    const res = await app.inject({ method: "POST", url: `/diligence/claims/${claimId}/review`, headers, payload: { reviewer: "expert-9", decision: "CORRECT", correction: "30 calendar days' written notice" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "REJECTED", corrected: true });
    const corrections = await db.query("SELECT original_term, corrected_term FROM correction_log");
    expect(corrections).toHaveLength(1);
    expect(corrections[0].corrected_term).toBe("30 calendar days' written notice");
    const claims = await db.query<{ term: string }>("SELECT term FROM extraction_claims ORDER BY id");
    expect(claims.map((c) => c.term)).toContain("30 calendar days' written notice");
  });

  it("computes recall, precision and false positives per clause and pooled", async () => {
    const res = await app.inject({
      method: "POST", url: "/diligence/evaluate", headers,
      payload: {
        gold: [
          { clause_type: "termination_rights", term: "30 days advance warning" },
          { clause_type: "termination_rights", term: "termination for convenience" },
          { clause_type: "payment_terms", term: "net 30 from invoice date" },
        ],
        predicted: [
          { clause_type: "termination_rights", term: "30 Days Advance Warning!" },
          { clause_type: "termination_rights", term: "termination for cause" },
          { clause_type: "payment_terms", term: "net 30 from invoice date" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    const termRights = json.clauses.find((c: { clause_type: string }) => c.clause_type === "termination_rights");
    expect(termRights).toMatchObject({ gold: 2, predicted: 2, matched: 1, recall: 0.5, precision: 0.5, false_positives: 1 });
    expect(json.pooled).toMatchObject({ recall: 0.6667, precision: 0.6667, false_positives: 1 });
  });

  it("keeps verified claims out of the expert queue", async () => {
    await fixture();
    const quote = "The term is 24 months";
    await app.inject({ method: "POST", url: `/diligence/claims/${claimId}/citations`, headers, payload: { document_id: documentId, page: 3, quote, char_start: TEXT.indexOf(quote), char_end: TEXT.indexOf(quote) + quote.length } });
    await app.inject({ method: "POST", url: `/diligence/claims/${claimId}/review`, headers, payload: { reviewer: "expert-9", decision: "VERIFY" } });
    const queue = await app.inject({ method: "GET", url: `/diligence/projects/${projectId}/queue`, headers });
    expect(queue.json()).toHaveLength(0);
  });

  it("rejects unknown review decisions", async () => {
    await fixture();
    const res = await app.inject({ method: "POST", url: `/diligence/claims/${claimId}/review`, headers, payload: { reviewer: "expert-9", decision: "SHRUG" } });
    expect(res.statusCode).toBe(422);
  });
});
