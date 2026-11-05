// Fonctions communes à toutes les pages + menu de navigation
const U = {
  esc: (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  date: (iso) => (iso ? new Date(iso).toLocaleDateString("fr-FR") : "—"),
  dateHeure: (iso) => (iso ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "—"),
  jourHeure: (iso) =>
    iso ? new Date(iso).toLocaleString("fr-FR", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—",
  statut(s) {
    const m = { envoye: ["Envoyé", ""], hors_domaine: ["Hors domaine", "g"], supprime: ["Supprimé", "g"], illisible: ["Illisible", "a"], ignore: ["Ignoré (déjà publié)", "g"] };
    const [t, c] = m[s] || ["En cours", "a"];
    return `<span class="chip ${c}">${t}</span>`;
  },
  categorie: (s) => (["envoye", "hors_domaine", "supprime", "illisible", "ignore"].includes(s) ? s : "en_cours"),
};

(function () {
  const pages = [["/", "Tableau de bord", "index"], ["/journaux.html", "Journal", "journal"], ["/sources.html", "Sources", "sources"], ["/reglages.html", "Réglages", "reglages"]];
  const actif = document.body.dataset.page;
  const nav = document.getElementById("nav");
  if (!nav) return;
  nav.innerHTML =
    pages.map(([h, t, k]) => `<a href="${h}"${k === actif ? ' class="on"' : ""}>${t}</a>`).join("") +
    '<a href="#" id="sortie">Déconnexion</a>';
  document.getElementById("sortie").onclick = async (e) => {
    e.preventDefault();
    await fetch("/api/deconnexion", { method: "POST" });
    location.href = "/login.html";
  };
})();

// Parcours d'un journal : étapes reliées par des flèches, couleur selon l'état
(function () {
  const LIB = { fait: "Terminé", en_cours: "En cours", attente: "En attente", reporte: "Reporté", echec: "Échec", non_concerne: "Non concerné" };
  const ICO = { fait: "✓", en_cours: "…", reporte: "↻", echec: "✕", non_concerne: "–" };
  const fleche = (etat) =>
    `<div class="pf ${etat}" aria-hidden="true"><svg viewBox="0 0 32 16"><path d="M1 8h26M21 2l8 6-8 6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`;

  Object.assign(U, {
    parcours(etapes) {
      return `<div class="parcours" role="list">` + etapes.map((p, i) =>
        (i ? fleche(p.etat) : "") +
        `<div class="pe ${p.etat}" role="listitem" title="${U.esc(p.detail || "")}"><div class="pt">${p.compte !== undefined ? p.compte : ICO[p.etat] ?? i + 1}</div><div class="pn">${U.esc(p.nom)}</div><div class="ps">${U.esc(p.texte || LIB[p.etat])}</div></div>`
      ).join("") + `</div>`;
    },
    legende() {
      return `<div class="legende">` + Object.keys(LIB).map((e) => `<span><i class="${e}"></i>${LIB[e]}</span>`).join("") + `</div>`;
    },
    mini(etapes) {
      const l = etapes || [];
      return `<span class="mini" role="img" aria-label="${U.esc(l.map((p) => p.nom + " : " + LIB[p.etat]).join(", "))}">` +
        l.map((p, i) => (i ? "<b></b>" : "") + `<i class="${p.etat}" title="${U.esc(p.nom + " : " + LIB[p.etat])}"></i>`).join("") + `</span>`;
    },
    // Vue d'ensemble : pour chaque étape, l'état le plus sévère parmi tous les journaux
    parcoursGlobal(journaux) {
      const noms = ["Détection", "Téléchargement", "Lecture", "Mots-clés", "Stockage AfGD", "Résumé IA", "Enregistrement", "Envoi mail"];
      return noms.map((nom, i) => {
        const c = { fait: 0, en_cours: 0, reporte: 0, echec: 0, attente: 0 };
        for (const j of journaux) { const e = (j.parcours || [])[i]; if (e && c[e.etat] !== undefined) c[e.etat]++; }
        const etat = c.echec ? "echec" : c.reporte ? "reporte" : c.en_cours ? "en_cours" : c.fait ? "fait" : "attente";
        const morceaux = [c.fait && c.fait + " terminé(s)", c.en_cours && c.en_cours + " en cours", c.reporte && c.reporte + " reporté(s)", c.echec && c.echec + " en échec"].filter(Boolean);
        return { nom, etat, compte: c.fait, texte: morceaux.join(" · ") || "Aucun journal" };
      });
    },
  });
})();