import { spawn } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { LAIN_DIR, LAIN_ROOT, ensureDir } from "./config.js"

/** Cada cuánto, como mucho, miramos el remoto por atrás. */
const CADA_MS = 24 * 60 * 60 * 1000

export interface UpdateInfo {
  /** El checkout es git y pudimos leer la rama del remoto. */
  ok: boolean
  /** Es un checkout de git. */
  isRepo: boolean
  /** Pudimos hablar con el remoto en esta pasada. */
  fetched: boolean
  branch: string
  /** Commits que hay arriba y todavía no tenemos. */
  behind: number
  /** Asunto de cada commit nuevo (el más nuevo primero). */
  commits: string[]
  local: string
  remote: string
  /** Hay cambios sin commitear en el checkout. */
  dirty: boolean
  note: string
}

export interface UpdateRun {
  ok: boolean
  before: string
  after: string
  /** Cuántos commits entraron. */
  pulled: number
  /** Hubo que tocar dependencias (package.json / lockfile). */
  deps: boolean
  note: string
}

/** Corre un comando y devuelve su salida, con techo de tiempo. Nunca tira. */
function run(cmd: string, args: string[], cwd: string, timeout = 45_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    let out = ""
    let listo = false
    let reloj: ReturnType<typeof setTimeout> | undefined
    const fin = (r: { ok: boolean; out: string }): void => {
      if (listo) return
      listo = true
      if (reloj) clearTimeout(reloj)
      resolve(r)
    }

    let hijo: ReturnType<typeof spawn>
    try {
      hijo = spawn(cmd, args, { cwd, windowsHide: true })
    } catch (err) {
      resolve({ ok: false, out: (err as Error).message })
      return
    }

    reloj = setTimeout(() => {
      try {
        hijo.kill()
      } catch {
        /* ya murió */
      }
      fin({ ok: false, out: `«${cmd} ${args[0] ?? ""}» tardó demasiado` })
    }, timeout)

    hijo.stdout?.on("data", (d: Buffer) => (out += String(d)))
    hijo.stderr?.on("data", (d: Buffer) => (out += String(d)))
    hijo.on("error", (err) => fin({ ok: false, out: err.message }))
    hijo.on("close", (code) => fin({ ok: code === 0, out: out.trim() }))
  })
}

const git = (args: string[], cwd: string, timeout?: number): Promise<{ ok: boolean; out: string }> =>
  run("git", args, cwd, timeout)

/** ¿Qué hay arriba que no tengamos? No aplica nada: solo mira y cuenta. */
export async function checkUpdate(dir: string = LAIN_ROOT): Promise<UpdateInfo> {
  const base: UpdateInfo = {
    ok: false,
    isRepo: false,
    fetched: false,
    branch: "",
    behind: 0,
    commits: [],
    local: "",
    remote: "",
    dirty: false,
    note: "",
  }

  const br = await git(["rev-parse", "--abbrev-ref", "HEAD"], dir)
  // En un repo todavía sin commits, `--abbrev-ref` falla: preguntamos si es git
  // de otra forma y sacamos la rama del symbolic-ref.
  if (!br.ok) {
    const esRepo = await git(["rev-parse", "--git-dir"], dir)
    if (!esRepo.ok) return { ...base, note: "esto no es un checkout de git" }
    const rama = (await git(["symbolic-ref", "--short", "HEAD"], dir)).out || "HEAD"
    return { ...base, isRepo: true, branch: rama, note: "el repo todavía no tiene commits" }
  }

  const branch = br.out
  const local = (await git(["rev-parse", "--short", "HEAD"], dir)).out
  if (!local) return { ...base, isRepo: true, branch, note: "el repo todavía no tiene commits" }

  const dirty = !!(await git(["status", "--porcelain"], dir)).out

  // Rama de arriba: la configurada, o `origin/<rama>` si no hay upstream.
  let up = (await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], dir)).out
  if (!up || !up.includes("/")) up = `origin/${branch}`

  const fetched = await git(["fetch", "--quiet", "--no-tags", "origin"], dir)
  const remote = (await git(["rev-parse", "--short", up], dir)).out
  const comun: UpdateInfo = { ...base, isRepo: true, fetched: fetched.ok, branch, local, dirty }

  if (!remote) return { ...comun, note: fetched.out || `no encontré la rama ${up} en origin` }

  const n = Number((await git(["rev-list", "--count", `HEAD..${up}`], dir)).out) || 0
  const log = n > 0 ? (await git(["log", "--no-merges", "--pretty=format:%h %s", `HEAD..${up}`], dir)).out : ""
  return {
    ...comun,
    ok: true,
    behind: n,
    commits: log ? log.split("\n").filter(Boolean).slice(0, 20) : [],
    remote,
    note: fetched.ok ? "" : "sin conexión con el remoto: uso lo último que sé",
  }
}

/** Fast-forward al remoto y, si hicieron falta, dependencias al día. */
export async function applyUpdate(dir: string = LAIN_ROOT): Promise<UpdateRun> {
  const before = (await git(["rev-parse", "--short", "HEAD"], dir)).out
  const pull = await git(["pull", "--ff-only"], dir, 120_000)
  if (!pull.ok) return { ok: false, before, after: before, pulled: 0, deps: false, note: pull.out }

  const after = (await git(["rev-parse", "--short", "HEAD"], dir)).out
  if (!after || after === before) return { ok: true, before, after: after || before, pulled: 0, deps: false, note: "" }

  const tocados = (await git(["diff", "--name-only", before, after], dir)).out
  const deps = /(^|\n)(package\.json|package-lock\.json)(\n|$)/.test(tocados)
  let note = ""
  if (deps) {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm"
    const inst = await run(npm, ["install", "--no-audit", "--no-fund"], dir, 300_000)
    note = inst.ok
      ? "dependencias al día"
      : `no pude correr npm install: ${inst.out.split("\n").slice(-2).join(" ")}`
  }

  const pulled = Number((await git(["rev-list", "--count", `${before}..${after}`], dir)).out) || 0
  return { ok: true, before, after, pulled, deps, note }
}

const STAMP = join(LAIN_DIR, "update.json")

/** ¿Toca mirar el remoto? Como mucho una vez por día. */
export function shouldCheckUpdate(now: number = Date.now()): boolean {
  try {
    const s = JSON.parse(readFileSync(STAMP, "utf8")) as { at?: number }
    return !s.at || now - s.at > CADA_MS
  } catch {
    return true
  }
}

/** Recuerda el resultado del chequeo (para no repetirlo en cada arranque). */
export function recordCheck(info: UpdateInfo, now: number = Date.now()): void {
  try {
    ensureDir(LAIN_DIR)
    writeFileSync(
      STAMP,
      JSON.stringify(
        { at: now, behind: info.behind, local: info.local, remote: info.remote, branch: info.branch, commits: info.commits },
        null,
        2,
      ),
      "utf8",
    )
  } catch {
    /* el registro es un lujo, no un requisito */
  }
}
