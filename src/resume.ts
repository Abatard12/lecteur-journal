import { config } from "./config";

function consigne(titre: string, texte: string) {
  return (
    `Résume en français, en 8 à 10 lignes, le journal ci-dessous pour un client. ` +
    `Mets en avant ce qui concerne ces thèmes : ${config.motsCles.join(", ")}. ` +
    `Réponds uniquement avec le résumé, sans introduction.\n\n` +
    `Titre : ${titre}\n\n${texte.slice(0, 60000)}`
  );
}

const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function appelGemini(modele: string, prompt: string): Promise<Response> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modele}:generateContent`;
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": config.ia.cle },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 8000 },
    }),
  });
}

async function viaGemini(prompt: string): Promise<string> {
  const modeles = [config.ia.modele];
  if (process.env.GEMINI_MODEL_SECOURS) modeles.push(process.env.GEMINI_MODEL_SECOURS);
  const pauses = [5000, 15000, 30000]; // attentes entre les essais

  let derniereErreur = "";
  for (const modele of modeles) {
    for (let essai = 0; essai <= pauses.length; essai++) {
      const res = await appelGemini(modele, prompt);

      if (res.ok) {
        const data: any = await res.json();
        const texte = (data.candidates?.[0]?.content?.parts ?? [])
          .map((p: any) => p.text ?? "")
          .join("")
          .trim();
                  if (data.candidates?.[0]?.finishReason === "MAX_TOKENS") {
          console.warn("   ⚠ résumé tronqué : limite de sortie atteinte");
        }
        if (!texte) throw new Error("Réponse vide de Gemini (contenu bloqué ?)");
        return texte;
      }

      const corps = (await res.text()).slice(0, 300);
      derniereErreur = `Gemini ${res.status} (${modele}) : ${corps}`;

      // Seules les erreurs temporaires (surcharge, limite) méritent un nouvel essai
      if (![429, 500, 503].includes(res.status)) throw new Error(derniereErreur);

      if (essai < pauses.length) {
        console.log(`   … ${modele} indisponible (${res.status}), nouvel essai dans ${pauses[essai] / 1000} s`);
        await attendre(pauses[essai]);
      }
    }
  }
  throw new Error(derniereErreur);
}

async function viaAnthropic(prompt: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.ia.cle,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.ia.modele,
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status} : ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  return (data.content ?? []).map((b: any) => (b.type === "text" ? b.text : "")).join("").trim();
}

export async function resumer(titre: string, texte: string): Promise<string> {
  if (!config.ia.cle) {
    throw new Error(`Clé manquante dans .env pour le fournisseur « ${config.ia.fournisseur} »`);
  }
  const prompt = consigne(titre, texte);
  return config.ia.fournisseur === "anthropic" ? viaAnthropic(prompt) : viaGemini(prompt);
}