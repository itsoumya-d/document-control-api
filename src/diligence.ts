import { createHash } from "node:crypto";
import { Database } from "./db.js";
import { NotFoundError, ValidationError } from "./service.js";

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

interface ProjectRow {
  [key: string]: unknown;
  id: number;
  workspace_id: number;
  name: string;
  status: string;
}

interface ClaimRow {
  [key: string]: unknown;
  id: number;
  project_id: number;
  clause_type: string;
  term: string;
  confidence: number;
  status: string;
  route_expert: boolean;
}

export interface EvalItem {
  clause_type: string;
  term: string;
}

export interface ClauseMetrics {
  clause_type: string;
  gold: number;
  predicted: number;
  matched: number;
  recall: number;
  precision: number;
  false_positives: number;
}

export const CLAUSE_TYPES = [
  "termination_rights",
  "change_of_control",
  "term_and_renewal",
  "liability_and_indemnity",
  "payment_terms",
  "confidentiality",
] as const;

export function normalizeTerm(term: string): string {
  return term.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export class DiligenceService {
  constructor(private readonly db: Database) {}

  private async project(id: number): Promise<ProjectRow> {
    const rows = await this.db.query<ProjectRow>("SELECT id, workspace_id, name, status FROM diligence_projects WHERE id=$1", [id]);
    if (!rows.length) throw new NotFoundError("diligence project not found");
    return rows[0];
  }

  private async claim(id: number): Promise<ClaimRow> {
    const rows = await this.db.query<ClaimRow>("SELECT id, project_id, clause_type, term, confidence, status, route_expert FROM extraction_claims WHERE id=$1", [id]);
    if (!rows.length) throw new NotFoundError("claim not found");
    return rows[0];
  }

  async createProject(workspaceId: number, name: string, actor: string) {
    if (!name.trim() || !actor.trim()) throw new ValidationError("name and actor are required");
    if (!(await this.db.query("SELECT id FROM workspaces WHERE id=$1", [workspaceId])).length) {
      throw new NotFoundError("workspace not found");
    }
    const rows = await this.db.query<ProjectRow>(
      "INSERT INTO diligence_projects (workspace_id, name, status, created_by) VALUES ($1,$2,'DRAFT',$3) RETURNING id, workspace_id, name, status",
      [workspaceId, name.trim(), actor]
    );
    return rows[0];
  }

  async ingestDocument(projectId: number, name: string, kind: string, pageCount: number, contentText: string, actor: string) {
    if (!name.trim() || !kind.trim() || !contentText.trim()) {
      throw new ValidationError("name, kind and content_text are required");
    }
    if (!Number.isInteger(pageCount) || pageCount <= 0) throw new ValidationError("page_count must be a positive integer");
    await this.project(projectId);
    const rows = await this.db.query<{ id: number; name: string; status: string }>(
      "INSERT INTO ingested_documents (project_id, name, kind, page_count, content_text, content_sha256, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,'PARSED',$7) RETURNING id, name, status",
      [projectId, name.trim(), kind.trim(), pageCount, contentText, hash(contentText), actor]
    );
    return rows[0];
  }

  async createClaim(projectId: number, clauseType: string, term: string, confidence: number, model: string, actor: string) {
    if (!CLAUSE_TYPES.includes(clauseType as (typeof CLAUSE_TYPES)[number])) {
      throw new ValidationError(`clause_type must be one of ${CLAUSE_TYPES.join(", ")}`);
    }
    if (!term.trim() || !model.trim() || !actor.trim()) throw new ValidationError("term, model and actor are required");
    if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
      throw new ValidationError("confidence must be between 0 and 1");
    }
    await this.project(projectId);
    const rows = await this.db.query<ClaimRow>(
      "INSERT INTO extraction_claims (project_id, clause_type, term, confidence, model, status, created_by) VALUES ($1,$2,$3,$4,$5,'PENDING',$6) RETURNING id, project_id, clause_type, term, confidence, status, route_expert",
      [projectId, clauseType, term.trim(), confidence, model, actor]
    );
    return rows[0];
  }

  async addCitation(claimId: number, documentId: number, page: number, quote: string, charStart: number, charEnd: number) {
    const claim = await this.claim(claimId);
    if (!Number.isInteger(page) || page <= 0) throw new ValidationError("page must be a positive integer");
    if (!quote.trim()) throw new ValidationError("quote is required");
    if (!Number.isInteger(charStart) || !Number.isInteger(charEnd) || charStart < 0 || charEnd < charStart) {
      throw new ValidationError("char_start must be >= 0 and char_end must be >= char_start");
    }
    const docs = await this.db.query<{ id: number; content_text: string; page_count: number }>(
      "SELECT id, content_text, page_count FROM ingested_documents WHERE id=$1 AND project_id=$2",
      [documentId, claim.project_id]
    );
    if (!docs.length) throw new NotFoundError("document not found in this project");
    const doc = docs[0];
    if (page > doc.page_count) throw new ValidationError(`page ${page} exceeds page_count ${doc.page_count}`);
    // The quote must appear verbatim in the cited document — never a paraphrase,
    // never an invented span. This is the never-guess invariant.
    if (!doc.content_text.includes(quote)) {
      throw new ValidationError("citation quote not found verbatim in the cited document");
    }
    const rows = await this.db.query<{ id: number; claim_id: number; page: number }>(
      "INSERT INTO claim_citations (claim_id, ingested_document_id, page, quote, char_start, char_end) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, claim_id, page",
      [claimId, documentId, page, quote, charStart, charEnd]
    );
    if (claim.status === "PENDING") {
      await this.db.query("UPDATE extraction_claims SET status='CITED' WHERE id=$1", [claimId]);
    }
    return { ...rows[0], status: claim.status === "PENDING" ? "CITED" : claim.status };
  }

  async markNotFound(claimId: number, actor: string) {
    const claim = await this.claim(claimId);
    if (!actor.trim()) throw new ValidationError("actor is required");
    if (claim.status === "VERIFIED") throw new ValidationError("verified claims cannot be marked not found");
    await this.db.query("UPDATE extraction_claims SET status='NOT_FOUND', route_expert=true WHERE id=$1", [claimId]);
    await this.db.query("INSERT INTO review_decisions (claim_id, reviewer, decision) VALUES ($1,$2,'ROUTE_EXPERT')", [claimId, actor]);
    return { id: claimId, status: "NOT_FOUND", route_expert: true };
  }

  async review(claimId: number, reviewer: string, decision: string, correction?: string) {
    const claim = await this.claim(claimId);
    if (!reviewer.trim()) throw new ValidationError("reviewer is required");
    if (!["VERIFY", "REJECT", "CORRECT"].includes(decision)) {
      throw new ValidationError("decision must be VERIFY, REJECT or CORRECT");
    }
    if (decision === "VERIFY") {
      const citations = await this.db.query("SELECT id FROM claim_citations WHERE claim_id=$1", [claimId]);
      if (!citations.length) throw new ValidationError("cannot verify a claim without a citation");
      await this.db.query("UPDATE extraction_claims SET status='VERIFIED', route_expert=false WHERE id=$1", [claimId]);
      await this.db.query("INSERT INTO review_decisions (claim_id, reviewer, decision) VALUES ($1,$2,'APPROVE')", [claimId, reviewer]);
      return { id: claimId, status: "VERIFIED" };
    }
    if (decision === "REJECT") {
      await this.db.query("UPDATE extraction_claims SET status='REJECTED' WHERE id=$1", [claimId]);
      await this.db.query("INSERT INTO review_decisions (claim_id, reviewer, decision) VALUES ($1,$2,'REJECT')", [claimId, reviewer]);
      return { id: claimId, status: "REJECTED" };
    }
    if (!correction?.trim()) throw new ValidationError("correction text is required for CORRECT");
    await this.db.query(
      "INSERT INTO correction_log (claim_id, reviewer, original_term, corrected_term) VALUES ($1,$2,$3,$4)",
      [claimId, reviewer, claim.term, correction.trim()]
    );
    await this.db.query(
      "INSERT INTO extraction_claims (project_id, clause_type, term, confidence, model, status, created_by, supersedes_id) VALUES ($1,$2,$3,1,'human-correction','PENDING',$4,$5)",
      [claim.project_id, claim.clause_type, correction.trim(), reviewer, claimId]
    );
    await this.db.query("INSERT INTO review_decisions (claim_id, reviewer, decision) VALUES ($1,$2,'CORRECT')", [claimId, reviewer]);
    await this.db.query("UPDATE extraction_claims SET status='REJECTED' WHERE id=$1", [claimId]);
    return { id: claimId, status: "REJECTED", corrected: true };
  }

  async expertQueue(projectId: number) {
    await this.project(projectId);
    return this.db.query(
      "SELECT c.id, c.clause_type, c.term, c.confidence, c.status, c.route_expert, c.created_at FROM extraction_claims c WHERE c.project_id=$1 AND c.status IN ('PENDING','NOT_FOUND') ORDER BY c.created_at",
      [projectId]
    );
  }

  async summary(projectId: number) {
    await this.project(projectId);
    const claims = await this.db.query<{ status: string; n: string }>(
      "SELECT status, count(*)::text AS n FROM extraction_claims WHERE project_id=$1 GROUP BY status",
      [projectId]
    );
    const docs = await this.db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM ingested_documents WHERE project_id=$1",
      [projectId]
    );
    const byStatus: Record<string, number> = {};
    for (const row of claims) byStatus[row.status] = Number(row.n);
    return { project_id: projectId, documents: Number(docs[0].n), claims: byStatus };
  }

  evaluate(gold: EvalItem[], predicted: EvalItem[]): { clauses: ClauseMetrics[]; pooled: { recall: number; precision: number; false_positives: number } } {
    const types = [...new Set([...gold.map((g) => g.clause_type), ...predicted.map((p) => p.clause_type)])].sort();
    const clauses: ClauseMetrics[] = types.map((clause_type) => {
      const goldTerms = new Set(gold.filter((g) => g.clause_type === clause_type).map((g) => normalizeTerm(g.term)));
      const predTerms = predicted.filter((p) => p.clause_type === clause_type).map((p) => normalizeTerm(p.term));
      const matched = predTerms.filter((t) => goldTerms.has(t)).length;
      const recall = goldTerms.size === 0 ? 0 : matched / goldTerms.size;
      const precision = predTerms.length === 0 ? 0 : matched / predTerms.length;
      return {
        clause_type,
        gold: goldTerms.size,
        predicted: predTerms.length,
        matched,
        recall: round4(recall),
        precision: round4(precision),
        false_positives: predTerms.length - matched,
      };
    });
    const totalGold = clauses.reduce((s, c) => s + c.gold, 0);
    const totalPred = clauses.reduce((s, c) => s + c.predicted, 0);
    const totalMatched = clauses.reduce((s, c) => s + c.matched, 0);
    return {
      clauses,
      pooled: {
        recall: round4(totalGold === 0 ? 0 : totalMatched / totalGold),
        precision: round4(totalPred === 0 ? 0 : totalMatched / totalPred),
        false_positives: totalPred - totalMatched,
      },
    };
  }
}
