import { Source } from "./registre";
import { entetes, urlAutorisee } from "./sources";

const TAILLE_MAX = 50 * 1024 * 1024;
const RESSOURCES = /\.(js|css|png|jpe?g|gif|svg|ico|woff2?|ttf|map)(\?|$)/i;

const absolu = (u: string, base: string) => {
  try {
    return new URL(u, base).toString();
  } catch {
    return "";
  }
};
const estPdf = (b: Buffer) => b.length > 100 && b.length <= TAILLE_MAX && b.subarray(0, 5).toString("latin1") === "%PDF-";
const uniques = (l: string[]) => [...new Set(l)];

// Le texte reçu est-il un PDF encodé en base64 (éventuellement entre guillemets JSON) ?
export function decoderBase64(texte: string): Buffer | null {
  let t: unknown = texte.trim();
  if (typeof t === "string" && t.startsWith('"')) {
    try {
      t = JSON.parse(t);
    } catch {
      return null;
    }
  }
  if (typeof t !== "string") return null;
  const propre = t.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (propre.length < 200 || !/^[A-Za-z0-9+/=]+$/.test(propre)) return null;
  const b = Buffer.from(propre, "base64");
  return estPdf(b) ? b : null;
}

export type Tentative = { url: string; type: "route" | "lien"; statut: string; octets: number; ok: boolean };

// Valeurs possibles de l'identifiant qui remplace « :id » dans l'adresse de lecture
function valeursPourId(html: string, base: string, expression: string): string[] {
  const valeurs: string[] = [];
  const expr = expression.trim();

  // 1) la variable utilisée par la page : valeur littérale (ex. let url = "abc123")
  const litteral = /^(["'`])([^"'`]*)\1$/.exec(expr);
  if (litteral) valeurs.push(litteral[2]);
  else if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
    const re = new RegExp(`(?:var|let|const)\\s+${expr.replace(/\$/g, "\\$")}\\s*=\\s*(["'\`])([^"'\`]+)\\1`, "g");
    for (const m of html.matchAll(re)) valeurs.push(m[2]);
  }

  // 2) l'élément caché de la page (ex. <div id="hideData">…</div> ou <input id="hideData" value="…">)
  const cache = /<(\w+)([^>]*\bid=["']hideData["'][^>]*)>([\s\S]*?)<\/\1>/i.exec(html) ?? /<(\w+)([^>]*\bid=["']hideData["'][^>]*)\/?>()/i.exec(html);
  if (cache) {
    const attr = /\b(?:value|data-[\w-]+)=["']([^"']+)["']/i.exec(cache[2]);
    if (attr) valeurs.push(attr[1]);
    const texte = cache[3].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (texte) valeurs.push(texte);
  }

  // 3) le dernier morceau de l'adresse de la page (le « slug » du journal)
  const dernier = new URL(base).pathname.split("/").filter(Boolean).pop();
  if (dernier) valeurs.push(dernier);

  return uniques(valeurs.map((v) => v.trim()).filter((v) => v && v.length <= 500));
}

// Adresses de lecture : routes AJAX de la page (avec leur identifiant résolu), puis requêtes $.get/$.ajax directes
function routesDeLecture(html: string, base: string): string[] {
  const sortie: string[] = [];
  for (const m of html.matchAll(/\broute\s*=\s*(["'`])([^"'`\s]+)\1/g)) {
    const modele = m[2];
    const remplace = /route\s*=\s*route\.replace\(\s*(["'`])(:\w+)\1\s*,\s*([^)]+?)\s*\)/.exec(html);
    if (/:\w+/.test(modele.replace(/^https?:\/\//, "")) && remplace) {
      for (const v of valeursPourId(html, base, remplace[3])) sortie.push(absolu(modele.replace(remplace[2], v), base));
    } else if (!/\/:\w+/.test(modele)) {
      sortie.push(absolu(modele, base));
    }
  }
  for (const m of html.matchAll(/\$\.(?:get|ajax)\(\s*(["'`])([^"'`\s]+)\1/g)) sortie.push(absolu(m[2], base));
  return uniques(sortie);
}

// Un lecteur de journal charge souvent le PDF par une requête AJAX (route) qui renvoie du base64.
// On essaie d'abord ces routes, puis les fichiers .pdf cités dans la page, avec la même session.
export async function trouverPdf(source: Source, html: string, base: string): Promise<{ pdf: Buffer | null; tentatives: Tentative[] }> {
  const tentatives: Tentative[] = [];
  const routes = routesDeLecture(html, base)
    .filter((u) => u && !RESSOURCES.test(u) && urlAutorisee(source, u))
    .slice(0, 6);
  const liens = uniques([...html.matchAll(/["'(]([^"'()\s]+\.pdf(?:\?[^"'()\s]*)?)["')]/gi)].map((m) => absolu(m[1], base)))
    .filter((u) => u && urlAutorisee(source, u))
    .slice(0, 5);

  for (const [type, urls] of [["route", routes], ["lien", liens]] as const) {
    for (const u of urls) {
      const t: Tentative = { url: u, type, statut: "", octets: 0, ok: false };
      tentatives.push(t);
      try {
        const r = await fetch(u, {
          headers: { ...entetes(source, u), "X-Requested-With": "XMLHttpRequest", Referer: base },
          signal: AbortSignal.timeout(60_000),
        });
        t.statut = String(r.status);
        const buf = Buffer.from(await r.arrayBuffer());
        t.octets = buf.length;
        if (!r.ok || buf.length > 80 * 1024 * 1024) continue;
        const pdf = estPdf(buf) ? buf : decoderBase64(buf.toString("utf8"));
        if (pdf) {
          t.ok = true;
          return { pdf, tentatives };
        }
      } catch (e) {
        t.statut = (e as Error).message;
      }
    }
  }
  return { pdf: null, tentatives };
}