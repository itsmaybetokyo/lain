import type { WireEntry, PublishRequest } from "./protocol.js"

async function getJson(url: string): Promise<any> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`wired ${res.status}`)
  return res.json()
}

export async function health(base: string): Promise<{ ok: boolean; entries: number; nodes: number }> {
  return getJson(`${base}/health`)
}

export async function publish(base: string, req: PublishRequest): Promise<{ added: number; total: number }> {
  const res = await fetch(`${base}/publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  })
  if (!res.ok) throw new Error(`wired ${res.status}`)
  return (await res.json()) as { added: number; total: number }
}

export async function search(base: string, q: string): Promise<WireEntry[]> {
  const out = (await getJson(`${base}/search?q=${encodeURIComponent(q)}`)) as { results: WireEntry[] }
  return out.results
}

export async function allEntries(base: string): Promise<WireEntry[]> {
  const out = await getJson(`${base}/entries`)
  return out.entries as WireEntry[]
}

export async function nodes(base: string): Promise<any[]> {
  const out = await getJson(`${base}/nodes`)
  return out.nodes
}
