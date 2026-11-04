import { promises as fs } from "fs";
import path from "path";
import { config } from "./config";

// Import direct du fichier interne : évite un bug connu du paquet pdf-parse
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdf = require("pdf-parse/lib/pdf-parse.js");

async function extraire(nom: string): Promise<string> {
  const chemin = path.join(config.dirs.telechargements, nom);
  const ext = path.extname(nom).toLowerCase();

  if (ext === ".pdf") {
    const data = await pdf(await fs.readFile(chemin));
    return String(data.text).replace(/\s+/g, " ").trim();
  }
  const brut = await fs.readFile(chemin, "utf8");
  if (ext === ".html" || ext === ".htm") {
    return brut
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return brut.replace(/\s+/g, " ").trim();
}

// Un journal n'est analysé qu'une fois par passage, même s'il est relu à plusieurs étapes
const cache = new Map<string, Promise<string>>();
export function lire(nom: string): Promise<string> {
  let p = cache.get(nom);
  if (!p) {
    p = extraire(nom);
    cache.set(nom, p);
    p.catch(() => cache.delete(nom));
  }
  return p;
}