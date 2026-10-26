import { config } from "./config";

// Minuscules, sans accents, sans tirets : « Cyber-sécurité » devient « cybersecurite »
const normaliser = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[-‐‑–]/g, "");

export type MotsTrouves = Record<string, number>;

// Renvoie chaque mot-clé trouvé avec son nombre d'occurrences
export function chercherMotsCles(texte: string): MotsTrouves {
  const t = normaliser(texte);
  const trouves: MotsTrouves = {};

  for (const mot of config.motsCles) {
    const m = normaliser(mot);
    if (!m) continue;
    const motif = m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Début de mot obligatoire, terminaison libre
    const regex = new RegExp(`(?<![a-z0-9])${motif}`, "g");
    const n = (t.match(regex) ?? []).length;
    if (n > 0) trouves[mot] = n;
  }
  return trouves;
}