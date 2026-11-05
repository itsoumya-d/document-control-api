import { createHash } from "node:crypto";
import { Database } from "./db.js";

export class NotFoundError extends Error {}
export class ValidationError extends Error {}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function validSha(value: string): boolean { return /^[0-9a-f]{64}$/.test(value); }

export class DocumentService {
  constructor(private readonly db: Database) {}

  private async activity(documentId: number, action: string, actor: string, detail = ""): Promise<void> {
    await this.db.query("INSERT INTO activities (document_id, action, actor, detail) VALUES ($1,$2,$3,$4)", [documentId, action, actor, detail]);
  }

  async createWorkspace(code: string, name: string, client: string, retentionYears = 7) {
    if (!code.trim() || !name.trim() || !client.trim()) throw new ValidationError("code, name and client are required");
    if (!Number.isInteger(retentionYears) || retentionYears <= 0) throw new ValidationError("retention_years must be positive");
    if ((await this.db.query("SELECT id FROM workspaces WHERE code=$1", [code])).length) throw new ValidationError("workspace code already exists");
    const rows = await this.db.query<{ id: number; code: string }>("INSERT INTO workspaces (code,name,client,retention_years) VALUES ($1,$2,$3,$4) RETURNING id, code", [code, name, client, retentionYears]);
    return rows[0];
  }

  async createDocument(workspaceId: number, documentNumber: string, title: string, filename: string, content: string, actor: string) {
    if (!documentNumber.trim() || !title.trim() || !filename.trim() || !content.trim()) throw new ValidationError("document number, title, filename and content are required");
    const workspace = await this.db.query<{ id: number; retention_years: number }>("SELECT id, retention_years FROM workspaces WHERE id=$1", [workspaceId]);
    if (!workspace.length) throw new NotFoundError("workspace not found");
    if ((await this.db.query("SELECT id FROM documents WHERE document_number=$1", [documentNumber])).length) throw new ValidationError("document number already exists");
    const rows = await this.db.query<{ id: number; status: string; current_version: number }>(
      "INSERT INTO documents (workspace_id, document_number, title, status, current_version, retention_until) VALUES ($1,$2,$3,'draft',1,$4) RETURNING id, status, current_version",
      [workspaceId, documentNumber, title, `${new Date().getFullYear() + workspace[0].retention_years}-12-31`]
    );
    await this.db.query("INSERT INTO document_versions (document_id, version, filename, content_sha256, created_by) VALUES ($1,1,$2,$3,$4)", [rows[0].id, filename, hash(content), actor]);
    await this.activity(rows[0].id, "document_created", actor, filename);
    return rows[0];
  }

  async checkout(documentId: number, actor: string) {
    const rows = await this.db.query<{ id: number; status: string; checked_out_by: string | null }>("SELECT id, status, checked_out_by FROM documents WHERE id=$1", [documentId]);
    if (!rows.length) throw new NotFoundError("document not found");
    if (rows[0].status === "archived") throw new ValidationError("document is archived");
    if (rows[0].status === "checked_out") {
      if (rows[0].checked_out_by === actor) return { id: documentId, status: "checked_out", unchanged: true };
      throw new ValidationError(`document is checked out by ${rows[0].checked_out_by}`);
    }
    await this.db.query("UPDATE documents SET status='checked_out', checked_out_by=$1 WHERE id=$2", [actor, documentId]);
    await this.activity(documentId, "checked_out", actor);
    return { id: documentId, status: "checked_out", unchanged: false };
  }

  async checkin(documentId: number, actor: string, filename: string, content: string) {
    const rows = await this.db.query<{ id: number; status: string; checked_out_by: string | null; current_version: number }>("SELECT id, status, checked_out_by, current_version FROM documents WHERE id=$1", [documentId]);
    if (!rows.length) throw new NotFoundError("document not found");
    if (rows[0].status !== "checked_out" || rows[0].checked_out_by !== actor) throw new ValidationError("document must be checked out by this actor");
    if (!filename.trim() || !content.trim()) throw new ValidationError("filename and content are required");
    const version = rows[0].current_version + 1;
    await this.db.query("INSERT INTO document_versions (document_id, version, filename, content_sha256, created_by) VALUES ($1,$2,$3,$4,$5)", [documentId, version, filename, hash(content), actor]);
    await this.db.query("UPDATE documents SET status='checked_in', checked_out_by=NULL, current_version=$1 WHERE id=$2", [version, documentId]);
    await this.activity(documentId, "checked_in", actor, `v${version}`);
    return { id: documentId, status: "checked_in", version };
  }

  async archive(documentId: number, actor: string) {
    const rows = await this.db.query<{ id: number; status: string }>("SELECT id, status FROM documents WHERE id=$1", [documentId]);
    if (!rows.length) throw new NotFoundError("document not found");
    if (rows[0].status === "archived") return { id: documentId, status: "archived", unchanged: true };
    if (rows[0].status === "checked_out") throw new ValidationError("cannot archive a checked-out document");
    await this.db.query("UPDATE documents SET status='archived' WHERE id=$1", [documentId]);
    await this.activity(documentId, "archived", actor);
    return { id: documentId, status: "archived", unchanged: false };
  }

  async search(workspaceId: number, query: string) {
    if (!query.trim()) throw new ValidationError("query is required");
    if (!(await this.db.query("SELECT id FROM workspaces WHERE id=$1", [workspaceId])).length) throw new NotFoundError("workspace not found");
    return this.db.query("SELECT document_number, title, status, current_version FROM documents WHERE workspace_id=$1 AND (title ILIKE $2 OR document_number ILIKE $2) ORDER BY document_number", [workspaceId, `%${query}%`]);
  }

  async versions(documentId: number) {
    if (!(await this.db.query("SELECT id FROM documents WHERE id=$1", [documentId])).length) throw new NotFoundError("document not found");
    return this.db.query("SELECT version, filename, content_sha256, created_by, created_at FROM document_versions WHERE document_id=$1 ORDER BY version", [documentId]);
  }

  async activities(documentId: number) {
    if (!(await this.db.query("SELECT id FROM documents WHERE id=$1", [documentId])).length) throw new NotFoundError("document not found");
    return this.db.query("SELECT action, actor, detail, at FROM activities WHERE document_id=$1 ORDER BY id", [documentId]);
  }
}
