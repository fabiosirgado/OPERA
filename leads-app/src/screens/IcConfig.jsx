// Intermediário de crédito (IC) de um cliente de imobiliário: os emails que recebem o aviso automático quando uma lead
// fica qualificada com Crédito no Objetivo. Fica na ficha do cliente (Clientes e acessos). Sem email, não sai aviso.
import { useEffect, useState } from "react";
import { sb } from "../supabase.js";
import { clientIcSave } from "../lib/leadsApi.js";
import { useAction } from "../ui/feedback.jsx";

const separar = (t) => t.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

export default function IcConfig({ clientId }) {
  const [guardado, setGuardado] = useState(null);
  const [texto, setTexto] = useState("");
  const [run, busy] = useAction();

  useEffect(() => {
    let vivo = true;
    sb.from("clients").select("ic_emails").eq("id", clientId).maybeSingle()
      .then(({ data, error }) => {
        if (!vivo) return;
        // Num ambiente em que a base de dados ainda não tem o campo, a secção simplesmente não aparece.
        if (error || !data) { setGuardado(false); return; }
        const v = (data.ic_emails || []).join(", ");
        setGuardado(v); setTexto(v);
      }, () => vivo && setGuardado(false));
    return () => { vivo = false; };
  }, [clientId]);

  if (guardado === null || guardado === false) return null;

  const guardar = async () => {
    const emails = await run(() => clientIcSave(clientId, separar(texto)),
      (v) => (v.length ? "Intermediário de crédito guardado" : "Aviso ao intermediário de crédito desligado"));
    if (Array.isArray(emails)) { const v = emails.join(", "); setGuardado(v); setTexto(v); }
  };
  const mudou = separar(texto).join(", ").toLowerCase() !== guardado;

  return (
    <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>Intermediário de crédito</h3>
      <label className="f">Email do intermediário de crédito (IC)
        <input type="text" inputMode="email" autoComplete="off" value={texto} disabled={busy}
          onChange={(e) => setTexto(e.target.value)} placeholder="ex.: nome@intermediario.pt" />
        <span className="sub" style={{ margin: 0, fontSize: 12 }}>
          Recebe um email com o contacto e o contexto sempre que a OPERA qualifica uma lead com Crédito no Objetivo.
          Vários emails separados por vírgulas. Sem email, não sai aviso.</span></label>
      <div className="actions" style={{ justifyContent: "flex-start" }}>
        <button type="button" className="btn primary" disabled={busy || !mudou} onClick={guardar}>Guardar</button>
      </div>
    </div>
  );
}
