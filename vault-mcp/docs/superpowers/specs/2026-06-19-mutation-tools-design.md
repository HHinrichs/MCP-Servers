# Mutations-Tools für den Vault-MCP — Design

**Datum:** 2026-06-19
**Status:** Entwurf (genehmigt von Hannes, 2026-06-19)
**Repo:** `HHinrichs/MCP-Servers` → `vault-mcp/`
**Betroffenes Vault:** `HHinrichs/Second-Brain` (nur `AGENTS.md`-Regeltext + Server-Notiz)

## Motivation

Der MCP-Server ist heute append-only (`add_to_*`, `quick_dump`, `update_daily`, `split_note`, `move_note`). Korrekturen in-place, Dedup und Löschen gehen nur im **Direkt-Modus** (Claude Code auf den Dateien). Die Vault-Regeln (`AGENTS.md`) erlauben „klare, verifizierte Korrekturen" und Triage-Moves aber bereits — dem MCP fehlen nur die Werkzeuge. Diese Spec schließt die MCP↔Direkt-Modus-Lücke mit vier Tools, ohne den append-only-Default oder den Audit-Log-Charakter des Vaults zu opfern.

Die frühere Entscheidung „kein `edit_section`/`delete_section`" (siehe [[Vault-MCP-Server]] → Bekannte Limitierungen) wurde bewusst getroffen *„ohne Policy-Gegengewicht"*. Diese Spec liefert genau dieses Gegengewicht: Fail-loud-Guard, Soft-Delete, Refuse-Overwrite, Protected-Root.

## Ziele
- MCP kann bestehende Inhalte **korrigieren** (`edit_section`), **entfernen** (`delete_section`), Notizen **soft-löschen** (`delete_note`) und **neu anlegen** (`create_note`).
- Append bleibt Default; die neuen Tools sind explizit als Korrektur-/Aufräum-Werkzeuge gerahmt.
- Keine stillen Fehler: Konflikte und Not-Found werden laut gemeldet.
- Race-Sicherheit über das bestehende CAS-Write-Modell.

## Nicht-Ziele
- Kein generisches „beliebige Datei hart überschreiben/löschen".
- `add_to_context` bleibt auf die vier Strategie-Dateien kuratiert (neue 00-Kontext-Dateien laufen über `create_note`).
- Keine Änderung am Embedding-/Retrieval-Pfad.

## Die vier Tools

### `edit_section(file, section, new_content, expected_current)`
Ersetzt den Inhalt unter `## section` (inkl. `###`-Subsections, bis zum nächsten `#`/`##`).
- **Guard (Pflicht):** `expected_current` = der Block, den der Aufrufer zu ersetzen glaubt (vorher per `read_note` geholt). Vergleich trim-normalisiert.
- Section fehlt → `SectionNotFoundError`, kein Write. Guard-Mismatch → `SectionConflictError` mit dem *tatsächlichen* aktuellen Block, kein Write.
- Der `## section`-Header bleibt erhalten, nur der Body darunter wird ersetzt.

### `delete_section(file, section, expected_current)`
Entfernt `## section` (Header + Body + Subsections) in-place. Gleicher Guard wie `edit_section`. Nur git als Wiederherstellungs-Netz — **kein Archiv** (Section-Schnipsel sind schlecht als Dateien archivierbar; bewusste Entscheidung).

### `delete_note(path)`
Soft-Delete: verschiebt `path` nach `06 Archiv/<path>` (Ordnerstruktur erhalten). Existiert das Archiv-Ziel schon → Zeitstempel-Suffix vor `.md`. Mechanik identisch zu `move_note` (`writeMulti` mit `{path, delete:true}` + `{path, content}`).

### `create_note(path, content)`
Legt eine neue Datei an. **Refuse-overwrite:** existiert `path` → `NoteExistsError`, kein Write (Meldung: „existiert schon, nutze edit_section/add_to_*"). Minimal-Frontmatter (`tags: []`, `erstellt`, `updated`) wird ergänzt, falls `content` keinen `---`-Block hat; sonst wird vorhandenes Frontmatter geparst und `updated` neu gestempelt.

## Gemeinsames Sicherheitsmodell

1. **Guard in der Transform, nicht im Handler.** Der CAS-Loop (`writes.ts:50` `attemptLoop`) re-applied die Transform bei `RefMovedError`. Liefe der Guard nur im Handler (einmaliger Read), könnte ein paralleler Write zwischen Read und Apply clobbern. Darum prüft die **Transform selbst** gegen den frisch gelesenen Stand und wirft bei Mismatch.
2. **Throws = fail-loud, kein Retry.** Eine geworfene `SectionConflictError`/`SectionNotFoundError`/`NoteExistsError` ist *kein* `RefMovedError` → der Loop bricht sofort ab (`writes.ts:63-71`), kein Write. Der Handler fängt sie und gibt `{isError:true}` mit klarer Meldung zurück (inkl. aktuellem Block bei Conflict, damit das LLM neu liest und gezielt erneut schreibt).
3. **Soft statt hart.** `delete_note` archiviert statt zu löschen; immer als Datei + via git wiederherstellbar.
4. **Refuse-overwrite.** `create_note` schreibt nie über Bestehendes.
5. **Protected-Root.** `isProtectedRootFile` (`vault.ts:112`) blockt `AGENTS.md`/`CLAUDE.md` in allen vier Tools.
6. **Path-Escape.** `resolveVaultPath` (`vault.ts:269`) in `create_note`/`delete_note`.

## Code-Integration

### Neue pure Transforms in `lib/transforms.ts`
- `replaceSectionContent(raw, section, newContent, expectedCurrent): string`
- `removeSection(raw, section, expectedCurrent): string`
- Beide spiegeln die Section-Grenze von `splitNoteContent` (`transforms.ts:84`): Header per `^## <sec>\s*$/m`, Ende per `^#{1,2} /m` (nächstes `#`/`##`) → Block = dazwischen, inkl. `###`-Subsections. Vergleich gegen `expectedCurrent` trim-normalisiert.
- `create_note` nutzt das bestehende `createNoteContent` (`transforms.ts:63`) + einen kleinen Frontmatter-Wrap-Helfer.

### Neue typisierte Errors (`lib/errors.ts`, neu)
- `SectionNotFoundError(section)`, `SectionConflictError(section, actualBlock)`, `NoteExistsError(path)`.

### Writer-Nutzung (`lib/writes.ts`, unverändert)
- `edit_section`/`delete_section`: `writeToOrigin(file, transform, msg)` — Transform wirft die Guard-Errors.
- `delete_note`: `writeMulti([from], raws => [{path:from, delete:true}, {path:archive, content:raws[0]}], msg)`.
- `create_note`: `writeToOrigin(path, raw => { if (raw!==null) throw NoteExistsError; return wrapped; }, msg)`.

### Registrierung
Vier Tool-Objekte in `src/tools/`, eingetragen in `tools/index.ts` (`ALL_TOOLS`, 14 → 18). Handler fangen die typisierten Errors und mappen sie auf `{isError:true}`-Responses (Muster wie `move_note`/`split_note`).

## Doku- & Regel-Updates

### Vault `AGENTS.md` (Direkt-Edit, push auf `main`)
- „Zwei Arbeitsmodi" / „Konventionen → Default ist Append-only": ergänzen, dass der MCP-Modus jetzt `edit_section`/`delete_section`/`delete_note`/`create_note` für die ohnehin erlaubten verifizierten Korrekturen + Soft-Deletes hat; Append bleibt Default.
- Routing-Tabelle: `create_note` (neue Standalone-Notiz an beliebigem Pfad) ergänzen.

### MCP-Tool-Beschreibungen
Jede der vier Beschreibungen rahmt das Tool als Korrektur-/Aufräum-Werkzeug, nennt den Fail-loud-Guard bzw. Soft-Delete und weist auf „`read_note` zuerst" hin (für `expected_current`).

### [[Vault-MCP-Server]]-Notiz (Vault)
- „Bekannte Limitierungen → kein `edit_section`/`delete_section`" aktualisieren.
- Tool-Tabelle (14 → 18) ergänzen.

## Tests (TDD, vitest)
- **transforms:** replace/remove happy-path; Guard-Mismatch → `SectionConflictError` (trägt aktuellen Block); fehlende Section → `SectionNotFoundError`; `###`-Subsection-Grenze respektiert; Regex-Metazeichen im Section-Namen; trim-Normalisierung.
- **create_note:** refuse-overwrite (`raw!==null` → throw), Frontmatter-Wrap vs. vorhandenes Frontmatter, path-escape, protected-root.
- **delete_note:** Archiv-Pfad + Struktur-Erhalt, Clash-Suffix, protected-root, source-vanished.
- **edit/delete_section Handler:** isError-Mapping der Errors → Meldungstext mit aktuellem Block.
- Mock-Writer wie in den bestehenden Tests (kein Git-Zugriff).

## Rollout
1. Branch `feat/mutation-tools` im MCP-Repo.
2. TDD-Implementierung; `npm test` + typecheck/build grün.
3. Commit MCP-Repo; `AGENTS.md` + [[Vault-MCP-Server]]-Notiz im Vault committen und auf `main` pushen (vorher `git pull`).
4. Coolify-Redeploy der App `vault-mcp` (Public-Repo pollt nicht automatisch).
5. Live-Smoke gegen eine Wegwerf-Notiz: je ein `create_note` / `edit_section` (Guard-OK **und** Guard-Conflict) / `delete_section` / `delete_note`.

## Genehmigte Mini-Entscheidungen (2026-06-19)
- Guard ist **Pflicht** (kein force-Bypass).
- Archiv-Pfad **spiegelt die Ordnerstruktur**.
- `delete_section` ist **in-place** (kein Archiv).
