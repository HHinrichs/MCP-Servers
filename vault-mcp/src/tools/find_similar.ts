import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { vaultPath, walkMarkdown } from "../lib/vault.js";
import { getSemanticIndex } from "../lib/index_singleton.js";
import type { SearchHit } from "../lib/semantic_index.js";

// Small stopword list (DE + EN). Enough to cut noise without a real NLP layer.
const STOPWORDS = new Set([
  // German
  "der", "die", "das", "den", "dem", "des", "ein", "eine", "einer", "einem", "einen", "eines",
  "und", "oder", "aber", "doch", "denn", "weil", "wenn", "als", "so", "auch",
  "in", "im", "an", "am", "auf", "aus", "bei", "mit", "von", "vom", "zu", "zum", "zur",
  "für", "über", "unter", "neben", "nach", "vor", "zwischen", "durch", "ohne",
  "ist", "war", "sind", "waren", "sein", "wird", "werden", "wurde", "hat", "habe", "haben", "hatte",
  "ich", "du", "er", "sie", "es", "wir", "ihr", "mich", "dich", "uns", "euch", "ihm", "ihn", "ihnen",
  "mein", "dein", "sein", "ihr", "unser", "nicht", "kein", "nur", "noch", "schon", "ja", "nein",
  "dass", "wie", "was", "wer", "wo", "wann", "warum",
  // English
  "the", "a", "an", "and", "or", "but", "of", "in", "on", "at", "to", "for", "with", "by",
  "is", "are", "was", "were", "be", "been", "being", "has", "have", "had",
  "this", "that", "these", "those", "it", "its", "i", "you", "he", "she", "we", "they",
  "not", "no", "yes", "do", "does", "did", "as", "from", "into", "than", "then",
  // Markdown noise
  "md", "markdown", "vault", "obsidian",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, " $1 ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, " $1 ")
    .replace(/^---[\s\S]*?---/m, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && t.length <= 32 && !STOPWORDS.has(t));
}

function tfMap(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

interface DocVec {
  path: string;
  tf: Map<string, number>;
  totalTerms: number;
  snippetSource: string;
}

function buildSnippet(content: string, queryTokens: Set<string>, contextChars = 100): string {
  const tokens = content.split(/(\s+)/);
  let bestIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < tokens.length; i += 2) {
    const t = tokens[i]?.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    if (t && queryTokens.has(t)) {
      let s = 0;
      for (let j = Math.max(0, i - 30); j <= Math.min(tokens.length - 1, i + 30); j += 2) {
        const u = tokens[j]?.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
        if (u && queryTokens.has(u)) s++;
      }
      if (s > bestScore) {
        bestScore = s;
        bestIdx = i;
      }
    }
  }
  let charPos = 0;
  for (let i = 0; i < bestIdx; i++) charPos += (tokens[i] ?? "").length;
  const start = Math.max(0, charPos - contextChars);
  const end = Math.min(content.length, charPos + contextChars);
  return (
    (start > 0 ? "…" : "") +
    content.slice(start, end).replace(/\s+/g, " ").trim() +
    (end < content.length ? "…" : "")
  );
}

/**
 * Legacy TF-IDF ranking. Kept as a fallback for when the embedding index is not
 * yet ready (boot) or the model layer fails — so find_similar never breaks.
 */
export async function findSimilarTfidf(text: string, limit: number) {
  const queryTokens = tokenize(text);
  if (queryTokens.length === 0) {
    return { content: [{ type: "text" as const, text: "Query enthält nur Stopwörter — keine sinnvolle Ähnlichkeitssuche möglich." }] };
  }
  const queryTokenSet = new Set(queryTokens);
  const queryTf = tfMap(queryTokens);

  const files = await walkMarkdown();
  const vaultRoot = vaultPath();
  const docs: DocVec[] = [];
  const docFreq = new Map<string, number>();

  for (const abs of files) {
    let content: string;
    try {
      content = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    const tokens = tokenize(content);
    if (tokens.length === 0) continue;
    const tf = tfMap(tokens);
    docs.push({ path: path.relative(vaultRoot, abs).replace(/\\/g, "/"), tf, totalTerms: tokens.length, snippetSource: content });
    for (const term of tf.keys()) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
  }

  if (docs.length === 0) {
    return { content: [{ type: "text" as const, text: "Vault enthält keine durchsuchbaren Notizen." }] };
  }

  const N = docs.length;
  const idf = (term: string): number => Math.log(1 + N / (1 + (docFreq.get(term) ?? 0)));
  const queryWeights = new Map<string, number>();
  let queryNorm = 0;
  for (const [term, count] of queryTf) {
    const w = (count / queryTokens.length) * idf(term);
    queryWeights.set(term, w);
    queryNorm += w * w;
  }
  queryNorm = Math.sqrt(queryNorm);

  type Hit = { path: string; score: number; snippet: string };
  const hits: Hit[] = [];
  for (const doc of docs) {
    let dot = 0;
    let docNorm = 0;
    for (const [term, count] of doc.tf) {
      const w = (count / doc.totalTerms) * idf(term);
      docNorm += w * w;
      if (queryWeights.has(term)) dot += w * (queryWeights.get(term) ?? 0);
    }
    docNorm = Math.sqrt(docNorm);
    const score = dot / (queryNorm * docNorm || 1);
    if (score > 0) hits.push({ path: doc.path, score, snippet: buildSnippet(doc.snippetSource, queryTokenSet) });
  }

  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, limit);
  if (top.length === 0) {
    return { content: [{ type: "text" as const, text: "Keine ähnlichen Notizen gefunden — der Inhalt scheint neu zu sein." }] };
  }
  const summary =
    `${top.length} ähnliche Notiz(en) gefunden (TF-IDF-Fallback):\n\n` +
    top.map((h, i) => `${i + 1}. **${h.path}** _(score ${h.score.toFixed(3)})_\n   ${h.snippet}`).join("\n\n");
  return { content: [{ type: "text" as const, text: summary }] };
}

function renderEmbeddingHits(hits: SearchHit[]) {
  const summary =
    `${hits.length} ähnliche Notiz(en) gefunden (semantisch, Label statt Rohwert):\n\n` +
    hits
      .map((h, i) => `${i + 1}. **${h.path}** → ## ${h.heading} — _${h.label}_\n   ${h.snippet}`)
      .join("\n\n") +
    `\n\n_Bei „verwandt" oder „sehr ähnlich": erwäge, die bestehende Notiz zu erweitern statt eine neue anzulegen._`;
  return { content: [{ type: "text" as const, text: summary }] };
}

export const findSimilarTool = {
  name: "find_similar",
  description:
    "Find existing notes semantically similar to a given text, using a local embedding model (cross-lingual DE/EN, section-level). Call this before add_to_project / add_to_area / add_to_resource to decide whether to extend an existing note instead of creating a new one. Each hit is labelled (sehr ähnlich / verwandt / eher anders) — at 'verwandt' or higher, prefer extending the existing note.",
  inputSchema: {
    text: z.string().min(3).describe("The new content you're about to write. The tool finds existing notes that may already cover this."),
    limit: z.number().int().min(1).max(20).optional().describe("Max results. Default 5."),
  },
  handler: async ({ text, limit = 5 }: { text: string; limit?: number }) => {
    const idx = getSemanticIndex();
    if (idx && idx.ready) {
      try {
        await idx.reconcile();
        const hits = await idx.searchText(text, { limit });
        if (hits.length === 0) {
          return { content: [{ type: "text" as const, text: "Keine ähnlichen Notizen gefunden — der Inhalt scheint neu zu sein." }] };
        }
        return renderEmbeddingHits(hits);
      } catch (e) {
        console.error("[find_similar] embedding path failed, falling back to TF-IDF:", e);
      }
    }
    return findSimilarTfidf(text, limit);
  },
};
