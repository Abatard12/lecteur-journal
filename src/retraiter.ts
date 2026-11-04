import { promises as fs } from "fs";
import path from "path";
import { config } from "./config";
import { chargerEtat, sauverEtat } from "./state";
import { prendreVerrou, libererVerrou } from "./passage";

// Remet des journaux « à traiter » depuis le début (fichiers et résumés supprimés)
async function main() {
  const mot = (process.argv[2] ?? "").toLowerCase();
  if (!mot) return void console.log("Usage : npm run retraiter -- <morceau du titre ou de l'adresse>");
  if (!(await prendreVerrou())) return void console.log("Le robot est en cours d'exécution : réessayez dans un instant.");
  try {
    const etat = await chargerEtat();
    let n = 0;
    for (const e of etat.filter((x) => `${x.titre} ${x.id}`.toLowerCase().includes(mot) && x.statut !== "supprime")) {
      for (const d of [config.dirs.telechargements, config.dirs.depot, config.dirs.afgd]) {
        if (e.fichier) await fs.rm(path.join(d, e.fichier), { force: true });
      }
      if (e.resumeFichier) await fs.rm(path.join(config.dirs.resumes, e.resumeFichier), { force: true });
      if (e.mailFichier) await fs.rm(path.join(config.dirs.mails, e.mailFichier), { force: true });
      for (const c of ["fichier", "depotLe", "nbCaracteres", "motsCles", "resume", "resumeFichier", "mailFichier", "envoyeLe", "avertiLe"] as const) delete e[c];
      e.statut = "detecte";
      n++;
    }
    await sauverEtat(etat);
    console.log(`${n} journal(aux) remis à traiter.`);
  } finally {
    await libererVerrou();
  }
}
main();