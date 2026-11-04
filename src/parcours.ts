import { Enregistrement } from "./types";

export const ETAPES = [
  { cle: "detection", nom: "Détection" },
  { cle: "telechargement", nom: "Téléchargement" },
  { cle: "lecture", nom: "Lecture" },
  { cle: "mots_cles", nom: "Mots-clés" },
  { cle: "stockage", nom: "Stockage AfGD" },
  { cle: "resume", nom: "Résumé IA" },
  { cle: "enregistrement", nom: "Enregistrement" },
  { cle: "envoi", nom: "Envoi mail" },
] as const;

export type EtatEtape = "fait" | "en_cours" | "attente" | "reporte" | "echec" | "non_concerne";
export type EtapeParcours = { cle: string; nom: string; etat: EtatEtape; detail?: string };

// Nombre d'étapes terminées selon le statut du journal
const RANG: Record<string, number> = { detecte: 1, telecharge: 2, lu: 3, pertinent: 4, stocke: 5, resume: 6, enregistre: 7, envoye: 8 };

export function parcoursDe(e: Enregistrement, robotEnCours: boolean): EtapeParcours[] {
  const etats: EtatEtape[] = ETAPES.map(() => "attente");
  const details: (string | undefined)[] = ETAPES.map(() => undefined);
  const marquer = (de: number, a: number, etat: EtatEtape, detail?: string) => {
    for (let i = de; i < a; i++) {
      etats[i] = etat;
      if (detail) details[i] = detail;
    }
  };
  const pertinent = !!e.motsCles && Object.keys(e.motsCles).length > 0;

  if (e.statut === "ignore") {
    etats[0] = "fait";
    marquer(1, 8, "non_concerne", "Journal déjà publié à l'ajout de la source : ignoré");
  } else if (e.statut === "supprime") {
    const faits = [true, !!e.fichier, e.nbCaracteres !== undefined, e.motsCles !== undefined, pertinent && !!e.fichier, !!e.resumeFichier, !!e.resumeFichier, !!e.envoyeLe];
    faits.forEach((f, i) => {
      etats[i] = f ? "fait" : "non_concerne";
    });
  } else if (e.statut === "hors_domaine") {
    marquer(0, 4, "fait");
    marquer(4, 8, "non_concerne", "Aucun mot-clé : journal hors domaine");
  } else if (e.statut === "illisible") {
    marquer(0, 2, "fait");
    etats[2] = "echec";
    details[2] = "Presque aucun texte (PDF scanné ?)";
    marquer(3, 8, "non_concerne");
  } else {
    const rang = RANG[e.statut] ?? 1;
    marquer(0, rang, "fait");
    if (rang < 8) {
      // L'étape suivante est : reportée ou en échec (incident noté par le robot), en cours (robot actif) ou en attente
      const i = rang;
      if (e.incident && e.incident.etape === ETAPES[i].cle) {
        etats[i] = e.incident.type === "reporte" ? "reporte" : "echec";
        details[i] = e.incident.message;
      } else {
        etats[i] = robotEnCours ? "en_cours" : "attente";
        details[i] = robotEnCours ? undefined : "En attente du prochain passage";
      }
      marquer(i + 1, 8, "attente");
    }
  }
  return ETAPES.map((s, i) => ({ cle: s.cle, nom: s.nom, etat: etats[i], detail: details[i] }));
}