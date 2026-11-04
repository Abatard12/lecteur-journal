import { promises as fs } from "fs";
import { config } from "./config";
import { detecterTout } from "./sources";
import { chargerEtat, sauverEtat } from "./state";
import { telecharger } from "./telechargement";
import { lire } from "./lecture";
import { chercherMotsCles } from "./motscles";
import { stockerAfgd } from "./stockage";
import { resumer } from "./resume";
import { enregistrerResume } from "./resumes";
import { envoyerJournal, fermerMail } from "./mail";
import { nettoyer } from "./nettoyage";
import { Enregistrement } from "./types";
import { prendreVerrou, libererVerrou, ecrirePassage, Passage } from "./passage";

const TERMINES = ["hors_domaine", "illisible", "envoye", "supprime", "ignore"];
const duree = (t0: number) => ((Date.now() - t0) / 1000).toFixed(1).replace(".", ",") + " s";

async function main() {
  if (!(await prendreVerrou())) {
    console.log("Un autre passage est déjà en cours : arrêt.");
    return;
  }

  const t0 = Date.now();
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

    // Détection
    const trouves = await detecterTout();
    const inedits = trouves.filter((j) => !vus.has(j.id));
    const nouveaux = inedits.slice(0, config.source.maxParPassage);
    passage.nouveaux = nouveaux.length;
    console.log(`${trouves.length} journal(aux) trouvé(s), ${inedits.length} nouveau(x).`);
    if (inedits.length > nouveaux.length) {
      console.log(` ! ${nouveaux.length} traité(s) maintenant, ${inedits.length - nouveaux.length} au prochain passage (limite SOURCE_MAX_PAR_PASSAGE).`);
    }
    for (const j of nouveaux) etat.push({ ...j, detecteLe: new Date().toISOString(), statut: "detecte" });
    await sauverEtat(etat);

    // Chaque journal suit tout son parcours d'une traite ; les journaux sont traités l'un après l'autre
    let iaIndisponible = false;
        const traiter = async (e: Enregistrement) => {
      const debut = Date.now();
      let etape = "telechargement"; // étape en cours : sert à dire où un incident survient
      delete e.incident;
      try {
        if (e.statut === "detecte") {
          etape = "telechargement";
          e.fichier = await telecharger(e);
          e.depotLe = new Date().toISOString();
          e.statut = "telecharge";
          console.log(` ↓ ${e.fichier}`);
          await sauverEtat(etat);
        }
        if (e.statut === "telecharge") {
          etape = "lecture";
          const texte = await lire(e.fichier!);
          e.nbCaracteres = texte.length;
          if (texte.length < 50) {
            e.statut = "illisible";
            console.warn(` ? ${e.fichier} : presque aucun texte (PDF scanné ?)`);
          } else {
            e.statut = "lu";
            console.log(` ✓ ${e.fichier} : ${texte.length} caractères`);
          }
          await sauverEtat(etat);
        }
        if (e.statut === "lu") {
          etape = "mots_cles";
          e.motsCles = chercherMotsCles(await lire(e.fichier!));
          const liste = Object.entries(e.motsCles).map(([m, n]) => `${m} (${n})`).join(", ");
          e.statut = liste ? "pertinent" : "hors_domaine";
          console.log(liste ? ` ★ ${e.fichier} : ${liste}` : ` – ${e.fichier} : aucun mot-clé`);
          await sauverEtat(etat);
        }
        if (e.statut === "pertinent") {
          etape = "stockage";
          await stockerAfgd(e.fichier!);
          e.statut = "stocke";
          console.log(` ▣ ${e.fichier} → journaux-afgd/`);
          await sauverEtat(etat);
        }
        if (e.statut === "stocke") {
          etape = "resume";
          if (iaIndisponible) {
            console.log(` … ${e.fichier} : reporté au prochain passage (IA indisponible)`);
            e.incident = { etape, type: "reporte", message: "IA indisponible : repris au prochain passage", le: new Date().toISOString() };
            await sauverEtat(etat);
            return;
          }
          const t = Date.now();
          try {
            e.resume = await resumer(e.titre, await lire(e.fichier!));
          } catch (err) {
            const message = (err as Error).message;
            if (/\b(429|500|503)\b/.test(message)) iaIndisponible = true;
            throw err;
          }
          e.statut = "resume";
          console.log(` ✎ ${e.fichier} (résumé en ${duree(t)})`);
          await sauverEtat(etat);
        }
        if (e.statut === "resume") {
          etape = "enregistrement";
          e.resumeFichier = await enregistrerResume(e);
          e.statut = "enregistre";
          console.log(` ▤ ${e.resumeFichier} → resumes/`);
          await sauverEtat(etat);
        }
        if (e.statut === "enregistre") {
          etape = "envoi";
          const copie = await envoyerJournal(e);
          e.statut = "envoye";
          e.envoyeLe = new Date().toISOString();
          if (copie) e.mailFichier = copie;
          console.log(` ✉ ${e.fichier} → ${config.mail.destinataires.join(", ")} (journal traité en ${duree(debut)})`);
          await sauverEtat(etat);
        }
      } catch (err) {
        const message = (err as Error).message.slice(0, 200);
        const reporte = /\b(429|500|503)\b|timeout|aborted/i.test(message);
        e.incident = { etape, type: reporte ? "reporte" : "echec", message, le: new Date().toISOString() };
        console.error(` ✗ ${e.fichier ?? e.titre} : ${message}`);
        await sauverEtat(etat);
      }
    };
    // File d'attente : d'abord les journaux nouveaux de ce passage (dans l'ordre de la source),
    // puis les anciens encore inachevés, du plus récemment détecté au plus ancien
    const rang = new Map(nouveaux.map((j, i) => [j.id, i] as const));
    const fileAttente = etat
      .filter((e) => !TERMINES.includes(e.statut))
      .sort((a, b) => {
        const ra = rang.get(a.id);
        const rb = rang.get(b.id);
        if (ra !== undefined && rb !== undefined) return ra - rb;
        if (ra !== undefined) return -1;
        if (rb !== undefined) return 1;
        return String(b.detecteLe ?? "").localeCompare(String(a.detecteLe ?? ""));
      });

    // Durée maximale du passage pour les anciens journaux (0 = illimité)
    const budget = Number(process.env.PASSAGE_MAX_MINUTES ?? 0) * 60_000;

    // Un journal à la fois : chacun est terminé (ou en échec) avant que le suivant commence
    for (const e of fileAttente) {
      if (!rang.has(e.id) && budget > 0 && Date.now() - t0 > budget) {
        console.log(` … ${e.fichier ?? e.titre} : reporté (durée maximale du passage atteinte)`);
        continue;
      }
      await traiter(e);
    }

    // Avertissement puis suppression après la durée de conservation
    await nettoyer(etat);
    console.log(`Passage terminé en ${duree(t0)}.`);
  } catch (err) {
    passage.message = (err as Error).message;
    erreurs++;
    throw err;
  } finally {
    console.error = erreurOrigine;
    fermerMail();
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