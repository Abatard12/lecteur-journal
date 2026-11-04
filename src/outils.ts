// Exécute `tache` sur chaque élément, avec au plus `limite` tâches en même temps
export async function pool<T>(items: T[], limite: number, tache: (x: T) => Promise<void>): Promise<void> {
  let suivant = 0;
  const travailleurs = Array.from({ length: Math.max(1, Math.min(limite, items.length)) }, async () => {
    while (suivant < items.length) {
      const x = items[suivant++];
      await tache(x);
    }
  });
  await Promise.all(travailleurs);
}

// Réduit un long texte : début du document + passages autour des mots-clés, répartis sur tout le texte
export function extraitPertinent(texte: string, mots: string[], max: number): string {
  if (texte.length <= max) return texte;
  const debut = Math.floor(max * 0.4);
  const bas = texte.toLowerCase();
  const fenetre = 400;

  // Occurrences de chaque mot-clé après le début du texte
  const parMot: [number, number][][] = [];
  for (const m of mots) {
    const motif = m.toLowerCase();
    if (motif.length < 2) continue;
    const liste: [number, number][] = [];
    let i = bas.indexOf(motif, debut);
    while (i !== -1 && liste.length < 1500) {
      liste.push([i, motif.length]);
      i = bas.indexOf(motif, i + motif.length);
    }
    if (liste.length) parMot.push(liste);
  }
  if (parMot.length === 0) return texte.slice(0, max);

  const k = Math.max(parMot.length, Math.floor((max - debut) / (2 * fenetre + 40)));
  // 1) un passage par mot-clé (le médian), 2) le reste réparti régulièrement sur tout le texte
  const choisis = new Map<number, [number, number]>();
  for (const liste of parMot) {
    const p = liste[Math.floor(liste.length / 2)];
    choisis.set(p[0], p);
  }
  const toutes = parMot.flat().sort((a, b) => a[0] - b[0]);
  const reste = k - choisis.size;
  for (let j = 0; j < reste && toutes.length > 0; j++) {
    const p = toutes[Math.floor((j * toutes.length) / reste)];
    choisis.set(p[0], p);
  }

  const zones: [number, number][] = [[0, debut]];
  for (const [i, n] of choisis.values()) zones.push([Math.max(debut, i - fenetre), Math.min(texte.length, i + n + fenetre)]);
  zones.sort((a, b) => a[0] - b[0]);

  const fusion: [number, number][] = [];
  for (const z of zones) {
    const dernier = fusion[fusion.length - 1];
    if (dernier && z[0] <= dernier[1]) dernier[1] = Math.max(dernier[1], z[1]);
    else fusion.push([z[0], z[1]]);
  }
  return fusion.map(([a, b]) => texte.slice(a, b)).join("\n[…]\n");
}

// Limite le nombre d'appels simultanés à une ressource (ex. l'IA)
export function limiteur(max: number) {
  let actifs = 0;
  const file: (() => void)[] = [];
  return async <T>(f: () => Promise<T>): Promise<T> => {
    if (actifs >= max) await new Promise<void>((r) => file.push(r));
    else actifs++;
    try {
      return await f();
    } finally {
      const suivant = file.shift();
      if (suivant) suivant();
      else actifs--;
    }
  };
}