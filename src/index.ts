import { promises as fs } from "fs";
import { config } from "./config";
import { detecter } from "./sources";
import { chargerEtat, sauverEtat } from "./state";
import { telecharger } from "./telechargement";
import { lire } from "./lecture";
import { chercherMotsCles } from "./motscles";
import { stockerAfgd } from "./stockage";
import { resumer } from "./resume";
import { enregistrerResume } from "./resumes";
import { envoyerJournal } from "./mail";
import { nettoyer } from "./nettoyage";
import { Enregistrement } from "./types";
import { prendreVerrou, libererVerrou, ecrirePassage, Passage } from "./passage";

async function main() {
  if (!(await prendreVerrou())) {
    console.log("Un autre passage est déjà en cours : arrêt.");
    return;
  }

  const passage: Passage = { debut: new Date().toISOString(), fin: null, ok: null, nouveaux: 0, envoyes: 0, erreurs: 0 };
  let etat: Enregistrement[] = [];
  let erreurs = 0;
  const erreurOrigine = console.error;
  console.error = (...a: unknown[]) => {
    if (String(a[0]).includes("✗")) erreurs++;
    erreurOrigine(...a);
  };

  try {
    await ecrirePassage(passage);
    for (const dir of Object.values(config.dirs)) await fs.mkdir(dir, { recursive: true });

    etat = await chargerEtat();
    const vus = new Set(etat.map((e) => e.id));

    // Étape 2 : détection
    const trouves = await detecter();
    const inedits = trouves.filter((j) => !vus.has(j.id));
    const nouveaux = inedits.slice(0, config.source.maxParPassage);
    passage.nouveaux = nouveaux.length;
    console.log(`${trouves.length} journal(aux) trouvé(s), ${inedits.length} nouveau(x).`);
    if (inedits.length > nouveaux.length) {
      console.log(` ! ${nouveaux.length} traité(s) maintenant, ${inedits.length - nouveaux.length} au prochain passage (limite SOURCE_MAX_PAR_PASSAGE).`);
    }
    for (const j of nouveaux) {
      etat.push({ ...j, detecteLe: new Date().toISOString(), statut: "detecte" });
    }
    await sauverEtat(etat);

    // Étape 3 : téléchargement + copie de dépôt (reprend aussi les échecs précédents)
    for (const e of etat.filter((x) => x.statut === "detecte")) {
      try {
        e.fichier = await telecharger(e);
        e.depotLe = new Date().toISOString();
        e.statut = "telecharge";
        console.log(` ↓ ${e.fichier}`);
      } catch (err) {
        console.error(` ✗ ${e.titre} : ${(err as Error).message}`);
      }
      await sauverEtat(etat);
    }

    // Étape 4 : lecture depuis le dossier de stockage
    for (const e of etat.filter((x) => x.statut === "telecharge")) {
      try {
        const texte = await lire(e.fichier!);
        e.nbCaracteres = texte.length;
        if (texte.length < 50) {
          e.statut = "illisible";
          console.warn(` ? ${e.fichier} : presque aucun texte (PDF scanné ?)`);
        } else {
          e.statut = "lu";
          console.log(` ✓ ${e.fichier} : ${texte.length} caractères`);
        }
      } catch (err) {
        console.error(` ✗ ${e.titre} : ${(err as Error).message}`);
      }
      await sauverEtat(etat);
    }

    // Étape 5 : détection des mots-clés du domaine
    for (const e of etat.filter((x) => x.statut === "lu")) {
      try {
        const trouves = chercherMotsCles(await lire(e.fichier!));
        e.motsCles = trouves;
        const liste = Object.entries(trouves).map(([m, n]) => `${m} (${n})`).join(", ");
        if (liste) {
          e.statut = "pertinent";
          console.log(` ★ ${e.fichier} : ${liste}`);
        } else {
          e.statut = "hors_domaine";
          console.log(` – ${e.fichier} : aucun mot-clé`);
        }
      } catch (err) {
        console.error(` ✗ ${e.titre} : ${(err as Error).message}`);
      }
      await sauverEtat(etat);
    }

    // Étape 6 : stockage des journaux du domaine dans journaux-afgd/
    for (const e of etat.filter((x) => x.statut === "pertinent")) {
      try {
        await stockerAfgd(e.fichier!);
        e.statut = "stocke";
        console.log(` ▣ ${e.fichier} → journaux-afgd/`);
      } catch (err) {
        console.error(` ✗ ${e.titre} : ${(err as Error).message}`);
      }
      await sauverEtat(etat);
    }

    // Étape 7 : résumé généré par l'IA (s'arrête si l'IA est indisponible)
    let iaIndisponible = false;
    for (const e of etat.filter((x) => x.statut === "stocke")) {
      if (iaIndisponible) {
        console.log(` … ${e.fichier} : reporté au prochain passage (IA indisponible)`);
        continue;
      }
      try {
        e.resume = await resumer(e.titre, await lire(e.fichier!));
        e.statut = "resume";
        console.log(` ✎ ${e.fichier}`);
      } catch (err) {
        const message = (err as Error).message;
        console.error(` ✗ ${e.titre} : ${message.slice(0, 200)}`);
        if (/\b(429|500|503)\b/.test(message)) iaIndisponible = true;
      }
      await sauverEtat(etat);
    }

    // Étape 8 : enregistrement du résumé dans resumes/
    for (const e of etat.filter((x) => x.statut === "resume")) {
      try {
        e.resumeFichier = await enregistrerResume(e);
        e.statut = "enregistre";
        console.log(` ▤ ${e.resumeFichier} → resumes/`);
      } catch (err) {
        console.error(` ✗ ${e.titre} : ${(err as Error).message}`);
      }
      await sauverEtat(etat);
    }

    // Étape 9 : envoi par mail (et copie du mail dans mails/)
    for (const e of etat.filter((x) => x.statut === "enregistre")) {
      try {
        const copie = await envoyerJournal(e);
        e.statut = "envoye";
        e.envoyeLe = new Date().toISOString();
        if (copie) e.mailFichier = copie;
        console.log(` ✉ ${e.fichier} → ${config.mail.destinataires.join(", ")}`);
      } catch (err) {
        console.error(` ✗ ${e.titre} : ${(err as Error).message}`);
      }
      await sauverEtat(etat);
    }

    // Étape 10 : avertissement puis suppression après la durée de conservation
    await nettoyer(etat);
  } catch (err) {
    passage.message = (err as Error).message;
    erreurs++;
    throw err;
  } finally {
    console.error = erreurOrigine;
    passage.fin = new Date().toISOString();
    passage.erreurs = erreurs;
    passage.ok = erreurs === 0;
    passage.envoyes = etat.filter((e) => e.envoyeLe && e.envoyeLe >= passage.debut).length;
    try {
      await ecrirePassage(passage);
    } finally {
      await libererVerrou();
    }
  }
}

main().catch((e) => {
  console.error("Erreur :", e.message);
  process.exit(1);
});
