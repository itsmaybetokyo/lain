import { createHash } from "node:crypto"

/** Protocolo 7: la unidad de conocimiento que viaja por la Wired. */
export interface WireEntry {
  id: string
  nodeId: string
  handle: string
  title: string
  tags: string[]
  /** Resumen corto (la "cara" simbólica). */
  summary: string
  /** Contenido completo (el "cuerpo"). */
  content: string
  /** Pregunta que originó el nodo, si existe. */
  question?: string
  created: string
  hash: string
}

export interface PublishRequest {
  nodeId: string
  handle: string
  entries: WireEntry[]
}

export interface NodeInfo {
  nodeId: string
  handle: string
  entries: number
  lastSeen: string
}

export function hashOf(nodeId: string, title: string, content: string): string {
  return createHash("sha256").update(`${nodeId}\u0000${title}\u0000${content}`).digest("hex").slice(0, 16)
}

export function slugify(text: string, max = 48): string {
  const s = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
  return (s.slice(0, max).replace(/-$/, "") || "nodo") + "-" + hashOf("s", s, text).slice(0, 4)
}

export function titleFrom(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, " ").trim()
  if (clean.length <= max) return clean
  return clean.slice(0, max).replace(/\s+\S*$/, "") + "…"
}

const STOP = new Set([
  "the", "and", "for", "that", "with", "this", "from", "what", "how", "why", "who",
  "que", "los", "las", "una", "uno", "por", "con", "para", "como", "del", "esta",
  "esto", "son", "sus", "mas", "pero", "the", "of", "to", "in", "is", "it", "a",
])

/** Relevancia de un nodo respecto a una consulta. */
export function scoreEntry(e: WireEntry, q: string): number {
  const needle = q.toLowerCase()
  let s = 0
  if (e.title.toLowerCase().includes(needle)) s += 5
  if (e.summary.toLowerCase().includes(needle)) s += 3
  if (e.tags.some((t) => t.includes(needle))) s += 3
  if (e.content.toLowerCase().includes(needle)) s += 1
  for (const word of needle.split(/\s+/).filter((w) => w.length > 2)) {
    if (e.content.toLowerCase().includes(word)) s += 1
    if (e.tags.some((t) => t.includes(word))) s += 1
  }
  return s
}

/** Nota legible (para el repo de la Wired: cada nodo es un archivo de texto). */
export function renderEntryNote(e: WireEntry): string {
  const fm = [
    "---",
    `id: ${e.id}`,
    "type: wired-entry",
    `handle: ${e.handle}`,
    `nodeId: ${e.nodeId}`,
    `created: ${e.created}`,
    `tags: [${e.tags.join(", ")}]`,
    `hash: ${e.hash}`,
    "---",
    "",
  ].join("\n")
  const body: string[] = [`# ${e.title}`, ""]
  if (e.question) {
    body.push(`> [!question] ${e.handle} preguntó`, ...e.question.split("\n").map((l) => `> ${l}`), "")
  }
  body.push("## lain responde", "", e.content, "", "---", `- tags: ${e.tags.map((t) => `#${t}`).join(" ")}`, "")
  return fm + body.join("\n")
}

export function tagsFrom(text: string, extra: string[] = []): string[] {
  const words = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !STOP.has(w))
  const counts = new Map<string, number>()
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1)
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([w]) => w)
  return [...new Set(["wired", "lain", ...top, ...extra])]
}
