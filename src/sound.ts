import { spawn, type ChildProcess } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { LAIN_DIR, LAIN_ROOT, loadConfig, saveConfig } from "./config.js"

/** Cuánto dura, a lo sumo, cada reproducción de aviso antes de cerrar el reproductor. */
const MAX_PLAY_MS = 2500

/** Reproductor del aviso de la Wired (uno por vez). */
let aviso: ChildProcess | null = null
/** Reproductor del tecleo (suena en bucle mientras lain escribe). */
let tecleo: ChildProcess | null = null
/** Cuándo arrancó el reproductor actual (para no matarlo antes de que suene). */
let tecleoDesde = 0
let tecleoStop: ReturnType<typeof setTimeout> | null = null
/** PowerShell tarda en abrir el mp3; matarlo antes de esto deja el turno mudo. */
const MIN_TECLEO_MS = 900

/** Los sonidos que vienen con lain, para que suene sin configurar nada. */
const SONIDOS = join(LAIN_ROOT, "assets", "sounds")

/**
 * De dónde sale un sonido, en orden de prioridad:
 *   1. lo que digas en la config (`soundFile` / `typingFile`),
 *   2. tu copia en `~/.lain`,
 *   3. la que viene con lain, en `assets/sounds`.
 */
export function rutaDeSonido(nombre: string, dicho?: string): string {
  const propio = dicho?.trim()
  if (propio) return propio
  const mio = join(LAIN_DIR, nombre)
  return existsSync(mio) ? mio : join(SONIDOS, nombre)
}

function archivoAviso(): string {
  return rutaDeSonido("notification.mp3", loadConfig().soundFile)
}

function archivoTecleo(): string {
  return rutaDeSonido("typing.mp3", loadConfig().typingFile)
}

/** Copia a ~/.lain el mp3 que esté en Descargas, para no depender de esa carpeta. */
function adopta(nombre: string): void {
  const dest = join(LAIN_DIR, nombre)
  if (existsSync(dest)) return
  const src = join(homedir(), "Downloads", nombre)
  try {
    if (!existsSync(src)) return
    if (!existsSync(LAIN_DIR)) mkdirSync(LAIN_DIR, { recursive: true })
    copyFileSync(src, dest)
  } catch {
    /* sin copia: quedará en silencio */
  }
}

/** Deja a mano los mp3 de aviso y de tecleo en ~/.lain. */
export function prepare(): void {
  adopta("notification.mp3")
  adopta("typing.mp3")
}

export function isSoundOn(): boolean {
  return loadConfig().sound !== false
}

export function isTypingSoundOn(): boolean {
  return loadConfig().soundTyping !== false
}

export function setSound(on: boolean): void {
  const cfg = loadConfig()
  cfg.sound = on
  saveConfig(cfg)
  if (!on) stopSound()
}

export function setTypingSound(on: boolean): void {
  const cfg = loadConfig()
  cfg.soundTyping = on
  saveConfig(cfg)
  if (!on) mataTecleo()
}

function lanzaPowershell(ps: string): ChildProcess | null {
  try {
    return spawn(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps],
      { stdio: "ignore", windowsHide: true },
    )
  } catch {
    return null
  }
}

/** Reproduce el mp3 del aviso. No-op si está apagado o falta el archivo. */
export function playSound(): void {
  if (!isSoundOn()) return
  const file = archivoAviso()
  if (!existsSync(file)) return
  // Cortamos el anterior: si llegan dos avisos seguidos, no se encinan.
  stopSound()
  const uri = file.replace(/'/g, "''")
  const ps =
    "Add-Type -AssemblyName PresentationCore; " +
    "$p=New-Object System.Windows.Media.MediaPlayer; " +
    `$p.Open([Uri]'${uri}'); $p.Volume=0.7; $p.Play(); ` +
    `Start-Sleep -Milliseconds ${MAX_PLAY_MS}; ` +
    "$p.Stop(); $p.Close()"
  aviso = lanzaPowershell(ps)
  if (!aviso) return
  const limpia = (): void => {
    aviso = null
  }
  aviso.on("exit", limpia)
  aviso.on("error", limpia)
}

export function stopSound(): void {
  try {
    aviso?.kill()
  } catch {
    /* ignore */
  }
  aviso = null
}

/**
 * Empieza el sonido de tecleo, en bucle, mientras lain escribe. Idempotente:
 * si ya está sonando no arranca otro. Se corta con stopTyping().
 */
export function startTyping(): void {
  if (!isTypingSoundOn()) return
  // Si había un corte esperando, se cancela: seguimos con el mismo reproductor.
  if (tecleoStop) {
    clearTimeout(tecleoStop)
    tecleoStop = null
  }
  if (tecleo) return
  const file = archivoTecleo()
  if (!existsSync(file)) return
  const uri = file.replace(/'/g, "''")
  // Leemos la duración real del mp3 y lo repetimos cada esa cantidad de segundos,
  // hasta que lain lo mate al terminar de escribir.
  const ps =
    "Add-Type -AssemblyName PresentationCore; " +
    "$p=New-Object System.Windows.Media.MediaPlayer; " +
    `$p.Open([Uri]'${uri}'); Start-Sleep -Milliseconds 250; ` +
    "$d=$p.NaturalDuration.TimeSpan.TotalSeconds; if($d -le 0){$d=3}; " +
    "$p.Volume=0.5; $p.Play(); " +
    "while($true){ Start-Sleep -Milliseconds ([int]($d*1000)); $p.Position=[TimeSpan]::Zero; $p.Play() }"
  tecleo = lanzaPowershell(ps)
  if (!tecleo) return
  tecleoDesde = Date.now()
  const limpia = (): void => {
    tecleo = null
  }
  tecleo.on("exit", limpia)
  tecleo.on("error", limpia)
}

/**
 * Corta el tecleo. Si el reproductor acaba de arrancar se espera lo mínimo para
 * que llegue a sonar: matarlo antes de que abra el mp3 dejaba el turno mudo.
 */
export function stopTyping(): void {
  if (!tecleo) return
  const falta = MIN_TECLEO_MS - (Date.now() - tecleoDesde)
  if (falta > 0) {
    if (!tecleoStop) {
      tecleoStop = setTimeout(() => {
        tecleoStop = null
        mataTecleo()
      }, falta)
    }
    return
  }
  mataTecleo()
}

/** Lo mata ya (apagado explícito o cierre de lain). */
function mataTecleo(): void {
  if (tecleoStop) {
    clearTimeout(tecleoStop)
    tecleoStop = null
  }
  try {
    tecleo?.kill()
  } catch {
    /* ignore */
  }
  tecleo = null
}

/** Corta todo sonido (tecleo y aviso). Para el cierre de lain. */
export function stopSoundAll(): void {
  stopSound()
  mataTecleo()
}
