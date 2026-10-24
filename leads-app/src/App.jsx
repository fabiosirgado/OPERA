import { useEffect } from "react";
import { configError } from "./supabase.js";
import { LoginScreen, MfaCodeScreen, MfaEnrollScreen, NoAccessScreen, SetPasswordScreen, useAccess } from "./auth/Auth.jsx";
import { ToastProvider } from "./ui/feedback.jsx";
import Shell from "./Shell.jsx";

function Gate() {
  const { state, refresh, passwordDone } = useAccess();
  // Antes de entrar, o menu lateral fica escondido (como no protótipo).
  useEffect(() => { document.body.classList.toggle("out", state.step !== "ready"); }, [state.step]);

  switch (state.step) {
    case "loading": return <div className="login"><div className="lcard"><span className="sub">A carregar…</span></div></div>;
    case "signedOut": return <LoginScreen initialMessage={state.message} onDone={refresh} />;
    case "setPassword": return <SetPasswordScreen invited={state.invited} onDone={() => { passwordDone(); refresh(); }} />;
    case "mfaEnroll": return <MfaEnrollScreen onDone={refresh} />;
    case "mfaCode": return <MfaCodeScreen factorId={state.factorId} onDone={refresh} />;
    case "noAccess": return <NoAccessScreen message={state.message} />;
    default: return <Shell access={state} />;
  }
}

export default function App() {
  if (configError) return <NoAccessScreen message={configError} />;
  return <ToastProvider><Gate /></ToastProvider>;
}
