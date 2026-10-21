import { useEffect, useState } from "react";
import { sb, configError, SUPABASE_URL } from "./supabase.js";

// Fase 0: ecrã provisório que só confirma que a aplicação compila e chega ao Supabase.
// É substituído pelo login e pelos ecrãs do protótipo na Fase 1.
export default function App() {
  const [session, setSession] = useState(undefined);
  const [error, setError] = useState(configError);

  useEffect(() => {
    if (!sb) return;
    sb.auth.getSession()
      .then(({ data, error }) => { if (error) throw error; setSession(data.session); })
      .catch((e) => setError(e.message));
  }, []);

  const env = SUPABASE_URL ? new URL(SUPABASE_URL).hostname.split(".")[0] : "sem projeto";

  return (
    <div className="boot">
      <div className="card">
        <div className="brand"><b>OPERA</b><span>Leads</span></div>
        {error && <p className="err">{error}</p>}
        {!error && session === undefined && <p>A ligar ao servidor…</p>}
        {!error && session !== undefined && (
          <>
            <p className="ok">Ligação ao Supabase feita.</p>
            <p>{session ? `Sessão iniciada como ${session.user.email}.` : "Sem sessão iniciada."}</p>
          </>
        )}
        <p>Projeto: {env}</p>
      </div>
    </div>
  );
}
