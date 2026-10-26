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
  const pages = [["/", "Tableau de bord", "index"], ["/journaux.html", "Journal", "journal"], ["/reglages.html", "Réglages", "reglages"]];
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
