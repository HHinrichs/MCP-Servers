# MCP-Servers

Monorepo für selbstgehostete Model-Context-Protocol-Server.

## Server in diesem Repo

| Verzeichnis | Server | Zweck |
|---|---|---|
| `vault-mcp/` | Vault-MCP | Schreibt/liest in `HHinrichs/Second-Brain`-Vault über MCP für beliebige LLM-Clients |

## Deploy

Jeder Server in seinem eigenen Subordner mit `Dockerfile`. Coolify auf dem Hostinger-VPS hostet die Container, Base Directory ist jeweils der Subordner-Name.
