// Dashboard de Setting (docs/setting/especificacao_setting.md e os desenhos dashboard_setting_vista_*.html).
// Vista OPERA: todos os clientes de setting (ou um), por Gestor de Leads, período e origem, com comparação entre
// clientes. Vista do cliente: só os seus números, as próximas reuniões e as reuniões por marcar resultado.
// Os números vêm todos da função leads_setting_dashboard (o servidor impõe que o cliente só vê os seus dados).
import { useEffect, useState } from "react";
import { sb } from "../supabase.js";
import { updateLead } from "../lib/leadsApi.js";
import { fmtDur, localInput } from "../lib/format.js";
import { OUTCOMES, fmtMeeting } from "../lib/setting.js";
import { useAction } from "../ui/feedback.jsx";

const PERIODS = [["1", "Hoje"], ["7", "7 dias"], ["30", "30 dias"], ["0", "Tudo"], ["custom", "Personalizado"]];
const ORIGENS = [["", "Todas"], ["nova", "Nova (inbound)"], ["reativada", "Reativada"], ["bd", "Base de dados"]];
const ORIGEM_NOME = { nova: "Nova (inbound)", reativada: "Reativada", bd: "Base de dados" };
const todayISO = () => localInput(Date.now()).slice(0, 10);
const monthStartISO = () => `${todayISO().slice(0, 8)}01`;
const pctN = (a, b) => (b ? (a / b) * 100 : null);
const pct = (a, b) => { const v = pctN(a, b); return v == null ? "—" : `${v < 10 && v % 1 ? v.toFixed(1).replace(".", ",") : Math.round(v)}%`; };
const n = (v) => Number(v || 0);
const dec = (v) => (v == null ? "—" : String(v).replace(".", ","));
const dataCurta = (iso) => new Intl.DateTimeFormat("pt-PT", { day: "2-digit", month: "2-digit" }).format(new Date(`${iso}T12:00:00`));

// Conversões do funil (fórmulas da especificação).
function taxas(f) {
  return {
    contacto: pct(n(f.atendidas), n(f.trabalhadas)),
    agendamento: pct(n(f.agendadas), n(f.atendidas)),
    global: pct(n(f.agendadas), n(f.recebidas)),
    comparencia: pct(n(f.realizadas), n(f.agendadas_passadas)),
    fecho: pct(n(f.fechados), n(f.realizadas)),
    negocio: pct(n(f.fechados), n(f.recebidas)),
  };
}

const CSS = `
.sd{background:#0A1230;color:#fff;border-radius:16px;padding:24px;margin:-8px 0 0;font-family:Inter,system-ui,sans-serif;display:flex;flex-direction:column;gap:16px}
.sd h1{color:#fff;margin:2px 0 4px;font-size:26px}.sd .ey{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6EA2FF;font-weight:700}
.sd .sub2{color:#B9C4E4;font-size:14px}
.sd .card{background:#111C45;border:1px solid #24336B;border-radius:14px;padding:18px}
.sd .card h3{margin:0 0 14px;font-size:16px;color:#fff}
.sd .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:16px}
.sd .kpi .l{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#B9C4E4;font-weight:700}
.sd .kpi b{display:block;font-size:30px;margin:8px 0 6px;color:#fff}.sd .kpi b.ac{color:#6EA2FF}
.sd .kpi small{color:#B9C4E4;font-size:13px}
.sd .filt{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.sd .chip2{background:#111C45;border:1px solid #24336B;border-radius:8px;color:#fff;font-size:13px;font-weight:600;padding:6px 10px;display:inline-flex;gap:8px;align-items:center;min-height:36px}
.sd .chip2 select,.sd .chip2 input{background:transparent;color:#fff;border:0;font:inherit;min-height:28px}
.sd .chip2 select option{color:#0A1230}
.sd .chip2.on{border-color:#2F7BFF}
.sd .pbtn{background:transparent;border:1px solid #24336B;color:#B9C4E4;border-radius:999px;padding:6px 12px;font-weight:600;font-size:13px;cursor:pointer;min-height:36px}
.sd .pbtn.on{background:#2F7BFF;border-color:#2F7BFF;color:#fff}
.sd .fun{display:grid;grid-template-columns:170px 1fr 70px;align-items:center;gap:14px;margin-bottom:6px}
.sd .fun .bar{background:#0A1230;border-radius:6px;height:26px;overflow:hidden}.sd .fun .bar i{display:block;height:100%;background:#3D5BB5;border-radius:6px}
.sd .fun .bar i.hi{background:#2F7BFF}
.sd .fun .lb{font-weight:600;font-size:14px}.sd .fun .v{text-align:right;font-weight:700;font-size:18px}
.sd .fun .cap{grid-column:2;color:#B9C4E4;font-size:12px;margin:-4px 0 6px}
.sd .two{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
.sd table{width:100%;border-collapse:collapse;font-size:14px}.sd th{color:#B9C4E4;font-weight:600;text-align:left;padding:8px 10px;border-bottom:1px solid #24336B;white-space:nowrap}
.sd td{padding:10px;border-bottom:1px solid #24336B}.sd td.n,.sd th.n{text-align:right}
.sd .weeks{display:flex;align-items:flex-end;gap:14px;height:170px;padding-top:10px}
.sd .week{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;min-width:28px}
.sd .week i{display:block;width:100%;max-width:56px;background:#2F7BFF;border-radius:8px 8px 4px 4px}
.sd .week span{color:#B9C4E4;font-size:12px}.sd .week b{font-size:14px}
.sd .act{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.sd .act div{background:#0A1230;border-radius:10px;padding:12px}.sd .act b{display:block;font-size:22px;margin:4px 0}.sd .act span,.sd .act small{color:#B9C4E4;font-size:12px}
.sd .mot{display:grid;grid-template-columns:160px 1fr 40px;gap:10px;align-items:center;margin-bottom:8px;font-size:14px}
.sd .mot .bar{background:#0A1230;border-radius:6px;height:14px;overflow:hidden}.sd .mot .bar i{display:block;height:100%;background:#3D5BB5}
.sd .meet{display:flex;gap:14px;align-items:flex-start;padding:12px 0;border-bottom:1px solid #24336B}
.sd .meet:last-child{border-bottom:0}.sd .when{background:#16307A;border-radius:10px;padding:8px 10px;text-align:center;min-width:72px}
.sd .when b{display:block;font-size:14px}.sd .when span{color:#B9C4E4;font-size:12px}
.sd .meet .who{flex:1;min-width:0}.sd .meet .who button{background:none;border:0;color:#fff;font-weight:700;font-size:15px;padding:0;cursor:pointer;text-align:left}
.sd .meet .who small{display:block;color:#B9C4E4;font-size:12px;margin-top:4px}
.sd .obtn{background:#16307A;border:1px solid #24336B;color:#fff;border-radius:8px;padding:6px 10px;font-weight:600;font-size:13px;cursor:pointer;min-height:36px}
.sd .obtn:hover{border-color:#6EA2FF}.sd .obtn.g{background:#1F6F43;border-color:#1F6F43}.sd .obtn.r{color:#FCA5A5}
.sd .muted{color:#B9C4E4;font-size:13px}
.sd a{color:#6EA2FF}
@media (max-width:640px){.sd{padding:16px}.sd .fun{grid-template-columns:110px 1fr 50px}.sd .mot{grid-template-columns:110px 1fr 32px}}
`;

export default function SettingDashboard({ ctx }) {
  const { opera, clients } = ctx;
  const [client, setClient] = useState("");
  const [manager, setManager] = useState("");
  const [origem, setOrigem] = useState("");
  const [period, setPeriod] = useState("30");
  const [range, setRange] = useState(() => ({ from: monthStartISO(), to: todayISO() }));
  const rangeOk = range.from && range.to && range.from <= range.to;
  const [d, setD] = useState(null);
  const [run, busy] = useAction();

  useEffect(() => {
    if (period === "custom" && !rangeOk) return;
    const custom = period === "custom" ? { p_from: range.from, p_to: range.to } : {};
    run(async () => {
      const { data, error } = await sb.rpc("leads_setting_dashboard", {
        p_client: opera ? client || null : null, p_manager: opera ? manager || null : null, p_period: period, p_origem: origem || null, ...custom,
      });
      if (error) throw error;
      setD(data);
    });
  }, [client, manager, origem, period, range.from, range.to, rangeOk, opera, ctx.version, run]);

  const f = d?.funil || {};
  const t = taxas(f);
  const settingClients = d?.clientes || [];
  const clientName = opera ? settingClients.find((c) => c.id === client)?.name : clients[0]?.name;
  const ttl = d?.ttl?.mediana != null ? fmtDur(Number(d.ttl.mediana)) : "—";
  const resumoQual = (l) => ctx.setting.qualFields(l.client_id).map((q) => (l.qualification?.[q.key] ? `${q.key}: ${l.qualification[q.key]}` : null)).filter(Boolean).join(" · ");
  const marcar = (l, o, nome) => {
    const s = ctx.setting.outcomeStage(l.client_id, o);
    if (!s) return;
    if (o === "nao_compareceu" && !window.confirm(`${l.name} não compareceu? A lead volta à OPERA para remarcar.`)) return;
    run(() => updateLead(l.id, { stage_id: s.id }), o === "nao_compareceu" ? "Registado. A OPERA vai remarcar." : `${l.name}: ${nome}`)
      .then((ok) => ok && ctx.onChanged());
  };

  const funil = opera
    ? [["Leads recebidas", f.recebidas, null], ["Leads trabalhadas", f.trabalhadas, `${pct(n(f.trabalhadas), n(f.recebidas))} das recebidas`],
       ["Leads atendidas", f.atendidas, `Taxa de contacto ${t.contacto}`], ["Reuniões agendadas", f.agendadas, `Taxa de agendamento ${t.agendamento}`],
       ["Reuniões realizadas", f.realizadas, `Taxa de comparência ${t.comparencia}`], ["Negócios fechados", f.fechados, `Taxa de fecho ${t.fecho}`]]
    : [["Leads recebidas", f.recebidas, null], ["Leads atendidas", f.atendidas, `Taxa de contacto ${t.contacto}`],
       ["Reuniões agendadas", f.agendadas, `Taxa de agendamento ${t.agendamento}`], ["Reuniões realizadas", f.realizadas, `Taxa de comparência ${t.comparencia}`],
       ["Negócios fechados", f.fechados, `Taxa de fecho ${t.fecho}`]];
  const maxF = Math.max(1, ...funil.map(([, v]) => n(v)));
  const semanas = d?.semanas || [];
  const maxW = Math.max(1, ...semanas.map((w) => n(w.n)));
  const motivos = d?.motivos || [];
  const maxM = Math.max(1, ...motivos.map((m) => n(m.n)));

  return (
    <div className="sd">
      <style>{CSS}</style>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
        <div>
          <div className="ey">OPERA Leads · {opera ? "Vista OPERA" : "Vista do cliente"}</div>
          <h1>{opera ? "Dashboard de Setting" : clientName || "Dashboard de Setting"}</h1>
          <div className="sub2">{opera ? "Conversões da lead ao negócio, por cliente, Gestor de Leads, período e origem" : "As vossas reuniões e conversões, atualizadas em tempo real"}</div>
        </div>
      </div>

      <div className="filt">
        {opera && (
          <label className={`chip2 ${client ? "on" : ""}`}>Cliente:
            <select value={client} onChange={(e) => setClient(e.target.value)}>
              <option value="">Todos os de setting</option>{settingClients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>)}
        {opera && (
          <label className={`chip2 ${manager ? "on" : ""}`}>Gestor de Leads:
            <select value={manager} onChange={(e) => setManager(e.target.value)}>
              <option value="">Todos</option>{(d?.gestores || []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>)}
        <label className={`chip2 ${origem ? "on" : ""}`}>Origem:
          <select value={origem} onChange={(e) => setOrigem(e.target.value)}>
            {ORIGENS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <div className="filt" role="group" aria-label="Período">
          {PERIODS.map(([v, l]) => <button key={v} type="button" className={`pbtn ${period === v ? "on" : ""}`} aria-pressed={period === v} onClick={() => setPeriod(v)}>{l}</button>)}
        </div>
        {period === "custom" && (
          <div className="filt" role="group" aria-label="Período personalizado">
            <label className="chip2">De<input type="date" value={range.from} max={range.to || undefined} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} /></label>
            <label className="chip2">Até<input type="date" value={range.to} min={range.from || undefined} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} /></label>
            {!rangeOk && <span className="muted" role="alert" style={{ color: "#FCA5A5" }}>A data de início tem de ser antes da data de fim.</span>}
          </div>
        )}
      </div>

      {!d ? <div className="muted">A calcular…</div> : opera && !settingClients.length ? (
        <div className="card"><h3>Ainda não há clientes de setting</h3>
          <div className="muted">Quando um cliente passar a ter o tipo de serviço Setting, os números dele aparecem aqui.</div></div>
      ) : (<>
        <div className="kpis">
          <div className="card kpi"><span className="l">Time to Lead</span><b>{ttl}</b><small>Objetivo {d.ttl?.objetivo ?? "—"} min{d.ttl?.n ? ` · ${pct(n(d.ttl.no_objetivo), n(d.ttl.n))} dentro` : ""}</small></div>
          <div className="card kpi"><span className="l">Reuniões agendadas</span><b className="ac">{n(f.agendadas)}</b><small>No período</small></div>
          {opera && <div className="card kpi"><span className="l">Taxa de agendamento</span><b>{t.agendamento}</b><small>Agendadas / atendidas</small></div>}
          <div className="card kpi"><span className="l">Taxa de comparência</span><b>{t.comparencia}</b><small>{opera ? "Realizadas / agendadas" : `${n(f.realizadas)} reuniões realizadas`}</small></div>
          {opera
            ? <div className="card kpi"><span className="l">Taxa de fecho</span><b>{t.fecho}</b><small>Fechados / realizadas</small></div>
            : <div className="card kpi"><span className="l">Negócios fechados</span><b>{n(f.fechados)}</b><small>Taxa de fecho {t.fecho}</small></div>}
          {opera
            ? <div className="card kpi"><span className="l">Lead a negócio</span><b>{t.negocio}</b><small>Fechados / recebidas</small></div>
            : <div className="card kpi"><span className="l">Contactos realizados</span><b>{n(d.atividade?.contactos)}</b><small>Feitos pela OPERA em vosso nome</small></div>}
        </div>

        {!opera && (
          <div className="two">
            <div className="card"><h3>Próximas reuniões</h3>
              {!d.proximas?.length && <div className="muted">Sem reuniões marcadas.</div>}
              {(d.proximas || []).map((l) => {
                const dt = new Date(l.meeting_at);
                return (
                  <div key={l.id} className="meet">
                    <div className="when"><b>{new Intl.DateTimeFormat("pt-PT", { day: "numeric", month: "short" }).format(dt)}</b>
                      <span>{new Intl.DateTimeFormat("pt-PT", { hour: "2-digit", minute: "2-digit" }).format(dt)}</span></div>
                    <div className="who"><button type="button" onClick={() => ctx.onOpenLead(l.id)}>{l.name}</button>
                      <small>{l.meeting_with ? `Com ${l.meeting_with}` : ""}{l.meeting_link && /^https?:\/\//i.test(l.meeting_link) && <> · <a href={l.meeting_link} target="_blank" rel="noopener noreferrer">ligação</a></>}</small>
                      <small>{resumoQual(l) || "Qualificação: ver a ficha da lead"}</small></div>
                  </div>);
              })}
            </div>
            <div className="card"><h3>Reuniões por marcar resultado</h3>
              <div className="muted" style={{ marginTop: -8, marginBottom: 8 }}>Um toque por reunião. É isto que alimenta as taxas de comparência e de fecho.</div>
              {!d.por_marcar?.length && <div className="muted">Nada por marcar.</div>}
              {(d.por_marcar || []).map((l) => (
                <div key={l.id} className="meet" style={{ flexWrap: "wrap" }}>
                  <div className="who"><button type="button" onClick={() => ctx.onOpenLead(l.id)}>{l.name}</button><small>Reunião de {fmtMeeting(l.meeting_at)}</small></div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {OUTCOMES.map(([o, nome]) => (
                      <button key={o} type="button" className={`obtn ${o === "fechado" ? "g" : o === "perdido" || o === "nao_compareceu" ? "r" : ""}`} disabled={busy}
                        onClick={() => marcar(l, o, nome)}>{nome}</button>))}
                  </div>
                </div>))}
            </div>
          </div>
        )}

        <div className="card"><h3>{opera ? "Funil de conversão" : "O vosso funil"}</h3>
          {funil.map(([lb, v, cap], i) => (
            <div key={lb}>
              <div className="fun"><span className="lb">{lb}</span><div className="bar"><i className={i === 3 && opera ? "hi" : ""} style={{ width: `${(n(v) / maxF) * 100}%` }}></i></div><span className="v">{n(v)}</span></div>
              {cap && <div className="fun" style={{ marginTop: -4 }}><span></span><span className="cap" style={{ margin: 0 }}>{cap}</span><span></span></div>}
            </div>
          ))}
          {opera && <div className="muted" style={{ marginTop: 10 }}>Taxa de agendamento global {t.global} (agendadas / recebidas) · Lead a negócio {t.negocio} · Faltas {n(f.faltas)} · Remarcadas {n(f.remarcadas)}</div>}
        </div>

        <div className={opera ? "two" : ""}>
          <div className="card"><h3>Reuniões agendadas por semana</h3>
            {!semanas.length ? <div className="muted">Sem reuniões agendadas no período.</div> : (
              <div className="weeks">{semanas.map((w) => (
                <div key={w.semana} className="week"><b>{n(w.n)}</b><i style={{ height: `${Math.max(4, (n(w.n) / maxW) * 120)}px` }}></i><span>{dataCurta(w.semana)}</span></div>))}
              </div>)}
          </div>
          {opera && (
            <div className="card"><h3>Conversão por origem da lead</h3>
              <div style={{ overflowX: "auto" }}>
                <table><thead><tr><th>Origem</th><th className="n">Recebidas</th><th className="n">Atendidas</th><th className="n">Reuniões</th><th className="n">Agendamento</th><th className="n">Comparência</th><th className="n">Fecho</th></tr></thead>
                  <tbody>{["nova", "reativada", "bd"].filter((o) => d.por_origem?.[o]).map((o) => {
                    const x = d.por_origem[o]; const tx = taxas(x);
                    return <tr key={o}><td>{ORIGEM_NOME[o]}</td><td className="n">{n(x.recebidas)}</td><td className="n">{n(x.atendidas)}</td><td className="n">{n(x.agendadas)}</td>
                      <td className="n">{tx.agendamento}</td><td className="n">{tx.comparencia}</td><td className="n">{tx.fecho}</td></tr>;
                  })}
                  {!Object.keys(d.por_origem || {}).length && <tr><td colSpan={7} className="muted">Sem leads no período.</td></tr>}</tbody></table>
              </div>
            </div>)}
        </div>

        {opera && (<>
          <div className="two">
            <div className="card"><h3>Atividade</h3>
              <div className="act">
                <div><span>Contactos realizados</span><b>{n(d.atividade?.contactos)}</b><small>Chamadas e mensagens</small></div>
                <div><span>Tentativas por lead</span><b>{dec(d.atividade?.tentativas_por_lead)}</b><small>Média</small></div>
                <div><span>Follow ups em atraso</span><b>{n(d.atividade?.followups_atraso)}</b><small>A tratar hoje</small></div>
                <div><span>Lead a reunião</span><b>{d.atividade?.lead_a_reuniao_dias != null ? `${dec(d.atividade.lead_a_reuniao_dias)} dias` : "—"}</b><small>Tempo médio</small></div>
                <div><span>Recuperadas da BD</span><b>{n(d.atividade?.recuperadas_bd)}</b><small>Reuniões de leads de BD</small></div>
              </div>
            </div>
            <div className="card"><h3>Motivos de desqualificação</h3>
              {!motivos.length && <div className="muted">Sem leads desqualificadas no período.</div>}
              {motivos.map((m) => (
                <div key={m.motivo} className="mot"><span>{m.motivo}</span><div className="bar"><i style={{ width: `${(n(m.n) / maxM) * 100}%` }}></i></div><b style={{ textAlign: "right" }}>{n(m.n)}</b></div>))}
            </div>
          </div>

          <div className="card"><h3>Comparação entre clientes de setting</h3>
            <div style={{ overflowX: "auto" }}>
              <table><thead><tr><th>Cliente</th><th className="n">Reuniões</th><th className="n">Agendamento</th><th className="n">Comparência</th><th className="n">Fecho</th><th>Faltas e remarcações</th></tr></thead>
                <tbody>{(d.por_cliente || []).map((c) => {
                  const tx = taxas(c);
                  return <tr key={c.id}><td><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: c.color, marginRight: 8 }}></span>{c.name}</td>
                    <td className="n">{n(c.agendadas)}</td><td className="n">{tx.agendamento}</td><td className="n">{tx.comparencia}</td><td className="n">{tx.fecho}</td>
                    <td>{n(c.faltas)} {n(c.faltas) === 1 ? "falta" : "faltas"}, {n(c.remarcadas)} {n(c.remarcadas) === 1 ? "remarcada" : "remarcadas"}</td></tr>;
                })}</tbody></table>
            </div>
            <div className="muted" style={{ marginTop: 10 }}>O setting interno da OPERA como referência entra numa próxima versão.</div>
          </div>
        </>)}
      </>)}
    </div>
  );
}
