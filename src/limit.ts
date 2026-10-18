import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { LAIN_DIR, loadConfig } from "./config.js"

const FILE = join(LAIN_DIR, "limit.json")

/**
 * La cuota gratuita de opencode se reinicia cada 11 horas. Esto es cuanto dura
 * la ventana (configurable con `limitWindowHours` en config.json).
 */
export function windowMs(): number {
  const h = loadConfig().limitWindowHours
  return (typeof h === "number" && h > 0 ? h : 11) * 60 * 60 * 1000
}

let resetAt = 0

/** Lee el contador guardado (sobrevive a cerrar lain). Descarta los ya vencidos. */
export function loadLimit(): void {
  try {
    if (!existsSync(FILE)) return
    const j = JSON.parse(readFileSync(FILE, "utf8")) as { resetAt?: number }
    if (typeof j.resetAt === "number") resetAt = j.resetAt
  } catch {
    /* archivo roto: se ignora */
  }
  if (resetAt && resetAt <= Date.now()) clearLimit()
}

function persist(): void {
  try {
    writeFileSync(FILE, JSON.stringify({ resetAt }, null, 2) + "\n", "utf8")
  } catch {
    /* sin permiso: seguimos en memoria */
  }
}

/**
 * Arranca el contador cuando el proveedor dice que te pasaste de la cuota.
 * Si ya había una cuenta corriendo, la respeta: reintentar dos horas después no
 * debe empujar el reinicio más lejos.
 */
export function noteLimit(now = Date.now()): number {
  if (resetAt > now) return resetAt
  resetAt = now + windowMs()
  persist()
  return resetAt
}

export function clearLimit(): void {
  resetAt = 0
  try {
    if (existsSync(FILE)) rmSync(FILE)
  } catch {
    /* ignore */
  }
}

/** Cuánto falta para que se reinicie (0 si no hay cuenta activa). */
export function limitRemaining(): number {
  if (!resetAt) return 0
  const left = resetAt - Date.now()
  if (left <= 0) {
    clearLimit()
    return 0
  }
  return left
}

/** "2h 07m" o "43m", o "" si no hay cuenta activa. */
export function limitLabel(): string {
  const left = limitRemaining()
  if (left <= 0) return ""
  const min = Math.ceil(left / 60_000)
  const h = Math.floor(min / 60)
  const m = min % 60
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`
}

/**
 * ¿El error es "te pasaste de la cuota"? Reconoce el 429, el 402 y los textos
 * habituales de límite. Deja pasar el error de versión ("...to use the free
 * tier"), que también menciona el plan gratis pero no es un límite de uso.
 */
export function looksLikeLimit(err: unknown): boolean {
  if (!err) return false
  const e = err as { name?: string; data?: { statusCode?: number; message?: string; responseBody?: string }; statusCode?: number; message?: string; responseBody?: string }
  const status = e?.data?.statusCode ?? e?.statusCode
  const name = String(e?.name ?? "").toLowerCase()
  const txt = `${e?.name ?? ""} ${e?.data?.message ?? ""} ${e?.message ?? ""} ${e?.data?.responseBody ?? ""} ${e?.responseBody ?? ""}`.toLowerCase()
  // El error de versión menciona el plan gratis pero no es una cuota agotada.
  if (/or newer is required|required to use|unsupported version|update opencode|outdated/i.test(txt)) return false
  if (/rate.?limit|usage.?limit|quota|toomanyrequests|freelimit/i.test(name)) return true
  if (status === 429 || status === 402) return true
  return /rate limit|too many requests|usage limit|quota|daily limit|hourly limit|limit reached|reached your limit|out of credits|free usage|exceeded your|free tier|try again in|se agotó|cuota/.test(txt)
}
