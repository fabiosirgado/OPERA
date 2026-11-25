// Configuração de um cliente de setting B2B, sem código: campos de qualificação, motivos de desqualificação,
// quem faz as reuniões e o link da agenda de marcações do cliente. Fica na ficha do cliente (Clientes e acessos).
import { useEffect, useState } from "react";
import { sb } from "../supabase.js";
import { clientSettingSave } from "../lib/leadsApi.js";
import { useAction } from "../ui/feedback.jsx";

const TIPOS = [["texto", "Texto"], ["sim_nao", "Sim ou não"], ["escolha", "Escolha"]];
const linhas = (t) => t.split("\n").map((x) => x.trim()).filter(Boolean);

export default function SettingConfig({ clientId, onSaved }) {
  const [cfg, setCfg] = useState(null);
  const [run, busy] = useAction();

  useEffect(() => {
    sb.from("clients").select("qual_fields,desq_reasons,meeting_hosts,booking_url").eq("id", clientId).maybeSingle()
      .then(({ data, error }) => {
        if (error || !data) { setCfg({ erro: true }); return; }
        setCfg({
          campos: (data.qual_fields || []).map((c) => ({ key: c.key, type: c.type || "texto", options: (c.options || []).join(", ") })),
          motivos: (data.desq_reasons || []).join("\n"),
          hosts: (data.meeting_hosts || []).join("\n"),
          booking: data.booking_url || "",
        });
      }, () => setCfg({ erro: true }));
  }, [clientId]);

  if (!cfg) return <div className="sub" style={{ margin: 0 }}>A carregar a configuração…</div>;
  if (cfg.erro) return <div className="banner orange">A configuração do setting ainda não está disponível neste ambiente.</div>;

  const setCampo = (i, patch) => setCfg((c) => ({ ...c, campos: c.campos.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
  const mover = (i, d) => setCfg((c) => {
    const a = [...c.campos]; const j = i + d;
    if (j < 0 || j >= a.length) return c;
    [a[i], a[j]] = [a[j], a[i]];
    return { ...c, campos: a };
  });
  const guardar = async () => {
    const campos = cfg.campos.filter((c) => c.key.trim()).map((c) => ({
      key: c.key.trim().slice(0, 60), type: c.type,
      ...(c.type === "escolha" ? { options: c.options.split(",").map((o) => o.trim()).filter(Boolean) } : {}),
    }));
    if (await run(() => clientSettingSave(clientId, {
      qual_fields: campos, desq_reasons: linhas(cfg.motivos), meeting_hosts: linhas(cfg.hosts), booking_url: cfg.booking.trim() || null,
    }), "Configuração do setting guardada")) onSaved?.();
  };

  return (
    <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>Configuração do setting</h3>

      <label className="f">Link da agenda de marcações do cliente
        <input value={cfg.booking} onChange={(e) => setCfg({ ...cfg, booking: e.target.value })} placeholder="https://calendly.com/… ou outra agenda de marcações" />
        <span className="sub" style={{ margin: 0, fontSize: 12 }}>Abre dentro da ficha da lead para marcar a reunião. Em Calendly e Cal.com o nome e o email da lead vão preenchidos.</span></label>

      <label className="f">Quem faz as reuniões (um por linha)
        <textarea rows={3} value={cfg.hosts} onChange={(e) => setCfg({ ...cfg, hosts: e.target.value })} placeholder={"Tomás\nInês"} /></label>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="f">Campos de qualificação</span>
        {cfg.campos.map((c, i) => (
          <div key={i} className="row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <input aria-label="Nome do campo" value={c.key} maxLength={60} onChange={(e) => setCampo(i, { key: e.target.value })} style={{ flex: "2 1 160px", minHeight: 38 }} />
            <select aria-label="Tipo do campo" value={c.type} onChange={(e) => setCampo(i, { type: e.target.value })} style={{ minHeight: 38 }}>
              {TIPOS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            {c.type === "escolha" && <input aria-label="Opções" value={c.options} onChange={(e) => setCampo(i, { options: e.target.value })} placeholder="Opções separadas por vírgulas" style={{ flex: "3 1 200px", minHeight: 38 }} />}
            <button type="button" className="btn sm" aria-label="Subir" disabled={i === 0} onClick={() => mover(i, -1)}>↑</button>
            <button type="button" className="btn sm" aria-label="Descer" disabled={i === cfg.campos.length - 1} onClick={() => mover(i, 1)}>↓</button>
            <button type="button" className="btn sm" style={{ color: "#B91C1C" }} onClick={() => setCfg((x) => ({ ...x, campos: x.campos.filter((_, j) => j !== i) }))}>Tirar</button>
          </div>
        ))}
        <div><button type="button" className="btn sm" onClick={() => setCfg((x) => ({ ...x, campos: [...x.campos, { key: "", type: "texto", options: "" }] }))}>Acrescentar campo</button></div>
      </div>

      <label className="f">Motivos de desqualificação (um por linha; "Outro" pede texto)
        <textarea rows={5} value={cfg.motivos} onChange={(e) => setCfg({ ...cfg, motivos: e.target.value })} /></label>

      <div className="actions" style={{ justifyContent: "flex-start" }}>
        <button type="button" className="btn primary" disabled={busy} onClick={guardar}>Guardar configuração</button>
      </div>
    </div>
  );
}
