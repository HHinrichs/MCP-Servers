# vault-mcp

MCP server that reads, writes, and searches Markdown notes in the `HHinrichs/Second-Brain` Obsidian vault and auto-pushes changes to GitHub.

## Tools

| Name | Purpose |
|---|---|
| `quick_dump` | Append to `01 Inbox/Brain Dump.md` with a timestamp header |
| `add_to_project` | Append to a section in `02 Projekte/<project>.md` |
| `add_to_area` | Append to a section in `03 Bereiche/<area>/<area>.md` |
| `add_to_resource` | Append to `04 Ressourcen/<topic>/<topic>.md` under `## Notizen` |
| `update_daily` | Append to `05 Daily Notes/<today>.md` (creates if missing) |
| `search_notes` | Full-text search across all `.md` files, optionally filtered by folder |
| `read_note` | Read the full content of a note |
| `list_inbox` | List inbox entries with timestamps |
| `move_note` | Move/rename a note |

## Background jobs

- `daily_recap` — 22:00 Europe/Berlin daily, appends a summary section to today's Daily Note.
- `inbox_curation` — 03:00 daily, writes classification suggestions to `01 Inbox/_kuratierung.md`.

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
MCP_BEARER_TOKEN=dev VAULT_REPO_PATH=./tmp-vault VAULT_REPO_REMOTE=... SSH_KEY_PATH=~/.ssh/id_ed25519 npm run dev
```
