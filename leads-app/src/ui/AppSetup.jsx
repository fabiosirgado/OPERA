import { useEffect, useState } from "react";
import { canInstall, disablePush, enablePush, install, isIOS, pushState } from "../lib/push.js";

// No fundo do menu: instalar a app e ligar ou desligar as notificações neste dispositivo.
export default function AppSetup() {
  const [state, setState] = useState(null);
  const [installable, setInstallable] = useState(canInstall);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    pushState().then(setState).catch(() => setState("sem_suporte"));
    const onInstall = () => setInstallable(canInstall());
    window.addEventListener("opera-instalar", onInstall);
    return () => window.removeEventListener("opera-instalar", onInstall);
  }, []);

  const run = async (fn) => {
    setBusy(true); setError("");
    try { setState(await fn()); } catch (e) { setError(e.message || "Não foi possível mudar as notificações."); }
    setBusy(false);
  };

  if (!state) return null;
  return (
    <div className="appSetup">
      {installable && <button type="button" onClick={() => install().then(() => setInstallable(canInstall()))}>Instalar a app</button>}
      {state === "instalar" && (
        <small>Para ter a app e as notificações no iPhone: no Safari toque em Partilhar, depois em Adicionar ao ecrã principal, e abra a app pelo ícone.</small>
      )}
      {state === "desligadas" && (
        <button type="button" disabled={busy} onClick={() => run(enablePush)}>{busy ? "A ativar…" : "Ativar notificações"}</button>
      )}
      {state === "ativas" && (
        <button type="button" disabled={busy} aria-pressed="true" title="Desligar as notificações neste dispositivo"
          onClick={() => run(disablePush)}>Notificações ativas ✓</button>
      )}
      {state === "bloqueadas" && (
        <small>As notificações estão bloqueadas. {isIOS() ? "Ative nas Definições do iPhone, em Notificações, OPERA Leads." : "Ative nas definições do site, no browser."}</small>
      )}
      {error && <small role="alert" className="err">{error}</small>}
    </div>
  );
}
