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

## Honest scope

This is a real, tested document-control service, not a full iManage replacement.
It does not store binaries, OCR, preview files, integrate with Outlook/Office,
enforce per-folder ACLs, or implement legal hold. The README does not claim
production usage.
