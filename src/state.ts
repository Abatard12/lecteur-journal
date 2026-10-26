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

export async function sauverEtat(etat: Enregistrement[]) {
  await fs.writeFile(FICHIER, JSON.stringify(etat, null, 2));
}