import { config } from "./config";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

async function main() {
  if (config.ia.fournisseur !== "gemini") return void console.log("Ce test concerne Gemini (IA_FOURNISSEUR=gemini).");
  if (!config.ia.cle) return void console.log("GEMINI_API_KEY manquante dans .env");
  const entetes = { "x-goog-api-key": config.ia.cle };

  const liste = await fetch(`${BASE}/models?pageSize=200`, { headers: entetes, signal: AbortSignal.timeout(20_000) });
  if (!liste.ok) return void console.log("Liste des modèles impossible :", liste.status, (await liste.text()).slice(0, 200));
  const data: any = await liste.json();
  const noms: string[] = (data.models ?? [])
    .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((m: any) => String(m.name).replace(/^models\//, ""));
  const candidats = noms.filter((n) => /flash/i.test(n));

  console.log("Modèles « flash » disponibles pour votre clé :");
  candidats.forEach((n) => console.log("  -", n));

  const aTester = [
    ...new Set([config.ia.modele, ...(process.env.GEMINI_MODEL_SECOURS ? [process.env.GEMINI_MODEL_SECOURS] : []), ...candidats.slice(0, 4)]),
  ];
  console.log("\nTest de réponse (question très courte, 30 s maximum par modèle) :");
  for (const m of aTester) {
    const t = Date.now();
    try {
      const r = await fetch(`${BASE}/models/${m}:generateContent`, {
        method: "POST",
        headers: { ...entetes, "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: "Réponds uniquement : ok" }] }], generationConfig: { maxOutputTokens: 50 } }),
        signal: AbortSignal.timeout(30_000),
      });
      console.log(`  ${r.ok ? "✓" : "✗"} ${m} : code ${r.status} en ${((Date.now() - t) / 1000).toFixed(1)} s`);
    } catch (e) {
      const err = e as Error;
      console.log(`  ✗ ${m} : ${err.name === "TimeoutError" ? "pas de réponse en 30 s" : err.message}`);
    }
  }
}
main();