import { promises as fs } from "fs";
import path from "path";
import { Journal } from "./types";
import { Source, chargerSources, hoteDe } from "./registre";

// Une erreur qui dit À QUELLE ÉTAPE la connexion a échoué (pour la boîte de dialogue)
export class ErreurSource extends Error {
  constructor(public etape: "connexion" | "authentification" | "lecture", message: string) {
    super(message);
  }
}

// ---------- Sécurité : on ne contacte que l'hôte de la source (et ceux déclarés) ----------
export function hotesAutorises(src: Source): Set<string> {
  const h = new Set((src.hotes ?? []).map((x) => x.toLowerCase()));
  if (src.url) h.add(hoteDe(src.url));
  return h;
}

export function urlAutorisee(src: Source, u: string): boolean {
  try {
    const x = new URL(u);
    return (x.protocol === "https:" || x.protocol === "http:") && hotesAutorises(src).has(x.host.toLowerCase());
  } catch {
    return false;
  }
}

// La clé d'accès (cookie, jeton) n'est envoyée qu'aux hôtes autorisés
export function entetes(src: Source, url: string, accept = "*/*"): Record<string, string> {
  const h: Record<string, string> = { "User-Agent": "veille-journaux/1.0", Accept: accept };
  if (src.auth && urlAutorisee(src, url)) h[src.authEntete || "Authorization"] = src.auth;
  return h;
}

function causeReseau(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err?.name === "TimeoutError") return "délai dépassé (30 s)";
  const code = err?.cause?.code;
  if (code === "ENOTFOUND") return "adresse introuvable (vérifiez le nom de domaine)";
  if (code === "ECONNREFUSED") return "connexion refusée par le serveur";
  if (code === "ECONNRESET") return "connexion interrompue";
  return err?.cause?.message ?? err?.message ?? "erreur réseau";
}

async function chargerBrut(src: Source, url: string, accept: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { headers: entetes(src, url, accept), signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new ErreurSource("connexion", `Site injoignable : ${causeReseau(e)}.`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new ErreurSource("authentification", `Accès refusé (${res.status}) : session ou identifiants invalides ou expirés.`);
  }
  if (!res.ok) throw new ErreurSource("connexion", `Réponse inattendue du site (${res.status}).`);
  const corps = await res.text();
  if (corps.length > 5 * 1024 * 1024) throw new ErreurSource("lecture", "Réponse trop volumineuse (plus de 5 Mo).");

  let chemin = "";
  try {
    chemin = new URL(res.url).pathname;
  } catch {
    /* ignoré */
  }
  const versConnexion =
    (res.redirected && /login|connexion|signin|sign-in/i.test(chemin)) ||
    (/html/i.test(res.headers.get("content-type") ?? "") && /type=["']password["']/i.test(corps));
  if (versConnexion) {
    throw new ErreurSource(
      "authentification",
      src.auth
        ? "Le site redirige vers sa page de connexion : session absente ou expirée. Récupérez un nouveau cookie."
        : "Ce site exige une connexion : renseignez un cookie de session."
    );
  }
  return corps;
}


// ---------- Connexion automatique par formulaire (identifiant + mot de passe) ----------
const UA = "veille-journaux/1.0";
type Formulaire = { action: string; methode: string; champs: Record<string, string>; champIdentifiant: string; champMotDePasse: string };

const attrib = (balise: string, nom: string): string | undefined => {
  const m = balise.match(new RegExp(`\\b${nom}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? decoder(m[1] ?? m[2] ?? m[3] ?? "") : undefined;
};

// Repère le formulaire qui contient un champ mot de passe (jeton CSRF et champs cachés compris)
export function extraireFormulaire(html: string, base: string): Formulaire | null {
  for (const f of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const champs: Record<string, string> = {};
    let champId = "";
    let champMdp = "";
    for (const i of f[2].matchAll(/<input\b[^>]*>/gi)) {
      const nom = attrib(i[0], "name");
      if (!nom) continue;
      const type = (attrib(i[0], "type") ?? "text").toLowerCase();
      if (type === "password") {
        if (!champMdp) champMdp = nom;
      } else if (type === "hidden") champs[nom] = attrib(i[0], "value") ?? "";
      else if ((type === "email" || type === "text") && !champId && !champMdp) champId = nom;
    }
    if (!champMdp || !champId) continue;
    try {
      return {
        action: new URL(attrib(f[1], "action") || base, base).toString(),
        methode: (attrib(f[1], "method") ?? "post").toUpperCase(),
        champs,
        champIdentifiant: champId,
        champMotDePasse: champMdp,
      };
    } catch {
      continue;
    }
  }
  return null;
}

async function seConnecter(src: Source): Promise<string> {
  const urlLogin = src.urlConnexion || new URL("/login", src.url).toString();
  if (!urlAutorisee(src, urlLogin)) throw new ErreurSource("connexion", "L'adresse de connexion doit être sur le même site que la source.");

  const jar = new Map<string, string>();
  const absorber = (r: Response) => {
    for (const sc of (r.headers as any).getSetCookie?.() ?? []) {
      const paire = String(sc).split(";")[0];
      const i = paire.indexOf("=");
      if (i > 0) jar.set(paire.slice(0, i).trim(), paire.slice(i + 1).trim());
    }
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

  let res: Response;
  try {
    res = await fetch(urlLogin, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new ErreurSource("connexion", `Site injoignable : ${causeReseau(e)}.`);
  }
  if (!res.ok) throw new ErreurSource("connexion", `Page de connexion inaccessible (${res.status}).`);
  absorber(res);
  const form = extraireFormulaire(await res.text(), res.url || urlLogin);
  if (!form) {
    throw new ErreurSource("authentification", "Aucun formulaire de connexion reconnu sur cette page (connexion dynamique ou captcha ?). Utilisez un cookie de session.");
  }
  if (!urlAutorisee(src, form.action)) throw new ErreurSource("authentification", "Le formulaire envoie les identifiants vers un autre site : refusé.");

  const champs = { ...form.champs, [form.champIdentifiant]: src.identifiant ?? "", [form.champMotDePasse]: src.motDePasse ?? "" };
  let url = form.action;
  let methode = form.methode === "GET" ? "GET" : "POST";
  let corps: string | undefined = new URLSearchParams(champs).toString();
  if (methode === "GET") {
    const u = new URL(url);
    for (const [k, v] of Object.entries(champs)) u.searchParams.set(k, v);
    url = u.toString();
    corps = undefined;
  }

  try {
    for (let saut = 0; saut < 6; saut++) {
      res = await fetch(url, {
        method: methode,
        redirect: "manual",
        body: corps,
        headers: { "User-Agent": UA, Accept: "text/html", Cookie: cookie(), Referer: urlLogin, ...(corps ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
        signal: AbortSignal.timeout(30_000),
      });
      absorber(res);
      const suite = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && suite) {
        url = new URL(suite, url).toString();
        if (!urlAutorisee(src, url)) break; // on ne suit jamais une redirection vers un autre site
        methode = "GET";
        corps = undefined;
        continue;
      }
      break;
    }
  } catch (e) {
    throw new ErreurSource("connexion", `Site injoignable : ${causeReseau(e)}.`);
  }

  const refus = "Identifiants refusés par le site (mot de passe incorrect, compte verrouillé ou protection anti-robot).";
  if (res.status >= 400) throw new ErreurSource("authentification", `${refus} (code ${res.status})`);
  if (res.status < 300 && /type=["']password["']/i.test(await res.text())) throw new ErreurSource("authentification", refus);
  if (!jar.size) throw new ErreurSource("authentification", "Le site n'a ouvert aucune session.");
  return cookie();
}

// Une session par source, gardée en mémoire (jamais sur disque) ; elle est rouverte si elle expire
const sessions = new Map<string, string>();
const cleSession = (s: Source) => [s.id, s.identifiant, s.url, s.urlConnexion].join("|");

export async function avecSession(src: Source, forcer = false): Promise<Source> {
  if (!src.identifiant) return src;
  if (src.illisible) throw new ErreurSource("authentification", "Accès enregistrés illisibles : SOURCES_CLE absente ou modifiée dans .env.");
  const k = cleSession(src);
  if (forcer) sessions.delete(k);
  let c = sessions.get(k);
  if (!c) {
    c = await seConnecter(src);
    if (sessions.size > 20) sessions.clear();
    sessions.set(k, c);
  }
  return { ...src, auth: c, authEntete: "Cookie" };
}

async function chargerPage(src: Source, url: string, accept: string): Promise<string> {
  if (src.illisible) throw new ErreurSource("authentification", "Accès enregistrés illisibles : SOURCES_CLE absente ou modifiée dans .env.");
  if (!src.identifiant) return chargerBrut(src, url, accept);
  const s = await avecSession(src); // un échec de connexion s'arrête ici : pas de seconde tentative
  try {
    return await chargerBrut(s, url, accept);
  } catch (e) {
    if (e instanceof ErreurSource && e.etape === "authentification") {
      return chargerBrut(await avecSession(src, true), url, accept); // session expirée : une reconnexion
    }
    throw e;
  }
}

// Écarte les liens vers d'autres hôtes et les doublons
function retenir(src: Source, liste: Journal[]): Journal[] {
  const vus = new Set<string>();
  const out: Journal[] = [];
  for (const j of liste) {
    if (!urlAutorisee(src, j.url) || vus.has(j.id)) continue;
    vus.add(j.id);
    out.push({ ...j, sourceId: src.id });
  }
  return out;
}

const decoder = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .trim();

// Un lien « Voir » ou « Lire » n'est pas un titre : on le tire alors de l'adresse
const GENERIQUE = /^(voir|lire|ouvrir|consulter|télécharger|telecharger|détails?|details?|lire la suite|en savoir plus|cliquez ici|ici|plus)$/i;
function titrePour(texte: string, lien: string): string {
  if (texte.length >= 4 && !GENERIQUE.test(texte)) return texte;
  let fin = lien;
  try {
    fin = decodeURIComponent(new URL(lien).pathname.split("/").filter(Boolean).pop() ?? lien);
  } catch {
    /* adresse non décodable : on garde le lien */
  }
  const t = fin.replace(/[-_]+/g, " ").replace(/\.[a-z0-9]{2,4}$/i, "").trim() || lien;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ---------- Dossier ----------
const IGNORES = /^(~\$|\.)/;
const STABLE_MS = 10_000;

async function detecterDossier(src: Source): Promise<Journal[]> {
  const dossier = src.dossier ?? "";
  if (src.id === "depot") await fs.mkdir(dossier, { recursive: true });
  let noms: string[];
  try {
    noms = await fs.readdir(dossier);
  } catch {
    throw new ErreurSource("connexion", `Dossier introuvable : ${dossier}`);
  }
  const journaux: Journal[] = [];
  for (const n of noms) {
    if (IGNORES.test(n) || !/\.(pdf|html?|txt)$/i.test(n)) continue;
    const chemin = path.join(dossier, n);
    const st = await fs.stat(chemin);
    if (!st.isFile() || Date.now() - st.mtimeMs < STABLE_MS) continue;
    journaux.push({ id: n, titre: path.parse(n).name, url: chemin, sourceId: src.id });
  }
  return journaux;
}

// ---------- API JSON ----------
async function detecterJson(src: Source): Promise<Journal[]> {
  const base = src.url!;
  const corps = await chargerPage(src, base, "application/json");
  let data: any;
  try {
    data = JSON.parse(corps);
  } catch {
    throw new ErreurSource("lecture", "La réponse n'est pas du JSON valide.");
  }
  for (const cle of (src.listPath ?? "").split(".").filter(Boolean)) data = data?.[cle];
  if (!Array.isArray(data)) throw new ErreurSource("lecture", "Le chemin de la liste ne pointe pas vers une liste.");
  const tf = src.titleField || "title";
  const uf = src.urlField || "url";
  return retenir(
    src,
    data
      .filter((x) => x && typeof x === "object" && x[uf])
      .map((x: any) => {
        const lien = new URL(String(x[uf]), base).toString();
        return { id: lien, titre: String(x[tf] ?? titrePour("", lien)), url: lien };
      })
  );
}

// ---------- Flux RSS / Atom ----------
async function detecterRss(src: Source): Promise<Journal[]> {
  const base = src.url!;
  const corps = await chargerPage(src, base, "application/rss+xml, application/atom+xml, application/xml, text/xml");
  if (!/<rss|<feed/i.test(corps)) throw new ErreurSource("lecture", "Cette adresse ne renvoie pas un flux RSS ou Atom.");
  const out: Journal[] = [];
  for (const m of corps.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)) {
    const b = m[0];
    const brut =
      b.match(/<enclosure[^>]*url=["']([^"']+)["']/i)?.[1] ??
      b.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1] ??
      b.match(/<link[^>]*>([^<]+)<\/link>/i)?.[1];
    if (!brut) continue;
    const lien = new URL(decoder(brut), base).toString();
    out.push({ id: lien, titre: decoder(b.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "") || lien, url: lien });
  }
  return retenir(src, out);
}

// ---------- Page web listant des liens ----------
async function detecterPage(src: Source): Promise<Journal[]> {
  const base = src.url!;
  const corps = await chargerPage(src, base, "text/html");
  const regex = new RegExp(src.lienRegex || "\\.pdf($|[?#])", "i");
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
    out.push({ id: lien, titre: titrePour(texte, lien), url: lien });
  }
  return retenir(src, out);
}

export async function detecterSource(src: Source): Promise<Journal[]> {
  switch (src.type) {
    case "json": return detecterJson(src);
    case "rss": return detecterRss(src);
    case "page": return detecterPage(src);
    default: return detecterDossier(src);
  }
}

// Lit toutes les sources actives ; l'échec d'une source n'arrête pas les autres
export async function detecterTout(): Promise<Journal[]> {
  const sources = (await chargerSources()).filter((s) => s.actif);
  if (!sources.length) {
    console.warn(" ! aucune source active (page Sources de l'interface)");
    return [];
  }
  const tous: Journal[] = [];
  for (const s of sources) {
    try {
      const j = await detecterSource(s);
      console.log(` ⌕ ${s.nom} : ${j.length} journal(aux)`);
      tous.push(...j);
    } catch (e) {
      console.error(` ✗ Source « ${s.nom} » : ${(e as Error).message}`);
    }
  }
  return tous;
}

// ---------- Test de connexion, étape par étape (boîte de dialogue de l'interface) ----------
export type Etape = { libelle: string; statut: "ok" | "echec"; detail?: string };
export type ResultatSonde = { ok: boolean; etapes: Etape[]; nombre: number; exemples: string[]; message: string };

export async function sonderSource(src: Source): Promise<ResultatSonde> {
  const web = src.type !== "dossier";
  const noms = web
    ? ["Connexion au site", (src.auth || src.identifiant) ? "Authentification" : "Accès public", "Lecture de la liste des journaux"]
    : ["Accès au dossier", "Lecture des fichiers"];
  try {
    const journaux = await detecterSource(src);
    if (web && journaux.length === 0) {
      throw new ErreurSource("lecture", "Connexion réussie, mais aucun journal reconnu : vérifiez l'adresse ou le motif des liens.");
    }
    return {
      ok: true,
      etapes: noms.map((libelle) => ({ libelle, statut: "ok" as const })),
      nombre: journaux.length,
      exemples: journaux.slice(0, 3).map((j) => j.titre),
      message: journaux.length
        ? `${journaux.length} journal(aux) détecté(s).`
        : "Dossier accessible (aucun fichier pour le moment).",
    };
  } catch (e) {
    const err = e instanceof ErreurSource ? e : new ErreurSource("lecture", (e as Error).message);
    const rang = web
      ? { connexion: 0, authentification: 1, lecture: 2 }[err.etape]
      : { connexion: 0, authentification: 0, lecture: 1 }[err.etape];
    const etapes: Etape[] = [
      ...noms.slice(0, rang).map((libelle) => ({ libelle, statut: "ok" as const })),
      { libelle: noms[rang], statut: "echec" as const, detail: err.message },
    ];
    return { ok: false, etapes, nombre: 0, exemples: [], message: err.message };
  }
}
