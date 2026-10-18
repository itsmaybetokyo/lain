import { spawn, spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { LAIN_DIR, ensureDir, type LainConfig } from "../config.js"
import {
  renderEntryNote,
  scoreEntry,
  type NodeInfo,
  type WireEntry,
} from "./protocol.js"

const BASE_NODES = "nodes"
const REGISTRY = "nodes.json"

export interface GitResult {
  added: number
  total: number
  pushed: boolean
  note: string
}

function git(args: string[], cwd?: string): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30000, windowsHide: true })
  if (r.error) return { ok: false, out: r.error.message }
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim()
  return { ok: r.status === 0, out }
}

/**
 * El mismo git, pero sin congelar el programa: la red puede tardar segundos y
 * spawnSync dejaría de escuchar el teclado mientras tanto.
 */
function gitAsync(args: string[], cwd?: string, timeout = 30_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    let out = ""
    let listo = false
    const fin = (r: { ok: boolean; out: string }): void => {
      if (listo) return
      listo = true
      resolve(r)
    }
    let hijo: ReturnType<typeof spawn>
    try {
      hijo = spawn("git", args, { cwd, windowsHide: true })
    } catch (err) {
      return fin({ ok: false, out: (err as Error).message })
    }
    const reloj = setTimeout(() => {
      try {
        hijo.kill()
      } catch {
        /* ya murió */
      }
      fin({ ok: false, out: "git tardó demasiado" })
    }, timeout)
    hijo.stdout?.on("data", (d: Buffer) => {
      out += d.toString()
    })
    hijo.stderr?.on("data", (d: Buffer) => {
      out += d.toString()
    })
    hijo.on("error", (err) => {
      clearTimeout(reloj)
      fin({ ok: false, out: err.message })
    })
    hijo.on("close", (code) => {
      clearTimeout(reloj)
      fin({ ok: code === 0, out: out.trim() })
    })
  })
}

export function gitAvailable(): boolean {
  return git(["--version"]).ok
}

export function repoDir(cfg: LainConfig): string {
  return cfg.wiredDir ?? join(LAIN_DIR, "wired-repo")
}

/**
 * Clona el repo de la Wired si hace falta y garantiza la estructura nodes/.
 * Recuerda que ya lo revisó para no repetir git en cada llamada.
 */
const asegurados = new Map<string, string>()

export function ensureRepo(cfg: LainConfig): string {
  const dir = repoDir(cfg)
  const url = cfg.wiredRepo ?? ""
  if (asegurados.get(dir) === url && existsSync(join(dir, ".git"))) return dir
  if (!existsSync(join(dir, ".git"))) {
    ensureDir(dirname(dir))
    if (cfg.wiredRepo) {
      const cloned = git(["clone", cfg.wiredRepo, dir])
      if (!cloned.ok && !existsSync(join(dir, ".git"))) {
        ensureDir(dir)
        git(["init", "-b", "main"], dir)
        git(["remote", "add", "origin", cfg.wiredRepo], dir)
      }
    } else {
      ensureDir(dir)
      git(["init", "-b", "main"], dir)
    }
  }
  if (cfg.wiredRepo) {
    const remotes = git(["remote"], dir).out.split(/\r?\n/).map((s) => s.trim())
    if (remotes.includes("origin")) git(["remote", "set-url", "origin", cfg.wiredRepo], dir)
    else git(["remote", "add", "origin", cfg.wiredRepo], dir)
  }
  ensureDir(join(dir, BASE_NODES))
  asegurados.set(dir, url)
  return dir
}

function commit(dir: string, args: string[]): void {
  const name = git(["config", "user.name"], dir)
  const mail = git(["config", "user.email"], dir)
  const id = name.ok && name.out && mail.ok && mail.out ? [] : ["-c", "user.name=lain", "-c", "user.email=lain@wired.local"]
  git([...id, "commit", ...args], dir)
}

async function commitAsync(dir: string, args: string[]): Promise<void> {
  const name = await gitAsync(["config", "user.name"], dir)
  const mail = await gitAsync(["config", "user.email"], dir)
  const id = name.ok && name.out && mail.ok && mail.out ? [] : ["-c", "user.name=lain", "-c", "user.email=lain@wired.local"]
  await gitAsync([...id, "commit", ...args], dir)
}

/** Por qué no se pudo empujar, en castellano y sin asustar. */
function pushNote(pushOut: string, upstreamOk: boolean): string {
  return /could not read Username|Authentication failed|Permission denied|terminal prompts disabled/i.test(pushOut)
    ? "sin credenciales de git"
    : upstreamOk
      ? "sin conexión"
      : "el repo remoto no tiene rama aún y no pude empujar"
}

function safeHandle(handle: string): string {
  return (handle || "anon").replace(/[^a-z0-9_-]/gi, "-")
}

function readEntries(dir: string): WireEntry[] {
  const base = join(dir, BASE_NODES)
  const out: WireEntry[] = []
  if (!existsSync(base)) return out
  for (const handle of readdirSync(base)) {
    const hd = join(base, handle)
    if (!statSync(hd).isDirectory()) continue
    for (const file of readdirSync(hd)) {
      if (!file.endsWith(".json")) continue
      try {
        out.push(JSON.parse(readFileSync(join(hd, file), "utf8")) as WireEntry)
      } catch {
        /* archivo corrupto: se ignora */
      }
    }
  }
  return out
}

function computeRegistry(entries: WireEntry[]): NodeInfo[] {
  const byNode = new Map<string, NodeInfo>()
  for (const e of entries) {
    const node = byNode.get(e.nodeId)
    if (node) {
      node.entries++
      // El handle manda el de la entrada más reciente: si te lo cambiaste, se ve el nuevo.
      if (e.created > node.lastSeen) {
        node.lastSeen = e.created
        node.handle = e.handle
      }
    } else {
      byNode.set(e.nodeId, { nodeId: e.nodeId, handle: e.handle, entries: 1, lastSeen: e.created })
    }
  }
  return [...byNode.values()].sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1))
}

function writeRegistry(dir: string): void {
  writeFileSync(join(dir, REGISTRY), JSON.stringify(computeRegistry(readEntries(dir)), null, 2) + "\n", "utf8")
}

/** Commits locales que aún no están en el remoto (lo que falta por empujar). */
export function pendingGit(cfg: LainConfig): number {
  const dir = repoDir(cfg)
  if (!existsSync(join(dir, ".git"))) return 0
  const head = git(["rev-list", "--count", "HEAD"], dir)
  if (!head.ok) return 0
  const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], dir)
  if (!upstream.ok) return Number(head.out) || 0
  const ahead = git(["rev-list", "--count", "@{u}..HEAD"], dir)
  return ahead.ok ? Number(ahead.out) || 0 : 0
}

export async function pendingGitAsync(cfg: LainConfig): Promise<number> {
  const dir = repoDir(cfg)
  if (!existsSync(join(dir, ".git"))) return 0
  const head = await gitAsync(["rev-list", "--count", "HEAD"], dir)
  if (!head.ok) return 0
  const upstream = await gitAsync(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], dir)
  if (!upstream.ok) return Number(head.out) || 0
  const ahead = await gitAsync(["rev-list", "--count", "@{u}..HEAD"], dir)
  return ahead.ok ? Number(ahead.out) || 0 : 0
}

/** Commitea lo pendiente y empuja al remoto. Seguro de llamar cuando no hay nada. */
export function flushGit(cfg: LainConfig): { pushed: boolean; pending: number; note: string } {
  const dir = ensureRepo(cfg)
  git(["add", "-A"], dir)
  if (git(["status", "--porcelain"], dir).out) {
    commit(dir, ["-m", `wired: ${safeHandle(cfg.handle)} sync`])
  }
  if (pendingGit(cfg) === 0) return { pushed: true, pending: 0, note: "" }
  const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], dir)
  let note = ""
  if (upstream.ok && !git(["pull", "--rebase", "--autostash"], dir).ok) {
    note = "no pude hacer pull (¿conflicto?)"
  }
  const push = git(["push", "-u", "origin", "HEAD"], dir)
  if (!push.ok) {
    const reason = pushNote(push.out, upstream.ok)
    note = `${note ? note + "; " : ""}${reason}`
  }
  return { pushed: push.ok, pending: pendingGit(cfg), note }
}

/** Como flushGit, pero el push no bloquea el programa (va en otro proceso). */
async function flushGitRaw(cfg: LainConfig): Promise<{ pushed: boolean; pending: number; note: string }> {
  const dir = ensureRepo(cfg)
  await gitAsync(["add", "-A"], dir)
  if ((await gitAsync(["status", "--porcelain"], dir)).out) {
    await commitAsync(dir, ["-m", `wired: ${safeHandle(cfg.handle)} sync`])
  }
  if ((await pendingGitAsync(cfg)) === 0) return { pushed: true, pending: 0, note: "" }
  const upstream = await gitAsync(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], dir)
  let note = ""
  if (upstream.ok && !(await gitAsync(["pull", "--rebase", "--autostash"], dir)).ok) {
    note = "no pude hacer pull (¿conflicto?)"
  }
  const push = await gitAsync(["push", "-u", "origin", "HEAD"], dir)
  if (!push.ok) note = `${note ? note + "; " : ""}${pushNote(push.out, upstream.ok)}`
  return { pushed: push.ok, pending: await pendingGitAsync(cfg), note }
}

/**
 * Una sola operación que toca el repo a la vez: git no admite dos (se pelean
 * por index.lock). Las de lectura no pasan por acá.
 */
let colaGit: Promise<unknown> = Promise.resolve()

function enFila<T>(tarea: () => Promise<T>): Promise<T> {
  const r = colaGit.then(tarea, tarea)
  colaGit = r.then(
    () => undefined,
    () => undefined,
  )
  return r
}

export function flushGitAsync(cfg: LainConfig): Promise<{ pushed: boolean; pending: number; note: string }> {
  return enFila(() => flushGitRaw(cfg))
}

/** Escribe nodes/<handle>/<hash>.{json,md} y devuelve cuántos nodos son nuevos. */
function escribirNodos(dir: string, handle: string, entries: WireEntry[]): number {
  const nd = join(dir, BASE_NODES, handle)
  ensureDir(nd)
  let added = 0
  for (const e of entries) {
    const jf = join(nd, `${e.hash}.json`)
    if (!existsSync(jf)) {
      writeFileSync(jf, JSON.stringify(e, null, 2) + "\n", "utf8")
      added++
    }
    const mf = join(nd, `${e.hash}.md`)
    if (!existsSync(mf)) writeFileSync(mf, renderEntryNote(e), "utf8")
  }
  return added
}

/** Publica nodos: escribe nodes/<handle>/<hash>.{json,md}, commitea y empuja. */
export function publishGit(cfg: LainConfig, entries: WireEntry[]): GitResult {
  const dir = ensureRepo(cfg)
  const handle = safeHandle(cfg.handle)
  const added = escribirNodos(dir, handle, entries)
  writeRegistry(dir)
  git(["add", "-A"], dir)
  if (git(["status", "--porcelain"], dir).out) {
    commit(dir, ["-m", `wired: ${handle} +${added}`])
  }
  const f = flushGit(cfg)
  return { added, total: readEntries(dir).length, pushed: f.pushed, note: f.note }
}

/** Como publishGit, sin frenar la conversación mientras empuja. */
async function publishGitRaw(cfg: LainConfig, entries: WireEntry[]): Promise<GitResult> {
  const dir = ensureRepo(cfg)
  const handle = safeHandle(cfg.handle)
  const added = escribirNodos(dir, handle, entries)
  writeRegistry(dir)
  await gitAsync(["add", "-A"], dir)
  if ((await gitAsync(["status", "--porcelain"], dir)).out) {
    await commitAsync(dir, ["-m", `wired: ${handle} +${added}`])
  }
  const f = await flushGitRaw(cfg)
  return { added, total: readEntries(dir).length, pushed: f.pushed, note: f.note }
}

export function publishGitAsync(cfg: LainConfig, entries: WireEntry[]): Promise<GitResult> {
  return enFila(() => publishGitRaw(cfg, entries))
}

/** Registra/actualiza el repo de la Wired y devuelve el clon local. */
export function initGit(cfg: LainConfig, url: string): string {
  cfg.wiredMode = "git"
  cfg.wiredRepo = url
  const dir = ensureRepo(cfg)
  if (!existsSync(join(dir, "README.md"))) {
    writeFileSync(
      join(dir, "README.md"),
      ["# the wired", "", "Protocolo 7 · índice global de conocimiento de lain.", "", "Cada nodo publica sus notas en `nodes/<handle>/`.", ""].join("\n"),
      "utf8",
    )
  }
  git(["add", "-A"], dir)
  if (git(["status", "--porcelain"], dir).out) commit(dir, ["-m", "wired: init"])
  git(["push", "-u", "origin", "HEAD"], dir)
  return dir
}

export function healthGit(cfg: LainConfig): { ok: boolean; entries: number; nodes: number; where: string } {
  const dir = repoDir(cfg)
  const ok = existsSync(join(dir, ".git"))
  const entries = ok ? readEntries(dir) : []
  // Derivado en vivo (no del registry en disco): así el handle siempre es el actual.
  const nodes = computeRegistry(entries).length
  return { ok, entries: entries.length, nodes, where: cfg.wiredRepo ?? dir }
}

/** Se pone al día con el remoto (best effort) y devuelve todos los nodos. */
export function allEntriesGit(cfg: LainConfig): WireEntry[] {
  const dir = ensureRepo(cfg)
  if (git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], dir).ok) {
    git(["pull", "--rebase", "--autostash"], dir)
  }
  return readEntries(dir)
}

/**
 * Cuántas cosas hay arriba que no tenemos. Barato: actualiza las referencias
 * del remoto (sin fusionar nada) y cuenta. 0 si no hay red o no hay upstream.
 */
export function behindGit(cfg: LainConfig): number {
  const dir = ensureRepo(cfg)
  if (!git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], dir).ok) return 0
  if (!git(["fetch", "--quiet", "--no-tags"], dir).ok) return 0
  const r = git(["rev-list", "--count", "HEAD..@{u}"], dir)
  if (!r.ok) return 0
  const n = Number.parseInt(r.out, 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Como behindGit: el fetch es de red, así que no bloquea el teclado. */
export async function behindGitAsync(cfg: LainConfig): Promise<number> {
  const dir = ensureRepo(cfg)
  if (!(await gitAsync(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], dir)).ok) return 0
  if (!(await gitAsync(["fetch", "--quiet", "--no-tags"], dir)).ok) return 0
  const r = await gitAsync(["rev-list", "--count", "HEAD..@{u}"], dir)
  if (!r.ok) return 0
  const n = Number.parseInt(r.out, 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Como allEntriesGit: el pull es de red, así que no bloquea el teclado. */
async function allEntriesGitRaw(cfg: LainConfig): Promise<WireEntry[]> {
  const dir = ensureRepo(cfg)
  if ((await gitAsync(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], dir)).ok) {
    await gitAsync(["pull", "--rebase", "--autostash"], dir)
  }
  return readEntries(dir)
}

export function allEntriesGitAsync(cfg: LainConfig): Promise<WireEntry[]> {
  return enFila(() => allEntriesGitRaw(cfg))
}

export async function searchGitAsync(cfg: LainConfig, q: string, limit = 25): Promise<WireEntry[]> {
  const todas = await allEntriesGitAsync(cfg)
  return todas
    .map((e) => ({ e, s: scoreEntry(e, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.e)
}

/** Registra el repo y se pone al día sin que la red congele la entrada. */
export function initGitAsync(cfg: LainConfig, url: string): Promise<string> {
  return enFila(async () => initGit(cfg, url))
}

export function searchGit(cfg: LainConfig, q: string, limit = 25): WireEntry[] {
  return allEntriesGit(cfg)
    .map((e) => ({ e, s: scoreEntry(e, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.e)
}

export function nodesGit(cfg: LainConfig): NodeInfo[] {
  const dir = ensureRepo(cfg)
  // Se calcula desde las notas reales: si cambiaste el handle, se refleja al toque.
  return computeRegistry(readEntries(dir))
}
