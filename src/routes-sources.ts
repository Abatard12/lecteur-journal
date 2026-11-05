import type { Express } from "express";
import { promises as fs } from "fs";
import path from "path";
import { chargerEtat, sauverEtat } from "./state";
import { chargerSources, sauverSources, nouvelId, sourcePourJournal, hoteDe, Source, TypeSource } from "./registre";
import { sonderSource, detecterSource } from "./sources";
import { origineAutorisee } from "./auth";
import { prendreVerrou, libererVerrou } from "./passage";

const TYPES: TypeSource[] = ["dossier", "page", "json", "rss"];
const HOTE_PRIVE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?$)/i;
const MAX_SOURCES = 10;

type Validation = { source?: Source; erreur?: string };

// Valide ce qu'envoie le navigateur. Un champ « clé d'accès » vide garde la clé déjà enregistrée.
async function valider(b: any, existante?: Source): Promise<Validation> {
  const type = String(b.type ?? existante?.type ?? "") as TypeSource;
  if (!TYPES.includes(type)) return { erreur: "Type de source invalide" };
  const nom = String(b.nom ?? existante?.nom ?? "").trim();
  if (!/^[^\r\n<>]{1,60}$/.test(nom)) return { erreur: "Nom : 1 à 60 caractères" };

  const s: Source = {
    id: existante?.id ?? nouvelId(),
    nom,
    type,
    actif: existante?.actif ?? true,
    ajouteLe: existante?.ajouteLe ?? new Date().toISOString(),
  };

  if (type === "dossier") {
    const d = String(b.dossier ?? existante?.dossier ?? "").trim();
    if (!d || d.length > 260 || d.includes("\0")) return { erreur: "Dossier : chemin invalide" };
    const r = path.resolve(d);
    try {
      if (!(await fs.stat(r)).isDirectory()) return { erreur: "Ce chemin n'est pas un dossier" };
    } catch {
      return { erreur: "Ce dossier n'existe pas. Créez-le d'abord." };
    }
    s.dossier = r;
    return { source: s };
  }

  const url = String(b.url ?? existante?.url ?? "").trim();
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { erreur: "Adresse invalide (exemple : https://site.exemple.org/journaux)" };
  }
  if (!/^https?:$/.test(u.protocol) || url.length > 500) return { erreur: "L'adresse doit commencer par http:// ou https://" };
  if (HOTE_PRIVE.test(u.hostname) && process.env.AUTORISER_SOURCES_LOCALES !== "1") {
    return { erreur: "Les adresses locales ou privées ne sont pas autorisées" };
  }
  s.url = u.toString();

  const acces = String(b.acces ?? (existante?.identifiant ? "identifiants" : "cookie"));
  if (acces === "identifiants") {
    const champ = /^[^\x00-\x1F\x7F]{1,200}$/;
    const idf = String(b.identifiant ?? existante?.identifiant ?? "").trim();
    const saisi = String(b.motDePasse ?? "");
    const mdp = saisi !== "" ? saisi : existante?.motDePasse ?? "";
    if (!champ.test(idf)) return { erreur: "Identifiant : 1 à 200 caractères" };
    if (!champ.test(mdp)) return { erreur: "Mot de passe : 1 à 200 caractères" };
    s.identifiant = idf;
    s.motDePasse = mdp;
    const uc = String(b.urlConnexion ?? existante?.urlConnexion ?? "").trim();
    if (uc) {
      try {
        const x = new URL(uc, s.url);
        if (!/^https?:$/.test(x.protocol) || hoteDe(x.toString()) !== hoteDe(s.url)) return { erreur: "L'adresse de connexion doit être sur le même site que la source" };
        s.urlConnexion = x.toString();
      } catch {
        return { erreur: "Adresse de connexion invalide" };
      }
    }
  } else {
    const entete = String(b.authEntete ?? existante?.authEntete ?? "Cookie").trim();
    if (!/^[A-Za-z0-9-]{1,40}$/.test(entete)) return { erreur: "Nom d'en-tête invalide (lettres, chiffres, tirets)" };
    s.authEntete = entete;
    const saisie = String(b.auth ?? "");
    const auth = saisie !== "" ? saisie : existante?.auth ?? "";
    if (auth.length > 4000 || !/^[\x20-\x7E]*$/.test(auth)) return { erreur: "Clé d'accès : caractères ASCII uniquement, 4000 au maximum" };
    if (auth && b.effacerAuth !== true) s.auth = auth;
  }

  if (type === "page") {
    const re = String(b.lienRegex ?? existante?.lienRegex ?? "\\.pdf($|[?#])").trim();
    if (!re || re.length > 200) return { erreur: "Motif des liens : 1 à 200 caractères" };
    try {
      new RegExp(re, "i");
    } catch {
      return { erreur: "Motif des liens invalide (expression régulière incorrecte)" };
    }
    s.lienRegex = re;
  }
  if (type === "json") {
    const champ = /^[A-Za-z0-9_.-]{0,60}$/;
    const lp = String(b.listPath ?? existante?.listPath ?? "").trim();
    const tf = String(b.titleField ?? existante?.titleField ?? "title").trim();
    const uf = String(b.urlField ?? existante?.urlField ?? "url").trim();
    if (![lp, tf, uf].every((x) => champ.test(x)) || !tf || !uf) return { erreur: "Champs JSON invalides" };
    s.listPath = lp;
    s.titleField = tf;
    s.urlField = uf;
  }
  return { source: s };
}

// Ce que le navigateur a le droit de voir : jamais la clé d'accès
function visible(s: Source, journaux: number) {
  return {
    id: s.id, nom: s.nom, type: s.type, actif: s.actif,
    dossier: s.dossier ?? null, url: s.url ?? null,
    lienRegex: s.lienRegex ?? null, authEntete: s.authEntete ?? null,
    authDefinie: !!s.auth, connexionAuto: !!s.identifiant, identifiant: s.identifiant ?? null,
    chiffre: !!process.env.SOURCES_CLE, illisible: !!s.illisible, journaux,
  };
}

const corpsJson = (req: any) => origineAutorisee(req) && req.is("application/json");

export function installerRoutesSources(app: Express) {
  app.get("/api/sources", async (_req, res) => {
    const [sources, etat] = await Promise.all([chargerSources(), chargerEtat()]);
    const compte = new Map<string, number>();
    for (const j of etat) {
      const s = sourcePourJournal(sources, j);
      if (s) compte.set(s.id, (compte.get(s.id) ?? 0) + 1);
    }
    res.json(sources.map((s) => visible(s, compte.get(s.id) ?? 0)));
  });

  // Test d'une source pas encore enregistrée (ou d'une existante si "id" est fourni)
  app.post("/api/sources/tester", async (req, res) => {
    if (!corpsJson(req)) return void res.status(403).json({ erreur: "Requête refusée" });
    const existante = req.body?.id ? (await chargerSources()).find((x) => x.id === String(req.body.id)) : undefined;
    const v = await valider(req.body ?? {}, existante);
    if (!v.source) return void res.status(400).json({ erreur: v.erreur });
    const r = await sonderSource(v.source);
    res.json({ ...r, hote: v.source.url ? hoteDe(v.source.url) : v.source.dossier });
  });

  app.post("/api/sources/:id/tester", async (req, res) => {
    if (!origineAutorisee(req)) return void res.status(403).json({ erreur: "Requête refusée" });
    const s = (await chargerSources()).find((x) => x.id === String(req.params.id));
    if (!s) return void res.status(404).json({ erreur: "Source introuvable" });
    res.json({ ...(await sonderSource(s)), hote: s.url ? hoteDe(s.url) : s.dossier });
  });

  // Ajout : on se connecte vraiment avant d'enregistrer (rien n'est ajouté en cas d'échec)
  app.post("/api/sources", async (req, res) => {
    if (!corpsJson(req)) return void res.status(403).json({ erreur: "Requête refusée" });
    const sources = await chargerSources();
    if (sources.length >= MAX_SOURCES) return void res.status(400).json({ erreur: `Maximum ${MAX_SOURCES} sources` });
    const v = await valider(req.body ?? {});
    if (!v.source) return void res.status(400).json({ erreur: v.erreur });
    const source = v.source;

    const sonde = await sonderSource(source);
    if (!sonde.ok) return void res.status(422).json({ erreur: sonde.message, etapes: sonde.etapes });

    // Journaux déjà publiés : on ne garde à traiter que les N plus récents (0 par défaut)
    let ignores = 0;
    if (source.type !== "dossier") {
      const garder = Math.min(5, Math.max(0, Math.trunc(Number(req.body?.garder ?? 0)) || 0));
      if (!(await prendreVerrou())) {
        return void res.status(409).json({ erreur: "Le robot est en cours d'exécution : réessayez dans un instant." });
      }
      try {
        const existants = await detecterSource(source);
        const etat = await chargerEtat();
        const vus = new Set(etat.map((e) => e.id));
        for (const j of existants.slice(garder).filter((x) => !vus.has(x.id))) {
          etat.push({ ...j, detecteLe: new Date().toISOString(), statut: "ignore" });
          ignores++;
        }
        await sauverEtat(etat);
        await sauverSources([...sources, source]);
      } finally {
        await libererVerrou();
      }
    } else {
      await sauverSources([...sources, source]);
    }
    res.status(201).json({ ok: true, source: visible(source, 0), nombre: sonde.nombre, exemples: sonde.exemples, ignores });
  });

  app.patch("/api/sources/:id", async (req, res) => {
    if (!corpsJson(req)) return void res.status(403).json({ erreur: "Requête refusée" });
    const sources = await chargerSources();
    const s = sources.find((x) => x.id === String(req.params.id));
    if (!s) return void res.status(404).json({ erreur: "Source introuvable" });
    if (typeof req.body?.actif === "boolean") s.actif = req.body.actif;
    await sauverSources(sources);
    res.json({ ok: true });
  });

  app.delete("/api/sources/:id", async (req, res) => {
    if (!origineAutorisee(req)) return void res.status(403).json({ erreur: "Requête refusée" });
    const sources = await chargerSources();
    const reste = sources.filter((x) => x.id !== String(req.params.id));
    if (reste.length === sources.length) return void res.status(404).json({ erreur: "Source introuvable" });
    await sauverSources(reste);
    res.json({ ok: true });
  });
}
