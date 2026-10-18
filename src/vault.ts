import { join } from "node:path"
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import type { LainConfig } from "./config.js"
import { type WireEntry, slugify, titleFrom, tagsFrom, hashOf } from "./wired/protocol.js"

export function wiredDir(cfg: LainConfig): string {
  return join(cfg.vaultPath, "WIRED")
}

export function ensureVault(cfg: LainConfig): void {
  for (const d of [
    cfg.vaultPath,
    wiredDir(cfg),
    join(wiredDir(cfg), "exchanges"),
    join(wiredDir(cfg), "sessions"),
    join(wiredDir(cfg), "nodes"),
  ]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }
  const id = join(wiredDir(cfg), "identity.md")
  if (!existsSync(id)) {
    writeFileSync(
      id,
      `---\ntype: identity\nhandle: ${cfg.handle}\nnodeId: ${cfg.nodeId}\n---\n\n# ${cfg.handle} :: un nodo en la Wired\n\nEste es tu nodo. Todo lo que hablas con lain se guarda aquí.\n\n- [[index|Wired (todo)]]\n`,
      "utf8",
    )
  }
}

const LOCAL_INDEX = "local-index.json"

function indexPath(cfg: LainConfig): string {
  return join(wiredDir(cfg), LOCAL_INDEX)
}

export function readLocalIndex(cfg: LainConfig): WireEntry[] {
  try {
    return JSON.parse(readFileSync(indexPath(cfg), "utf8")) as WireEntry[]
  } catch {
    return []
  }
}

function writeLocalIndex(cfg: LainConfig, entries: WireEntry[]): void {
  writeFileSync(indexPath(cfg), JSON.stringify(entries, null, 2), "utf8")
}

function appendUnique(file: string, marker: string, line: string): void {
  let content = existsSync(file) ? readFileSync(file, "utf8") : ""
  if (!content.includes(marker)) {
    if (!content.endsWith("\n")) content += "\n"
    content += line + "\n"
    writeFileSync(file, content, "utf8")
  }
}

/**
 * Guarda un intercambio como nota de Obsidian y nodo de la Wired.
 * Devuelve el WireEntry creado.
 */
export function writeExchange(
  cfg: LainConfig,
  question: string,
  answer: string,
  extraTags: string[] = [],
): WireEntry {
  ensureVault(cfg)
  const slug = slugify(question)
  const title = titleFrom(question)
  const date = new Date().toISOString()
  const day = date.slice(0, 10)
  const tags = tagsFrom(`${question} ${answer}`, extraTags)
  const hash = hashOf(cfg.nodeId, title, answer)

  const entry: WireEntry = {
    id: slug,
    nodeId: cfg.nodeId,
    handle: cfg.handle,
    title,
    tags,
    summary: titleFrom(answer, 140),
    content: answer,
    question,
    created: date,
    hash,
  }

  const fm = [
    "---",
    `id: ${slug}`,
    "type: exchange",
    `handle: ${cfg.handle}`,
    `nodeId: ${cfg.nodeId}`,
    `created: ${date}`,
    `tags: [${tags.join(", ")}]`,
    `hash: ${hash}`,
    "---",
    "",
  ].join("\n")

  const body = [
    `# ${title}`,
    "",
    `> [!question] ${cfg.handle} preguntó`,
    ...question.split("\n").map((l) => `> ${l}`),
    "",
    `## ${cfg.handle === "lain" ? "lain" : "lain"} responde`,
    "",
    answer,
    "",
    "---",
    `- sesión: [[sessions/${day}]]`,
    `- volver: [[index|Wired]]`,
    `- tags: ${tags.map((t) => `#${t}`).join(" ")}`,
    "",
  ].join("\n")

  writeFileSync(join(wiredDir(cfg), "exchanges", `${slug}.md`), fm + body, "utf8")

  const all = readLocalIndex(cfg).filter((e) => e.id !== slug)
  all.push(entry)
  writeLocalIndex(cfg, all)

  appendUnique(
    join(wiredDir(cfg), "sessions", `${day}.md`),
    `exchanges/${slug}`,
    `- [[exchanges/${slug}|${title}]]`,
  )
  const sessionFile = join(wiredDir(cfg), "sessions", `${day}.md`)
  if (!existsSync(sessionFile) || !readFileSync(sessionFile, "utf8").includes("# ")) {
    const head = `---\ntype: session\ndate: ${day}\n---\n\n# sesión ${day}\n\n- [[index|Wired]]\n\n## nodos\n`
    const cur = existsSync(sessionFile) ? readFileSync(sessionFile, "utf8") : ""
    writeFileSync(sessionFile, head + cur.replace(/^.*\n/, ""), "utf8")
  }
  appendUnique(
    join(wiredDir(cfg), "index.md"),
    `exchanges/${slug}`,
    `- [[exchanges/${slug}|${title}]]  ${tags.slice(0, 3).map((t) => `#${t}`).join(" ")}`,
  )

  return entry
}

/** Escribe en el vault los nodos bajados de la Wired (conocimiento global). */
export function writeRemoteEntries(cfg: LainConfig, entries: WireEntry[]): number {
  ensureVault(cfg)
  let n = 0
  const byNode = new Map<string, WireEntry[]>()
  for (const e of entries) {
    if (e.nodeId === cfg.nodeId) continue
    const list = byNode.get(e.nodeId) ?? []
    list.push(e)
    byNode.set(e.nodeId, list)
  }
  for (const [nodeId, list] of byNode) {
    const handle = list[0]?.handle ?? nodeId.slice(0, 8)
    const lines = [
      "---",
      "type: remote-node",
      `handle: ${handle}`,
      `nodeId: ${nodeId}`,
      `synced: ${new Date().toISOString()}`,
      "---",
      "",
      `# nodo remoto :: ${handle}`,
      "",
      `${list.length} nodos de conocimiento desde la Wired.`,
      "",
      "## conocimiento",
      "",
    ]
    for (const e of list) {
      lines.push(`### ${e.title}`)
      lines.push("")
      lines.push(`tags: ${e.tags.map((t) => `#${t}`).join(" ")}`)
      lines.push("")
      lines.push(e.content)
      lines.push("")
    }
    lines.push("---", "- [[index|Wired]]", "")
    const safe = handle.replace(/[^a-z0-9_-]/gi, "-")
    writeFileSync(join(wiredDir(cfg), "nodes", `${safe}.md`), lines.join("\n"), "utf8")
    appendUnique(
      join(wiredDir(cfg), "index.md"),
      `nodes/${safe}`,
      `- [[nodes/${safe}|◈ ${handle}]] (nodo remoto)`,
    )
    n += list.length
  }
  return n
}

/** Huella de las notas de otros nodos en el vault (archivo → tamaño). */
export function remoteNoteFingerprint(cfg: LainConfig): Map<string, number> {
  const dir = join(wiredDir(cfg), "nodes")
  const out = new Map<string, number>()
  try {
    for (const f of readdirSync(dir)) {
      try {
        out.set(f, statSync(join(dir, f)).size)
      } catch {
        /* se movió mientras mirábamos */
      }
    }
  } catch {
    /* todavía no hay carpeta de nodos */
  }
  return out
}

export function vaultStats(cfg: LainConfig): { exchanges: number; nodes: number; files: number } {
  ensureVault(cfg)
  const ex = readLocalIndex(cfg).length
  let files = 0
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      if (statSync(p).isDirectory()) walk(p)
      else files++
    }
  }
  try {
    walk(cfg.vaultPath)
  } catch {
    /* ignore */
  }
  const nodes = existsSync(join(wiredDir(cfg), "nodes"))
    ? readdirSync(join(wiredDir(cfg), "nodes")).length
    : 0
  return { exchanges: ex, nodes, files }
}
