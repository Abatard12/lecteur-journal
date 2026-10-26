import { promises as fs } from "fs";
import { config } from "./config";
import { detecter } from "./sources";
import { chargerEtat, sauverEtat } from "./state";

// Marque tous les journaux DÉJÀ publiés comme « ignorés » : le robot ne traitera
// (et n'enverra par mail) que ceux qui apparaîtront après cette commande.
async function main() {
  await fs.mkdir(config.root, { recursive: true });
  const etat = await chargerEtat();
  const vus = new Set(etat.map((e) => e.id));
  const trouves = await detecter();
  let n = 0;
  for (const j of trouves.filter((x) => !vus.has(x.id))) {
    etat.push({ ...j, detecteLe: new Date().toISOString(), statut: "ignore" });
    n++;
  }
  await sauverEtat(etat);
  console.log(`${n} journal(aux) existant(s) marqué(s) comme ignoré(s). ${trouves.length - n} déjà connu(s).`);
}
main().catch((e) => {
  console.error("Erreur :", e.message);
  process.exit(1);
});
