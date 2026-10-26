import { testerMail } from "./mail";

testerMail()
  .then(() => console.log("Mail de test envoyé. Vérifiez la boîte de réception (et les spams)."))
  .catch((e) => {
    console.error("Échec :", e.message);
    process.exit(1);
  });