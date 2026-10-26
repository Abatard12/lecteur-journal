import { config } from "./config";
import { detecter, entetes, hotesAutorises, trouverListe } from "./sources";

// Diagnostic de la source : montre ce que le robot voit, sans rien télécharger ni modifier
function cheminsDeListes(x: any, chemin = "", prof = 0, out: string[] = []): string[] {
  if (prof > 3 || x === null || typeof x !== "object") return out;
  if (Array.isArray(x)) {
    if (x.length && typeof x[0] === "object") out.push(`${chemin || "(racine)"}  →  champs : ${Object.keys(x[0]).slice(0, 12).join(", ")}`);
    return out;
  }
  for (const [k, v] of Object.entries(x)) cheminsDeListes(v, chemin ? `${chemin}.${k}` : k, prof + 1, out);
  return out;
}

async function main() {
  const s = config.source;
  console.log(`Mode : ${s.mode}`);
  if (s.mode === "dossier") console.log(`Dossier : ${s.dossier}`);
  else {
    console.log(`Adresse : ${s.url || "(vide)"}`);
    console.log(`Hôtes autorisés : ${[...hotesAutorises()].join(", ") || "(aucun)"}`);
    console.log(`Clé d'accès : ${s.auth ? "définie (en-tête " + s.authEntete + ")" : "aucune"}`);
    if (s.url) {
      const res = await fetch(s.url, { headers: entetes(s.url), signal: AbortSignal.timeout(30_000) }).catch((e) => {
        console.log("Connexion impossible :", e.message);
        return null;
      });
      if (!res) return;
      console.log(`Réponse : ${res.status} ${res.statusText} · type : ${res.headers.get("content-type")}`);
      if (res.status === 401 || res.status === 403) console.log("→ Accès refusé : vérifiez SOURCE_AUTH et SOURCE_AUTH_HEADER.");
      if (s.mode === "page" && res.ok) {
        const html = await res.text();
        if (/type=["']password["']/i.test(html)) {
          console.log("→ La page ressemble à un formulaire de connexion : le cookie manque ou a expiré.");
        }
        const absolu = (h: string) => {
          try {
            return new URL(h, s.url).toString();
          } catch {
            return h;
          }
        };
        const liens = [...html.matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({
          url: absolu(m[1]).slice(0, 150),
          texte: m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 50),
        }));
        const pdfs = [...new Set([...html.matchAll(/["']([^"'\s]+\.pdf[^"'\s]*)["']/gi)].map((m) => absolu(m[1])))];
        const compte = (re: RegExp) => (html.match(re) ?? []).length;
        console.log(`\nContenu de la page : ${liens.length} lien(s), ${compte(/<iframe/gi)} iframe, ${compte(/<embed/gi)} embed, ${compte(/<img/gi)} image(s), ${compte(/<script/gi)} script(s)`);
        console.log(`Mentions de fichiers .pdf n'importe où dans la page : ${pdfs.length}`);
        pdfs.slice(0, 5).forEach((u) => console.log("  -", u));
        console.log("\nLiens de la page (30 premiers, sans doublon) :");
        const vus = new Set<string>();
        for (const l of liens) {
          if (vus.has(l.url) || vus.size >= 30) continue;
          vus.add(l.url);
          console.log(`  - ${l.texte || "(sans texte)"}\n      ${l.url}`);
        }
      }
      if (s.mode === "json" && res.ok) {
        const brut = await res.text();
        try {
          const data = JSON.parse(brut);
          const listes = cheminsDeListes(data);
          console.log("\nListes trouvées dans la réponse (valeur possible de JSON_LIST_PATH) :");
          listes.forEach((l) => console.log("  -", l));
          if (Array.isArray(data)) console.log("  (la réponse est elle-même une liste : laissez JSON_LIST_PATH vide)");
          console.log(`\nListe actuellement lue (JSON_LIST_PATH="${s.listPath}") : ${Array.isArray(trouverListe(data, s.listPath)) ? "OK" : "introuvable"}`);
        } catch {
          console.log("→ La réponse n'est pas du JSON valide.");
        }
      }
    }
  }
  console.log("\nDétection :");
  try {
    const trouves = await detecter();
    console.log(`${trouves.length} journal(aux) détecté(s).`);
    trouves.slice(0, 8).forEach((j) => console.log(`  - ${j.titre}\n      ${j.url}`));
    if (trouves.length > 8) console.log(`  … et ${trouves.length - 8} autre(s)`);
    if (trouves.length > s.maxParPassage) {
      console.log(`\n⚠ Plus de ${s.maxParPassage} journaux : lancez d'abord « npm run amorcer » pour ne pas tout traiter et envoyer d'un coup.`);
    }
  } catch (e) {
    console.log("Échec :", (e as Error).message);
  }
}
main();