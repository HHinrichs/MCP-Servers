# vault-mcp

MCP server that reads, writes, and searches Markdown notes in the `HHinrichs/Second-Brain` Obsidian vault and auto-pushes changes to GitHub.

## Server instructions

The behavioral rules served to MCP clients live **in the vault itself**: `AGENTS.md` in the vault root is the single source of truth. The server reads it per request (`src/lib/instructions.ts`), so editing the file changes the rules for every client without a redeploy. If the file is missing, a minimal fallback is served. The vault's `CLAUDE.md` is just an `@AGENTS.md` import pointer for Claude Code working directly on the files.

## Tools

| Name | Purpose |
|---|---|
| `quick_dump` | Append to `01 Inbox/Brain Dump.md` with a timestamp header |
| `add_to_project` | Append to a section in `02 Projekte/<project>.md` |
| `add_to_area` | Append to a section in `03 Bereiche/<area>/<area>.md` |
| `add_to_resource` | Append to `04 Ressourcen/<topic>/<topic>.md` under `## Notizen` |
| `add_to_context` | Append to one of the four product files in `00 Kontext/` |
| `update_daily` | Append to `05 Daily Notes/<today>.md` (creates if missing) |
| `search_notes` | Full-text search across all `.md` files, optionally filtered by folder |
| `find_similar` | TF-IDF similarity ranking against all notes (anti-sprawl pre-check) |
| `read_note` | Read the full content of a note |
| `list_inbox` | List inbox entries with timestamps |
| `move_note` | Move/rename a note (root `AGENTS.md`/`CLAUDE.md` are protected) |
| `split_note` | Extract a `## section` (incl. `###` subsections) into a new note, leaving a `[[Wikilink]]` stub |
| `get_briefing` | Recent daily notes + active projects + recent commits |

## Background jobs

- `daily_recap` — 03:00 Europe/Berlin daily, appends a commit summary to yesterday's Daily Note.
- `inbox_curation` — 04:00 daily, writes classification suggestions to `01 Inbox/_kuratierung.md`.

## Configuration (environment variables)

| Variable | Required | Notes |
|---|---|---|
| `MCP_BEARER_TOKEN` | Yes | Static bearer token for client auth. Generate with `openssl rand -hex 32`. |
| `MCP_ALLOWED_ORIGINS` | No | Comma-separated whitelist for the `Origin` header (DNS-rebinding protection). Empty allows requests without an Origin header (CLI clients). |
| `VAULT_REPO_PATH` | Yes | Path inside container where the vault is cloned (e.g. `/data/vault/repo`). |
| `VAULT_REPO_REMOTE` | Yes | `git@github.com:HHinrichs/Second-Brain.git` |
| `SSH_KEY_PATH` | Yes | Path to the deploy-key private file inside the container (e.g. `/data/vault/ssh/id_ed25519`). |
| `GIT_AUTHOR_NAME` | No | Default `Vault MCP`. |
| `GIT_AUTHOR_EMAIL` | No | Default `mcp@verdara-homegrow.de`. |
| `PUSH_DEBOUNCE_MS` | No | Default `30000` (30s). |
| `PORT` | No | Default `3000`. |
| `TZ` | No | Default `Europe/Berlin` (drives the cron schedules). |

## Endpoint

Streamable HTTP MCP endpoint at `POST/GET /mcp`. Auth via `Authorization: Bearer <token>`.

Health check at `GET /healthz` (returns `ok` without auth).

## Local dev

```bash
npm install
npm test        # vitest unit tests (no git/network access needed)
MCP_BEARER_TOKEN=dev VAULT_REPO_PATH=./tmp-vault VAULT_REPO_REMOTE=... SSH_KEY_PATH=~/.ssh/id_ed25519 npm run dev
```
