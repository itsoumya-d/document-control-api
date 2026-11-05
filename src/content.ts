import { createHash } from "node:crypto";
import { Database } from "./db.js";
import { NotFoundError, ValidationError } from "./service.js";

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

interface ComponentRow {
  [key: string]: unknown;
  id: number;
  workspace_id: number;
  code: string;
  title: string;
  status: string;
  current_version: number;
}

interface VersionRow {
  [key: string]: unknown;
  component_id: number;
  version: number;
  content_sha256: string;
  status: string;
}

export class ContentService {
  constructor(private readonly db: Database) {}

  private async activity(componentId: number, action: string, actor: string, detail = ""): Promise<void> {
    await this.db.query("INSERT INTO component_activities (component_id, action, actor, detail) VALUES ($1,$2,$3,$4)", [componentId, action, actor, detail]);
  }

  private async component(id: number): Promise<ComponentRow> {
    const rows = await this.db.query<ComponentRow>("SELECT id, workspace_id, code, title, status, current_version FROM components WHERE id=$1", [id]);
    if (!rows.length) throw new NotFoundError("component not found");
    return rows[0];
  }

  async createComponent(workspaceId: number, code: string, title: string, content: string, actor: string) {
    if (!code.trim() || !title.trim() || !content.trim() || !actor.trim()) {
      throw new ValidationError("code, title, content and actor are required");
    }
    if (!(await this.db.query("SELECT id FROM workspaces WHERE id=$1", [workspaceId])).length) {
      throw new NotFoundError("workspace not found");
    }
    if ((await this.db.query("SELECT id FROM components WHERE workspace_id=$1 AND code=$2", [workspaceId, code])).length) {
      throw new ValidationError("component code already exists in this workspace");
    }
    const rows = await this.db.query<ComponentRow>(
      "INSERT INTO components (workspace_id, code, title, status, current_version, created_by) VALUES ($1,$2,$3,'draft',1,$4) RETURNING id, workspace_id, code, title, status, current_version",
      [workspaceId, code, title, actor]
    );
    const component = rows[0];
    const contentSha = hash(content);
    await this.db.query(
      "INSERT INTO component_versions (component_id, version, content, content_sha256, status, created_by) VALUES ($1,1,$2,$3,'draft',$4)",
      [component.id, content, contentSha, actor]
    );
    await this.activity(component.id, "component_created", actor, code);
    return { ...component, version: { version: 1, content_sha256: contentSha, status: "draft" } };
  }

  async listComponents(workspaceId: number) {
    if (!(await this.db.query("SELECT id FROM workspaces WHERE id=$1", [workspaceId])).length) {
      throw new NotFoundError("workspace not found");
    }
    return this.db.query(
      "SELECT id, code, title, status, current_version, created_by, created_at FROM components WHERE workspace_id=$1 ORDER BY code",
      [workspaceId]
    );
  }

  async addVersion(componentId: number, content: string, actor: string) {
    if (!content.trim() || !actor.trim()) throw new ValidationError("content and actor are required");
    const component = await this.component(componentId);
    const version = component.current_version + 1;
    const contentSha = hash(content);
    await this.db.query(
      "INSERT INTO component_versions (component_id, version, content, content_sha256, status, created_by) VALUES ($1,$2,$3,$4,'draft',$5)",
      [component.id, version, content, contentSha, actor]
    );
    await this.db.query("UPDATE components SET current_version=$1, status='draft' WHERE id=$2", [version, component.id]);
    await this.activity(component.id, "version_added", actor, `v${version}`);
    return { component_id: component.id, version, content_sha256: contentSha, status: "draft" };
  }

  async approveVersion(componentId: number, version: number, actor: string) {
    if (!actor.trim()) throw new ValidationError("actor is required");
    const component = await this.component(componentId);
    const rows = await this.db.query<VersionRow>(
      "SELECT component_id, version, content_sha256, status FROM component_versions WHERE component_id=$1 AND version=$2",
      [component.id, version]
    );
    if (!rows.length) throw new NotFoundError("component version not found");
    await this.db.query(
      "UPDATE component_versions SET status='approved', approved_by=$1, approved_at=now() WHERE component_id=$2 AND version=$3",
      [actor, component.id, version]
    );
    await this.db.query(
      "UPDATE components SET status='approved' WHERE id=$1 AND current_version=$2",
      [component.id, version]
    );
    await this.activity(component.id, "version_approved", actor, `v${version}`);
    return { component_id: component.id, version, status: "approved" };
  }

  async deprecateComponent(componentId: number, actor: string) {
    if (!actor.trim()) throw new ValidationError("actor is required");
    const component = await this.component(componentId);
    await this.db.query("UPDATE components SET status='deprecated' WHERE id=$1", [component.id]);
    await this.activity(component.id, "component_deprecated", actor);
    return { id: component.id, status: "deprecated" };
  }

  async addDependency(componentId: number, dependsOnId: number, actor: string) {
    if (!actor.trim()) throw new ValidationError("actor is required");
    if (componentId === dependsOnId) throw new ValidationError("a component cannot depend on itself");
    const component = await this.component(componentId);
    const dependsOn = await this.component(dependsOnId);
    if (component.workspace_id !== dependsOn.workspace_id) throw new ValidationError("components must be in the same workspace");
    if ((await this.db.query("SELECT 1 FROM component_dependencies WHERE component_id=$1 AND depends_on_id=$2", [componentId, dependsOnId])).length) {
      return { component_id: componentId, depends_on_id: dependsOnId, unchanged: true };
    }

    const edges = await this.db.query<{ component_id: number; depends_on_id: number }>(
      "SELECT cd.component_id, cd.depends_on_id FROM component_dependencies cd JOIN components c ON c.id=cd.component_id WHERE c.workspace_id=$1",
      [component.workspace_id]
    );
    const graph = new Map<number, number[]>();
    for (const edge of edges) {
      const list = graph.get(edge.component_id) ?? [];
      list.push(edge.depends_on_id);
      graph.set(edge.component_id, list);
    }
    const seen = new Set<number>();
    const stack = [dependsOnId];
    while (stack.length) {
      const current = stack.pop()!;
      if (current === componentId) throw new ValidationError("dependency cycle");
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of graph.get(current) ?? []) stack.push(next);
    }

    await this.db.query("INSERT INTO component_dependencies (component_id, depends_on_id) VALUES ($1,$2)", [componentId, dependsOnId]);
    await this.activity(component.id, "dependency_added", actor, `depends_on:${dependsOnId}`);
    return { component_id: componentId, depends_on_id: dependsOnId, unchanged: false };
  }

  async referenceComponent(documentId: number, componentId: number, version: number, actor: string) {
    if (!actor.trim()) throw new ValidationError("actor is required");
    if (!(await this.db.query("SELECT id FROM documents WHERE id=$1", [documentId])).length) throw new NotFoundError("document not found");
    const component = await this.component(componentId);
    if (version <= 0 || version > component.current_version) throw new ValidationError("component version does not exist");
    const existing = await this.db.query("SELECT 1 FROM document_components WHERE document_id=$1 AND component_id=$2", [documentId, componentId]);
    if (existing.length) {
      await this.db.query("UPDATE document_components SET component_version=$1 WHERE document_id=$2 AND component_id=$3", [version, documentId, componentId]);
    } else {
      await this.db.query("INSERT INTO document_components (document_id, component_id, component_version) VALUES ($1,$2,$3)", [documentId, componentId, version]);
    }
    await this.db.query("INSERT INTO activities (document_id, action, actor, detail) VALUES ($1,'component_referenced',$2,$3)", [documentId, actor, `${component.code}@v${version}`]);
    return { document_id: documentId, component_id: componentId, component_version: version };
  }

  async approveDocument(documentId: number, actor: string) {
    if (!actor.trim()) throw new ValidationError("actor is required");
    if (!(await this.db.query("SELECT id FROM documents WHERE id=$1", [documentId])).length) throw new NotFoundError("document not found");
    const refs = await this.db.query<{ component_id: number; component_version: number }>(
      "SELECT component_id, component_version FROM document_components WHERE document_id=$1",
      [documentId]
    );
    if (!refs.length) throw new ValidationError("document has no component references");

    const blockers: string[] = [];
    for (const ref of refs) {
      const component = await this.component(ref.component_id);
      const versions = await this.db.query<VersionRow>(
        "SELECT component_id, version, content_sha256, status FROM component_versions WHERE component_id=$1 AND version=$2",
        [ref.component_id, ref.component_version]
      );
      if (!versions.length) blockers.push(`component ${component.code} version ${ref.component_version} not found`);
      else if (versions[0].status !== "approved") blockers.push(`component ${component.code} v${ref.component_version} is not approved`);
      if (component.status === "deprecated") blockers.push(`component ${component.code} is deprecated`);
      if (component.current_version !== ref.component_version) blockers.push(`component ${component.code} has a newer version ${component.current_version}`);
    }
    if (blockers.length) throw new ValidationError(blockers.join("; "));

    const existing = await this.db.query("SELECT document_id FROM document_approvals WHERE document_id=$1", [documentId]);
    if (existing.length) {
      await this.db.query("UPDATE document_approvals SET status='approved', approved_by=$1, approved_at=now() WHERE document_id=$2", [actor, documentId]);
    } else {
      await this.db.query("INSERT INTO document_approvals (document_id, status, approved_by) VALUES ($1,'approved',$2)", [documentId, actor]);
    }
    await this.db.query("INSERT INTO activities (document_id, action, actor, detail) VALUES ($1,'document_approved',$2,$3)", [documentId, actor, `${refs.length} components`]);
    return { document_id: documentId, status: "approved", approved_by: actor };
  }

  async documentApproval(documentId: number) {
    if (!(await this.db.query("SELECT id FROM documents WHERE id=$1", [documentId])).length) throw new NotFoundError("document not found");
    const rows = await this.db.query<{ document_id: number; status: string; approved_by: string; approved_at: string }>(
      "SELECT document_id, status, approved_by, approved_at FROM document_approvals WHERE document_id=$1",
      [documentId]
    );
    return rows[0] ?? { document_id: documentId, status: "unapproved", approved_by: "", approved_at: "" };
  }

  async impact(componentId: number) {
    const component = await this.component(componentId);
    const edges = await this.db.query<{ component_id: number; depends_on_id: number }>(
      "SELECT cd.component_id, cd.depends_on_id FROM component_dependencies cd JOIN components c ON c.id=cd.component_id WHERE c.workspace_id=$1",
      [component.workspace_id]
    );
    const reverse = new Map<number, number[]>();
    for (const edge of edges) {
      const list = reverse.get(edge.depends_on_id) ?? [];
      list.push(edge.component_id);
      reverse.set(edge.depends_on_id, list);
    }
    const directDependents = reverse.get(componentId) ?? [];
    const seen = new Set<number>();
    const stack = [...directDependents];
    while (stack.length) {
      const current = stack.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of reverse.get(current) ?? []) stack.push(next);
    }
    const affected = new Set<number>([componentId, ...seen]);
    const components = await this.db.query<ComponentRow>(
      "SELECT id, workspace_id, code, title, status, current_version FROM components WHERE workspace_id=$1",
      [component.workspace_id]
    );
    const byId = new Map(components.map((row) => [row.id, row]));
    const refs = await this.db.query<{ document_id: number; component_id: number; component_version: number }>(
      "SELECT dc.document_id, dc.component_id, dc.component_version FROM document_components dc JOIN components c ON c.id=dc.component_id WHERE c.workspace_id=$1",
      [component.workspace_id]
    );
    const affectedRefs = refs.filter((ref) => affected.has(ref.component_id));
    const stale = affectedRefs.filter((ref) => {
      const owner = byId.get(ref.component_id);
      return !owner || owner.status !== "approved" || owner.current_version !== ref.component_version;
    });
    return {
      component_id: componentId,
      direct_dependents: directDependents,
      transitive_dependents: [...seen],
      affected_document_ids: [...new Set(affectedRefs.map((ref) => ref.document_id))],
      stale_references: stale
    };
  }

  async reuse(workspaceId: number) {
    if (!(await this.db.query("SELECT id FROM workspaces WHERE id=$1", [workspaceId])).length) throw new NotFoundError("workspace not found");
    const components = await this.db.query<ComponentRow>(
      "SELECT id, workspace_id, code, title, status, current_version FROM components WHERE workspace_id=$1",
      [workspaceId]
    );
    const refs = await this.db.query<{ document_id: number; component_id: number; component_version: number }>(
      "SELECT dc.document_id, dc.component_id, dc.component_version FROM document_components dc JOIN components c ON c.id=dc.component_id WHERE c.workspace_id=$1",
      [workspaceId]
    );
    const uniqueComponents = new Set(refs.map((ref) => ref.component_id)).size;
    const reusedReferences = Math.max(0, refs.length - uniqueComponents);
    const reuseRate = refs.length === 0 ? 0 : Math.round((reusedReferences / refs.length) * 10000) / 100;
    const usage = new Map<number, number>();
    for (const ref of refs) usage.set(ref.component_id, (usage.get(ref.component_id) ?? 0) + 1);
    return {
      workspace_id: workspaceId,
      components: components.length,
      approved_components: components.filter((row) => row.status === "approved").length,
      document_references: refs.length,
      unique_components_referenced: uniqueComponents,
      reused_references: reusedReferences,
      reuse_rate_percent: reuseRate,
      usage: components.map((row) => ({ code: row.code, references: usage.get(row.id) ?? 0 }))
    };
  }
}
