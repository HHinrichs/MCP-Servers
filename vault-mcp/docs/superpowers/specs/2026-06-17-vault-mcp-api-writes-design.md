# Spec: Vault-MCP — Writes über GitHub-API, Klon nur noch Lese-Spiegel

**Datum:** 2026-06-17 · **Status:** Design approved · **Repo:** `vault-mcp`

## Ziel

Den stillen Sync-Wedge **konstruktiv unmöglich** machen. Schreibvorgänge gehen nicht mehr über lokale Commits im Server-Klon (die mit Hannes' Direkt-Modus-Pushes divergieren und beim Rebase stumm hängen bleiben können — Incident 2026-06-13, ~3 Tage / 10 Commits gestrandet), sondern **direkt über die GitHub-API auf `origin`**. Der lokale Klon wird zum **reinen, wegwerfbaren Lese-Spiegel** für die semantische Suche — hält nie eigene Commits, kann also nicht mehr verklemmen.

## Nicht-Ziele (YAGNI)

- **Kein** Wegfall der lokalen Vault-Kopie — die Embedding-Suche braucht schnellen Dateizugriff (kein API-Roundtrip/Rate-Limit pro Query). Bestätigt 2026-06-17. Nur die Schreib-Mechanik wandert weg vom Klon.
- **Kein** Webhook-getriebener Refresh — periodischer `fetch + reset` reicht; Webhook ist optionaler späterer Ausbau.
- **Keine** neue Tool-Schnittstelle — die Client-Sicht der 8 Tools + 2 Jobs bleibt unverändert; nur die Plumbing darunter ändert sich.
- **Kein** Batching mehrerer Writes in einen Commit — die 30 s-Debounce entfällt; ein Commit pro Write (ehrlicher + simpler).

## Architektur: vorher → nachher

**Vorher:** Tool schreibt lokale Datei → `markDirty` → 30 s-Debounce → `git commit + pull --rebase + push`. Der **lokale Commit** divergiert bei Parallel-Writes → Rebase-Konflikt → stiller Retry-Loop (Wedge).

**Nachher:** Tool ruft `writeToOrigin(transform)` → **origin-first Commit über die Git-Data-API** mit Compare-and-Swap auf die Branch-Ref; bei Kollision re-fetch + Transform neu anwenden. Danach Spiegel-Datei aktualisieren (instant read-after-write). Ein Hintergrund-Loop hält den Spiegel via `fetch + reset --hard origin/main` aktuell (zieht externe Änderungen rein). **Kein lokaler Commit existiert je.**

## Schreib-Pfad (Kern-Algorithmus)

Pro Write (`writeToOrigin(file, transform, message)`):
1. Aktuellen Datei-Inhalt + Branch-Head-SHA von `origin` holen (Datei fehlt → leerer Inhalt).
2. **Transform** anwenden: reine Funktion `(alterInhalt) → neuerInhalt`.
3. Commit auf `origin` bauen: Blob(s) → Tree (Basis = aktueller Head-Tree) → Commit (Parent = Head, Author/Committer aus `GIT_AUTHOR_*`) → `updateRef` mit **`force:false`** (Compare-and-Swap).
4. CAS-Fehler (Head bewegt — z.B. Direkt-Modus-Push dazwischen) → **ab 1 neu**: frischen Inhalt holen, Transform erneut anwenden, neu committen. Cap 5 Versuche + kurzer Backoff. Appends landen am neuen Ende → konfliktfrei.
5. Nach Erfolg: neuen Inhalt **in die lokale Lese-Kopie schreiben** → Suche sieht den Write sofort; späterer `reset --hard` ist No-Op (Inhalt == origin). Status-Tracking aktualisieren.

**Zwei abgesegnete Konsequenzen (2026-06-17):**
- **(a) Writes sind synchron + ehrlich** — Tool wartet auf den origin-Commit (~hundert(e) ms) und meldet wahrheitsgemäß „gespeichert + gepusht". Klasse *committed-but-not-pushed* verschwindet.
- **(b) Writes scheitern laut** — geht der Commit nach Retries nicht durch (GitHub down / Token weg), gibt das Tool einen **Fehler** zurück, **kein** lokales Queuen (das brächte die Divergenz zurück).

## Komponenten

### `src/lib/transforms.ts` (neu) — reine Schreib-Transforms
Schreiblogik von fs entkoppelt; pro Operation eine **reine, re-runnable Funktion** (Voraussetzung fürs CAS-Retry):
- `appendUnderSection(content, section, entry) → content`
- `createNote(frontmatter, body) → content`
- `splitNote(sourceContent, section) → { source, target }`
- `moveNote`: reiner Pfad-Move (kein Inhalts-Transform) → im Tree als delete+add.
Frontmatter-/Timestamp-Pflege wandert aus den fs-Helfern hierher (reiner Input→Output). **Tötet den Append-RMW-Race** (Serialisierung jetzt am origin via CAS).

### `src/lib/github.ts` (neu) — origin-first Writer über Git-Data-API
- `interface GitHubWriter { writeFiles(changes: {path, content?, delete?}[], message): Promise<void> }` — mehrere Dateien **atomar in einem Commit**.
- Ablauf: Head-SHA → Base-Tree → neue Blobs → neuer Tree → Commit → `updateRef(force:false)`. CAS-Fail (`422`) wirft einen typisierten `RefMovedError`, den die Orchestrierung fängt.
- `createFakeWriter()` — In-Memory-Repo-Sim inkl. **erzwingbarem CAS-Konflikt**, für Tests ohne Netz.

### `src/lib/writes.ts` (neu) — Orchestrierung + Retry
- `writeToOrigin(file, transform, message)` (Single-File) und `writeMulti(changes, message)` (move/split): origin-Inhalt holen → Transform → `github.writeFiles` → bei `RefMovedError` Transform neu anwenden, retry (Cap 5 + Backoff). Nach Erfolg: Spiegel schreiben + Status-Tracking.

### `src/lib/git.ts` (stark verkleinert) — nur Lese-Spiegel + Status
- Behält: Klon/Fetch, **`refreshMirror()`** = `fetch + reset --hard origin/main`, **serialisiert gegen Index-Reconcile** (Single-Flight-Chain von 2026-06-13 erweitern), Boot-Clone (darf **immer** resetten → Boot kann nicht verklemmen).
- Raus: `commitAndPush`, Debounce, `markDirty`/`flushNow`, pull-rebase-abort, SSH-Setup.
- `getSyncStatus()` bleibt, **umgepolt**: statt `ahead`/Push jetzt **API-Write-Health** (`lastWriteOkAt`, `lastWriteError`, `consecutiveWriteFailures`); `stale = letzter Write fehlgeschlagen`. Reine `evaluateSync()` analog anpassen (Tests mit).

### 8 Tools + 2 Jobs (Anpassung)
Jedes `markDirty(msg)` → `await writeToOrigin(file, transform, msg)` (bzw. `writeMulti` bei move/split). Der lokale fs-Write in den Tools entfällt (passiert zentral nach dem origin-Commit). `daily_recap` macht vor dem `git log`-Lesen ein `refreshMirror()`.

### `src/index.ts` — Mirror-Refresh-Loop
Periodischer `refreshMirror()` (`MIRROR_REFRESH_MS`, default `45000`), `.unref()`. Ersetzt den reinen Sync-Watchdog (der Write-Health-Teil bleibt über `/healthz`).

### `/healthz` (`server.ts`)
Body-Shape bleibt JSON, **immer HTTP 200**; `sync` reportet jetzt Write-Health statt Push-ahead.

## Auth — eine Quelle

- **Ein fine-grained PAT** (`Contents: read+write`, nur `Second-Brain`-Repo) in ENV `GITHUB_TOKEN`.
- Writes: Git-Data-API mit `Authorization: Bearer <token>`.
- Reads: Mirror-Fetch über HTTPS, Token injiziert (`https://x-access-token:<token>@github.com/…`). **SSH-Deploy-Key + `known_hosts` + `ssh`-Volume entfallen.**

## Fehler & Edge-Cases

1. **Transform-Reinheit** — Kern-Refactor; ermöglicht das CAS-Retry und tötet den Append-RMW-Race.
2. **Create vs. Append** — neue Datei: origin-GET 404 → Transform startet bei leerem Inhalt; Tree-Build legt sie an.
3. **Multi-File atomar** — `move_note`/`split_note` als ein Tree/Commit.
4. **Mirror-Reset vs. Query** — `reset --hard` gegen Index-Reconcile serialisieren (kein Torn-Read).
5. **`daily_recap`** — vor dem `git log` `refreshMirror()`, damit die via API gemachten Bot-Commits sichtbar sind.
6. **Retry-Cap** — pathologischer Dauerkonflikt spinnt nicht endlos; nach Cap → lauter Fehler.

## Tests (TDD)

- **`tests/transforms.test.ts`** — reine Transforms (append/create/split): Content-in → Content-out, idempotent re-runnable. Schnell, kein Git/Netz.
- **`tests/writes.test.ts`** — `writeToOrigin` gegen `createFakeWriter()`: Happy-Path; **CAS-Konflikt-dann-Erfolg** (Ref bewegt → Retry wendet Transform neu an, kein verlorener Eintrag); Hard-Fail nach Cap → Fehler propagiert.
- **`tests/sync_status.test.ts`** — auf Write-Health umstellen (`stale = letzter Write fehlgeschlagen`).
- Bestehende Tool-Tests bleiben grün (Client-Sicht unverändert); fs-Mock bzw. injizierter Fake-Writer.
- Mirror-Refresh: leichter Integrationstest gegen Temp-Repo **oder** Deploy-Verify.
- Volle Suite + Typecheck grün; echte Modell-/Netz-Tests hinter Flags.

## Operator-Setup (Hannes) — Coolify + GitHub

**GitHub (1×):**
1. **Fine-grained PAT anlegen:** Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → *Generate new token*.
   - **Resource owner:** dein Account.
   - **Repository access:** *Only select repositories* → **`HHinrichs/Second-Brain`**.
   - **Permissions → Repository:** **Contents: Read and write** (Metadata: Read wird automatisch gesetzt). Sonst nichts.
   - **Expiration:** deine Wahl (z.B. 1 Jahr). ⚠️ Bei Ablauf scheitern Writes **laut** (`/healthz` `sync.stale`, Tool-Fehler) → neuen PAT erzeugen + in Coolify ersetzen.
   - Token kopieren (`github_pat_…`, wird nur einmal angezeigt).
2. **Erst NACH erfolgreicher Migration:** Repo → Settings → **Deploy keys** → `vault-mcp`-Key löschen. Nicht vorher.

**Coolify (am `vault-mcp`-Container):**
1. **Environment:**
   - **Neu:** `GITHUB_TOKEN` = der PAT (als Secret markieren).
   - **Ändern:** `VAULT_REPO_REMOTE` → HTTPS-URL `https://github.com/HHinrichs/Second-Brain.git` (Token NICHT in die URL — injiziert der Code).
   - **Setzen:** `SEMANTIC_INDEX_PATH` → Pfad im neuen Cache-Volume, z.B. `/data/index/index.json`.
   - **Entfernen:** `SSH_KEY_PATH`, `PUSH_DEBOUNCE_MS` (obsolet).
2. **Volumes:**
   - **Neu:** persistentes Volume für den Index-Cache, gemountet auf z.B. `/data/index` — **schreibbar für den Container-User `node`** (= EACCES-Fix).
   - **Entfernen:** das `ssh`-Volume.
   - `repo`-Volume kann bleiben (jetzt reiner Cache) oder ephemer werden.
3. **Redeploy**, nachdem der Code auf `main` ist.

**Reihenfolge:** PAT anlegen → Coolify-ENV/Volumes setzen → Code mergen → Redeploy → verifizieren (`/healthz` `sync.stale:false`; Test-`quick_dump` landet auf GitHub) → **dann** SSH-Deploy-Key löschen.

_(Exakte aktuelle ENV-Namen/Volume-Pfade gleichen wir beim Umsetzen gegen die Live-Coolify-Config ab.)_

## Mit-erledigte Folgepunkte

- **Wedge** — konstruktiv unmöglich (kein lokaler Commit existiert je).
- **Append-RMW-Race** (`src/lib/vault.ts`) — Serialisierung am origin via CAS.
- **EACCES** (Index-Cache) — eigenes schreibbares Volume + `SEMANTIC_INDEX_PATH`.

## Migration / Deploy

Code → `HHinrichs/MCP-Servers` `main`. Vor Redeploy: PAT + Coolify-ENV/Volumes setzen (s.o.). Redeploy. Verifizieren. SSH-Key löschen. Die alte SSH-/Debounce-/commitAndPush-Mechanik wird im selben PR entfernt, nicht parallel betrieben.
