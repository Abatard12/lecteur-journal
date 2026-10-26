import { execFile } from "child_process";

const TACHE = "VeilleJournaux";
const HEURE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const heureValide = (h: string) => HEURE.test(h);

export type Planification = {
  disponible: boolean;
  existe: boolean;
  etat: string | null;
  prochain: string | null;
  heures: string[];
  erreur?: string;
};

// Les valeurs variables passent par l'environnement, jamais dans le texte du script
function powershell(script: string, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.platform !== "win32") {
      reject(new Error("Le Planificateur de tâches n'existe que sous Windows"));
      return;
    }
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 20000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error((String(stderr) || err.message).trim().slice(0, 300)));
        else resolve(String(stdout));
      }
    );
  });
}

export async function lirePlanification(): Promise<Planification> {
  const vide: Planification = { disponible: false, existe: false, etat: null, prochain: null, heures: [] };
  if (process.platform !== "win32") return vide;
  try {
    const sortie = await powershell(`
$t = Get-ScheduledTask -TaskName '${TACHE}' -ErrorAction SilentlyContinue
if (-not $t) { 'ABSENTE'; exit 0 }
$i = Get-ScheduledTaskInfo -TaskName '${TACHE}'
'ETAT=' + $t.State
if ($i.NextRunTime -and $i.NextRunTime.Year -gt 2000) { 'PROCHAIN=' + $i.NextRunTime.ToString('s') }
foreach ($tr in $t.Triggers) { if ($tr.StartBoundary) { 'HEURE=' + ([datetime]$tr.StartBoundary).ToString('HH:mm') } }
`);
    const lignes = sortie.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lignes.includes("ABSENTE")) return { ...vide, disponible: true };
    const val = (cle: string) => lignes.find((l) => l.startsWith(cle + "="))?.slice(cle.length + 1) ?? null;
    const prochainLocal = val("PROCHAIN");
    return {
      disponible: true,
      existe: true,
      etat: val("ETAT"),
      prochain: prochainLocal ? new Date(prochainLocal).toISOString() : null,
      heures: [...new Set(lignes.filter((l) => l.startsWith("HEURE=")).map((l) => l.slice(6)))].sort(),
    };
  } catch (e) {
    return { ...vide, erreur: (e as Error).message };
  }
}

// Modifie les heures de la tâche, ou la crée si elle n'existe pas encore
export async function appliquerHeures(heures: string[]): Promise<"MODIFIEE" | "CREEE"> {
  if (heures.length < 1 || heures.length > 6 || !heures.every(heureValide)) {
    throw new Error("Heures invalides");
  }
  const sortie = await powershell(
    `
$ErrorActionPreference = 'Stop'
$h = $env:VEILLE_HEURES.Split(',')
$triggers = @($h | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ })
$t = Get-ScheduledTask -TaskName '${TACHE}' -ErrorAction SilentlyContinue
if ($t) {
  Set-ScheduledTask -TaskName '${TACHE}' -Trigger $triggers | Out-Null
  'MODIFIEE'
} else {
  $dir = $env:VEILLE_DIR
  $a = New-ScheduledTaskAction -Execute (Join-Path $dir 'lancer.bat') -WorkingDirectory $dir
  $s = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries
  Register-ScheduledTask -TaskName '${TACHE}' -Action $a -Trigger $triggers -Settings $s | Out-Null
  'CREEE'
}
`,
    { VEILLE_HEURES: heures.join(","), VEILLE_DIR: process.cwd() }
  );
  return sortie.includes("CREEE") ? "CREEE" : "MODIFIEE";
}

// Prochaine occurrence calculée à partir des heures (si le Planificateur n'est pas lisible)
export function prochaineOccurrence(heures: string[]): Date | null {
  const maintenant = new Date();
  const candidats: Date[] = [];
  for (const h of heures.filter(heureValide)) {
    const [hh, mm] = h.split(":").map(Number);
    for (const decalage of [0, 1]) {
      const d = new Date(maintenant);
      d.setDate(d.getDate() + decalage);
      d.setHours(hh, mm, 0, 0);
      if (d.getTime() > maintenant.getTime()) candidats.push(d);
    }
  }
  candidats.sort((a, b) => a.getTime() - b.getTime());
  return candidats[0] ?? null;
}
