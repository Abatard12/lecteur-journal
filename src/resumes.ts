import { promises as fs } from "fs";
import path from "path";
import { config } from "./config";
import { Enregistrement } from "./types";
import { chargerEtat, sauverEtat } from "./state";
import { slug } from "./utils";

const JOUR = 86_400_000;

export function dateSuppression(e: Enregistrement): Date {
  const depart = new Date(e.depotLe ?? e.detecteLe).getTime();
  return new Date(depart + config.retentionDays * JOUR);
}

async function existe(chemin: string) {
  try {
    await fs.access(chemin);
    return true;
  } catch {
    return false;
  }
}

// Écrit le résumé dans resumes/
export async function enregistrerResume(e: Enregistrement): Promise<string> {
  const nom = `${path.parse(e.fichier!).name}.md`;
  const mots =
    Object.entries(e.motsCles ?? {})
      .map(([m, n]) => `${m} (${n})`)
      .join(", ") || "aucun";

  const contenu =
    `# ${e.titre}\n\n` +
    `> Journal : ${e.fichier}  \n` +
    `> Mots-clés : ${mots}  \n` +
    `> Suppression automatique prévue le ${dateSuppression(e).toLocaleDateString("fr-FR")}\n\n` +
    `${e.resume}\n`;

  await fs.writeFile(path.join(config.dirs.resumes, nom), contenu);
  return nom;
}

// Renomme un résumé et met à jour l'état
export async function renommerResume(ancien: string, nouveau: string): Promise<string> {
  const ancienNom = path.basename(ancien);
  const nom = slug(nouveau.replace(/\.md$/i, "")) + ".md";
  const src = path.join(config.dirs.resumes, ancienNom);
  const dst = path.join(config.dirs.resumes, nom);

  if (!(await existe(src))) throw new Error(`Résumé introuvable : ${ancienNom}`);
  if (src !== dst && (await existe(dst))) throw new Error(`Le nom « ${nom} » existe déjà`);

  await fs.rename(src, dst);

  const etat = await chargerEtat();
  for (const e of etat) if (e.resumeFichier === ancienNom) e.resumeFichier = nom;
  await sauverEtat(etat);
  return nom;
}