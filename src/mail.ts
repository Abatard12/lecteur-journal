import { promises as fs } from "fs";
import path from "path";
import nodemailer from "nodemailer";
import { config } from "./config";
import { Enregistrement } from "./types";
import { dateSuppression } from "./resumes";

const MAX_PIECE_JOINTE = 20 * 1024 * 1024; // Gmail limite l'ensemble à 25 Mo

export type CopieMail = {
  envoyeLe: string;
  de: string;
  a: string[];
  sujet: string;
  texte: string;
  pieces: string[];
};

function transport() {
  const { utilisateur, motDePasse, destinataires } = config.mail;
  if (!utilisateur || !motDePasse) throw new Error("GMAIL_USER ou GMAIL_APP_PASSWORD manquant dans .env");
  if (destinataires.length === 0) throw new Error("Aucun destinataire (réglages ou MAIL_TO)");
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: utilisateur, pass: motDePasse },
  });
}

const expediteur = () => `${config.mail.nom} <${config.mail.utilisateur}>`;

// Envoie le résumé (dans le corps) + l'article et le résumé en pièces jointes.
// Garde une copie du mail dans storage/mails/ et renvoie le nom de cette copie.
export async function envoyerJournal(e: Enregistrement): Promise<string> {
  const articlePath = path.join(config.dirs.telechargements, e.fichier!);
  const resumePath = path.join(config.dirs.resumes, e.resumeFichier!);

  const pieces: { filename: string; path: string }[] = [{ filename: e.resumeFichier!, path: resumePath }];
  let note = "";
  const taille = (await fs.stat(articlePath)).size;
  if (taille <= MAX_PIECE_JOINTE) pieces.unshift({ filename: e.fichier!, path: articlePath });
  else note = "\n(L'article est trop volumineux pour être joint.)\n";

  const mots = Object.keys(e.motsCles ?? {}).join(", ");
  const sujet = `Veille AfGD : ${e.titre}`;
  const texte =
    `Résumé du journal « ${e.titre} »\n` +
    (mots ? `Thèmes détectés : ${mots}\n` : "") +
    `\n${e.resume}\n\n---\n` +
    `L'article et le résumé sont joints à ce message.${note}\n` +
    `Ils seront supprimés le ${dateSuppression(e).toLocaleDateString("fr-FR")}.`;

  await transport().sendMail({
    from: expediteur(),
    to: config.mail.destinataires,
    subject: sujet,
    text: texte,
    attachments: pieces,
  });

  // Le mail est parti : un échec de la copie ne doit jamais provoquer un second envoi
  const nom = `${path.parse(e.fichier!).name}.json`;
  try {
    const copie: CopieMail = {
      envoyeLe: new Date().toISOString(),
      de: expediteur(),
      a: [...config.mail.destinataires],
      sujet,
      texte,
      pieces: pieces.map((p) => p.filename),
    };
    await fs.mkdir(config.dirs.mails, { recursive: true });
    await fs.writeFile(path.join(config.dirs.mails, nom), JSON.stringify(copie, null, 2));
    return nom;
  } catch (err) {
    console.warn(`   ⚠ copie du mail non enregistrée : ${(err as Error).message}`);
    return "";
  }
}

// Avertit qu'un journal et son résumé vont être supprimés
export async function envoyerAvertissement(e: Enregistrement) {
  await transport().sendMail({
    from: expediteur(),
    to: config.mail.destinataires,
    subject: `Suppression prochaine : ${e.titre}`,
    text:
      `Le journal « ${e.titre} » et son résumé seront supprimés de tous les dossiers ` +
      `le ${dateSuppression(e).toLocaleDateString("fr-FR")}.\n\n` +
      `Si vous souhaitez les conserver, enregistrez-les ailleurs avant cette date.`,
  });
}

// Test de la connexion et envoi d'un message d'essai
export async function testerMail() {
  const t = transport();
  await t.verify();
  await t.sendMail({
    from: expediteur(),
    to: config.mail.destinataires,
    subject: "Test veille journaux",
    text: "Si vous lisez ce message, l'envoi par Gmail fonctionne.",
  });
}
