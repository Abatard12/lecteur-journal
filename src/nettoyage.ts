import { promises as fs } from "fs";
import path from "path";
import { config } from "./config";
import { Enregistrement } from "./types";
import { dateSuppression } from "./resumes";
import { envoyerAvertissement } from "./mail";
import { sauverEtat } from "./state";

const JOUR = 86_400_000;

// Supprime le journal dans les 3 dossiers de stockage, son résumé et la copie du mail
async function supprimerFichiers(e: Enregistrement) {
  const cibles: string[] = [];
  if (e.fichier) {
    for (const d of [config.dirs.telechargements, config.dirs.depot, config.dirs.afgd]) {
      cibles.push(path.join(d, e.fichier));
    }
  }
  if (e.resumeFichier) cibles.push(path.join(config.dirs.resumes, e.resumeFichier));
  if (e.mailFichier) cibles.push(path.join(config.dirs.mails, e.mailFichier));
  for (const c of cibles) await fs.rm(c, { force: true });
}

export async function nettoyer(etat: Enregistrement[]) {
  const maintenant = Date.now();

  for (const e of etat) {
    if (e.statut === "supprime" || !e.fichier) continue;
    const reste = dateSuppression(e).getTime() - maintenant;

    if (reste <= 0) {
      await supprimerFichiers(e);
      e.statut = "supprime";
      e.supprimeLe = new Date().toISOString();
      delete e.resume; // on ne garde pas le contenu dans l'état
      console.log(` 🗑 ${e.fichier} supprimé de tous les dossiers`);
      await sauverEtat(etat);
    } else if (reste <= config.avertissementJours * JOUR && !e.avertiLe && e.resumeFichier) {
      try {
        await envoyerAvertissement(e);
        e.avertiLe = new Date().toISOString();
        console.log(` ⚠ avertissement envoyé : ${e.fichier} sera supprimé le ${dateSuppression(e).toLocaleDateString("fr-FR")}`);
      } catch (err) {
        console.error(` ✗ avertissement ${e.titre} : ${(err as Error).message}`);
      }
      await sauverEtat(etat);
    }
  }
}
