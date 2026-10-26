document.querySelectorAll("[data-sortie]").forEach((a) => {
  a.addEventListener("click", async (e) => {
    e.preventDefault();
    await fetch("/api/deconnexion", { method: "POST" });
    location.href = "/login.html";
  });
});