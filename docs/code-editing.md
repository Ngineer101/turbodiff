# Code browser & editor

`/repos/:id/code` gives every repo a browser-based codebase viewer and a
single-file editor. One page, one API contract, two storage backends: GitHub
repos are served through the GitHub REST API, turbodiff-hosted (Cloudflare
Artifacts) repos through real git in the per-repo sandbox. This doc explains
the shared architecture and where the two adapters diverge.

## Shared architecture

```text
client (src/client/pages/code.tsx)
        |
        v
routes (src/http/api.ts)  -- auth, validation, provider dispatch
        |
        +--> repo.provider === 'github'    -> src/services/repo-browser.ts
        +--> repo.provider === 'artifacts' -> src/services/repo-browser-artifacts.ts
```

Both adapters implement the same contracts from `src/shared/api-types.ts`, so
the client is provider-agnostic apart from the save-mode toggle:

- `GET /repos/:id/code` → `ApiRepoCode` — branches + default branch for the
  page header.
- `GET /repos/:id/tree?ref=&path=` → `ApiRepoTree` — one directory level,
  fetched lazily per expanded directory.
- `GET /repos/:id/file?ref=&path=` → `ApiRepoFile` — file content with
  `binary` / `too_large` fallbacks (1 MB text cap on both providers).
- `PUT /repos/:id/file` → `ApiFileSave` — save one edited file as a commit.

Shared pieces live in `repo-browser.ts` and are reused by the Artifacts
adapter: `isValidRepoRef` / `isValidRepoPath` (no `..`, no absolute paths, no
ref metacharacters — asserted in the routes and re-asserted in the Artifacts
adapter before anything reaches a sandbox exec), `sortTreeEntries` (dirs
first, name-sorted), `decodeBase64Text` (UTF-8 or `binary`), and
`RepoBrowserError` (client-mistake 400/409 vs the generic 502 mapping).

Saves use optimistic concurrency on both providers: the client sends the
`base_sha` it loaded (or `null` for a new file), and a mismatch — including a
push race — maps to a 409 telling the user to reload and reapply the edit.
Commits are attributed to the session user via explicit author/committer
fields rather than the App bot.

## GitHub adapter (`src/services/repo-browser.ts`)

A pure REST adapter: no clone, no sandbox, no local state.

- **Reads** go through the contents API with a cached installation token
  minted by the route. Directory listings and file blobs are single API
  calls; blobs over GitHub's 1 MB contents limit surface as `too_large`.
- **Writes** use a least-privilege `sandboxGitToken` (write scope, single
  repo) and a contents-API `PUT`, passing `base_sha` as the API's `sha`
  precondition. GitHub enforces the staleness check server-side.
- **Save modes**: `commit` (directly to the viewed branch) or `pr` — the
  adapter creates a `turbodiff/edit-…` branch from the viewed ref, commits
  there, and opens a pull request.
- **Authorization**: the route checks the caller's own GitHub push permission
  on the repo before minting any write token, so read-only collaborators of
  the installation cannot save.

## Artifacts adapter (`src/services/repo-browser-artifacts.ts`)

Artifacts has no contents REST API, so the same contracts are computed with
real git in the warm per-repo sandbox — the pattern established by the CR
engine (`src/ai/runtime/cr-engine.ts`).

- **Workspace**: a full mirror in `/workspace/code-browse`, deliberately
  separate from the CR engine's `/workspace/cr-workspace` in the same
  container — the engine hard-resets its directory and the browser mutates
  this one. Every request clones on first touch and `fetch --prune`s after.
- **Credentials** are minted inside the adapter via `resolveWorkspaceRemote`
  (read or write scope per operation), not by the route.
- **Reads**: branches via `for-each-ref`, trees via NUL-separated
  `ls-tree -l -z` (filenames with spaces/quotes parse safely), files via
  `cat-file`, with content shipped out as base64 because exec stdout is not
  binary-safe. The 1 MB `too_large` cap mirrors the GitHub adapter.
- **Writes**: the save re-runs the staleness check itself
  (`rev-parse origin/<ref>:<path>` vs `base_sha`), checks out a dedicated
  `code-edit` branch so concurrent reads (which only touch
  `refs/remotes/origin/*`) are unaffected, commits, and pushes to the branch.
  A non-fast-forward rejection — a race that slipped past the check — maps to
  the same 409; any failure hard-resets the worktree so no half-committed
  state leaks into the next browse or save.
- **Command injection safety**: user-influenced values (ref, path, message,
  author) only travel via env vars referenced as `"$VAR"` in command strings;
  file content goes through `sandbox.writeFile`, never through env or the
  command string. Errors are secret-redacted before leaving the adapter.
- **Save modes**: `commit` only. There is no PR save mode — the native
  change-request layer covers review flows, and the route rejects `mode: 'pr'`
  for Artifacts repos with an explicit error. The client pins the toggle to
  direct commit accordingly.
- **Authorization**: saves gate on the org `settings` capability — the same
  bar as the CR Merge button — since Artifacts repos have no per-user forge
  permissions to defer to.
- **Events**: no extra plumbing — the push fires `ArtifactsEventsWorkflow`
  like any other push (`last_push_at` stamp, CR refresh, review-on-push).

## Differences at a glance

|                        | GitHub                                                 | Artifacts                                                   |
| ---------------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| Transport              | REST contents API                                      | real git in the per-repo sandbox                            |
| Local state            | none                                                   | full mirror in `/workspace/code-browse`                     |
| Credentials            | minted by the route (installation / `sandboxGitToken`) | minted in the adapter (`resolveWorkspaceRemote`)            |
| Staleness check        | GitHub enforces `sha` precondition                     | adapter compares `rev-parse` to `base_sha`, push race → 409 |
| Save modes             | commit or branch + PR                                  | commit only                                                 |
| Write authorization    | caller's GitHub push permission                        | org `settings` capability                                   |
| Post-push side effects | GitHub webhooks                                        | `ArtifactsEventsWorkflow`                                   |

## Adding a provider or endpoint

Keep the seam where it is: routes own auth, validation, and provider
dispatch; adapters own transport. A new capability should land as one
function per adapter behind the same `Api*` contract, with path/ref hygiene
asserted before any request or exec is built.
