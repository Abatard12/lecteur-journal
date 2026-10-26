import { promises as fs } from "fs";
import path from "path";
import { config } from "./config";

// Copie un journal pertinent de telechargements/ vers journaux-afgd/
export async function stockerAfgd(nom: string): Promise<string> {
  const source = path.join(config.dirs.telechargements, nom);
  const cible = path.join(config.dirs.afgd, nom);
  await fs.copyFile(source, cible);
  return cible;
}