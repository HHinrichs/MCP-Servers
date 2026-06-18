# vault-mcp

MCP server that reads, writes, and searches Markdown notes in the `HHinrichs/Second-Brain` Obsidian vault. Writes go **origin-first via the GitHub API** (compare-and-swap on the branch ref, so two writers can never wedge); the local clone is a **read-only mirror** for the embedding search, refreshed via HTTPS.

## Server instructions

The behavioral rules served to MCP clients live **in the vault itself**: `AGENTS.md` in the vault root is the single source of truth. The server reads it per request (`src/lib/instructions.ts`), so editing the file changes the rules for every client without a redeploy. If the file is missing, a minimal fallback is served. The vault's `CLAUDE.md` is just an `@AGENTS.md` import pointer for Claude Code working directly on the files.

## Tools

| Name | Purpose |
|---|---|
| `quick_dump` | Create an atomic inbox note `01 Inbox/YYYY-MM-DD HHMM <Titel>.md` (one file per thought) |
| `add_to_project` | Append to a section in `02 Projekte/<project>.md` |
| `add_to_area` | Append to a section in `03 Bereiche/<area>/<area>.md` |
| `add_to_resource` | Append to `04 Ressourcen/<topic>/<topic>.md` under `## Notizen` |
| `add_to_context` | Append to one of the four product files in `00 Kontext/` |
| `update_daily` | Append to `05 Daily Notes/<today>.md` (creates if missing) |
| `search_notes` | Full-text search across all `.md` files, optionally filtered by folder |
| `find_similar` | Semantic similarity ranking against all notes (anti-sprawl pre-check) |
| `ask_vault` | Answer a question from the vault — retrieves relevant sections for the client LLM to synthesise a cited answer (local, no API) |
| `read_note` | Read the full content of a note |
| `list_inbox` | List atomic inbox notes, newest first (flags legacy Brain Dump entries) |
| `move_note` | Move/rename a note (root `AGENTS.md`/`CLAUDE.md` are protected) |
| `split_note` | Extract a `## section` (incl. `###` subsections) into a new note, leaving a `[[Wikilink]]` stub |
| `get_briefing` | Recent daily notes + active projects + recent commits |

## Background jobs

- `daily_recap` — 03:00 Europe/Berlin daily, appends a commit summary to yesterday's Daily Note.
- `inbox_curation` — 04:00 daily, writes per-note triage suggestions (target + move_note flow) to `01 Inbox/_kuratierung.md`.

## Configuration (environment variables)

| Variable | Required | Notes |
|---|---|---|
| `MCP_BEARER_TOKEN` | Yes | Static bearer token for client auth. Generate with `openssl rand -hex 32`. |
| `MCP_ALLOWED_ORIGINS` | No | Comma-separated whitelist for the `Origin` header (DNS-rebinding protection). Empty allows requests without an Origin header (CLI clients). |
| `VAULT_REPO_PATH` | Yes | Path inside container where the vault is cloned (e.g. `/data/vault/repo`). |
| `VAULT_REPO_REMOTE` | Yes | HTTPS clone URL, e.g. `https://github.com/HHinrichs/Second-Brain.git`. The token is injected at runtime — do not put it in the URL. |
| `GITHUB_TOKEN` | Yes | Fine-grained PAT with `Contents: read+write` on the vault repo. Used for both the API writes and the HTTPS mirror fetch. |
| `VAULT_REPO_BRANCH` | No | Default `main`. |
| `GIT_AUTHOR_NAME` | No | Default `Vault MCP`. |
| `GIT_AUTHOR_EMAIL` | No | Default `mcp@verdara-homegrow.de`. |
| `MIRROR_REFRESH_MS` | No | Default `45000` (45s). How often the read mirror pulls external changes (direct-mode pushes, Obsidian). |
| `SEMANTIC_INDEX_PATH` | No | Index cache file path. MUST be outside the repo dir — a `reset --hard` of the mirror would wipe an in-repo index. Default `<repo-parent>/semantic-index.json`. |
| `PORT` | No | Default `3000`. |
| `TZ` | No | Default `Europe/Berlin` (drives the cron schedules). |

## Endpoint

Streamable HTTP MCP endpoint at `POST/GET /mcp`. Auth via `Authorization: Bearer <token>`.

Health check at `GET /healthz` (no auth). Returns JSON `{"status":"ok","sync":{…}}` and **always HTTP 200** — a write stall surfaces as `sync.stale:true` in the body, never via the status code (so a stall can't trigger a container restart loop).

## Local dev

```bash
npm install
npm test        # vitest unit tests (no git/network access needed)
MCP_BEARER_TOKEN=dev VAULT_REPO_PATH=./tmp-vault VAULT_REPO_REMOTE=https://github.com/HHinrichs/Second-Brain.git GITHUB_TOKEN=github_pat_... npm run dev
```
