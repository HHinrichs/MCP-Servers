# MCP-Servers

Monorepo für selbstgehostete Model-Context-Protocol-Server.

## Server in diesem Repo

| Verzeichnis | Server | Zweck |
|---|---|---|
| `vault-mcp/` | Vault-MCP | Schreibt/liest in `HHinrichs/Second-Brain`-Vault über MCP für beliebige LLM-Clients |

## Deploy

Jeder Server in seinem eigenen Subordner mit `Dockerfile`. Coolify auf dem Hostinger-VPS hostet die Container, Base Directory ist jeweils der Subordner-Name.

---

# vault-mcp — Client-Setup-Anleitung

Diese Anleitung erklärt, wie du den Vault-MCP-Server in **Claude Code CLI**, **Claude Desktop / claude.ai Web** und **Microsoft Copilot (GitHub Copilot in VS Code)** einrichtest — jeweils für **Mac** und **Windows**.

Endpoint: `https://mcp.verdara-homegrow.de/mcp`
Auth: `Authorization: Bearer <token>`

## 0. Token besorgen

Der Bearer-Token wird pro Rechner einmal lokal gespeichert. Niemals in Repos, niemals im Chat teilen.

**Windows:** `C:\Users\<dein-user>\.config\vault-mcp-token.txt`
**Mac/Linux:** `~/.config/vault-mcp-token.txt`

Wenn du den Token auf einem neuen Rechner noch nicht hast:

1. **Empfehlung:** Kopiere ihn aus deinem Passwortmanager oder von einem Rechner, auf dem er schon liegt. Es ist ein 64-Zeichen-Hex-String, eine Zeile, ohne Leerzeichen/Anführungszeichen.
2. **Alternative:** Generiere einen neuen Token und rotiere serverseitig (Schritt-für-Schritt im Runbook des Vault: siehe `02 Projekte/Vault-MCP-Server.md`).

Token-Datei anlegen:

```bash
# Mac / Linux
mkdir -p ~/.config && chmod 700 ~/.config
# Token in die Datei schreiben — z.B. via Editor — dann:
chmod 600 ~/.config/vault-mcp-token.txt
```

```powershell
# Windows PowerShell
$dir = "$env:USERPROFILE\.config"
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
# Token reinkopieren in: $dir\vault-mcp-token.txt
# Owner-only Permissions:
icacls "$dir\vault-mcp-token.txt" /inheritance:r /grant:r "${env:USERNAME}:F"
```

---

## 1. Claude Code CLI (empfohlene Primärintegration)

Funktioniert identisch auf Mac und Windows. Voraussetzung: `claude --version` läuft.

**Mac / Linux:**
```bash
TOKEN=$(cat ~/.config/vault-mcp-token.txt)
claude mcp add --transport http --scope user vault \
  https://mcp.verdara-homegrow.de/mcp \
  -H "Authorization: Bearer $TOKEN"
```

**Windows PowerShell:**
```powershell
$TOKEN = Get-Content "$env:USERPROFILE\.config\vault-mcp-token.txt"
claude mcp add --transport http --scope user vault `
  https://mcp.verdara-homegrow.de/mcp `
  -H "Authorization: Bearer $TOKEN"
```

Verifizieren:
```bash
claude mcp list
# erwartet: vault: https://mcp.verdara-homegrow.de/mcp (HTTP) - ✔ Connected
```

Die Config landet in `~/.claude.json` (Mac) bzw. `C:\Users\<user>\.claude.json` (Windows).

---

## 2. Claude Desktop (Anthropic native App)

Claude Desktop's Config-Datei unterstützt direkten HTTP-MCP — alternativ über den `mcp-remote`-Wrapper als Fallback, falls die native HTTP-Variante in deiner Version noch nicht greift. Voraussetzung für den Fallback: **Node.js 18+** installiert.

### Config-Datei finden

**Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`

**Windows:** `%APPDATA%\Claude\claude_desktop_config.json` (= `C:\Users\<user>\AppData\Roaming\Claude\claude_desktop_config.json`)

Wenn die Datei nicht existiert: Claude Desktop einmal öffnen + schließen, oder selbst anlegen.

### Variante A — Direktes HTTP (neuere Claude-Desktop-Versionen)

```json
{
  "mcpServers": {
    "vault": {
      "type": "http",
      "url": "https://mcp.verdara-homegrow.de/mcp",
      "headers": {
        "Authorization": "Bearer DEINTOKENHIER"
      }
    }
  }
}
```

### Variante B — Wrapper über npx mcp-remote (Fallback, sicher kompatibel)

```json
{
  "mcpServers": {
    "vault": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp.verdara-homegrow.de/mcp",
        "--header",
        "Authorization:Bearer DEINTOKENHIER"
      ]
    }
  }
}
```

`DEINTOKENHIER` durch den 64-stelligen Wert aus der Token-Datei ersetzen. Dann **Claude Desktop neu starten**. Im Status-Menü (Hammer-/Stecker-Symbol oben in der Chat-Eingabe) sollte `vault` erscheinen.

### Alternative: claude.ai Web (Pro / Team / Enterprise)

Schnellster Weg, ohne Config-Datei. Setzt einen kostenpflichtigen Plan voraus.

1. **claude.ai** öffnen, einloggen.
2. **Settings** → **Connectors** (oder „Profile/Settings → Integrations" je nach Version).
3. **Add custom connector**.
4. URL: `https://mcp.verdara-homegrow.de/mcp`
5. Authentication: **Bearer Token** → Token aus der Token-Datei einfügen.
6. **Save**. Der Connector `vault` ist sofort in allen Conversations verfügbar.

---

## 3. Microsoft Copilot (GitHub Copilot in VS Code)

GitHub Copilot ab **VS Code 1.96+** unterstützt remote MCP-Server. Du kannst die Config über die UI-Workflow „MCP: Add Server" (Command Palette) anlegen lassen oder die Datei direkt schreiben.

### Config-Datei finden (User-Scope)

**Mac:** `~/Library/Application Support/Code/User/mcp.json`

**Windows:** `%APPDATA%\Code\User\mcp.json` (= `C:\Users\<user>\AppData\Roaming\Code\User\mcp.json`)

(Workspace-Scope alternativ: `.vscode/mcp.json` im jeweiligen Projekt — nicht empfohlen für persönliche Token.)

### Eintrag

```json
{
  "servers": {
    "vault": {
      "type": "http",
      "url": "https://mcp.verdara-homegrow.de/mcp",
      "headers": {
        "Authorization": "Bearer DEINTOKENHIER"
      }
    }
  }
}
```

`DEINTOKENHIER` durch den Token aus der Token-Datei ersetzen. Dann **VS Code neu starten**.

In Copilot Chat das Tool-Symbol (Schraubenschlüssel/Werkzeug-Icon im Chat-Input) öffnen → die `vault`-Tools müssen dort aktivierbar sein. Im Chat einfach normal sprechen — Copilot ruft die Tools von selbst auf, sobald sie relevant sind.

---

## Verbindung testen

In jedem Client:

> Wo war ich gestern?

Ein funktionierendes Setup ruft `get_briefing` automatisch auf und antwortet mit Inhalt aus den Daily Notes + aktiven Projekten. Wenn der Vault noch leer ist, kommt eine entsprechende Meldung („Keine Daily Notes vorhanden") — auch das ist ein Erfolg, weil heißt: Connection + Auth funktionieren.

## Troubleshooting

| Symptom | Ursache | Fix |
|---|---|---|
| 401 Unauthorized | Token falsch oder mit Whitespace eingefügt | Token-Datei neu lesen, kein Trim-Whitespace, keine Spitzklammern `<...>`, keine Anführungszeichen |
| 401 nach Token-Rotation | Laufende Client-Sessions lesen die MCP-Config nur beim Start und halten den alten Token | Alle laufenden Clients (Claude Code Session, Claude Desktop, VS Code) einmal neu starten |
| 403 Forbidden | Origin-Header ist nicht in der Whitelist (`MCP_ALLOWED_ORIGINS`) | Betrifft nur browser-basierte Clients (z.B. claude.ai Web). Der Hostinger-Admin muss den Origin in der ENV-Variable des `vault-mcp`-Containers ergänzen. |
| Connection timeout | URL-Tippfehler oder DNS noch nicht propagiert | `curl https://mcp.verdara-homegrow.de/healthz` muss `ok` zurückgeben |
| Tools tauchen im Client nicht auf | Config wurde nicht erkannt | Client komplett neu starten, Config-Datei auf gültiges JSON prüfen, in Logs schauen |
| Briefing ist leer / „Keine Daily Notes" | Du hast noch nichts in den Vault geschrieben | Sag z.B. „merk dir das: Test" — beim nächsten Briefing taucht das auf |

## Sicherheit

- Der Token gibt **Vollzugriff** auf den gesamten Vault (Lesen und Schreiben). Behandle ihn wie ein Passwort.
- Owner-only Permissions auf die Token-Datei. Niemals in Repos committen.
- Bei Verdacht auf Leak: rotieren — siehe Token-Rotation-Runbook in `02 Projekte/Vault-MCP-Server.md` im Vault.
- Aktuell ist es **ein** Token für alle Clients. Wenn ein Client kompromittiert ist, müssen alle neu konfiguriert werden. Eine Multi-Token-Variante ist ein offener Folgepunkt.
