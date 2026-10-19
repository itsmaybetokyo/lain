/**
 * Pedir las llaves de la Wired cuando no se tienen.
 *
 * El huevo y la gallina: si el repo de la Wired es privado, quien no es
 * colaborador no lo ve — y GitHub no deja abrir un issue en un repo que no ves.
 * Así que el pedido va al repo público de lain (ACCESS_REPO_DEFAULT), que esa
 * persona ya alcanzó: de ahí bajó el programa. Ahí el dueño se entera.
 *
 * No hace falta gh ni token: armamos la URL del issue con título y cuerpo ya
 * escritos, y la abre el navegador. La persona la revisa y aprieta «Submit».
 */
import { ACCESS_REPO_DEFAULT, type LainConfig } from "../config.js"

/** github.com/<dueño>/<repo> a partir de cualquier forma de URL de git. */
export function slugDeRepo(url: string): string | null {
  const m = url.trim().match(/(?:github\.com[/:])([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i)
  return m ? `${m[1]}/${m[2]}` : null
}

/** Repo donde se pide el acceso: lo que diga la config, o el de lain. */
export function repoDeAcceso(cfg: LainConfig): string {
  return cfg.accessRepo?.trim() || ACCESS_REPO_DEFAULT
}

export function tituloDelPedido(cfg: LainConfig): string {
  return `acceso a la Wired · ${cfg.handle}`
}

/**
 * El pedido, en el idioma del repo de lain. Lleva lo justo para que el dueño
 * pueda sumar a esa persona sin preguntar nada: handle, nodeId y a qué Wired
 * apunta; y, si sabemos por qué falló, el motivo tal cual lo dijo git.
 */
export function cuerpoDelPedido(cfg: LainConfig, falla?: string): string {
  const lineas = [
    `hola. soy **${cfg.handle}**, un nodo de lain, y quiero publicar en la Wired.`,
    "",
    "```",
    `handle:    ${cfg.handle}`,
    `nodeId:    ${cfg.nodeId}`,
    `la Wired:  ${cfg.wiredRepo ?? cfg.wiredUrl}`,
  ]
  if (falla) lineas.push(`al subir: ${falla}`)
  lineas.push(
    "```",
    "",
    "No tengo permiso para escribir ahí, así que mi nota quedó guardada en casa",
    "(lain la reintenta sola cuando pueda).",
    "",
    "¿me sumás como colaborador? (o decime cómo entrar)",
    "",
    "_pedido armado por lain_",
  )
  return lineas.join("\n")
}

/**
 * URL de «nuevo issue» con el pedido ya cargado. Null si el repo de acceso no
 * es de GitHub (entonces no hay a dónde mandarlo).
 */
export function urlDelPedido(cfg: LainConfig, falla?: string): string | null {
  const slug = slugDeRepo(repoDeAcceso(cfg))
  if (!slug) return null
  const q = new URLSearchParams({ title: tituloDelPedido(cfg), body: cuerpoDelPedido(cfg, falla) })
  // GitHub quiere %20 y no + en el título/cuerpo precargados.
  return `https://github.com/${slug}/issues/new?${q.toString().replace(/\+/g, "%20")}`
}
