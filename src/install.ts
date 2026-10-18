import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { LAIN_ROOT } from "./config.js"

const WIN = process.platform === "win32"

export interface InstallResult {
  ok: boolean
  /** Carpeta donde vive el lanzador. */
  dir: string
  /** Ruta del lanzador. */
  file: string
  /** Hubo que agregar la carpeta al PATH del usuario. */
  pathAdded: boolean
  /** Hubo que quitarla. */
  pathRemoved: boolean
  note: string
}

/**
 * Dónde dejamos el comando. En Windows usamos una carpeta propia bajo
 * %LOCALAPPDATA%; en el resto, ~/.local/bin (que ya está en el PATH en muchas
 * distribuciones).
 */
export function binDir(): string {
  if (WIN) return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "lain", "bin")
  return join(homedir(), ".local", "bin")
}

/** Ruta del lanzador que dejamos en `dir`. */
export function shimPath(dir: string = binDir()): string {
  return join(dir, WIN ? "lain.cmd" : "lain")
}

/** El contenido del lanzador de Windows: llama al node que está corriendo esto. */
export function shimContent(nodeExe: string, entry: string): string {
  return `@echo off\r\n"${nodeExe}" "${entry}" %*\r\n`
}

/** Escapado mínimo para incrustar una ruta en un literal de PowerShell. */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

function ps(script: string): { ok: boolean; out: string } {
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  })
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() }
}

// El PATH del usuario vive en HKCU\Environment. Lo tocamos por el registro, y no
// con [Environment]::SetEnvironmentVariable, para no expandir los %VARIABLES% que
// ya tuvieras ahí (eso convertiría un REG_EXPAND_SZ en un REG_SZ).
const CLAVE_PATH = "Environment"
const PS_LEER = `[string]$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)`
const PS_TIPO = `$tipo = 'String'; try { $tipo = $k.GetValueKind('Path') } catch { }`
const PS_PARTES = `$partes = @($k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -split ';' | Where-Object { $_ -ne '' })`
// En un template literal `\\` es una barra: PowerShell ve TrimEnd('\','/').
const PS_IGUAL = `$_.TrimEnd('\\','/') -ieq $d.TrimEnd('\\','/')`

const abrir = (clave: string): string =>
  `[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${psQuote(clave)}, $true)`

const pelar = (s: string): string => s.replace(/[\\/]+$/, "").toLowerCase()

/**
 * Las tres de abajo reciben la clave del registro solo para poder probarlas:
 * en uso real siempre apuntan a HKCU\Environment.
 */

/** Las entradas del PATH del usuario, tal cual están guardadas. */
export function userPathEntries(clave: string = CLAVE_PATH): string[] {
  if (!WIN) return (process.env.PATH ?? "").split(":").filter(Boolean)
  const r = ps(`$k = ${abrir(clave)}\nif ($k) { ${PS_LEER} }`)
  return r.ok ? r.out.split(";").map((s) => s.trim()).filter(Boolean) : []
}

/** ¿La carpeta ya está en el PATH del usuario? */
export function userPathHas(dir: string, clave: string = CLAVE_PATH): boolean {
  const want = WIN ? pelar(dir) : dir.replace(/\/+$/, "")
  return userPathEntries(clave).some((e) => (WIN ? pelar(e) : e.replace(/\/+$/, "")) === want)
}

/**
 * Agrega la carpeta al PATH del usuario. Solo Windows: en unix no tocamos tus
 * archivos de shell, te decimos qué agregar y listo.
 */
export function addUserPath(dir: string, clave: string = CLAVE_PATH): boolean {
  if (!WIN) return false
  if (userPathHas(dir, clave)) return true
  return ps(
    `$d = ${psQuote(dir)}\n` +
      `$k = ${abrir(clave)}\n` +
      `if (-not $k) { $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(${psQuote(clave)}) }\n` +
      `if ($k) {\n` +
      `  ${PS_TIPO}\n` +
      `  ${PS_PARTES}\n` +
      `  $hay = @($partes | Where-Object { ${PS_IGUAL} })\n` +
      `  if ($hay.Count -eq 0) { $k.SetValue('Path', (($partes + $d) -join ';'), $tipo) }\n` +
      `  $k.Close()\n` +
      `}\n` +
      `'ok'`,
  ).ok
}

/** Quita la carpeta del PATH del usuario (solo Windows). */
export function removeUserPath(dir: string, clave: string = CLAVE_PATH): boolean {
  if (!WIN) return true
  return ps(
    `$d = ${psQuote(dir)}\n` +
      `$k = ${abrir(clave)}\n` +
      `if ($k) {\n` +
      `  ${PS_TIPO}\n` +
      `  ${PS_PARTES}\n` +
      `  $resto = @($partes | Where-Object { $_.TrimEnd('\\','/') -ine $d.TrimEnd('\\','/') })\n` +
      `  $k.SetValue('Path', ($resto -join ';'), $tipo)\n` +
      `  $k.Close()\n` +
      `}\n` +
      `'ok'`,
  ).ok
}

/** Deja el lanzador escrito. No toca el PATH. */
export function writeShim(dir: string = binDir()): string {
  mkdirSync(dir, { recursive: true })
  const entry = join(LAIN_ROOT, "bin", "lain.mjs")

  if (WIN) {
    const file = shimPath(dir)
    writeFileSync(file, shimContent(process.execPath, entry), "utf8")
    return file
  }

  try {
    chmodSync(entry, 0o755)
  } catch {
    /* si no se puede, el enlace igual sirve mientras el archivo se pueda leer */
  }
  const file = shimPath(dir)
  if (existsSync(file)) unlinkSync(file)
  symlinkSync(entry, file)
  return file
}

/**
 * Deja el comando `lain` disponible desde cualquier carpeta.
 * Con `addPath = false` escribe el lanzador pero no toca el PATH.
 */
export function installLauncher(addPath = true): InstallResult {
  const dir = binDir()
  const r: InstallResult = { ok: false, dir, file: "", pathAdded: false, pathRemoved: false, note: "" }
  try {
    r.file = writeShim(dir)
  } catch (err) {
    return { ...r, note: (err as Error).message }
  }

  if (userPathHas(dir)) return { ...r, ok: true }

  if (!addPath) return { ...r, ok: true, note: `agregá ${dir} a tu PATH` }

  r.pathAdded = addUserPath(dir)
  if (!r.pathAdded) return { ...r, ok: true, note: `no pude editar el PATH; agregá ${dir} a mano` }
  return { ...r, ok: true }
}

/** Saca el comando (y, si lo agregamos nosotros, la carpeta del PATH). */
export function uninstallLauncher(removePath = true): InstallResult {
  const dir = binDir()
  const file = shimPath(dir)
  const r: InstallResult = { ok: true, dir, file, pathAdded: false, pathRemoved: false, note: "" }

  try {
    if (existsSync(file)) unlinkSync(file)
  } catch (err) {
    return { ...r, ok: false, note: (err as Error).message }
  }
  try {
    if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true })
  } catch {
    /* si quedó algo, lo dejamos */
  }

  if (removePath && userPathHas(dir)) r.pathRemoved = removeUserPath(dir)
  return r
}
