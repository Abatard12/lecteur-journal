import { promises as fs } from "fs";
import path from "path";
import { config } from "./config";

const FICHIER = path.join(config.root, "passage.json");
const VERROU = path.join(config.root, "robot.lock");
const PEREMPTION = 15 * 60 * 1000; // un verrou de plus de 15 min est considéré comme abandonné

export type Passage = {
  debut: string;
  fin: string | null;
  ok: boolean | null;
  nouveaux: number;
  envoyes: number;
  erreurs: number;
  message?: string;
};

// Empêche deux passages simultanés (Planificateur + bouton de l'interface)
export async function prendreVerrou(): Promise<boolean> {
  await fs.mkdir(config.root, { recursive: true });
  try {
    const h = await fs.open(VERROU, "wx");
    await h.writeFile(JSON.stringify({ pid: process.pid, debut: new Date().toISOString() }));
    await h.close();
    return true;
  } catch {
    try {
      const st = await fs.stat(VERROU);
      if (Date.now() - st.mtimeMs > PEREMPTION) {
        await fs.rm(VERROU, { force: true });
        return prendreVerrou();
      }
    } catch {
      /* le verrou vient d'être libéré */
    }
    return false;
  }
}

export async function libererVerrou() {
  await fs.rm(VERROU, { force: true });
}

export async function lirePassage(): Promise<Passage | null> {
  try {
    return JSON.parse(await fs.readFile(FICHIER, "utf8"));
  } catch {
    return null;
  }
}

export async function ecrirePassage(p: Passage) {
  await fs.mkdir(config.root, { recursive: true });
  await fs.writeFile(FICHIER, JSON.stringify(p, null, 2));
}
