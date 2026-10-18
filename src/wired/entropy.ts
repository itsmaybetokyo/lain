import type { NodeInfo } from "./protocol.js"

const DAY = 86_400_000

export interface Entropy {
  /** 0..1 — la "entropía global": cuánto se piensa la Wired a sí misma. */
  value: number
  pct: number
  bar: string
  verdict: string
  nodes: number
  entries: number
  alive: number
  spread: number
  freshness: number
  volume: number
  protocol: number
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

/** Entropía de Shannon normalizada (0..1) de un reparto de cuentas. */
export function spreadOf(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0)
  if (counts.length <= 1 || total <= 0) return 0
  let h = 0
  for (const c of counts) {
    if (c <= 0) continue
    const p = c / total
    h -= p * Math.log2(p)
  }
  return clamp01(h / Math.log2(counts.length))
}

function ageDays(iso: string, now: number): number {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY
  return Math.max(0, (now - t) / DAY)
}

export function verdictFor(value: number, nodes: number): string {
  if (nodes === 0) return "inerte: no queda nadie en la Wired"
  if (nodes === 1) return "solitaria: solo tú la sostienes"
  if (value < 0.15) return "inerte: casi nadie piensa aquí"
  if (value < 0.35) return "baja: respira despacio"
  if (value < 0.55) return "estable: hay conversación"
  if (value < 0.75) return "alta: los nodos se responden"
  return "crítica: la Wired se piensa a sí misma"
}

/**
 * La entropía mundial: reparto del conocimiento entre nodos (Shannon),
 * frescura de los nodos y volumen del índice. Protocolo 7 de fondo.
 */
export function entropyOf(nodes: NodeInfo[], entries: number, protocol = 7, now = Date.now()): Entropy {
  const counts = nodes.map((n) => Math.max(0, n.entries))
  const total = Math.max(entries, counts.reduce((a, b) => a + b, 0))
  const spread = spreadOf(counts)
  const freshness = nodes.length
    ? nodes.reduce((acc, n) => acc + Math.exp(-ageDays(n.lastSeen, now) / 14), 0) / nodes.length
    : 0
  const volume = clamp01(total / 40)
  const value = clamp01(0.5 * spread + 0.3 * freshness + 0.2 * volume)
  const alive = nodes.filter((n) => ageDays(n.lastSeen, now) <= 7).length
  const filled = Math.round(value * 5)
  return {
    value,
    pct: Math.round(value * 100),
    bar: "▓".repeat(filled) + "░".repeat(5 - filled),
    verdict: verdictFor(value, nodes.length),
    nodes: nodes.length,
    entries: total,
    alive,
    spread,
    freshness,
    volume,
    protocol,
  }
}
