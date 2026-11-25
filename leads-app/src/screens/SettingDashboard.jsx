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
import "./admin/admin.css";

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

// Mesmo estilo do Dashboard Admin (admin/admin.css: .op, .op-tile, .op-card, .op-bar, .op-table…). Só o que é
// próprio deste ecrã fica aqui.
const CSS = `
.op.sd { margin: -8px -8px 0; }
.sd .op-filtros { display:flex; flex-wrap:wrap; align-items:end; gap:8px 16px; }
.sd .op-tabs { margin: 0; }
.sd .op-card h2 { margin-bottom: 14px; }
.sd .op-bar .row b { font-size: 16px; }
.sd .weeks { display:flex; align-items:flex-end; gap:14px; height:190px; padding-top:10px; }
.sd .week { flex:1; display:flex; flex-direction:column; align-items:center; gap:6px; min-width:28px; }
.sd .week i { display:block; width:100%; max-width:56px; border-radius:8px 8px 4px 4px; background:linear-gradient(180deg,#4C8DFF,#2B63E8);
  box-shadow:0 5px 12px rgba(43,99,232,.25), inset 0 1px 0 rgba(255,255,255,.35); }
.sd .week span { color:var(--color-fg-muted); font-size:12px; } .sd .week b { font-size:14px; }
.sd .act { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; }
.sd .act div { background:#F5F8FF; border:1px solid rgba(30,60,140,.08); border-radius:12px; padding:12px; }
.sd .act b { display:block; font-size:22px; margin:4px 0; color:#0B1A44; } .sd .act span, .sd .act small { color:var(--color-fg-muted); font-size:12px; }
.sd .meet { display:flex; gap:14px; align-items:flex-start; padding:12px 0; border-bottom:1px solid var(--color-border-line); }
.sd .meet:last-child { border-bottom:0; }
.sd .when { background:#EEF3FF; border-radius:12px; padding:8px 10px; text-align:center; min-width:72px; color:#2B63E8; }
.sd .when b { display:block; font-size:14px; } .sd .when span { font-size:12px; color:var(--color-fg-muted); }
.sd .who { flex:1; min-width:0; } .sd .who button { background:none; border:0; color:#0B1A44; font-weight:650; font-size:15px; padding:0; cursor:pointer; text-align:left; }
.sd .who small { display:block; color:var(--color-fg-muted); font-size:12px; margin-top:4px; }
.sd .obtn { font:inherit; font-size:13px; border-radius:10px; padding:6px 12px; cursor:pointer; border:1px solid rgba(30,60,140,.18); background:#fff; color:#0B1A44; min-height:36px; }
.sd .obtn.g { background:linear-gradient(180deg,#4C8DFF,#2B63E8); color:#fff; border-color:transparent; } .sd .obtn.r { color:#B42335; border-color:rgba(224,56,75,.35); }
.sd .muted { color:var(--color-fg-muted); font-size:13px; }
.sd .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:8px; }
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

  const Tile = ({ lbl, val, sub, cls }) => (
    <div className="op-tile"><div className="lbl">{lbl}</div><div className={`val ${cls || ""}`}>{val}</div>{sub && <div className="sub">{sub}</div>}</div>);
  const Bar = ({ lb, v, cap, hi }) => (
    <div className="op-bar"><div className="row"><span>{lb}</span><b>{n(v)}</b></div>
      <div className="track"><div className="fill" style={{ width: `${(n(v) / maxF) * 100}%`, backgroundColor: hi ? "#2B63E8" : "#3B82FF" }}></div></div>
      {cap && <div className="hint">{cap}</div>}</div>);

  return (
    <div className="op sd">
      <style>{CSS}</style>
      <header className="op-head">
        <div className="op-brand"><span className="op-logo">OPERA</span><span className="op-tagline">{opera ? "Setting · vista OPERA" : "Setting · vista do cliente"}</span></div>
        <h1>{opera ? "Dashboard de Setting" : clientName || "Dashboard de Setting"}</h1>
        <p>{opera ? "Conversões da lead ao negócio, por cliente, Gestor de Leads, período e origem" : "As vossas reuniões e conversões, atualizadas em tempo real"}</p>
        <span className="op-live">Dados em direto do OPERA Leads</span>
      </header>

      <div className="op-periodo">
        <div className="op-filtros">
          {opera && (
            <label>Cliente<select value={client} onChange={(e) => setClient(e.target.value)}>
              <option value="">Todos os de setting</option>{settingClients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>)}
          {opera && (
            <label>Gestor de Leads<select value={manager} onChange={(e) => setManager(e.target.value)}>
              <option value="">Todos</option>{(d?.gestores || []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>)}
          <label>Origem<select value={origem} onChange={(e) => setOrigem(e.target.value)}>
            {ORIGENS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          {period === "custom" && (<>
            <label>De<input type="date" value={range.from} max={range.to || undefined} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} /></label>
            <label>Até<input type="date" value={range.to} min={range.from || undefined} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} /></label>
            {!rangeOk && <span className="pnote" role="alert" style={{ color: "var(--color-bad)" }}>A data de início tem de ser antes da data de fim.</span>}
          </>)}
        </div>
        <div className="op-tabs" role="tablist" aria-label="Período">
          {PERIODS.map(([v, l]) => <button key={v} type="button" role="tab" className="op-tab" aria-selected={period === v} onClick={() => setPeriod(v)}>{l}</button>)}
        </div>
      </div>

      {!d ? <div className="muted" style={{ marginTop: 16 }}>A calcular…</div> : opera && !settingClients.length ? (
        <div className="op-card" style={{ marginTop: 16 }}><h2>Ainda não há clientes de setting</h2>
          <div className="note">Quando um cliente passar a ter o tipo de serviço Setting, os números dele aparecem aqui.</div></div>
      ) : (<>
        <div className="op-sec">Indicadores</div>
        <div className="op-tiles">
          <Tile lbl="Time to Lead" val={ttl} sub={`Objetivo ${d.ttl?.objetivo ?? "—"} min${d.ttl?.n ? ` · ${pct(n(d.ttl.no_objetivo), n(d.ttl.n))} dentro` : ""}`}
            cls={d.ttl?.mediana != null && d.ttl?.objetivo != null ? (Number(d.ttl.mediana) <= d.ttl.objetivo ? "op-good" : "op-bad") : ""} />
          <Tile lbl="Reuniões agendadas" val={n(f.agendadas)} sub="No período" />
          {opera && <Tile lbl="Taxa de agendamento" val={t.agendamento} sub="Agendadas / atendidas" />}
          <Tile lbl="Taxa de comparência" val={t.comparencia} sub={opera ? "Realizadas / agendadas" : `${n(f.realizadas)} reuniões realizadas`} />
          {opera ? <Tile lbl="Taxa de fecho" val={t.fecho} sub="Fechados / realizadas" /> : <Tile lbl="Negócios fechados" val={n(f.fechados)} sub={`Taxa de fecho ${t.fecho}`} />}
          {opera ? <Tile lbl="Lead a negócio" val={t.negocio} sub="Fechados / recebidas" /> : <Tile lbl="Contactos realizados" val={n(d.atividade?.contactos)} sub="Feitos pela OPERA em vosso nome" />}
        </div>

        {!opera && (
          <div className="op-grid">
            <div className="op-card"><h2>Próximas reuniões</h2>
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
            <div className="op-card"><h2>Reuniões por marcar resultado</h2>
              <div className="note">Um toque por reunião. É isto que alimenta as taxas de comparência e de fecho.</div>
              {!d.por_marcar?.length && <div className="muted">Nada por marcar.</div>}
              {(d.por_marcar || []).map((l) => (
                <div key={l.id} className="meet" style={{ flexWrap: "wrap" }}>
                  <div className="who" style={{ flexBasis: "100%" }}><button type="button" onClick={() => ctx.onOpenLead(l.id)}>{l.name}</button><small>Reunião de {fmtMeeting(l.meeting_at)}</small></div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {OUTCOMES.map(([o, nome]) => (
                      <button key={o} type="button" className={`obtn ${o === "fechado" ? "g" : o === "perdido" || o === "nao_compareceu" ? "r" : ""}`} disabled={busy}
                        onClick={() => marcar(l, o, nome)}>{nome}</button>))}
                  </div>
                </div>))}
            </div>
          </div>
        )}

        <div className="op-grid">
          <div className="op-card"><h2>{opera ? "Funil de conversão" : "O vosso funil"}</h2>
            <div className="note">Leads distintas no período, com a passagem de cada passo para o seguinte.</div>
            {funil.map(([lb, v, cap], i) => <Bar key={lb} lb={lb} v={v} cap={cap} hi={opera ? i === 3 : i === 2} />)}
            {opera && <div className="note" style={{ margin: 0 }}>Taxa de agendamento global {t.global} (agendadas / recebidas) · Lead a negócio {t.negocio} · Faltas {n(f.faltas)} · Remarcadas {n(f.remarcadas)}</div>}
          </div>
          <div className="op-card"><h2>Reuniões agendadas por semana</h2>
            <div className="note">Semana a começar à segunda-feira.</div>
            {!semanas.length ? <div className="muted">Sem reuniões agendadas no período.</div> : (
              <div className="weeks">{semanas.map((w) => (
                <div key={w.semana} className="week"><b>{n(w.n)}</b><i style={{ height: `${Math.max(4, (n(w.n) / maxW) * 130)}px` }}></i><span>{dataCurta(w.semana)}</span></div>))}
              </div>)}
          </div>
        </div>

        {opera && (<>
          <div className="op-card" style={{ marginBottom: 16 }}><h2>Conversão por origem da lead</h2>
            <div className="note">Leads novas, reativadas e de base de dados convertem de forma muito diferente.</div>
            <div className="op-table-wrap">
              <table className="op-table"><thead><tr><th>Origem</th><th className="n">Recebidas</th><th className="n">Trabalhadas</th><th className="n">Atendidas</th><th className="n">Reuniões</th><th className="n">Realizadas</th><th className="n">Fechados</th>
                <th className="n">Contacto</th><th className="n">Agendamento</th><th className="n">Comparência</th><th className="n">Fecho</th><th className="n">Lead a negócio</th></tr></thead>
                <tbody>{["nova", "reativada", "bd"].filter((o) => d.por_origem?.[o]).map((o) => {
                  const x = d.por_origem[o]; const tx = taxas(x);
                  return <tr key={o}><td>{ORIGEM_NOME[o]}</td><td className="n">{n(x.recebidas)}</td><td className="n">{n(x.trabalhadas)}</td><td className="n">{n(x.atendidas)}</td>
                    <td className="n">{n(x.agendadas)}</td><td className="n">{n(x.realizadas)}</td><td className="n">{n(x.fechados)}</td>
                    <td className="n">{tx.contacto}</td><td className="n">{tx.agendamento}</td><td className="n">{tx.comparencia}</td><td className="n">{tx.fecho}</td><td className="n">{tx.negocio}</td></tr>;
                })}
                {!Object.keys(d.por_origem || {}).length && <tr><td colSpan={12} className="muted">Sem leads no período.</td></tr>}</tbody></table>
            </div>
          </div>

          <div className="op-grid">
            <div className="op-card"><h2>Atividade</h2>
              <div className="note">Trabalho da OPERA no período.</div>
              <div className="act">
                <div><span>Contactos realizados</span><b>{n(d.atividade?.contactos)}</b><small>Chamadas e mensagens</small></div>
                <div><span>Tentativas por lead</span><b>{dec(d.atividade?.tentativas_por_lead)}</b><small>Média</small></div>
                <div><span>Follow ups em atraso</span><b className={n(d.atividade?.followups_atraso) ? "op-bad" : ""}>{n(d.atividade?.followups_atraso)}</b><small>A tratar hoje</small></div>
                <div><span>Lead a reunião</span><b>{d.atividade?.lead_a_reuniao_dias != null ? `${dec(d.atividade.lead_a_reuniao_dias)} dias` : "—"}</b><small>Tempo médio</small></div>
                <div><span>Recuperadas da BD</span><b>{n(d.atividade?.recuperadas_bd)}</b><small>Reuniões de leads de BD</small></div>
              </div>
            </div>
            <div className="op-card"><h2>Motivos de desqualificação</h2>
              <div className="note">Por ordem de frequência.</div>
              {!motivos.length && <div className="muted">Sem leads desqualificadas no período.</div>}
              {motivos.map((m) => (
                <div key={m.motivo} className="op-bar"><div className="row"><span>{m.motivo}</span><b>{n(m.n)}</b></div>
                  <div className="track"><div className="fill" style={{ width: `${(n(m.n) / maxM) * 100}%`, backgroundColor: "#9B8CFF" }}></div></div></div>))}
            </div>
          </div>

          <div className="op-card"><h2>Comparação entre clientes de setting</h2>
            <div className="note">O setting interno da OPERA como referência entra numa próxima versão.</div>
            <div className="op-table-wrap">
              <table className="op-table"><thead><tr><th>Cliente</th><th className="n">Reuniões</th><th className="n">Agendamento</th><th className="n">Comparência</th><th className="n">Fecho</th><th>Faltas e remarcações</th></tr></thead>
                <tbody>{(d.por_cliente || []).map((c) => {
                  const tx = taxas(c);
                  return <tr key={c.id}><td><span className="dot" style={{ background: c.color }}></span>{c.name}</td>
                    <td className="n">{n(c.agendadas)}</td><td className="n">{tx.agendamento}</td><td className="n">{tx.comparencia}</td><td className="n">{tx.fecho}</td>
                    <td>{n(c.faltas)} {n(c.faltas) === 1 ? "falta" : "faltas"}, {n(c.remarcadas)} {n(c.remarcadas) === 1 ? "remarcada" : "remarcadas"}</td></tr>;
                })}</tbody></table>
            </div>
          </div>
        </>)}
      </>)}
    </div>
  );
}
