import { execFile, spawnSync } from "node:child_process"

export type Mux = "psmux" | "tmux"

const OPTION = "scroll-enter-copy-mode"

/** ¿Corremos dentro de un multiplexor (psmux/tmux)? */
export function muxName(): Mux | null {
  const inside = Boolean(process.env.TMUX || process.env.TMUX_PANE || process.env.IN_MUX)
  if (!inside) return null
  if (has("psmux")) return "psmux"
  if (has("tmux")) return "tmux"
  return null
}

function has(bin: string): boolean {
  try {
    return spawnSync(bin, ["-V"], { stdio: "ignore" }).status === 0
  } catch {
    return false
  }
}

/** Valor actual de `scroll-enter-copy-mode`, o null si el multiplexor no lo tiene. */
export function scrollEnterCopyMode(mux: Mux): "on" | "off" | null {
  try {
    const r = spawnSync(mux, ["show-options", "-g", OPTION], { encoding: "utf8" })
    if (r.status !== 0 || !r.stdout) return null
    const m = new RegExp(`${OPTION}\\s+(on|off)`).exec(r.stdout)
    return (m?.[1] as "on" | "off" | undefined) ?? null
  } catch {
    return null
  }
}

/** Cede la rueda a la aplicación (off) o la devuelve al multiplexor (on). */
export function setScrollEnterCopyMode(mux: Mux, on: boolean): boolean {
  try {
    return spawnSync(mux, ["set", "-g", OPTION, on ? "on" : "off"], { stdio: "ignore" }).status === 0
  } catch {
    return false
  }
}

/** El comando exacto, para poder enseñárselo al usuario. */
export function scrollCommand(mux: Mux, on: boolean): string {
  return `${mux} set -g ${OPTION} ${on ? "on" : "off"}`
}

let borrowed: { mux: Mux; previous: "on" | "off" } | null = null
let exitHooked = false
let auto = true

/** ¿Seguimos gestionando la rueda solos, o el usuario decidió con /mouse? */
export function autoEnabled(): boolean {
  return auto
}

/** El usuario ha decidido con /mouse: no la toquemos más en esta sesión. */
export function setAuto(on: boolean): void {
  auto = on
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout))
    })
  })
}

/** ¿Su panel es el que está mirando el usuario? null si no se puede saber. */
export async function focused(mux: Mux): Promise<boolean | null> {
  const pane = process.env.TMUX_PANE
  if (!pane) return null
  try {
    const out = (await run(mux, ["display-message", "-p", "-t", pane, "#{window_active}#{pane_active}"])).trim()
    if (out === "11") return true
    if (out === "10" || out === "01" || out === "00") return false
    return null
  } catch {
    return null
  }
}

/**
 * Si el multiplexor se está quedando la rueda (copy-mode), se la pedimos prestada
 * mientras lain vive, para que la rueda funcione sin que el usuario toque nada.
 * `LAIN_KEEP_MUX_WHEEL=1` lo desactiva.
 */
export function takeWheel(mux: Mux): boolean {
  if (process.env.LAIN_KEEP_MUX_WHEEL) return false
  const now = scrollEnterCopyMode(mux)
  if (now !== "on") return false
  if (!setScrollEnterCopyMode(mux, false)) return false
  borrowed = { mux, previous: now }
  if (!exitHooked) {
    exitHooked = true
    process.on("exit", () => {
      if (borrowed) setScrollEnterCopyMode(borrowed.mux, borrowed.previous === "on")
    })
  }
  return true
}

/** Reafirma el préstamo si alguien lo pisó (un source-file del conf, por ejemplo). */
export function keepWheel(mux: Mux): boolean {
  if (!borrowed) return false
  if (scrollEnterCopyMode(mux) !== "on") return false
  return setScrollEnterCopyMode(mux, false)
}

/** Devuelve la rueda al multiplexor (al salir de lain o al perder el foco). */
export function giveWheelBack(): void {
  if (!borrowed) return
  const { mux, previous } = borrowed
  borrowed = null
  setScrollEnterCopyMode(mux, previous === "on")
}

/** El usuario ha decidido con /mouse: no la toquemos más al salir. */
export function forgetWheel(): void {
  borrowed = null
  auto = false
}

/** ¿La rueda la tiene lain ahora mismo (prestada)? */
export function wheelIsOurs(): boolean {
  return borrowed !== null
}
