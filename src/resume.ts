import { config } from "./config";
import { extraitPertinent, limiteur } from "./outils";

const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));
const limiteIA = limiteur(config.performance.concurrenceIA);

function consigne(titre: string, texte: string) {
  const extrait = extraitPertinent(texte, config.motsCles, config.performance.resumeMaxCaracteres);
  return (
    `Résume en français, en 8 lignes maximum, le journal ci-dessous pour un client. ` +
    `Mets en avant ce qui concerne ces thèmes : ${config.motsCles.join(", ")}. ` +
    `Réponds uniquement avec le résumé, sans introduction.\n\n` +
    `Titre : ${titre}\n\n${extrait}`
  );
}

async function appelGemini(modele: string, prompt: string, avecReflexion: boolean): Promise<Response> {
  const generationConfig: Record<string, unknown> = { maxOutputTokens: config.performance.maxTokens };
  if (avecReflexion && config.performance.reflexion !== null) {
    generationConfig.thinkingConfig = { thinkingBudget: config.performance.reflexion };
  }
  return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modele}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": config.ia.cle },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }),
    signal: AbortSignal.timeout(180_000),
  });
}

async function viaGemini(prompt: string): Promise<string> {
  const modeles = [config.ia.modele];
  if (process.env.GEMINI_MODEL_SECOURS) modeles.push(process.env.GEMINI_MODEL_SECOURS);
  let derniere = "";

  for (let m = 0; m < modeles.length; m++) {
    const modele = modeles[m];
    // Un modèle de secours existe : on y bascule tout de suite ; sinon on patiente davantage
    const pauses = m === modeles.length - 1 ? [3000, 8000] : [];
    let reflexion = true;

    for (let essai = 0; essai <= pauses.length; essai++) {
      let res: Response;
      try {
        res = await appelGemini(modele, prompt, reflexion);
            } catch (e) {
        derniere = `Gemini (${modele}) : ${(e as Error).message}`;
        break; // délai dépassé ou réseau coupé : on passe au modèle suivant sans insister
      }

      if (res.ok) {
        const data: any = await res.json();
        const texte = (data.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("").trim();
        if (!texte) throw new Error("Réponse vide de Gemini (contenu bloqué ?)");
        if (data.candidates?.[0]?.finishReason === "MAX_TOKENS") console.warn("   ⚠ résumé tronqué : augmentez RESUME_MAX_TOKENS");
        return texte;
      }

            const brut = await res.text();
      const corps = brut.slice(0, 300);
      derniere = `Gemini ${res.status} (${modele}) : ${corps}`;
      // Quota dépassé : on n'insiste pas (chaque essai consomme encore du quota)
      if (res.status === 429) {
        const delai = Number(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(brut)?.[1]);
        if (delai > 0 && delai <= 20 && essai < pauses.length) {
          console.log(`   … limite par minute atteinte, reprise dans ${Math.ceil(delai)} s`);
          await attendre(delai * 1000);
          continue;
        }
        if (m < modeles.length - 1) break; // un autre modèle a peut-être encore du quota
        throw new Error(`Quota Gemini dépassé (429) : réessayez plus tard ou changez de fournisseur. ${corps.slice(0, 120)}`);
      }
      // Le modèle refuse le réglage de réflexion : on réessaie aussitôt sans lui
      if (res.status === 400 && reflexion && config.performance.reflexion !== null) {
        reflexion = false;
        essai--;
        continue;
      }
      if (![429, 500, 503].includes(res.status)) throw new Error(derniere);
      if (essai < pauses.length) {
        console.log(`   … ${modele} indisponible (${res.status}), nouvel essai dans ${pauses[essai] / 1000} s`);
        await attendre(pauses[essai]);
      }
    }
  }
  throw new Error(derniere);
}

async function viaAnthropic(prompt: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": config.ia.cle, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: config.ia.modele, max_tokens: 1000, messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status} : ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  return (data.content ?? []).map((b: any) => (b.type === "text" ? b.text : "")).join("").trim();
}

export async function resumer(titre: string, texte: string): Promise<string> {
  if (!config.ia.cle) throw new Error(`Clé manquante dans .env pour le fournisseur « ${config.ia.fournisseur} »`);
  const prompt = consigne(titre, texte);
    return limiteIA(() => (config.ia.fournisseur === "anthropic" ? viaAnthropic(prompt) : viaGemini(prompt)));
}