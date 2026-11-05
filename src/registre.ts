import { promises as fs } from "fs";
import path from "path";
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from "crypto";
import { config } from "./config";

export type TypeSource = "dossier" | "page" | "json" | "rss";

export type Source = {
  id: string;
  nom: string;
  type: TypeSource;
  actif: boolean;
  ajouteLe?: string;
  dossier?: string; // type "dossier"
  url?: string; // types "page", "json", "rss"
  lienRegex?: string; // "page" : motif des liens de journaux
  listPath?: string; // "json"
  titleField?: string;
  urlField?: string;
  authEntete?: string; // ex. "Cookie" ou "Authorization"
  auth?: string; // secret : jamais renvoyé au navigateur
  hotes?: string[]; // hôtes supplémentaires autorisés
  identifiant?: string; // connexion automatique par formulaire
  motDePasse?: string; // secret : jamais renvoyé au navigateur
  urlConnexion?: string; // page du formulaire (par défaut /login)
  illisible?: boolean; // accès chiffrés impossibles à relire (SOURCES_CLE absente ou modifiée)
};

// ---------- Chiffrement des secrets au repos (actif si SOURCES_CLE est définie dans .env) ----------
const PREFIXE = "enc:v1:";
const cleChiffrement = (): Buffer | null => {
  const k = process.env.SOURCES_CLE ?? "";
  return k.length >= 16 ? scryptSync(k, "veille-journaux", 32) : null;
};
function chiffrer(t?: string): string | undefined {
  const k = cleChiffrement();
  if (!k || !t) return t;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const d = Buffer.concat([c.update(t, "utf8"), c.final()]);
  return PREFIXE + [iv, c.getAuthTag(), d].map((b) => b.toString("base64")).join(":");
}
function dechiffrer(t?: string): string | undefined {
  if (!t || !t.startsWith(PREFIXE)) return t;
  const k = cleChiffrement();
  if (!k) throw new Error("SOURCES_CLE manquante");
  const [iv, tag, d] = t.slice(PREFIXE.length).split(":").map((x) => Buffer.from(x, "base64"));
  const dc = createDecipheriv("aes-256-gcm", k, iv);
  dc.setAuthTag(tag);
  return Buffer.concat([dc.update(d), dc.final()]).toString("utf8");
}

const FICHIER = path.join(config.root, "sources.json");

export const hoteDe = (u: string): string => {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return "";
  }
};

// Tant qu'aucune source n'a été enregistrée depuis l'interface, on reprend le fichier .env
function parDefaut(): Source[] {
  const s = config.source;
  if (s.mode !== "page" && s.mode !== "json" && s.mode !== "rss") {
    return [{ id: "depot", nom: "Espace de dépôt", type: "dossier", actif: true, dossier: s.dossier }];
  }
  return [
    {
      id: "principale",
      nom: "Source principale",
      type: s.mode,
      actif: true,
      url: s.url,
      lienRegex: s.lienRegex,
      listPath: s.listPath,
      titleField: s.titleField,
      urlField: s.urlField,
      authEntete: s.authEntete,
      auth: s.auth || undefined,
      hotes: s.hotes,
    },
  ];
}

export async function chargerSources(): Promise<Source[]> {
  try {
    const liste = JSON.parse(await fs.readFile(FICHIER, "utf8"));
    if (Array.isArray(liste)) {
      return liste.map((s: Source) => {
        try {
          return { ...s, auth: dechiffrer(s.auth), motDePasse: dechiffrer(s.motDePasse) };
        } catch {
          return { ...s, auth: undefined, motDePasse: undefined, illisible: true };
        }
      });
    }
  } catch {
    /* pas encore de fichier : valeurs par défaut */
  }
  return parDefaut();
}

export async function sauverSources(liste: Source[]) {
  await fs.mkdir(config.root, { recursive: true });
  // Le fichier peut contenir un cookie de session : lisible par son propriétaire seulement (Linux/macOS)
  const aEcrire = liste.map((s) => ({ ...s, auth: chiffrer(s.auth), motDePasse: chiffrer(s.motDePasse), illisible: undefined }));
  await fs.writeFile(FICHIER, JSON.stringify(aEcrire, null, 2), { mode: 0o600 });
}

export const nouvelId = () => "s_" + randomBytes(4).toString("hex");

// Retrouve la source d'un journal (les anciens journaux n'ont pas de sourceId)
export function sourcePourJournal(sources: Source[], j: { sourceId?: string; url: string }): Source | undefined {
  if (j.sourceId) {
    const s = sources.find((x) => x.id === j.sourceId);
    if (s) return s;
  }
  if (/^https?:\/\//i.test(j.url)) {
    const h = hoteDe(j.url);
    return (
      sources.find((s) => s.url && hoteDe(s.url) === h) ??
      sources.find((s) => (s.hotes ?? []).some((x) => x.toLowerCase() === h))
    );
  }
  return sources.find((s) => s.type === "dossier");
}
