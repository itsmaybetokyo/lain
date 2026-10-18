import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { randomUUID } from "node:crypto"

export interface LainConfig {
  /** Identidad del nodo en la Wired. */
  nodeId: string
  /** Nombre visible (handle) de este nodo. */
  handle: string
  /** Carpeta del vault de Obsidian donde vive tu conocimiento. */
  vaultPath: string
  /** URL del relay de la Wired. */
  wiredUrl: string
  /** Transporte de la Wired: repo git compartido (por defecto) o relay propio. */
  wiredMode?: "relay" | "git"
  /** Repo git compartido (URL) cuando wiredMode = "git" (por defecto WIRED_REPO_DEFAULT). */
  wiredRepo?: string
  /** Clon local del repo de la Wired (por defecto ~/.lain/wired-repo). */
  wiredDir?: string
  /** Puerto del servidor de opencode (0 = elegir libre). */
  port: number
  /** Modelo opcional: providerID/modelID. */
  model?: { providerID: string; modelID: string }
  /** Cómo dibujar el retrato: braille suavizado, medios bloques o bloques completos. */
  art?: "smooth" | "half" | "full"
  /** Ciudad del usuario: se pregunta una vez y se recuerda. */
  place?: string
  /** Política de publicación por defecto. */
  publish: "private" | "public" | "all"
  /** Lain lee las respuestas en voz alta. Se puede mutear con /mute. */
  tts?: boolean
  /**
   * Motor de voz externo: comando al que se le pasa el texto por stdin (o en el
   * lugar de `{}` si el comando lo incluye). Sin esto, no hay voz.
   * Ej: "/voice piper -m lain.onnx -f - | aplay"
   */
  ttsCommand?: string
  /** Cada cuántas horas se reinicia la cuota gratuita (por defecto 11). */
  limitWindowHours?: number
  /** Sonido al llegar un aviso de la Wired. Encendido por defecto; se apaga con /sound. */
  sound?: boolean
  /** Ruta del mp3 de notificación (por defecto ~/.lain/notification.mp3). */
  soundFile?: string
  /** Sonido mientras se escriben las respuestas de lain. Se apaga con /typing. */
  soundTyping?: boolean
  /** Ruta del mp3 de tecleo (por defecto ~/.lain/typing.mp3). */
  typingFile?: string
  /**
   * Carpeta donde trabajan lain y sus subagentes (crean y editan archivos ahí).
   * Por defecto ~/.lain/work, para no ensuciar la carpeta donde vive lain.
   */
  workDir?: string
}

/**
 * Repo git de la Wired por defecto: la federación que comparten todas las
 * instalaciones de lain. Leer alcanza con que el repo sea público; para publicar
 * hay que ser colaborador. Se cambia con `/wired git <url>` o `lain wired git <url>`.
 */
export const WIRED_REPO_DEFAULT = "https://github.com/itsmaybetokyo/wired"

export const LAIN_DIR = process.env.LAIN_HOME ?? join(homedir(), ".lain")
const CONFIG_FILE = join(LAIN_DIR, "config.json")

/**
 * Raíz del código de lain: donde viven `bin/`, `src/` y `package.json`.
 * Sirve para el lanzador y para saber contra qué repo actualizarse.
 */
export const LAIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

export function defaultConfig(): LainConfig {
  return {
    nodeId: randomUUID(),
    handle: `${(process.env.USERNAME ?? process.env.USER ?? "lain").toLowerCase()}`,
    vaultPath: join(LAIN_DIR, "vault"),
    wiredUrl: "http://127.0.0.1:7777",
    wiredMode: "git",
    wiredRepo: WIRED_REPO_DEFAULT,
    port: 0,
    publish: "public",
  }
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function loadConfig(): LainConfig {
  ensureDir(LAIN_DIR)
  if (!existsSync(CONFIG_FILE)) {
    const cfg = defaultConfig()
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8")
    return cfg
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Partial<LainConfig>
    return { ...defaultConfig(), ...raw }
  } catch {
    const cfg = defaultConfig()
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8")
    return cfg
  }
}

export function saveConfig(cfg: LainConfig): void {
  ensureDir(LAIN_DIR)
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8")
}

/**
 * Carpeta de trabajo de lain y sus subagentes. Nunca es "donde esté el código de
 * lain" por defecto: así un subagente que crea un proyecto no ensucia la carpeta
 * del sistema. Se puede fijar con /work o con LAIN_WORKDIR.
 */
export function workDirOf(cfg: LainConfig): string {
  const env = process.env.LAIN_WORKDIR?.trim()
  if (env) return env
  const propio = cfg.workDir?.trim()
  return propio || join(LAIN_DIR, "work")
}
