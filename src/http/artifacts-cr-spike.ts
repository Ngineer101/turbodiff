import { Hono } from 'hono';
import { buildCrDemoRepo } from '../ai/runners/artifacts-cr-demo.ts';
import { CR_BRANCH_NAME, CR_REPO_NAME } from '../ai/runners/artifacts-cr-engine.ts';
import {
  addCrComment,
  getChangeRequest,
  listChangeRequests,
  mergeChangeRequest,
  openChangeRequest,
  refreshChangeRequest,
  type ChangeRequest,
  type CrComment,
} from '../services/artifacts-crs.ts';
import { isString } from '../shared/json.ts';

// Phase-0.5 native change-request surface (docs/artifacts-cr-spike.md).
// Mounted under /internal/artifacts-cr, behind the operator shared secret.
export function createArtifactsCrRoutes() {
  const routes = new Hono();

  // One call, whole story: build the demo repo (main + two feature branches
  // that both merge cleanly but overlap each other) and open a CR for each.
  routes.post('/demo', async (c) => {
    try {
      const demo = await buildCrDemoRepo();
      const crs: ChangeRequest[] = [];
      for (const feature of demo.branches) {
        crs.push(
          await openChangeRequest({
            repo: demo.repo.name,
            sourceBranch: feature.branch,
            targetBranch: demo.repo.defaultBranch,
            title: feature.title,
            openedBy: 'demo',
          }),
        );
      }
      return c.json({ repo: demo.repo, build_timings: demo.timings, crs: crs.map(summarize) });
    } catch (err) {
      console.error('turbodiff: artifacts CR demo failed:', err);
      return c.json({ error: err instanceof Error ? err.message : 'demo failed' }, 502);
    }
  });

  // Open a CR on any Artifacts repo (works against non-demo repos too).
  //   POST /crs { "repo": "...", "source": "...", "target": "main", "title": "..." }
  routes.post('/crs', async (c) => {
    const payload = await c.req
      .json<{ repo?: string; source?: string; target?: string; title?: string }>()
      .catch(() => null);
    if (
      !payload ||
      !isString(payload.repo) ||
      !CR_REPO_NAME.test(payload.repo) ||
      !isString(payload.source) ||
      !CR_BRANCH_NAME.test(payload.source) ||
      !isString(payload.target) ||
      !CR_BRANCH_NAME.test(payload.target)
    ) {
      return c.json(
        {
          error: 'body must be {"repo": "...", "source": "...", "target": "...", "title"?: "..."}',
        },
        400,
      );
    }
    try {
      const cr = await openChangeRequest({
        repo: payload.repo,
        sourceBranch: payload.source,
        targetBranch: payload.target,
        title: payload.title?.trim() || `Merge ${payload.source} into ${payload.target}`,
        openedBy: 'operator',
      });
      return c.json(summarize(cr));
    } catch (err) {
      console.error('turbodiff: artifacts CR open failed:', err);
      return c.json({ error: err instanceof Error ? err.message : 'open failed' }, 502);
    }
  });

  routes.get('/crs', async (c) => {
    const repo = c.req.query('repo');
    if (repo !== undefined && !CR_REPO_NAME.test(repo)) {
      return c.json({ error: `repo must match ${CR_REPO_NAME}` }, 400);
    }
    return c.json({ crs: (await listChangeRequests(repo)).map(summarize) });
  });

  routes.get('/crs/:id', async (c) => {
    const cr = await getChangeRequest(c.req.param('id'));
    if (!cr) return c.json({ error: 'unknown change request' }, 404);
    return c.json(cr);
  });

  // Rendered diff view. Behind the shared secret like everything else here,
  // so from a browserless shell: curl -H "$AUTH" .../view > cr.html && open it.
  routes.get('/crs/:id/view', async (c) => {
    const cr = await getChangeRequest(c.req.param('id'));
    if (!cr) return c.json({ error: 'unknown change request' }, 404);
    return c.html(renderCrView(cr));
  });

  routes.post('/crs/:id/refresh', async (c) => {
    try {
      const cr = await refreshChangeRequest(c.req.param('id'));
      if (!cr) return c.json({ error: 'unknown change request' }, 404);
      return c.json(summarize(cr));
    } catch (err) {
      console.error('turbodiff: artifacts CR refresh failed:', err);
      return c.json({ error: err instanceof Error ? err.message : 'refresh failed' }, 502);
    }
  });

  //   POST /crs/:id/comments { "file": "src/pricing.ts", "line": 7, "body": "..." }
  routes.post('/crs/:id/comments', async (c) => {
    const payload = await c.req
      .json<{ file?: string; line?: number; body?: string; author?: string }>()
      .catch(() => null);
    const line = payload?.line ?? 0;
    if (
      !payload ||
      !isString(payload.file) ||
      !payload.file.trim() ||
      !Number.isInteger(line) ||
      line < 1 ||
      !isString(payload.body) ||
      !payload.body.trim()
    ) {
      return c.json({ error: 'body must be {"file": "...", "line": 1, "body": "..."}' }, 400);
    }
    const cr = await addCrComment(c.req.param('id'), {
      file: payload.file.trim(),
      line,
      body: payload.body.trim(),
      author: isString(payload.author) && payload.author.trim() ? payload.author.trim() : undefined,
    });
    if (!cr) return c.json({ error: 'unknown change request' }, 404);
    return c.json(summarize(cr));
  });

  routes.post('/crs/:id/merge', async (c) => {
    try {
      const outcome = await mergeChangeRequest(c.req.param('id'));
      return c.json({ merged: summarize(outcome.cr), rippled: outcome.rippled });
    } catch (err) {
      console.error('turbodiff: artifacts CR merge failed:', err);
      return c.json({ error: err instanceof Error ? err.message : 'merge failed' }, 409);
    }
  });

  return routes;
}

// List/summary shape: everything but the patch (which can be hundreds of KB).
function summarize(cr: ChangeRequest) {
  const additions = cr.files.reduce((sum, f) => sum + (f.additions ?? 0), 0);
  const deletions = cr.files.reduce((sum, f) => sum + (f.deletions ?? 0), 0);
  return {
    id: cr.id,
    repo: cr.repo,
    title: cr.title,
    source: cr.sourceBranch,
    target: cr.targetBranch,
    status: cr.status,
    mergeable: cr.mergeable,
    conflict_files: cr.conflictFiles,
    files: cr.files.length,
    additions,
    deletions,
    comments: cr.comments.length,
    timings: cr.timings,
    updated_at: cr.updatedAt,
    view: `/internal/artifacts-cr/crs/${cr.id}/view`,
  };
}

function esc(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// Server-rendered CR page: header with status lamp and serial, per-file
// unified diff with inline review comments — the cockpit CR view in miniature.
function renderCrView(cr: ChangeRequest): string {
  const additions = cr.files.reduce((sum, f) => sum + (f.additions ?? 0), 0);
  const deletions = cr.files.reduce((sum, f) => sum + (f.deletions ?? 0), 0);
  const lamp =
    cr.status === 'merged'
      ? '<span class="lamp merged">MERGED</span>'
      : cr.mergeable
        ? '<span class="lamp clean">OPEN · CLEAN</span>'
        : '<span class="lamp conflict">OPEN · CONFLICTS</span>';
  const conflicts = cr.conflictFiles.length
    ? `<p class="conflicts">Conflicts: ${cr.conflictFiles.map(esc).join(', ')}</p>`
    : '';
  const timings = cr.timings
    .map((t) => `${esc(t.step)}${t.detail ? ` (${esc(t.detail)})` : ''}: ${t.ms}ms`)
    .join(' · ');
  const history = cr.history.map((h) => `<li>${esc(h.at)} — ${esc(h.what)}</li>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(cr.id)} · ${esc(cr.title)}</title>
<style>
  body { background: #0e1116; color: #c9d1d9; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; padding: 24px; }
  header { border: 1px solid #2d333b; border-radius: 6px; padding: 16px 20px; margin-bottom: 20px; }
  h1 { font-size: 16px; margin: 0 0 4px; color: #e6edf3; }
  .serial { color: #768390; font-size: 11px; letter-spacing: 0.08em; }
  .branches { margin: 8px 0 0; color: #96a0aa; }
  .branches b { color: #6cb6ff; font-weight: normal; }
  .lamp { display: inline-block; padding: 2px 10px; border-radius: 10px; font-size: 11px; letter-spacing: 0.06em; margin-left: 8px; }
  .lamp.clean { background: #113a1b; color: #56d364; border: 1px solid #238636; }
  .lamp.conflict { background: #3d1214; color: #f47067; border: 1px solid #c93c37; }
  .lamp.merged { background: #21262d; color: #a371f7; border: 1px solid #8957e5; }
  .stats { margin-top: 6px; color: #768390; }
  .stats .add { color: #56d364; } .stats .del { color: #f47067; }
  .conflicts { color: #f47067; }
  section.file { border: 1px solid #2d333b; border-radius: 6px; margin-bottom: 16px; overflow: hidden; }
  section.file h3 { font-size: 12px; font-weight: normal; color: #adbac7; background: #161b22; margin: 0; padding: 8px 12px; border-bottom: 1px solid #2d333b; }
  .line { display: flex; white-space: pre-wrap; word-break: break-all; }
  .line .no { flex: 0 0 44px; text-align: right; padding-right: 10px; color: #545d68; user-select: none; }
  .line code { flex: 1; }
  .line.add { background: #12261e; } .line.add code { color: #7ee39a; }
  .line.del { background: #25171c; } .line.del code { color: #f2857c; }
  .line.hunk { background: #131c2b; } .line.hunk code { color: #6cb6ff; }
  .line.meta code { color: #545d68; }
  .comment { margin: 4px 8px 8px 54px; border: 1px solid #3b434c; border-left: 3px solid #d29922; border-radius: 4px; padding: 6px 10px; background: #1c2128; }
  .comment .author { color: #d29922; }
  footer { color: #545d68; font-size: 11px; margin-top: 20px; }
  footer ul { margin: 6px 0 0; padding-left: 18px; }
  .empty { color: #768390; }
</style>
</head>
<body>
<header>
  <div class="serial">CHANGE REQUEST ${esc(cr.id.toUpperCase())} · ${esc(cr.repo)}${lamp}</div>
  <h1>${esc(cr.title)}</h1>
  <p class="branches"><b>${esc(cr.sourceBranch)}</b> → <b>${esc(cr.targetBranch)}</b> · base ${esc(cr.mergeBase.slice(0, 10))} · head ${esc(cr.sourceHead.slice(0, 10))}</p>
  <p class="stats">${cr.files.length} file(s) · <span class="add">+${additions}</span> <span class="del">−${deletions}</span> · ${cr.comments.length} comment(s)</p>
  ${conflicts}
</header>
${renderPatch(cr)}
<footer>
  <div>engine: ${timings || 'no timings recorded'}${cr.patchTruncated ? ' · PATCH TRUNCATED' : ''}</div>
  <ul>${history}</ul>
</footer>
</body>
</html>`;
}

function renderPatch(cr: ChangeRequest): string {
  if (!cr.patch.trim()) return '<p class="empty">No changes between these branches.</p>';
  return cr.patch
    .split(/\n(?=diff --git )/)
    .filter((section) => section.trim())
    .map((section) => renderFileSection(section, cr.comments))
    .join('\n');
}

function renderFileSection(section: string, comments: CrComment[]): string {
  const lines = section.split('\n');
  let oldPath = '';
  let newPath = '';
  for (const line of lines.slice(0, 6)) {
    if (line.startsWith('--- ')) oldPath = line.slice(4);
    if (line.startsWith('+++ ')) newPath = line.slice(4);
  }
  const file =
    newPath && newPath !== '/dev/null' ? newPath.replace(/^b\//, '') : oldPath.replace(/^a\//, '');

  let newLine = 0;
  const rows: string[] = [];
  for (const line of lines) {
    let cls = 'meta';
    let no = '';
    if (line.startsWith('@@')) {
      cls = 'hunk';
      const hunk = line.match(/\+(\d+)/);
      if (hunk) newLine = Number(hunk[1]);
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      cls = 'add';
      no = String(newLine++);
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      cls = 'del';
    } else if (line.startsWith(' ')) {
      cls = 'ctx';
      no = String(newLine++);
    }
    rows.push(
      `<div class="line ${cls}"><span class="no">${no}</span><code>${esc(line)}</code></div>`,
    );
    if (no) {
      for (const comment of comments) {
        if (comment.file === file && String(comment.line) === no) {
          rows.push(
            `<div class="comment"><span class="author">${esc(comment.author)}</span> · ${esc(comment.body)}</div>`,
          );
        }
      }
    }
  }
  return `<section class="file"><h3>${esc(file)}</h3><div class="diff">${rows.join('')}</div></section>`;
}
