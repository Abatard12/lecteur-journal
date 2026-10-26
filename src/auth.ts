import "./config"; // charge .env avant de lire le mot de passe
import { randomBytes, createHash, timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";

const MOT_DE_PASSE = process.env.INTERFACE_MOT_DE_PASSE ?? "";
export const authActive = MOT_DE_PASSE.length > 0;
if (authActive && MOT_DE_PASSE.length < 10) {
  throw new Error("INTERFACE_MOT_DE_PASSE doit contenir au moins 10 caractères");
}

const DUREE_SESSION = 8 * 3600 * 1000; // 8 heures
const FENETRE = 15 * 60 * 1000;        // 15 minutes
const MAX_ECHECS = 5;

const sessions = new Map<string, number>();
const echecs = new Map<string, { n: number; debut: number }>();

const empreinte = (s: string) => createHash("sha256").update(s).digest();
const motDePasseValide = (s: string) =>
  timingSafeEqual(empreinte(s), empreinte(MOT_DE_PASSE));

function lireCookie(req: Request, nom: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === nom) return v.join("=");
  }
  return null;
}

// Une requête venant d'une autre page web est refusée
export function origineAutorisee(req: Request) {
  const origine = req.headers.origin;
  if (!origine) return true;
  try {
    return new URL(origine).host === req.headers.host;
  } catch {
    return false;
  }
}

function sessionValide(req: Request) {
  const jeton = lireCookie(req, "sid");
  if (!jeton) return false;
  const expire = sessions.get(jeton);
  if (!expire || expire < Date.now()) {
    sessions.delete(jeton);
    return false;
  }
  return true;
}

function attributsCookie(req: Request, maxAge: number) {
  const https = req.secure || req.headers["x-forwarded-proto"] === "https";
  return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${https ? "; Secure" : ""}`;
}

export function connexion(req: Request, res: Response) {
  if (!authActive) {
    res.json({ ok: true });
    return;
  }
  if (!origineAutorisee(req) || !req.is("application/json")) {
    res.status(403).json({ erreur: "Requête refusée" });
    return;
  }
  const ip = req.ip ?? "inconnu";
  const maintenant = Date.now();
  const e = echecs.get(ip);
  if (e && maintenant - e.debut < FENETRE && e.n >= MAX_ECHECS) {
    res.status(429).json({ erreur: "Trop de tentatives. Réessayez dans quelques minutes." });
    return;
  }

  if (!motDePasseValide(String(req.body?.motDePasse ?? ""))) {
    if (!e || maintenant - e.debut >= FENETRE) echecs.set(ip, { n: 1, debut: maintenant });
    else e.n++;
    res.status(401).json({ erreur: "Mot de passe incorrect" });
    return;
  }

  echecs.delete(ip);
  const jeton = randomBytes(32).toString("hex");
  sessions.set(jeton, maintenant + DUREE_SESSION);
  res.setHeader("Set-Cookie", `sid=${jeton}; ${attributsCookie(req, DUREE_SESSION / 1000)}`);
  res.json({ ok: true });
}

export function deconnexion(req: Request, res: Response) {
  if (!origineAutorisee(req)) {
    res.status(403).json({ erreur: "Requête refusée" });
    return;
  }
  const jeton = lireCookie(req, "sid");
  if (jeton) sessions.delete(jeton);
  res.setHeader("Set-Cookie", `sid=; ${attributsCookie(req, 0)}`);
  res.json({ ok: true });
}

export function exigerConnexion(req: Request, res: Response, next: NextFunction) {
  if (!authActive || sessionValide(req)) {
    next();
    return;
  }
  if (req.path.startsWith("/api/")) {
    res.status(401).json({ erreur: "Connexion requise" });
    return;
  }
  res.redirect("/login.html");
}