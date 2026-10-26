import { promises as fs } from "fs";
import { config } from "./config";
import { renommerResume } from "./resumes";

async function main() {
  const [ancien, ...reste] = process.argv.slice(2);
  const nouveau = reste.join(" ");

  if (!ancien || !nouveau) {
    await fs.mkdir(config.dirs.resumes, { recursive: true });
    const noms = (await fs.readdir(config.dirs.resumes)).filter((n) => n.endsWith(".md"));
    console.log("Résumés disponibles :");
    noms.forEach((n) => console.log(" -", n));
    console.log('\nUsage : npm run renommer -- ancien.md "nouveau nom"');
    return;
  }
  console.log("Renommé :", await renommerResume(ancien, nouveau));
}

main().catch((e) => {
  console.error("Erreur :", e.message);
  process.exit(1);
});