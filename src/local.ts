/**
 * El "faro" local: tiempo y titulares de la ciudad del usuario.
 * Sin claves de API: Open-Meteo (geocodificación + tiempo) y RSS de noticias.
 */

export interface Place {
  name: string
  admin?: string
  country?: string
  lat: number
  lon: number
}

export interface Weather {
  temp: number
  max?: number
  min?: number
  desc: string
}

export interface Headline {
  title: string
  source?: string
  link: string
}

export interface Beacon {
  place: string
  weather?: Weather
  news: Headline[]
  at: number
}

const UA = { "user-agent": "lain-cli/0.1" }
const CACHE_MS = 15 * 60_000
const cache = new Map<string, Beacon>()

async function get(url: string, ms = 7000): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: UA })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.text()
}

async function getJson<T>(url: string, ms = 7000): Promise<T> {
  return JSON.parse(await get(url, ms)) as T
}

/** Ciudad → coordenadas (Open-Meteo, sin clave). */
export async function geocode(query: string): Promise<Place | null> {
  const q = query.trim()
  if (!q) return null
  try {
    const d = await getJson<any>(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=es&format=json`,
    )
    const r = d?.results?.[0]
    if (!r || typeof r.latitude !== "number") return null
    return { name: r.name, admin: r.admin1, country: r.country, lat: r.latitude, lon: r.longitude }
  } catch {
    return null
  }
}

const WMO: Array<[number[], string]> = [
  [[0], "despejado"],
  [[1], "casi despejado"],
  [[2], "nubes y claros"],
  [[3], "nublado"],
  [[45, 48], "niebla"],
  [[51, 53, 55, 56, 57], "llovizna"],
  [[61, 63, 65, 66, 67], "lluvia"],
  [[71, 73, 75, 77], "nieve"],
  [[80, 81, 82], "chubascos"],
  [[85, 86], "chubascos de nieve"],
  [[95, 96, 99], "tormenta"],
]

function codeText(code: unknown): string {
  const n = typeof code === "number" ? code : Number(code)
  for (const [codes, text] of WMO) if (codes.includes(n)) return text
  return "cielo raro"
}

export async function weatherOf(place: Place): Promise<Weather | null> {
  try {
    const d = await getJson<any>(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
        `&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto`,
    )
    const c = d?.current
    if (!c || typeof c.temperature_2m !== "number") return null
    const daily = d?.daily ?? {}
    const max = daily.temperature_2m_max?.[0]
    const min = daily.temperature_2m_min?.[0]
    return {
      temp: Math.round(c.temperature_2m),
      max: typeof max === "number" ? Math.round(max) : undefined,
      min: typeof min === "number" ? Math.round(min) : undefined,
      desc: codeText(c.weather_code),
    }
  } catch {
    return null
  }
}

function clean(html: string): string {
  return html
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function parseRss(xml: string, limit: number): Headline[] {
  const out: Headline[] = []
  for (const block of xml.split(/<item[\s>]/).slice(1)) {
    const title = clean(/<title>([\s\S]*?)<\/title>/i.exec(block)?.[1] ?? "")
    const link = clean(/<link>([\s\S]*?)<\/link>/i.exec(block)?.[1] ?? "")
    const source = clean(/<source[^>]*>([\s\S]*?)<\/source>/i.exec(block)?.[1] ?? "")
    if (!title) continue
    let t = title
    let src = source
    if (src) {
      t = t.replace(new RegExp(`\\s+-\\s+${src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"), "").trim()
    } else {
      const m = /^(.*)\s+-\s+([^-]{2,40})$/.exec(title)
      if (m) {
        t = m[1]!.trim()
        src = m[2]!.trim()
      }
    }
    out.push({ title: t, source: src || undefined, link })
    if (out.length >= limit) break
  }
  return out
}

/** Titulares sobre un lugar (Google News RSS, con Bing como respaldo). */
export async function newsOf(query: string, limit = 2): Promise<Headline[]> {
  const q = encodeURIComponent(query)
  const feeds = [
    `https://news.google.com/rss/search?q=${q}&hl=es&gl=ES&ceid=ES:es`,
    `https://www.bing.com/news/search?q=${q}&format=RSS&setlang=es`,
  ]
  for (const url of feeds) {
    try {
      const items = parseRss(await get(url), limit)
      if (items.length) return items
    } catch {
      /* probamos la siguiente */
    }
  }
  return []
}

/** Tiempo + titulares de un lugar, con caché corta. */
export async function beacon(placeRaw: string): Promise<Beacon | null> {
  const key = placeRaw.trim().toLowerCase()
  if (!key) return null
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit
  const p = await geocode(placeRaw)
  const zona = [p?.name, p?.country].filter(Boolean).join(" ")
  const busqueda = p?.country && p.name.toLowerCase() !== p.country.toLowerCase() ? zona : p?.name ?? placeRaw
  let news = await newsOf(busqueda)
  if (!news.length && p) news = await newsOf(p.name)
  const weather = p ? await weatherOf(p) : null
  if (!p && news.length === 0) return null
  const label = p ? [p.name, p.country].filter(Boolean).join(", ") : placeRaw.trim()
  const b: Beacon = { place: label, weather: weather ?? undefined, news, at: Date.now() }
  cache.set(key, b)
  cache.set(label.toLowerCase(), b)
  return b
}

function temp(w: Weather): string {
  const rango = w.max != null && w.min != null ? ` (${w.max}°/${w.min}°)` : ""
  return `${w.temp}° y ${w.desc}${rango}`
}

/** ¿Empieza esto con un saludo? ("hola lain", "buenas", "hey"…) */
export function looksLikeGreeting(line: string): boolean {
  const t = line.trim().replace(/^[\s,¡!¿?.]+/, "")
  return /^(hola+|holi|hey|hi|hello|buenas|buenos d[ií]as|buenas tardes|buenas noches|qu[eé] tal|qu[eé] pasa|qu[eé] cuentas|c[oó]mo est[aá]s|c[oó]mo and[aá]s)\b/i.test(
    t,
  )
}

const PLACE_STRIP = /^(soy de|soy|estoy en|estoy|vivo en|vivo|desde|en|mi ciudad es|mi ciudad|aqu[ií] en|ac[aá] en|escribo desde)\s+/i

/**
 * ¿Esto que escribió el usuario es una ciudad?
 * Conservador: corto, sin preguntas y con pinta de nombre propio.
 */
export function parsePlace(raw: string): string | null {
  let t = raw.trim().replace(/^["'«“]+|["'»”]+$/g, "").replace(/[.;,]+$/, "").trim()
  t = t.replace(PLACE_STRIP, "").trim()
  if (t.length < 2 || t.length > 48) return null
  const words = t.split(/\s+/)
  if (words.length > 5) return null
  if (/[?¿!¡\n]/.test(t)) return null
  if (/^(hola|hey|buenas|gracias|si|sí|no|ok|vale|qué|que|cómo|como|cuál|cual|por ?qué)\b/i.test(t)) return null
  if (!/^[\p{L}\p{M}][\p{L}\p{M}\s.,'’()-]*$/u.test(t)) return null
  return t
}

/** Lo que se le enseña al usuario: el tiempo y un par de titulares. */
export function beaconLines(b: Beacon): string[] {
  const out: string[] = []
  out.push(`local · ${b.place}${b.weather ? ` · ${temp(b.weather)}` : ""}`)
  if (b.news.length) {
    for (const n of b.news) out.push(`titular · «${n.title}»${n.source ? ` — ${n.source}` : ""}`)
  } else {
    out.push("titular · no pude leer la prensa de ahí ahora mismo")
  }
  return out
}

/** Lo que se le mete a lain en el prompt para que comente. */
export function beaconContext(b: Beacon): string {
  const partes = [`[contexto local] El usuario está en ${b.place}.`]
  if (b.weather) partes.push(`Tiempo ahora: ${temp(b.weather)}.`)
  if (b.news.length) {
    partes.push(
      "Titulares del día: " +
        b.news.map((n) => `${n.title}${n.source ? ` (${n.source})` : ""}`).join(" | ") +
        ".",
    )
  }
  partes.push("Ya se los has enseñado en pantalla: coméntalos en una o dos frases, con tu voz, sin repetirlos literalmente.")
  return partes.join(" ")
}
