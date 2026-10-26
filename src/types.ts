export type Journal = { id: string; titre: string; url: string };

export type Statut =
  | "detecte"
  | "telecharge"
  | "lu"
  | "illisible"
  | "pertinent"
  | "hors_domaine"
  | "stocke"
  | "resume"
  | "enregistre"
  | "envoye"
  | "supprime"
  | "ignore";

export type Enregistrement = Journal & {
  detecteLe: string;
  statut: Statut;
  fichier?: string;
  depotLe?: string;
  nbCaracteres?: number;
  motsCles?: Record<string, number>;
  resume?: string;
  resumeFichier?: string;
  mailFichier?: string;
  envoyeLe?: string;
  avertiLe?: string;
  supprimeLe?: string;
};
