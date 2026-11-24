// Ficha da lead de um cliente de setting B2B: qualificação com os campos do cliente, dados da reunião (obrigatórios
// para Reunião Agendada), resultado da reunião com um toque e motivo de desqualificação obrigatório.
import { useState } from "react";
import { updateLead } from "../lib/leadsApi.js";
import { OUTCOMES, fmtMeeting, meetingIso, meetingParts } from "../lib/setting.js";

// Campos de qualificação definidos no cliente: texto, sim ou não, escolha.
export function SettingQualPanel({ lead, fields, busy, onSave }) {
  const q = lead.qualification || {};
  const filled = fields.filter((f) => q[f.key]).length;
  return (
    <div className="panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3>Qualificação</h3>
        <span className="tag" style={{ background: "var(--greenSoft)", color: "var(--greenText)" }}>{filled} de {fields.length}</span>
      </div>
      {!fields.length && <span className="sub" style={{ margin: "8px 0 0", fontSize: 12 }}>Este cliente ainda não tem campos de qualificação definidos. Usa as notas.</span>}
      {fields.map((f) => {
        if (f.type === "sim_nao" || f.type === "escolha") {
          const opts = f.type === "sim_nao" ? ["Sim", "Não"] : (f.options || []);
          return (
            <div key={f.key} className="kv"><span>{f.key}</span>
              <div className="pills" role="group" aria-label={f.key}>
                {opts.map((o) => {
                  const on = q[f.key] === o;
                  return <button key={o} type="button" className={`pill ${on ? "on" : ""}`} aria-pressed={on} disabled={busy}
                    onClick={() => onSave(f.key, on ? "" : o)}>{o}</button>;
                })}
              </div></div>
          );
        }
        return (
          <label key={f.key} className="kv"><span>{f.key}</span>
            <input defaultValue={q[f.key] || ""} key={`${f.key}-${lead.updated_at}`} placeholder="Por perguntar"
              onBlur={(e) => e.target.value.trim() !== (q[f.key] || "") && onSave(f.key, e.target.value)} /></label>
        );
      })}
    </div>
  );
}

// Dados da reunião. Antes de agendar: o botão grava os dados e passa a lead para Reunião Agendada no mesmo pedido.
export function MeetingPanel({ lead, stage, qualificadaId, busy, after, refEl }) {
  const p = meetingParts(lead.meeting_at);
  const [f, setF] = useState({ date: p.date, time: p.time, with: lead.meeting_with || "", link: lead.meeting_link || "" });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const agendada = stage.key === "qualificada";
  const desq = stage.key === "desq";
  const ok = f.date && f.time && f.with.trim() && f.link.trim();
  const patch = () => ({ meeting_at: meetingIso(f.date, f.time), meeting_with: f.with.trim(), meeting_link: f.link.trim() });
  const agendar = () => after(() => updateLead(lead.id, { ...patch(), stage_id: qualificadaId }),
    lead.reschedules ? "Reunião remarcada. O cliente vai ser avisado." : "Reunião agendada. O cliente vai ser avisado.");
  const guardar = () => after(() => updateLead(lead.id, patch()), "Dados da reunião guardados");
  return (
    <div className="panel" ref={refEl}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <h3>Reunião</h3>
        {lead.reschedules > 0 && <span className="tag" style={{ background: "#FFEDD5", color: "#9A3412" }}>
          {lead.reschedules === 1 ? "1 remarcação" : `${lead.reschedules} remarcações`}</span>}
      </div>
      {agendada && lead.meeting_at && <span className="sub" style={{ margin: "6px 0 0", fontSize: 13 }}><b>{fmtMeeting(lead.meeting_at)}</b> com {lead.meeting_with}</span>}
      <div className="g2" style={{ marginTop: 10 }}>
        <label className="f">Dia *<input type="date" value={f.date} onChange={set("date")} disabled={busy || desq} /></label>
        <label className="f">Hora *<input type="time" value={f.time} onChange={set("time")} disabled={busy || desq} /></label>
      </div>
      <label className="f" style={{ marginTop: 8 }}>Quem faz a reunião *<input value={f.with} onChange={set("with")} placeholder="Ex.: Tomás" disabled={busy || desq} /></label>
      <label className="f" style={{ marginTop: 8 }}>Ligação da reunião *<input value={f.link} onChange={set("link")} placeholder="Ex.: https://meet.google.com/…" disabled={busy || desq} /></label>
      {lead.meeting_link && /^https?:\/\//i.test(lead.meeting_link) && (
        <a href={lead.meeting_link} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, marginTop: 6, display: "inline-block" }}>Abrir a ligação</a>)}
      {!desq && (
        <div className="row" style={{ marginTop: 10 }}>
          {agendada
            ? <button type="button" className="btn" disabled={busy || !ok} onClick={guardar}>Guardar alterações</button>
            : <button type="button" className="btn green" disabled={busy || !ok} onClick={agendar}>Agendar reunião e avisar cliente</button>}
          {!ok && <span style={{ fontSize: 12, color: "var(--mute)" }}>Preenche o dia, a hora, quem faz a reunião e a ligação.</span>}
        </div>
      )}
    </div>
  );
}

// Resultado da reunião, com um toque. Não compareceu devolve a lead à OPERA para remarcar.
export function OutcomePanel({ lead, outcomeStage, busy, after }) {
  const passou = lead.meeting_at && new Date(lead.meeting_at) <= Date.now();
  const marcar = (o, nome) => {
    const s = outcomeStage(o);
    if (!s) return;
    if (o === "nao_compareceu" && !window.confirm(`${lead.name} não compareceu? A lead volta à OPERA para remarcar.`)) return;
    after(() => updateLead(lead.id, { stage_id: s.id }), o === "nao_compareceu" ? "Registado. A OPERA vai remarcar." : `Resultado: ${nome}`);
  };
  return (
    <div className="panel" style={{ borderColor: passou ? "var(--blue)" : undefined }}>
      <h3>Resultado da reunião</h3>
      <span className="sub" style={{ margin: "4px 0 10px", fontSize: 12 }}>
        {passou ? "A reunião já passou. Marquem o resultado com um toque." : `A reunião é ${fmtMeeting(lead.meeting_at)}. Depois dela, marquem aqui o resultado.`}</span>
      <div className="row">
        {OUTCOMES.map(([o, nome]) => (
          <button key={o} type="button" className={`btn sm ${o === "fechado" ? "green" : ""}`} disabled={busy}
            style={o === "perdido" || o === "nao_compareceu" ? { color: "#B91C1C" } : undefined} onClick={() => marcar(o, nome)}>{nome}</button>
        ))}
      </div>
    </div>
  );
}

// Motivo de desqualificação (obrigatório nos clientes de setting).
export function DesqPanel({ lead, reasons, desqId, busy, after, onCancel }) {
  const [outro, setOutro] = useState(null);
  const desq = (motivo) => after(() => updateLead(lead.id, { desq_reason: motivo, stage_id: desqId }), "Lead desqualificada");
  return (
    <div className="panel" style={{ borderColor: "#FCA5A5" }}>
      <h3>Motivo da desqualificação</h3>
      <span className="sub" style={{ margin: "4px 0 10px", fontSize: 12 }}>Obrigatório. As tarefas em aberto são canceladas.</span>
      <div className="chips">
        {reasons.map((m) => (
          <button key={m} type="button" className="chip" disabled={busy}
            onClick={() => (m === "Outro" ? setOutro("") : desq(m))}>{m}</button>))}
      </div>
      {outro !== null && (
        <div className="row" style={{ marginTop: 10 }}>
          <input value={outro} onChange={(e) => setOutro(e.target.value)} placeholder="Qual o motivo?" autoFocus style={{ flex: 1, minHeight: 38 }} />
          <button type="button" className="btn sm" disabled={busy || !outro.trim()} onClick={() => desq(`Outro: ${outro.trim()}`)}>Desqualificar</button>
        </div>
      )}
      <button type="button" className="link" style={{ marginTop: 8 }} onClick={onCancel}>Cancelar</button>
    </div>
  );
}
