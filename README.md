# Document Control API

Production-oriented document-control backend for professional-services and
government teams: workspaces, document registers, versions, check-in/out,
retention dates, search and audit.

## Why this exists

Document management fails at the same seams as iManage-style systems: two
people editing one file, versions without a content hash, retention dates that
are never calculated, and no record of who checked a document in or out. This
service models those controls explicitly.

## Stack

- TypeScript, Node.js, Fastify
- PostgreSQL (`pg`), SQL schema migration on boot
- Zod request validation
- SHA-256 content hashes per version
- Vitest + `pg-mem` integration tests
- Multi-stage Dockerfile and docker-compose with Postgres
- GitHub Actions CI (`npm ci`, build, test)

## Features

- Workspaces with client and retention period
- Document register with unique document numbers
- Version 1 created with a SHA-256 content hash
- Check-out / check-in with actor ownership
- New version on every check-in; immutable version history
- Archive gating (cannot archive checked-out documents)
- Search by title or document number
- Activity trail for create/checkout/checkin/archive
- Health probe and consistent 401/404/422 responses
- Structured content components with versioned content, approval status and SHA-256 hashes
- Component dependency graph with cycle detection
- Document references pinned to component versions
- Document approval gate that blocks draft, stale or deprecated components
- Transitive change-impact analysis and workspace reuse metrics
- Content Governance Studio at `/studio` using Docuvera's Open Sans/teal/light-gray tokens

## Content governance API

| Method | Route | Purpose |
|---|---|---|
| POST | `/workspaces/:id/components` | Create a component and draft v1 |
| GET | `/workspaces/:id/components` | List components |
| POST | `/components/:id/versions` | Add a new draft version |
| POST | `/components/:id/versions/:version/approve` | Approve a version |
| POST | `/components/:id/deprecate` | Deprecate a component |
| POST | `/components/:id/dependencies` | Add a dependency (cycle-safe) |
| POST | `/documents/:id/components` | Pin a component version to a document |
| POST | `/documents/:id/approve` | Approve a document only when every reference is current and approved |
| GET | `/documents/:id/approval` | Read approval state |
| GET | `/components/:id/impact` | Direct/transitive dependents, affected documents and stale references |
| GET | `/workspaces/:id/reuse` | Component reuse rate and per-component usage |

The approval formula is: a document is approvable only when every referenced
component version is approved, is the component's current version, and the
component is not deprecated. Reuse is reported as
`reused_references / document_references`, where a reference is reused once a
component is used by more than one document.

## Run locally

```bash
npm install
DATABASE_URL=postgres://documents:documents@localhost:5432/documents API_KEY=dev-key npm run dev
```

Or:

```bash
docker compose up --build
```

## Test

```bash
npm test
npm run build
```

36 Vitest tests cover the original document-control lifecycle plus component
versioning, approvals, dependency cycles, document approval gates, impact
analysis and reuse metrics.

## AI-native diligence (citation-verifiable extraction)

A second domain on top of the same primitives, built for AI-native legal and
financial services: an agent extracts terms from long documents, and **every
claim must link back to the exact page it came from** — or it is marked
`NOT_FOUND` and routed to an expert. It never guesses.

- `POST /diligence/projects` — a diligence project in a workspace
- `POST /diligence/projects/:id/documents` — ingest a document with page count
  and full text (SHA-256 hashed)
- `POST /diligence/projects/:id/claims` — an agent-extracted term, with
  clause type (termination rights, change of control, …), confidence and model
- `POST /diligence/claims/:id/citations` — page-anchored evidence; the quote
  must appear **verbatim** in the cited document or the request is rejected
- `POST /diligence/claims/:id/mark-not-found` — route unevidenced claims to
  an expert instead of fabricating an answer
- `POST /diligence/claims/:id/review` — expert sign-off: `VERIFY` (requires a
  citation), `REJECT`, or `CORRECT` (records the correction and spawns a new
  claim linked to the original)
- `GET /diligence/projects/:id/queue` — the expert queue: `PENDING` and
  `NOT_FOUND` claims
- `GET /diligence/projects/:id/summary` — documents and claim counts by status
- `POST /diligence/evaluate` — the “facts, not vibes” metric: per-clause
  recall (matched gold / gold), precision and false-positive count against a
  gold set, pooled across clauses

The never-guess invariant also shows up in the numbers: the eval counts a
predicted term as correct only when it matches a gold term after
normalization, so a model that hallucinates terms loses precision and a
model that misses terms loses recall — exactly the regression signal the CI
of an AI-native service needs.

51 Vitest tests cover the document-control lifecycle plus all of the
diligence flows above (valid citations, verbatim-quote enforcement,
verification gates, corrections, expert queue, evaluation metrics).

## Honest scope

This is a real, tested document-control service, not a full iManage replacement.
It does not store binaries, OCR, preview files, integrate with Outlook/Office,
enforce per-folder ACLs, or implement legal hold. The diligence layer works
on supplied text, not live PDF parsing. The README does not claim production usage.
