import Fastify, { FastifyInstance } from "fastify";
import { z } from "zod";
import { Database } from "./db.js";
import { DocumentService, NotFoundError, ValidationError } from "./service.js";

const workspaceSchema = z.object({ code: z.string().min(1), name: z.string().min(1), client: z.string().min(1), retention_years: z.number().int().positive().default(7) });
const documentSchema = z.object({ workspace_id: z.number().int().positive(), document_number: z.string().min(1), title: z.string().min(1), filename: z.string().min(1), content: z.string().min(1), actor: z.string().min(1) });
const actorSchema = z.object({ actor: z.string().min(1) });
const checkinSchema = z.object({ actor: z.string().min(1), filename: z.string().min(1), content: z.string().min(1) });

export function buildApp(db: Database, apiKey: string): FastifyInstance {
  const app = Fastify({ logger: false });
  const service = new DocumentService(db);

  app.addHook("preHandler", async (request, reply) => {
    if (request.url === "/health") return;
    if (request.headers["x-api-key"] !== apiKey) reply.code(401).send({ error: "missing or invalid API key" });
  });

  const handle = (error: unknown) => {
    if (error instanceof NotFoundError) return { status: 404, body: { error: error.message } };
    if (error instanceof ValidationError) return { status: 422, body: { error: error.message } };
    if (error instanceof z.ZodError) return { status: 422, body: { error: error.issues } };
    return { status: 500, body: { error: "internal error" } };
  };

  app.get("/health", async () => ({ status: "ok" }));

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

  return app;
}
