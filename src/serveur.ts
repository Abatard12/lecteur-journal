import express from "express";
import { promises as fs } from "fs";
import path from "path";
import { spawn } from "child_process";
import { config, FICHIER_REGLAGES, calculerIA } from "./config";
import { chargerEtat } from "./state";
import { dateSuppression, renommerResume } from "./resumes";
import { exigerConnexion, connexion, deconnexion, authActive, origineAutorisee } from "./auth";
import { lirePassage } from "./passage";
import { lirePlanification, appliquerHeures, prochaineOccurrence, heureValide } from "./planification";

const JOUR = 86_400_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const app = express();

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "10kb" }));

// Accessibles sans connexion
app.get("/login.html", (_req, res) => res.sendFile(path.resolve("public", "login.html")));
app.post("/api/connexion", connexion);
app.post("/api/deconnexion", deconnexion);

// Tout le reste exige une connexion
app.use(exigerConnexion);
app.use(express.static(path.resolve("public")));

async function existe(chemin: string) {
  try {
    await fs.access(chemin);
    return true;
  } catch {
    return false;
  }
}

// ---------- Tableau de bord et liste ----------
app.get("/api/etat", async (_req, res) => {
  const etat = await chargerEtat();
  const maintenant = Date.now();
  const compte = (f: (e: (typeof etat)[number]) => boolean) => etat.filter(f).length;
  const aVenir = etat.filter((e) => {
    if (e.statut === "supprime" || !e.fichier) return false;
    return dateSuppression(e).getTime() - maintenant <= config.avertissementJours * JOUR;
  }).length;
  const pertinent = (e: (typeof etat)[number]) => !!e.motsCles && Object.keys(e.motsCles).length > 0;

  res.json({
    misAJour: new Date().toISOString(),
    kpi: {
      detectes: etat.length,
      pertinents: compte(pertinent),
      envoyes: compte((e) => !!e.envoyeLe),
      suppressionsAVenir: aVenir,
    },
    parcours: [
      { etape: "Détection", nombre: etat.length },
      { etape: "Téléchargement", nombre: compte((e) => !!e.fichier) },
      { etape: "Lecture", nombre: compte((e) => !!e.nbCaracteres) },
      { etape: "Mots-clés", nombre: compte((e) => !!e.motsCles) },
      { etape: "Stockage AfGD", nombre: compte(pertinent) },
      { etape: "Résumé IA", nombre: compte((e) => !!e.resume || !!e.resumeFichier) },
      { etape: "Enregistrement", nombre: compte((e) => !!e.resumeFichier) },
      { etape: "Envoi mail", nombre: compte((e) => !!e.envoyeLe) },
    ],
    journaux: [...etat]
      .sort((a, b) => b.detecteLe.localeCompare(a.detecteLe))
      .map((e) => ({
        id: e.id,
        titre: e.titre,
        statut: e.statut,
        motsCles: e.motsCles ?? {},
        detecteLe: e.detecteLe,
        suppressionLe: e.statut === "supprime" ? null : e.fichier ? dateSuppression(e).toISOString() : null,
      })),
  });
});

// ---------- Détail d'un journal ----------
app.get("/api/journal", async (req, res) => {
  const e = (await chargerEtat()).find((x) => x.id === String(req.query.id ?? ""));
  if (!e) {
    res.status(404).json({ erreur: "Journal introuvable" });
    return;
  }
  const f = e.fichier;
  const r = e.resumeFichier;
  const m = e.mailFichier;
  res.json({
    id: e.id,
    titre: e.titre,
    statut: e.statut,
    fichier: f ?? null,
    resumeFichier: r ?? null,
    resume: e.resume ?? null,
    motsCles: e.motsCles ?? {},
    nbCaracteres: e.nbCaracteres ?? null,
    mailDispo: !!m && (await existe(path.join(config.dirs.mails, path.basename(m)))),
    emplacements: [
      { dossier: "telechargements", present: !!f && (await existe(path.join(config.dirs.telechargements, f))) },
      { dossier: "depot", present: !!f && (await existe(path.join(config.dirs.depot, f))) },
      { dossier: "journaux-afgd", present: !!f && (await existe(path.join(config.dirs.afgd, f))) },
      { dossier: "resumes", present: !!r && (await existe(path.join(config.dirs.resumes, r))) },
    ],
    historique: [
      { evenement: "Détecté", date: e.detecteLe },
      { evenement: "Déposé dans le dossier de dépôt", date: e.depotLe },
      { evenement: "Envoyé par mail", date: e.envoyeLe },
      { evenement: "Avertissement de suppression envoyé", date: e.avertiLe },
      { evenement: "Supprimé de tous les dossiers", date: e.supprimeLe },
    ].filter((h) => h.date),
    suppressionLe: e.statut !== "supprime" && f ? dateSuppression(e).toISOString() : null,
  });
});

// ---------- Copie du mail envoyé ----------
app.get("/api/mail", async (req, res) => {
  const e = (await chargerEtat()).find((x) => x.id === String(req.query.id ?? ""));
  if (!e?.mailFichier) {
    res.status(404).json({ erreur: "Aucune copie de mail pour ce journal" });
    return;
  }
  try {
    const brut = await fs.readFile(path.join(config.dirs.mails, path.basename(e.mailFichier)), "utf8");
    res.json(JSON.parse(brut));
  } catch {
    res.status(404).json({ erreur: "Copie du mail introuvable" });
  }
});

// ---------- Téléchargements (les chemins viennent de l'état, jamais de la requête) ----------
app.get("/api/telecharger", async (req, res) => {
  const type = String(req.query.type ?? "");
  const e = (await chargerEtat()).find((x) => x.id === String(req.query.id ?? ""));
  if (!e || (type !== "article" && type !== "resume")) {
    res.status(404).send("Introuvable");
    return;
  }
  let candidats: string[] = [];
  if (type === "article" && e.fichier) {
    candidats = [config.dirs.telechargements, config.dirs.afgd, config.dirs.depot].map((d) => path.join(d, e.fichier!));
  } else if (type === "resume" && e.resumeFichier) {
    candidats = [path.join(config.dirs.resumes, e.resumeFichier)];
  }
  for (const chemin of candidats) {
    if (await existe(chemin)) {
      res.download(chemin, path.basename(chemin));
      return;
    }
  }
  res.status(404).send("Fichier introuvable (peut-être déjà supprimé).");
});

// ---------- Renommer un résumé ----------
app.post("/api/renommer", async (req, res) => {
  if (!origineAutorisee(req) || !req.is("application/json")) {
    res.status(403).json({ erreur: "Requête refusée" });
    return;
  }
  const nouveau = String(req.body?.nom ?? "").trim();
  if (!nouveau || nouveau.length > 100) {
    res.status(400).json({ erreur: "Nom invalide (1 à 100 caractères)" });
    return;
  }
  const e = (await chargerEtat()).find((x) => x.id === String(req.body?.id ?? ""));
  if (!e || !e.resumeFichier) {
    res.status(404).json({ erreur: "Aucun résumé à renommer pour ce journal" });
    return;
  }
  try {
    res.json({ resumeFichier: await renommerResume(e.resumeFichier, nouveau) });
  } catch (err) {
    res.status(400).json({ erreur: (err as Error).message });
  }
});

// ---------- Réglages ----------
app.get("/api/reglages", async (_req, res) => {
  const plan = await lirePlanification();
  res.json({
    motsCles: config.motsCles,
    retentionDays: config.retentionDays,
    avertissementJours: config.avertissementJours,
    destinataires: config.mail.destinataires,
    heures: plan.heures.length ? plan.heures : config.heures,
    dossierSource: config.source.mode === "dossier" ? config.source.dossier : "",
    modeSource: config.source.mode,
    urlSource: config.source.url,
    nomExpediteur: config.mail.nom,
    adresseExpediteur: config.mail.utilisateur,
    fournisseurIA: config.ia.fournisseur,
    modeleIA: config.ia.modele,
    cleIAPresente: config.ia.cle.length > 0,
    planification: { disponible: plan.disponible, existe: plan.existe, etat: plan.etat, erreur: plan.erreur ?? null },
  });
});

app.post("/api/reglages", async (req, res) => {
  if (!origineAutorisee(req) || !req.is("application/json")) {
    res.status(403).json({ erreur: "Requête refusée" });
    return;
  }
  const b = req.body ?? {};
  const liste = (v: unknown) =>
    Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim()).filter(Boolean))] : [];

  const motsCles = liste(b.motsCles);
  const destinataires = liste(b.destinataires);
  const heures = liste(b.heures).sort();
  const retentionDays = Number(b.retentionDays);
  const avertissementJours = Number(b.avertissementJours);
  const fournisseurIA = String(b.fournisseurIA ?? "");
  const modeleIA = String(b.modeleIA ?? "").trim();
  const nomExpediteur = String(b.nomExpediteur ?? "").trim();
  const dossierSource = String(b.dossierSource ?? "").trim();

  let erreur: string | null =
    motsCles.length < 1 || motsCles.length > 30 || motsCles.some((m) => m.length < 2 || m.length > 50)
      ? "Mots-clés : 1 à 30 mots de 2 à 50 caractères"
      : !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365
      ? "Conservation : un nombre entier de jours entre 1 et 365"
      : !Number.isInteger(avertissementJours) || avertissementJours < 0 || avertissementJours >= retentionDays
      ? "Avertissement : un entier entre 0 et la durée de conservation moins 1"
      : destinataires.length < 1 || destinataires.length > 10 || destinataires.some((d) => !EMAIL.test(d))
      ? "Destinataires : 1 à 10 adresses mail valides"
      : heures.length < 1 || heures.length > 6 || !heures.every(heureValide)
      ? "Heures de passage : 1 à 6 heures au format HH:MM"
      : fournisseurIA !== "gemini" && fournisseurIA !== "anthropic"
      ? "Fournisseur d'IA : gemini ou anthropic"
      : !/^[A-Za-z0-9._:\/-]{0,80}$/.test(modeleIA)
      ? "Modèle d'IA : caractères non autorisés"
      : !/^[^\r\n<>"]{1,60}$/.test(nomExpediteur)
      ? "Nom d'expéditeur : 1 à 60 caractères, sans < > \" ni retour à la ligne"
      : null;

  let dossierResolu = config.source.dossier;
  if (!erreur && config.source.mode === "dossier") {
    if (!dossierSource || dossierSource.length > 260 || dossierSource.includes("\0")) {
      erreur = "Dossier surveillé : chemin invalide";
    } else {
      dossierResolu = path.resolve(dossierSource);
      try {
        if (!(await fs.stat(dossierResolu)).isDirectory()) erreur = "Dossier surveillé : ce chemin n'est pas un dossier";
      } catch {
        erreur = "Dossier surveillé : ce dossier n'existe pas. Créez-le d'abord.";
      }
    }
  }
  if (erreur) {
    res.status(400).json({ erreur });
    return;
  }

  const avant = await lirePlanification();
  const reference = avant.heures.length ? avant.heures : config.heures;
  const heuresChangees = JSON.stringify(reference) !== JSON.stringify(heures);

  await fs.mkdir(config.root, { recursive: true });
  await fs.writeFile(
    FICHIER_REGLAGES,
    JSON.stringify(
      {
        motsCles,
        retentionDays,
        avertissementJours,
        destinataires,
        heures,
        nomExpediteur,
        fournisseurIA,
        modeleIA: modeleIA || undefined,
        dossierSource: config.source.mode === "dossier" ? dossierSource : undefined,
      },
      null,
      2
    )
  );

  // Applique tout de suite dans ce serveur (le robot relit le fichier à chaque lancement)
  config.motsCles = motsCles;
  config.retentionDays = retentionDays;
  config.avertissementJours = avertissementJours;
  config.mail.destinataires = destinataires;
  config.mail.nom = nomExpediteur;
  config.heures = heures;
  config.ia = calculerIA(fournisseurIA, modeleIA || undefined);
  if (config.source.mode === "dossier") config.source.dossier = dossierResolu;

  let planification = { appliquee: false, message: "" };
  if (heuresChangees) {
    try {
      const r = await appliquerHeures(heures);
      planification = {
        appliquee: true,
        message: r === "CREEE" ? "Tâche planifiée créée avec ces heures." : "Heures de passage mises à jour dans le Planificateur de tâches.",
      };
    } catch (err) {
      planification = {
        appliquee: false,
        message: "Heures enregistrées, mais le Planificateur de tâches n'a pas pu être modifié : " + (err as Error).message,
      };
    }
  }
  res.json({ ok: true, planification });
});

// ---------- État du robot, planification et lancement ----------
type Execution = { enCours: boolean; debut: string | null; fin: string | null; code: number | null; sortie: string };
let exec: Execution = { enCours: false, debut: null, fin: null, code: null, sortie: "" };

app.get("/api/robot", async (_req, res) => {
  const [passage, planification] = await Promise.all([lirePassage(), lirePlanification()]);
  const heures = planification.heures.length ? planification.heures : config.heures;
  const recent = !!passage && !passage.fin && Date.now() - new Date(passage.debut).getTime() < 15 * 60 * 1000;
  res.json({
    enCours: exec.enCours || recent,
    passage,
    planification,
    prochain: planification.prochain ?? prochaineOccurrence(heures)?.toISOString() ?? null,
  });
});

app.post("/api/lancer", (req, res) => {
  if (!origineAutorisee(req)) {
    res.status(403).json({ erreur: "Requête refusée" });
    return;
  }
  if (exec.enCours) {
    res.status(409).json({ erreur: "Le robot est déjà en cours d'exécution" });
    return;
  }
  exec = { enCours: true, debut: new Date().toISOString(), fin: null, code: null, sortie: "" };
  const terminer = (code: number) => {
    if (!exec.enCours) return;
    exec.enCours = false;
    exec.fin = new Date().toISOString();
    exec.code = code;
  };
  // Programme et arguments fixes : rien de ce qu'envoie le navigateur n'est exécuté
  const enfant = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: process.cwd(), windowsHide: true });
  const ajouter = (m: Buffer) => {
    exec.sortie = (exec.sortie + m.toString("utf8")).slice(-20000);
  };
  enfant.stdout.on("data", ajouter);
  enfant.stderr.on("data", ajouter);
  const minuteur = setTimeout(() => enfant.kill(), 10 * 60 * 1000);
  enfant.on("error", (e) => {
    clearTimeout(minuteur);
    exec.sortie += `\nImpossible de lancer le robot : ${e.message}`;
    terminer(-1);
  });
  enfant.on("close", (code) => {
    clearTimeout(minuteur);
    terminer(code ?? -1);
  });
  res.status(202).json({ ok: true });
});

app.get("/api/lancer", (_req, res) => {
  res.json(exec);
});

const PORT = Number(process.env.PORT_INTERFACE ?? 4000);
const HOTE = process.env.HOTE_INTERFACE ?? "127.0.0.1";

if (HOTE !== "127.0.0.1" && HOTE !== "localhost" && !authActive) {
  console.error("Refus de démarrer : ouvrir l'interface au réseau exige INTERFACE_MOT_DE_PASSE dans .env");
  process.exit(1);
}
if (!authActive) console.warn("⚠ Aucun mot de passe défini : interface accessible sans connexion (cet ordinateur seulement).");

app.listen(PORT, HOTE, () => {
  console.log(`Interface : http://localhost:${PORT}`);
});
