import { config as chargerEnv } from "dotenv";
chargerEnv({ override: true, quiet: true });
import { readFileSync } from "fs";
import path from "path";

const root = path.resolve(process.env.STORAGE_ROOT ?? "./storage");
export const FICHIER_REGLAGES = path.join(root, "reglages.json");

type ReglagesFichier = {
  motsCles?: string[];
  retentionDays?: number;
  avertissementJours?: number;
  destinataires?: string[];
  heures?: string[];
  dossierSource?: string;
  nomExpediteur?: string;
  fournisseurIA?: string;
  modeleIA?: string;
};

function lireReglagesFichier(): ReglagesFichier {
  try {
    return JSON.parse(readFileSync(FICHIER_REGLAGES, "utf8"));
  } catch {
    return {};
  }
}

const liste = (s?: string) => (s ?? "").split(",").map((m) => m.trim()).filter(Boolean);

export type ReglagesIA = { fournisseur: string; cle: string; modele: string };

// Les clés d'API restent dans .env : seuls le fournisseur et le modèle sont réglables
export function calculerIA(fournisseur: string, modele?: string): ReglagesIA {
  const f = fournisseur.toLowerCase() === "anthropic" ? "anthropic" : "gemini";
  return {
    fournisseur: f,
    cle: f === "anthropic" ? process.env.ANTHROPIC_API_KEY ?? "" : process.env.GEMINI_API_KEY ?? "",
    modele:
      modele ||
      (f === "anthropic"
        ? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5"
        : process.env.GEMINI_MODEL ?? "gemini-3.8-flash"),
  };
}

const f = lireReglagesFichier();

export const config = {
  root,
  dirs: {
    telechargements: path.join(root, "telechargements"),
    depot: path.join(root, "depot"),
    afgd: path.join(root, "journaux-afgd"),
    resumes: path.join(root, "resumes"),
    mails: path.join(root, "mails"),
  },
  retentionDays: f.retentionDays ?? Number(process.env.RETENTION_DAYS ?? 30),
  avertissementJours: f.avertissementJours ?? Number(process.env.WARN_DAYS_BEFORE ?? 3),
  motsCles: f.motsCles?.length
    ? f.motsCles
    : liste(process.env.MOTS_CLES ?? "AfGD,durabilité,cybersécurité"),
  heures: f.heures?.length ? f.heures : liste(process.env.HEURES_PASSAGE ?? "07:00,17:00"),
  ia: calculerIA(f.fournisseurIA ?? process.env.IA_FOURNISSEUR ?? "gemini", f.modeleIA),
  mail: {
    utilisateur: process.env.GMAIL_USER ?? "",
    motDePasse: (process.env.GMAIL_APP_PASSWORD ?? "").replace(/\s+/g, ""),
    nom: f.nomExpediteur ?? process.env.MAIL_NOM ?? "Veille journaux",
    destinataires: f.destinataires?.length ? f.destinataires : liste(process.env.MAIL_TO),
  },
  source: {
    mode: process.env.SOURCE_MODE ?? "dossier", // "dossier", "json", "rss" ou "page"
    dossier: path.resolve(f.dossierSource ?? process.env.DOSSIER_SOURCE ?? "./a-publier"),
    url: process.env.SOURCE_URL ?? "",
    listPath: process.env.JSON_LIST_PATH ?? "",
    titleField: process.env.JSON_TITLE_FIELD ?? "title",
    urlField: process.env.JSON_URL_FIELD ?? "url",
    // Source externe : accès protégé, sécurité et limites
    auth: process.env.SOURCE_AUTH ?? "", // ex. "Bearer abc123" (valeur complète de l'en-tête)
    authEntete: process.env.SOURCE_AUTH_HEADER ?? "Authorization",
    lienRegex: process.env.SOURCE_LIEN_REGEX ?? "\\.pdf($|[?#])", // mode "page" : liens retenus
    hotes: liste(process.env.SOURCE_HOTES_AUTORISES), // hôtes supplémentaires autorisés (fichiers hébergés ailleurs)
    maxParPassage: Number(process.env.SOURCE_MAX_PAR_PASSAGE ?? 10),
  },
};
