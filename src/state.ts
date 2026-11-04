import { promises as fs } from "fs";
import path from "path";
import { config } from "./config";
import { Enregistrement } from "./types";

const FICHIER = path.join(config.root, "state.json");

export async function chargerEtat(): Promise<Enregistrement[]> {
  try {
    return JSON.parse(await fs.readFile(FICHIER, "utf8"));
  } catch {
    return [];
  }
}

// Les écritures sont mises en file : des journaux traités en parallèle ne s'écrasent pas
let file: Promise<void> = Promise.resolve();
export function sauverEtat(etat: Enregistrement[]): Promise<void> {
  file = file
    .then(async () => {
      await fs.mkdir(config.root, { recursive: true });
      await fs.writeFile(FICHIER, JSON.stringify(etat, null, 2));
    })
    .catch((e) => console.error(" ✗ écriture de l'état impossible :", (e as Error).message));
  return file;
}