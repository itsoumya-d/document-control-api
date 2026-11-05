CREATE TABLE IF NOT EXISTS workspaces (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  client TEXT NOT NULL,
  retention_years INTEGER NOT NULL DEFAULT 7 CHECK (retention_years > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  document_number TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  current_version INTEGER NOT NULL DEFAULT 1,
  checked_out_by TEXT,
  retention_until TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_versions (
  id SERIAL PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  version INTEGER NOT NULL,
  filename TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, version)
);

CREATE TABLE IF NOT EXISTS activities (
  id SERIAL PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
