import { chargerSources } from "./registre";
import { sonderSource, entetes, urlAutorisee, extraireFormulaire, avecSession } from "./sources";
import { trouverPdf } from "./lecteurpdf";

// Diagnostic en ligne de commande :
//   npm run sonder                  → teste chaque source enregistrée
//   npm run sonder -- <adresse>     → analyse une page précise (ex. la page d'un journal)

const absolu = (h: string, base: string) => {
  try {
    return new URL(h, base).toString();
  } catch {
    return h;
  }
};

function analyserHtml(html: string, base: string) {
  if (/type=["']password["']/i.test(html)) console.log("→ La page ressemble à un formulaire de connexion : cookie absent ou expiré.");
  const f = extraireFormulaire(html, base);
  if (f) {
    console.log(`\nFormulaire de connexion détecté : ${f.methode} ${f.action}`);
    console.log(`  champ identifiant : ${f.champIdentifiant} · champ mot de passe : ${f.champMotDePasse}`);
    console.log(`  champs cachés envoyés : ${Object.keys(f.champs).join(", ") || "aucun"}`);
  }
  const compte = (re: RegExp) => (html.match(re) ?? []).length;
  console.log(
    `\nContenu : ${compte(/<a\s/gi)} lien(s), ${compte(/<iframe/gi)} iframe, ${compte(/<embed/gi)} embed, ${compte(/<object/gi)} object, ${compte(/<img/gi)} image(s), ${compte(/<canvas/gi)} canvas, ${compte(/<script/gi)} script(s)`
  );
  const texte = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  console.log(`Texte lisible sur la page : ${texte.length} caractères`);

  const attr = (balise: string, nom: string) =>
    [...html.matchAll(new RegExp(`<${balise}\\s[^>]*${nom}=["']([^"']+)["']`, "gi"))].map((m) => absolu(m[1], base));
  const montrer = (titre: string, liste: string[], max = 8) => {
    const u = [...new Set(liste)];
    if (!u.length) return;
    console.log(`\n${titre} (${u.length}) :`);
    u.slice(0, max).forEach((x) => console.log("  -", x.slice(0, 160)));
    if (u.length > max) console.log(`  … et ${u.length - max} autre(s)`);
  };
  montrer("Iframes", attr("iframe", "src"));
  montrer("Embeds", attr("embed", "src"));
  montrer("Objects", attr("object", "data"));
  montrer("Images", attr("img", "src"), 6);
  montrer("Scripts de la page", attr("script", "src"), 10);
  montrer(
    "Fichiers .pdf / .epub / .zip / .json cités dans la page",
    [...html.matchAll(/["'(]([^"'()\s]+\.(?:pdf|epub|zip|json)(?:\?[^"'()\s]*)?)["')]/gi)].map((m) => absolu(m[1], base))
  );
  const indices = ["flipbook", "pageflip", "turn.js", "pdf.js", "pdfjs", "dflip", "real3d", "heyzine", "issuu", "calameo", "viewer"].filter((m) =>
    html.toLowerCase().includes(m)
  );
  if (indices.length) console.log(`\nIndices d'un lecteur de journal : ${indices.join(", ")}`);
  
  // Code propre à la page (hors bibliothèques) autour des appels PDF ou réseau ; les longues chaînes (jetons) sont masquées
  const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join("\n");
  const extraits: string[] = [];
      for (const m of inline.matchAll(/getDocument|pdfUrl|pdf_url|DEFAULT_URL|\.pdf|XMLHttpRequest|\$\.ajax|\$\.get\(|fetch\(|\broute\s*=|\b(?:var|let|const)\s+url\s*=/gi)) {
    const i = m.index ?? 0;
    const bout = inline.slice(Math.max(0, i - 120), i + 180).replace(/\s+/g, " ").replace(/[A-Za-z0-9+\/=_-]{32,}/g, "[…]");
    if (!extraits.some((x) => x.slice(40, 120) === bout.slice(40, 120))) extraits.push(bout);
    if (extraits.length >= 8) break;
  }
    const cache = /<(\w+)([^>]*\bid=["']hideData["'][^>]*)>([\s\S]*?)<\/\1>/i.exec(html);
  if (cache) {
    const masque = (t: string) => t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 80).replace(/[A-Za-z0-9+\/=_-]{16,}/g, "[…]");
    console.log(`\nÉlément caché « hideData » : <${cache[1]}${cache[2].replace(/\s+/g, " ").replace(/[A-Za-z0-9+\/=_-]{16,}/g, "[…]").slice(0, 120)}> contenu : ${masque(cache[3]) || "(vide)"}`);
  }
  if (extraits.length) {
    console.log("\nExtraits de code de la page autour des appels PDF ou réseau :");
    extraits.forEach((x) => console.log("  …" + x + "…"));
  }
}

async function main() {
  const sources = await chargerSources();
  const cible = process.argv[2];

  if (cible) {
    const src = sources.find((s) => urlAutorisee(s, cible));
    if (!src) return void console.log("Adresse refusée : aucune source enregistrée ne couvre cet hôte.");
    console.log(`Page analysée : ${cible}  (source « ${src.nom} »)`);
    const res = await fetch(cible, { headers: entetes(await avecSession(src), cible), signal: AbortSignal.timeout(30_000) }).catch((e) => {
      console.log("Connexion impossible :", e.message);
      return null;
    });
    if (!res) return;
    console.log(`Réponse : ${res.status} · type : ${res.headers.get("content-type")}`);
    if (res.url !== cible) console.log(`Redirigé vers : ${res.url}`);
            if (res.ok) {
      const html = await res.text();
      const base = res.url || cible;
      analyserHtml(html, base);
      const { pdf, tentatives } = await trouverPdf(await avecSession(src), html, base);
      console.log("\nRecherche du PDF (routes de lecture, puis liens cités), avec la session de la page :");
      if (!tentatives.length) console.log("  aucune route ni lien à essayer");
      tentatives.forEach((t) => console.log(`  ${t.ok ? "✓" : "✗"} [${t.type}] ${t.url.replace(/\?.*$/, "?[…]")}\n      → ${t.statut} · ${t.octets} octets`));
      console.log(pdf ? `\n→ PDF obtenu : ${pdf.length} octets.` : "\n→ Aucun PDF obtenu.");
    }
    return;
  }

  for (const s of sources) {
    console.log(`\n=== ${s.nom} (${s.type}, ${s.actif ? "active" : "désactivée"}) ===`);
    const r = await sonderSource(s);
    r.etapes.forEach((e) => console.log(`  ${e.statut === "ok" ? "✓" : "✗"} ${e.libelle}${e.detail ? " : " + e.detail : ""}`));
    if (r.ok) {
      console.log(`  ${r.message}`);
      r.exemples.forEach((t) => console.log(`   - ${t}`));
    }
  }
}
main();
