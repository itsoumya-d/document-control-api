export function studioPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Docuvera Content Governance Studio</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;600;700&family=Montserrat:wght@600;700&display=swap');
    :root {
      --dv-font-heading: 'Open Sans', sans-serif;
      --dv-font-body: 'Open Sans', sans-serif;
      --dv-font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      --dv-bg-primary: #FFFFFF;
      --dv-bg-surface: #FAFAFA;
      --dv-text-primary: #333333;
      --dv-accent: #48A4A7;
      --dv-accent-dark: #2B2B2B;
      --dv-muted: #808285;
      --dv-radius: 5px;
      --dv-space: 8px;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--dv-bg-primary); color: var(--dv-text-primary); font-family: var(--dv-font-body); }
    main { max-width: 1080px; margin: 0 auto; padding: calc(var(--dv-space) * 5) calc(var(--dv-space) * 3); }
    .eyebrow { margin: 0 0 var(--dv-space); color: var(--dv-accent); font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 0 0 var(--dv-space); font-family: var(--dv-font-heading); font-size: clamp(30px, 5vw, 46px); line-height: 1.05; letter-spacing: -0.02em; }
    .lede { max-width: 680px; margin: 0; color: var(--dv-muted); line-height: 1.65; }
    .bar { display: flex; flex-wrap: wrap; gap: var(--dv-space); margin: calc(var(--dv-space) * 3) 0; padding: calc(var(--dv-space) * 2); background: var(--dv-bg-surface); border: 1px solid #e3e3e3; border-radius: var(--dv-radius); }
    label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; font-weight: 700; color: var(--dv-accent-dark); text-transform: uppercase; letter-spacing: .06em; }
    input { font: inherit; font-size: 14px; padding: 8px 9px; border: 1px solid #dedede; border-radius: var(--dv-radius); background: #fff; color: var(--dv-text-primary); min-width: 160px; }
    button { font: inherit; font-size: 13px; font-weight: 700; border: 0; border-radius: var(--dv-radius); padding: 9px 16px; background: var(--dv-accent); color: #fff; cursor: pointer; align-self: flex-end; }
    button.secondary { background: var(--dv-accent-dark); }
    .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: calc(var(--dv-space) * 2); }
    .card { background: var(--dv-bg-surface); border: 1px solid #e3e3e3; border-radius: var(--dv-radius); padding: calc(var(--dv-space) * 2); }
    .card .label { margin: 0 0 6px; color: var(--dv-muted); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
    .card .value { margin: 0; font-family: var(--dv-font-heading); font-size: 30px; font-weight: 700; color: var(--dv-accent-dark); }
    .panels { display: grid; grid-template-columns: 1fr 1fr; gap: calc(var(--dv-space) * 2); margin-top: calc(var(--dv-space) * 2); }
    .panel { background: var(--dv-bg-surface); border: 1px solid #e3e3e3; border-radius: var(--dv-radius); padding: calc(var(--dv-space) * 2); }
    .panel h2 { margin: 0 0 var(--dv-space); color: var(--dv-accent); font-family: var(--dv-font-heading); font-size: 20px; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: var(--dv-font-mono); font-size: 12px; line-height: 1.55; color: var(--dv-text-primary); }
    .status { margin-top: var(--dv-space); color: var(--dv-muted); font-size: 12px; }
    .chip { display: inline-block; padding: 4px 8px; border-radius: 999px; background: #E6F3E7; color: #2B6B3A; font-size: 11px; font-weight: 700; }
    @media (max-width: 820px) { .metrics { grid-template-columns: 1fr 1fr; } .panels { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
<main>
  <p class="eyebrow">Docuvera · Structured content governance</p>
  <h1>Content Governance Studio</h1>
  <p class="lede">Inspect component reuse, approval readiness and the downstream impact of a change. The numbers come from the TypeScript/Fastify document-control service; the surface uses Docuvera's Open Sans, teal, light-gray and 5px-radius tokens.</p>

  <section class="bar">
    <label>Workspace ID <input id="workspace" type="number" value="1" min="1"></label>
    <label>API key <input id="key" type="password" value="dev-key"></label>
    <button id="load">Load reuse</button>
    <label>Component ID <input id="component" type="number" value="1" min="1"></label>
    <button id="impact" class="secondary">Run impact</button>
  </section>

  <section class="metrics">
    <article class="card"><p class="label">Components</p><p class="value" id="components">—</p></article>
    <article class="card"><p class="label">Approved</p><p class="value" id="approved">—</p></article>
    <article class="card"><p class="label">References</p><p class="value" id="references">—</p></article>
    <article class="card"><p class="label">Reuse rate</p><p class="value" id="reuse">—</p></article>
  </section>

  <section class="panels">
    <article class="panel">
      <h2>Reuse by component</h2>
      <pre id="usage">Load a workspace to see component usage.</pre>
    </article>
    <article class="panel">
      <h2>Change impact</h2>
      <pre id="impact-out">Run impact for a component to see affected documents and stale references.</pre>
    </article>
  </section>
  <p class="status" id="status">Ready.</p>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const headers = () => ({ 'x-api-key': $('key').value });
  const status = (message) => { $('status').textContent = message; };

  async function loadReuse() {
    status('Loading reuse metrics...');
    try {
      const response = await fetch('/workspaces/' + $('workspace').value + '/reuse', { headers: headers() });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Request failed');
      $('components').textContent = body.components;
      $('approved').textContent = body.approved_components;
      $('references').textContent = body.document_references;
      $('reuse').textContent = body.reuse_rate_percent + '%';
      $('usage').textContent = body.usage.map((row) => row.code + '  ' + row.references + ' reference(s)').join('\\n') || 'No components yet.';
      status('Reuse metrics loaded.');
    } catch (error) { status(error.message); }
  }

  async function runImpact() {
    status('Computing impact...');
    try {
      const response = await fetch('/components/' + $('component').value + '/impact', { headers: headers() });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Request failed');
      $('impact-out').textContent = JSON.stringify(body, null, 2);
      status('Impact computed. Review stale references before approving a document.');
    } catch (error) { status(error.message); }
  }

  $('load').addEventListener('click', loadReuse);
  $('impact').addEventListener('click', runImpact);
</script>
</body>
</html>`;
}
