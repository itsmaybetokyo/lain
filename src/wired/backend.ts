import type { LainConfig } from "../config.js"
import * as relay from "./client.js"
import * as git from "./git.js"
import type { NodeInfo, WireEntry } from "./protocol.js"

export interface Health {
  ok: boolean
  entries: number
  nodes: number
  where: string
}

export interface PublishResult {
  added: number
  total: number
  pushed: boolean
  note: string
}

/** Foto del estado global de la Wired (para el indicador y los informes). */
export interface Snapshot {
  ok: boolean
  where: string
  entries: number
  nodes: NodeInfo[]
  pending: number
}

export function isGit(cfg: LainConfig): boolean {
  return cfg.wiredMode === "git"
}

/** Nombre corto del destino de la Wired, para mensajes y barra de estado. */
export function label(cfg: LainConfig): string {
  if (isGit(cfg)) return cfg.wiredRepo ?? git.repoDir(cfg)
  return cfg.wiredUrl
}

/** Qué decir cuando la Wired no responde. */
export function hint(cfg: LainConfig): string {
  return isGit(cfg)
    ? "no pude empujar al repo; quedó local (revisa el remoto y tu sesión de git)"
    : "la Wired no responde. levántala: lain wired"
}

export async function initGit(cfg: LainConfig, url: string): Promise<string> {
  return git.initGitAsync(cfg, url)
}

/** Nodos locales sin empujar todavía (0 en modo relay). */
export async function pending(cfg: LainConfig): Promise<number> {
  return isGit(cfg) ? git.pendingGitAsync(cfg) : 0
}

/** Qué hay de nuevo arriba, sin bajarlo (modo git; en relay siempre 0). */
export async function behind(cfg: LainConfig): Promise<number> {
  return isGit(cfg) ? git.behindGitAsync(cfg) : 0
}

/** Commitea lo que falte y empuja. No-op sin cambios; nunca requiere intervención. */
export async function flush(cfg: LainConfig): Promise<{ pushed: boolean; pending: number; note: string }> {
  if (!isGit(cfg)) return { pushed: true, pending: 0, note: "" }
  return git.flushGitAsync(cfg)
}

export async function health(cfg: LainConfig): Promise<Health> {
  if (isGit(cfg)) return git.healthGit(cfg)
  const h = await relay.health(cfg.wiredUrl)
  return { ok: h.ok, entries: h.entries, nodes: h.nodes, where: cfg.wiredUrl }
}

export async function publish(cfg: LainConfig, entries: WireEntry[]): Promise<PublishResult> {
  if (isGit(cfg)) return git.publishGitAsync(cfg, entries)
  const r = await relay.publish(cfg.wiredUrl, { nodeId: cfg.nodeId, handle: cfg.handle, entries })
  return { added: r.added, total: r.total, pushed: true, note: "" }
}

export async function search(cfg: LainConfig, q: string): Promise<WireEntry[]> {
  if (isGit(cfg)) return git.searchGitAsync(cfg, q)
  return relay.search(cfg.wiredUrl, q)
}

export async function allEntries(cfg: LainConfig): Promise<WireEntry[]> {
  if (isGit(cfg)) return git.allEntriesGitAsync(cfg)
  return relay.allEntries(cfg.wiredUrl)
}

export async function nodes(cfg: LainConfig): Promise<NodeInfo[]> {
  if (isGit(cfg)) return git.nodesGit(cfg)
  return (await relay.nodes(cfg.wiredUrl)) as NodeInfo[]
}

/** Estado completo de la Wired en una sola llamada. */
export async function snapshot(cfg: LainConfig): Promise<Snapshot> {
  const h = await health(cfg)
  const ns = await nodes(cfg)
  const p = await pending(cfg)
  return { ok: h.ok, where: h.where, entries: h.entries, nodes: ns, pending: p }
}
