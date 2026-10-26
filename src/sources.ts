import { promises as fs } from "fs";
import path from "path";
import { config } from "./config";
import { Journal } from "./types";

// ---------- Sécurité : on ne contacte que l'hôte de la source (et ceux déclarés) ----------
export function hotesAutorises(): Set<string> {
  const hotes = new Set(config.source.hotes.map((h) => h.toLowerCase()));
  try {
    if (config.source.url) hotes.add(new URL(config.source.url).host.toLowerCase());
  } catch {
    /* adresse source invalide : signalée plus loin */
  }
  return hotes;
}

export function urlAutorisee(u: string): boolean {
  try {
    const x = new URL(u);
    return (x.protocol === "https:" || x.protocol === "http:") && hotesAutorises().has(x.host.toLowerCase());
  } catch {
    return false;
  }
}

// La clé d'accès n'est envoyée qu'aux hôtes autorisés
export function entetes(url: string, accept = "*/*"): Record<string, string> {
  const h: Record<string, string> = { "User-Agent": "veille-journaux/1.0", Accept: accept };
  if (config.source.auth && urlAutorisee(url)) h[config.source.authEntete] = config.source.auth;
  return h;
}

async function lireTexte(url: string, accept: string): Promise<{ corps: string; type: string }> {
  const res = await fetch(url, { headers: entetes(url, accept), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Source inaccessible (${res.status}) : ${url}`);
  const corps = await res.text();
  if (corps.length > 5 * 1024 * 1024) throw new Error("Réponse de la source trop volumineuse (> 5 Mo)");
  return { corps, type: res.headers.get("content-type") ?? "" };
}

function exigerUrlSource(): string {
  if (!config.source.url) throw new Error("SOURCE_URL est vide dans .env");
  if (!/^https?:\/\//i.test(config.source.url)) throw new Error("SOURCE_URL doit commencer par http:// ou https://");
  return config.source.url;
}

// Écarte les liens vers d'autres hôtes ; renvoie les journaux retenus
function retenir(liste: Journal[]): Journal[] {
  const vus = new Set<string>();
  const out: Journal[] = [];
  for (const j of liste) {
    if (!urlAutorisee(j.url)) {
      console.warn(` ! lien ignoré (hôte non autorisé) : ${j.url}`);
      continue;
    }
    if (vus.has(j.id)) continue;
    vus.add(j.id);
    out.push(j);
  }
  return out;
}

// ---------- Source "dossier" ----------
const IGNORES = /^(~\$|\.)/;
const STABLE_MS = 10_000;

async function detecterDossier(): Promise<Journal[]> {
  await fs.mkdir(config.source.dossier, { recursive: true });
  const noms = await fs.readdir(config.source.dossier);
  const journaux: Journal[] = [];
  for (const n of noms) {
    if (IGNORES.test(n) || !/\.(pdf|html?|txt)$/i.test(n)) continue;
    const chemin = path.join(config.source.dossier, n);
    const st = await fs.stat(chemin);
    if (!st.isFile() || Date.now() - st.mtimeMs < STABLE_MS) continue;
    journaux.push({ id: n, titre: path.parse(n).name, url: chemin });
  }
  return journaux;
}

// ---------- Source "json" : une API qui renvoie la liste des journaux ----------
export function trouverListe(data: unknown, chemin: string): unknown {
  let cur: any = data;
  for (const cle of chemin.split(".").filter(Boolean)) cur = cur?.[cle];
  return cur;
}

async function detecterJson(): Promise<Journal[]> {
  const base = exigerUrlSource();
  const { corps } = await lireTexte(base, "application/json");
  const data = trouverListe(JSON.parse(corps), config.source.listPath);
  if (!Array.isArray(data)) throw new Error("JSON_LIST_PATH ne pointe pas vers une liste (lancez npm run sonder)");
  const { titleField, urlField } = config.source;
  return retenir(
    data
      .filter((x) => x && typeof x === "object" && (x as any)[urlField])
      .map((x: any) => {
        const lien = new URL(String(x[urlField]), base).toString();
        return { id: lien, titre: String(x[titleField] ?? decodeURIComponent(lien.split("/").pop() ?? lien)), url: lien };
      })
  );
}

// ---------- Source "rss" : flux RSS ou Atom ----------
const decoder = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .trim();

async function detecterRss(): Promise<Journal[]> {
  const base = exigerUrlSource();
  const { corps } = await lireTexte(base, "application/rss+xml, application/atom+xml, application/xml, text/xml");
  if (!/<rss|<feed/i.test(corps)) throw new Error("Cette adresse ne renvoie pas un flux RSS/Atom (lancez npm run sonder)");
  const out: Journal[] = [];
  for (const m of corps.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)) {
    const b = m[0];
    const brut =
      b.match(/<enclosure[^>]*url=["']([^"']+)["']/i)?.[1] ??
      b.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1] ??
      b.match(/<link[^>]*>([^<]+)<\/link>/i)?.[1];
    if (!brut) continue;
    const lien = new URL(decoder(brut), base).toString();
    const titre = decoder(b.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "") || lien;
    out.push({ id: lien, titre, url: lien });
  }
  return retenir(out);
}

// ---------- Source "page" : une page web qui liste des liens vers les journaux ----------
async function detecterPage(): Promise<Journal[]> {
  const base = exigerUrlSource();
  const { corps } = await lireTexte(base, "text/html");
  const regex = new RegExp(config.source.lienRegex, "i");
  const out: Journal[] = [];
  for (const m of corps.matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let lien: string;
    try {
      lien = new URL(decoder(m[1]), base).toString();
    } catch {
      continue;
    }
    if (!regex.test(lien)) continue;
    const texte = decoder(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
    out.push({ id: lien, titre: texte || decodeURIComponent(lien.split("/").pop()?.split("?")[0] ?? lien), url: lien });
  }
  return retenir(out);
}

export async function detecter(): Promise<Journal[]> {
  switch (config.source.mode) {
    case "json": return detecterJson();
    case "rss": return detecterRss();
    case "page": return detecterPage();
    default: return detecterDossier();
  }
}
