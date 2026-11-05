import Fastify, { FastifyInstance } from "fastify";
import { z } from "zod";
import { Database } from "./db.js";
import { DocumentService, NotFoundError, ValidationError } from "./service.js";
import { ContentService } from "./content.js";
import { studioPage } from "./studio.js";

const workspaceSchema = z.object({ code: z.string().min(1), name: z.string().min(1), client: z.string().min(1), retention_years: z.number().int().positive().default(7) });
const documentSchema = z.object({ workspace_id: z.number().int().positive(), document_number: z.string().min(1), title: z.string().min(1), filename: z.string().min(1), content: z.string().min(1), actor: z.string().min(1) });
const actorSchema = z.object({ actor: z.string().min(1) });
const checkinSchema = z.object({ actor: z.string().min(1), filename: z.string().min(1), content: z.string().min(1) });
const componentSchema = z.object({ code: z.string().min(1), title: z.string().min(1), content: z.string().min(1), actor: z.string().min(1) });
const versionSchema = z.object({ content: z.string().min(1), actor: z.string().min(1) });
const approveComponentSchema = z.object({ actor: z.string().min(1) });
const dependencySchema = z.object({ depends_on_id: z.number().int().positive(), actor: z.string().min(1) });
const referenceSchema = z.object({ component_id: z.number().int().positive(), component_version: z.number().int().positive(), actor: z.string().min(1) });

export function buildApp(db: Database, apiKey: string): FastifyInstance {
  const app = Fastify({ logger: false });
  const service = new DocumentService(db);
  const content = new ContentService(db);

  app.addHook("preHandler", async (request, reply) => {
    if (request.url === "/health" || request.url === "/studio") return;
    if (request.headers["x-api-key"] !== apiKey) reply.code(401).send({ error: "missing or invalid API key" });
  });

  const handle = (error: unknown) => {
    if (error instanceof NotFoundError) return { status: 404, body: { error: error.message } };
    if (error instanceof ValidationError) return { status: 422, body: { error: error.message } };
    if (error instanceof z.ZodError) return { status: 422, body: { error: error.issues } };
    return { status: 500, body: { error: "internal error" } };
  };

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/studio", async (_request, reply) => reply.type("text/html").send(studioPage()));

  app.post("/workspaces", async (request, reply) => {
    try { const body = workspaceSchema.parse(request.body); return reply.code(201).send(await service.createWorkspace(body.code, body.name, body.client, body.retention_years)); }
    catch (error) { const r = handle(error); return reply.code(r.status).send(r.body); }
  });

  app.post("/documents", async (request, reply) => {
    try { const body = documentSchema.parse(request.body); return reply.code(201).send(await service.createDocument(body.workspace_id, body.document_number, body.title, body.filename, body.content, body.actor)); }
    catch (error) { const r = handle(error); return reply.code(r.status).send(r.body); }
  });

  app.post("/documents/:id/checkout", async (request, reply) => {
    try { const id = z.coerce.number().int().positive().parse((request.params as { id: string }).id); const body = actorSchema.parse(request.body); return await service.checkout(id, body.actor); }
    catch (error) { const r = handle(error); return reply.code(r.status).send(r.body); }
  });

  app.post("/documents/:id/checkin", async (request, reply) => {
    try { const id = z.coerce.number().int().positive().parse((request.params as { id: string }).id); const body = checkinSchema.parse(request.body); return await service.checkin(id, body.actor, body.filename, body.content); }
    catch (error) { const r = handle(error); return reply.code(r.status).send(r.body); }
  });

  app.post("/documents/:id/archive", async (request, reply) => {
    try { const id = z.coerce.number().int().positive().parse((request.params as { id: string }).id); const body = actorSchema.parse(request.body); return await service.archive(id, body.actor); }
    catch (error) { const r = handle(error); return reply.code(r.status).send(r.body); }
  });

  app.get("/workspaces/:id/search", async (request, reply) => {
    try { const id = z.coerce.number().int().positive().parse((request.params as { id: string }).id); const q = z.object({ q: z.string().min(1) }).parse(request.query); return { results: await service.search(id, q.q) }; }
    catch (error) { const r = handle(error); return reply.code(r.status).send(r.body); }
  });

  app.get("/documents/:id/versions", async (request, reply) => {
    try { const id = z.coerce.number().int().positive().parse((request.params as { id: string }).id); return { versions: await service.versions(id) }; }
    catch (error) { const r = handle(error); return reply.code(r.status).send(r.body); }
  });

  app.get("/documents/:id/activities", async (request, reply) => {
    try { const id = z.coerce.number().int().positive().parse((request.params as { id: string }).id); return { activities: await service.activities(id) }; }
    catch (error) { const r = handle(error); return reply.code(r.status).send(r.body); }
  });

  app.post("/workspaces/:id/components", async (request, reply) => {
    try {
      const workspaceId = z.coerce.number().int().positive().parse((request.params as { id: string }).id);
      const body = componentSchema.parse(request.body);
      return reply.code(201).send(await content.createComponent(workspaceId, body.code, body.title, body.content, body.actor));
    } catch (error) { const r = handle(error); return reply.code(r.status).send(r.body); }
  });

  app.get("/workspaces/:id/components", async (request, reply) => {
    try {
      const workspaceId = z.coerce.number().int().positive().parse((request.params as { id: string }).id);
      return { components: await content.listComponents(workspaceId) };
    } catch (error) { const r = handle(error); return reply.code(r.status).send(r.body); }
  });

  app.post("/components/:id/versions", async (request, reply) => {
    try {
      const componentId = z.coerce.number().int().positive().parse((request.params as { id: string }).id);
      const body = versionSchema.parse(request.body);
      return reply.code(201).send(await content.addVersion(componentId, body.content, body.actor));
    } catch (error) { const r = handle(error); return reply.code(r.status).send(r.body); }
  });

  app.post("/components/:id/versions/:version/approve", async (request, reply) => {
    try {
      const componentId = z.coerce.number().int().positive().parse((request.params as { id: string }).id);
      const version = z.coerce.number().int().positive().parse((request.params as { version: string }).version);
      const body = approveComponentSchema.parse(request.body);
      return await content.approveVersion(componentId, version, body.actor);
    } catch (error) { const r = handle(error); return reply.code(r.status).send(r.body); }
  });

  app.post("/components/:id/deprecate", async (request, reply) => {
    try {
      const componentId = z.coerce.number().int().positive().parse((request.params as { id: string }).id);
      const body = approveComponentSchema.parse(request.body);
      return await content.deprecateComponent(componentId, body.actor);
    } catch (error) { const r = handle(error); return reply.code(r.status).send(r.body); }
  });

  app.post("/components/:id/dependencies", async (request, reply) => {
    try {
      const componentId = z.coerce.number().int().positive().parse((request.params as { id: string }).id);
      const body = dependencySchema.parse(request.body);
      return await content.addDependency(componentId, body.depends_on_id, body.actor);
    } catch (error) { const r = handle(error); return reply.code(r.status).send(r.body); }
  });

  app.post("/documents/:id/components", async (request, reply) => {
    try {
      const documentId = z.coerce.number().int().positive().parse((request.params as { id: string }).id);
      const body = referenceSchema.parse(request.body);
      return await content.referenceComponent(documentId, body.component_id, body.component_version, body.actor);
    } catch (error) { const r = handle(error); return reply.code(r.status).send(r.body); }
  });

  app.post("/documents/:id/approve", async (request, reply) => {
    try {
      const documentId = z.coerce.number().int().positive().parse((request.params as { id: string }).id);
      const body = approveComponentSchema.parse(request.body);
      return await content.approveDocument(documentId, body.actor);
    } catch (error) { const r = handle(error); return reply.code(r.status).send(r.body); }
  });

  app.get("/documents/:id/approval", async (request, reply) => {
    try {
      const documentId = z.coerce.number().int().positive().parse((request.params as { id: string }).id);
      return await content.documentApproval(documentId);
    } catch (error) { const r = handle(error); return reply.code(r.status).send(r.body); }
  });

  app.get("/components/:id/impact", async (request, reply) => {
    try {
      const componentId = z.coerce.number().int().positive().parse((request.params as { id: string }).id);
      return await content.impact(componentId);
    } catch (error) { const r = handle(error); return reply.code(r.status).send(r.body); }
  });

  app.get("/workspaces/:id/reuse", async (request, reply) => {
    try {
      const workspaceId = z.coerce.number().int().positive().parse((request.params as { id: string }).id);
      return await content.reuse(workspaceId);
    } catch (error) { const r = handle(error); return reply.code(r.status).send(r.body); }
  });

  return app;
}
