import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { LAIN_DIR, ensureDir } from "../config.js"
import type { WireEntry } from "./protocol.js"

/** Dónde recordamos qué notas de la Wired ya te anunciamos. */
const ARCHIVO = join(LAIN_DIR, "wired-visto.json")

/** Tope de ids guardados: no hace falta recordar el repo entero para siempre. */
const MAX_IDS = 2000

interface Guardado {
  at: number
  ids: string[]
}

const hasta = (iso: string): number => {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

/**
 * Los ids que ya te anunciamos. Si todavía no hay archivo (primera vez) o el
 * archivo está roto, devuelve vacío: el peor caso es repetir un aviso.
 */
export function cargaVistos(): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(ARCHIVO, "utf8")) as Partial<Guardado>
    const ids = Array.isArray(raw.ids) ? raw.ids.filter((i): i is string => typeof i === "string") : []
    return new Set(ids)
  } catch {
    return new Set()
  }
}

/** Anota lo que ya viste, para poder marcar qué llegó después. */
export function guardaVistos(ids: Iterable<string>, ahora: number = Date.now()): void {
  try {
    ensureDir(LAIN_DIR)
    writeFileSync(ARCHIVO, JSON.stringify({ at: ahora, ids: [...ids].slice(-MAX_IDS) } satisfies Guardado, null, 2), "utf8")
  } catch {
    /* no poder recordar no debe romper nada */
  }
}

/** Suma ids a lo ya visto (por ejemplo, lo que publicaste vos en esta sesión). */
export function anotaVisto(...ids: string[]): void {
  const s = cargaVistos()
  for (const id of ids) s.add(id)
  guardaVistos(s)
}

/**
 * Las `cupo` notas más nuevas, en orden cronológico (la más vieja primero, que
 * es como se apilan bajo el retrato). No filtra por "ya visto": abrir lain es
 * ver qué hay ahora en la Wired. Si filtrara, como lo tuyo se marca al
 * publicar, no aparecería nunca nada.
 */
export function ultimasDe(entries: WireEntry[], cupo: number): WireEntry[] {
  const n = Math.max(0, Math.floor(cupo))
  if (!n) return []
  return [...entries].sort((a, b) => hasta(a.created) - hasta(b.created)).slice(-n)
}
