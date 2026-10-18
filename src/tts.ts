import { spawn } from "node:child_process"
import { loadConfig, saveConfig } from "./config.js"

/** Quita markdown básico para que la voz no lea asteriscos ni backticks. */
function plain(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/#+\s*/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

let current: ReturnType<typeof spawn> | null = null

/**
 * Lee el texto con el motor que hayas configurado (config `ttsCommand`). No usamos
 * la voz de Windows: si no hay motor, no habla. El texto se pasa por stdin, o en
 * el lugar de `{}` si el comando lo trae.
 */
export function speak(text: string): void {
  const cfg = loadConfig()
  if (cfg.tts === false) return
  const cmd = cfg.ttsCommand?.trim()
  if (!cmd) return
  const t = plain(text)
  if (!t) return
  // Cortamos cualquier lectura anterior para no encimar.
  try {
    current?.kill()
  } catch {
    /* ignore */
  }
  const conTexto = cmd.includes("{}")
  const linea = conTexto ? cmd.replace("{}", `"${t.replace(/"/g, '\\"')}"`) : cmd
  try {
    current = spawn(linea, { shell: true, stdio: ["pipe", "ignore", "ignore"], windowsHide: true })
  } catch {
    current = null
    return
  }
  if (!conTexto) {
    current.stdin?.write(t)
    current.stdin?.end()
  }
  current.on("exit", () => {
    current = null
  })
  current.on("error", () => {
    current = null
  })
}

export function isMuted(): boolean {
  return loadConfig().tts === false
}

export function setMuted(muted: boolean): void {
  const cfg = loadConfig()
  cfg.tts = !muted
  saveConfig(cfg)
  if (muted) {
    try {
      current?.kill()
    } catch {
      /* ignore */
    }
    current = null
  }
}

export function stopSpeech(): void {
  try {
    current?.kill()
  } catch {
    /* ignore */
  }
  current = null
}
