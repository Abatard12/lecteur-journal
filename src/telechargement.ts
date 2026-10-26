import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";
import { config } from "./config";
import { Journal } from "./types";
import { slug } from "./utils";
import { entetes, urlAutorisee } from "./sources";

const TAILLE_MAX = 50 * 1024 * 1024; // 50 Mo

function extension(url: string, contentType = ""): string {
  if (/pdf/i.test(contentType) || /\.pdf($|[?#])/i.test(url)) return ".pdf";
  if (/html/i.test(contentType) || /\.html?($|[?#])/i.test(url)) return ".html";
  return ".txt";
}

// Télécharge dans telechargements/ puis dépose une copie dans depot/
export async function telecharger(j: Journal): Promise<string> {
  let contenu: Buffer;
  let ext: string;

  if (/^https?:\/\//i.test(j.url)) {
    if (!urlAutorisee(j.url)) throw new Error("Hôte non autorisé : " + new URL(j.url).host);
    const res = await fetch(j.url, { headers: entetes(j.url), signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Téléchargement impossible (${res.status})`);
    const annonce = Number(res.headers.get("content-length") ?? 0);
    if (annonce > TAILLE_MAX) throw new Error("Fichier trop volumineux (> 50 Mo)");
    contenu = Buffer.from(await res.arrayBuffer());
    if (contenu.length > TAILLE_MAX) throw new Error("Fichier trop volumineux (> 50 Mo)");
    ext = extension(j.url, res.headers.get("content-type") ?? "");
  } else {
    contenu = await fs.readFile(j.url);
    ext = path.extname(j.url).toLowerCase() || ".txt";
  }

  const date = new Date().toISOString().slice(0, 10);
  const court = createHash("md5").update(j.id).digest("hex").slice(0, 6);
  const nom = `${date}_${slug(j.titre)}_${court}${ext}`;

  const principal = path.join(config.dirs.telechargements, nom);
  await fs.writeFile(principal, contenu);
  await fs.copyFile(principal, path.join(config.dirs.depot, nom));
  return nom;
}
