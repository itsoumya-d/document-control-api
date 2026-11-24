import { readFileSync } from "node:fs";
import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import {
  classifyDocumentContent,
  calculateRetentionSchedule,
  evaluateBatchCompliance,
} from "../src/compliance.js";
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

describe("records compliance and retention classification", () => {
  it("classifies financial records with IRD number as IN_CONFIDENCE and 7 years retention", () => {
    const res = classifyDocumentContent(
      "Annual Tax Return 2024",
      "Company IRD number 123-456-789. Audit finding shows balanced ledger."
    );
    expect(res.category).toBe("FINANCIAL");
    expect(res.sensitivity).toBe("IN_CONFIDENCE");
    expect(res.statutoryScheduleYears).toBe(7);
    expect(res.disposalAction).toBe("DESTROY");
    expect(res.matchedRules).toContain("financial-tax-audit");
  });

  it("classifies ministerial policy as RESTRICTED with 25-year archive transfer", () => {
    const res = classifyDocumentContent(
      "Cabinet in Confidence: Regulatory Strategy",
      "This ministerial briefing contains statutory regulation guidelines for public infrastructure."
    );
    expect(res.category).toBe("GOVERNANCE_POLICY");
    expect(res.sensitivity).toBe("RESTRICTED");
    expect(res.statutoryScheduleYears).toBe(25);
    expect(res.disposalAction).toBe("TRANSFER_TO_ARCHIVES");
    expect(res.matchedRules).toContain("executive-cabinet-policy");
  });

  it("classifies personnel health & disciplinary records as SENSITIVE", () => {
    const res = classifyDocumentContent(
      "HR Performance Review & Medical Certificate",
      "Confidential salary review and disciplinary hearing summary."
    );
    expect(res.category).toBe("PERSONNEL");
    expect(res.sensitivity).toBe("SENSITIVE");
    expect(res.statutoryScheduleYears).toBe(7);
    expect(res.disposalAction).toBe("DESTROY");
  });

  it("calculates retention dates and identifies overdue disposal", () => {
    const classification = classifyDocumentContent("Old Project Invoice", "Tax return reference 98-765-432");
    // Created 8 years ago
    const oldDate = new Date();
    oldDate.setFullYear(oldDate.getFullYear() - 8);

    const schedule = calculateRetentionSchedule(classification, oldDate);
    expect(schedule.isDisposalDue).toBe(true);
    expect(schedule.daysUntilDisposal).toBeLessThan(0);
  });

  it("evaluates batch records and aggregates sensitivity breakdown", () => {
    const batch = [
      { id: "doc-1", title: "Meeting Minutes", content: "General project update.", createdDate: "2024-01-01" },
      { id: "doc-2", title: "Tax Filing", content: "IRD number 44-555-666 audit finding.", createdDate: "2024-01-01" },
      { id: "doc-3", title: "Board Charter", content: "Cabinet in confidence executive charter.", createdDate: "2024-01-01" },
    ];

    const summary = evaluateBatchCompliance(batch);
    expect(summary.total).toBe(3);
    expect(summary.bySensitivity.UNCLASSIFIED).toBe(1);
    expect(summary.bySensitivity.IN_CONFIDENCE).toBe(1);
    expect(summary.bySensitivity.RESTRICTED).toBe(1);
    expect(summary.byAction.TRANSFER_TO_ARCHIVES).toBe(1);
    expect(summary.flaggedCount).toBe(1); // RESTRICTED is flagged
  });

  it("serves compliance classify and batch evaluate endpoints via Fastify", async () => {
    const db = testDatabase();
    const app = buildApp(db, "test-api-key");

    const classifyRes = await app.inject({
      method: "POST",
      url: "/compliance/classify",
      headers: { "x-api-key": "test-api-key" },
      payload: {
        title: "Vendor Agreement",
        content: "Master services agreement with pricing schedule and commercial in confidence deed.",
      },
    });

    expect(classifyRes.statusCode).toBe(200);
    const body = JSON.parse(classifyRes.body);
    expect(body.classification.category).toBe("LEGAL_CONTRACT");
    expect(body.classification.statutoryScheduleYears).toBe(10);

    const batchRes = await app.inject({
      method: "POST",
      url: "/compliance/evaluate-batch",
      headers: { "x-api-key": "test-api-key" },
      payload: {
        records: [
          { id: 101, title: "Employee Health", content: "Medical certificate and leave report." },
          { id: 102, title: "Notes", content: "Temporary scratchpad notes." },
        ],
      },
    });

    expect(batchRes.statusCode).toBe(200);
    const batchBody = JSON.parse(batchRes.body);
    expect(batchBody.total).toBe(2);
    expect(batchBody.bySensitivity.SENSITIVE).toBe(1);
    expect(batchBody.bySensitivity.UNCLASSIFIED).toBe(1);
    await db.close();
  });
});
