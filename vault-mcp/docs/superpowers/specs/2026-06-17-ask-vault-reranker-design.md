# Spec: Lokaler Reranker für `ask_vault`

**Datum:** 2026-06-17 · **Status:** Design approved (Scope: nur `ask_vault`) · **Repo:** `vault-mcp`

## Ziel

Trefferqualität von `ask_vault` erhöhen: nach dem Embedding-Retrieval ordnet ein **lokaler Cross-Encoder-Reranker** die Kandidaten-Sections nach echter Frage-Relevanz neu (Retrieve-then-Rerank), bevor sie ans Client-LLM gehen. Vollständig lokal/offline, kein API, Architektur spiegelt den bestehenden Embedder.

## Nicht-Ziele (YAGNI)

- Kein Reranking in `find_similar` (eigene 0.84/0.90-Dedup-Schwellen, läuft pro Schreibvorgang → mehr Last, wenig Gewinn).
- Kein neues Tool, keine Konfig-UI — rein interne Pipeline-Verbesserung, Steuerung nur über ENV.

## Modell

- **Default:** `onnx-community/bge-reranker-v2-m3-ONNX` (multilingual XLM-R, DE/EN), dtype **q8** (ENV-konfigurierbar; falls für das Modell nicht verfügbar, kleinste verfügbare Quantisierung — in der Impl verifiziert).
- ENV: `RERANK_MODEL_ID`, `RERANK_MODEL_DTYPE`, `RERANK_ENABLED` (default `true`), `RERANK_ALLOW_REMOTE` (nur Build-Prefetch).
- Cross-Encoder: Input `(query, passage)` → Relevanz-Logit (höher = relevanter). Läuft via `text-classification` in transformers.js.

## Komponenten

### `src/lib/reranking.ts` (neu)
- `interface Reranker { rerank(query, passages): Promise<number[]>; readonly id: string }` — ein Score pro Passage, in Eingabe-Reihenfolge.
- `createTransformersReranker()` — lazy import von `@huggingface/transformers`, offline-env-gated, promise-memoized Load, `(query, passage)`-Paare batched. Spiegelt `createTransformersEmbedder()` 1:1.
- `createFakeReranker()` — deterministisch (Score = Token-Overlap query↔passage), für Tests, kein Modell-Load.

### `src/tools/ask_vault.ts` (geändert)
1. Frage einbetten → Top-K Kandidaten über den Index (Cosine-Floor `SIM.answer` bleibt das Eintritts-Gate; K leicht erhöhen, ~15–20).
2. **Rerank:** `reranker.rerank(frage, kandidatenTexte)` → absteigend nach Score sortieren.
3. **Select:** bestehende `select()`-Logik (Per-Note-Cap = 3, Char-Budget = 8000) auf der gereihten Liste. Der bisherige `TOP_GAP`-Cosine-Filter (0.03) wird durch ein Rerank-Score-Kriterium ersetzt (relativer Abstand zum Top-Logit) — exakter Wert in der Impl empirisch.
4. Reranker wird **injizierbar** (wie Index/Embedder), damit `ask_vault.test.ts` ihn mit FakeReranker testet.

### Robustheit
- **Lazy:** Modell lädt beim ersten `ask_vault`, blockiert den Boot nicht.
- **Fallback:** `RERANK_ENABLED=false`, Modell nicht bereit, oder `rerank()` wirft → **Embedding-Reihenfolge** wird verwendet (wie der TF-IDF-Fallback). `ask_vault` darf nie am Reranker scheitern.

### Build / Deploy
- `scripts/prefetch-model.js` (oder Peer) lädt das Reranker-Modell zur **Docker-Build-Zeit** in die Cache-Dir; Dockerfile kopiert sie ins Runtime-Image; Runtime offline (`RERANK_ALLOW_REMOTE=true` nur im Builder-Stage, wie `EMBED_ALLOW_REMOTE`).
- RAM: +~einige hundert MB (q8 XLM-R) — der 7.8-GB-VPS verkraftet das neben dem Embedder.

## Performance

- Reranking von ~15–20 `(query, passage)`-Paaren in **einer** batched Inferenz. Grobe Schätzung 2-Core-CPU/q8: ~2–4 s pro `ask_vault` — akzeptabel (interaktiver Call, nicht hochfrequent). Zu langsam → Kandidatenzahl senken oder via ENV auf leichteren Reranker wechseln, keine Logik-Änderung.

## Tests (TDD)

- `tests/reranking.test.ts`: FakeReranker (Score = Overlap); rerank-then-sort; leere Eingabe; `scores.length === passages.length`.
- `tests/ask_vault.test.ts` (erweitern): injizierter FakeReranker → andere, rerank-bestimmte Reihenfolge als Embedding-only; Reranker wirft → Embedding-Fallback, kein Fehler.
- Volle Suite + Typecheck grün; echte Modell-Tests bleiben hinter `RUN_MODEL_TESTS`.

## Deploy

Code → `HHinrichs/MCP-Servers` `main` → **Coolify-Redeploy** (manuell), damit das Modell geprefetcht + geladen wird.
