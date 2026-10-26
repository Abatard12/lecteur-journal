import { chargerEtat, sauverEtat } from "./state";

const JOUR = 86_400_000;
const jours = Number(process.argv[2]);

async function main() {
  if (!Number.isFinite(jours) || jours <= 0) {
    console.log("Usage : npm run vieillir -- 28   (recule la date de dépôt de 28 jours)");
    return;
  }
  const etat = await chargerEtat();
  let n = 0;
  for (const e of etat) {
    if (e.depotLe && e.statut !== "supprime") {
      e.depotLe = new Date(new Date(e.depotLe).getTime() - jours * JOUR).toISOString();
      n++;
    }
  }
  await sauverEtat(etat);
  console.log(`${n} journal(aux) vieilli(s) de ${jours} jour(s).`);
}

main();