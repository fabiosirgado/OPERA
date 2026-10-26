import { useEffect, useState } from "react";
import { sb } from "../supabase.js";
import { MAX_CLIENTS_PER_MANAGER, fmtDur } from "../lib/format.js";
import { useAction } from "../ui/feedback.jsx";

const PERIODS = [["1", "Hoje"], ["7", "7 dias"], ["30", "30 dias"], ["0", "Tudo"]];
const TTL_BUCKETS = ["Até 15 min", "15 a 30 min", "30 a 60 min", "1 a 4 h", "Mais de 4 h", "Por contactar"];
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const dec = (n) => n.toFixed(1).replace(".", ",");

// Dashboard: a equipa OPERA vê todos os clientes; cada cliente vê só os seus números (sem a ocupação dos gestores).
// Números calculados no servidor.
export default function Dashboard({ ctx, isAdmin, opera }) {
  const { clients } = ctx;
  const [client, setClient] = useState("");
  const [period, setPeriod] = useState("7");
  const [d, setD] = useState(null);
  const [managers, setManagers] = useState([]);
  const [run] = useAction();

  useEffect(() => {
    run(async () => {
      const [dash, load] = await Promise.all([
        sb.rpc("leads_dashboard", { p_client: client || null, p_period: period }),
        opera ? sb.rpc("leads_managers_load") : Promise.resolve({ data: [] }),
      ]);
      if (dash.error) throw dash.error;
      setD(dash.data);
      setManagers(load.data || []);
    });
  }, [client, period, opera, ctx.version, run]);

  const setTarget = async (v) => {
    const m = Math.max(1, Math.min(240, Number(v) || 15));
    if (await run(async () => { const { error } = await sb.rpc("leads_set_ttl_target", { p_minutes: m }); if (error) throw error; }, `Objetivo do Time to Lead: ${m} min`)) {
      setD((x) => ({ ...x, ttl_target: m }));
    }
  };

  const clientName = clients.find((c) => c.id === client)?.name;

  return (
    <>
      <div className="top">
        <div><h1>Dashboard</h1><div className="sub">{opera
          ? `Desempenho da OPERA na gestão de leads${clientName ? ` · ${clientName}` : ""}`
          : `As vossas leads e o trabalho da OPERA${clients[0] ? ` · ${clients[0].name}` : ""}`}</div></div>
        <div className="row">
          {opera && (
            <label className="f" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>Cliente
              <select value={client} onChange={(e) => setClient(e.target.value)} style={{ minHeight: 40 }}>
                <option value="">Todos os clientes</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>)}
          <div className="pills" role="group" aria-label="Período">
            {PERIODS.map(([v, l]) => <button key={v} type="button" className={`pill ${period === v ? "on" : ""}`} aria-pressed={period === v} onClick={() => setPeriod(v)}>{l}</button>)}
          </div>
        </div>
      </div>

      {!d ? <div className="empty">A calcular…</div> : (
        <div className="dgrid">
          <div className={`panel ${opera ? "s6" : "s12"} hero`}>
            <span className="lbl">Time to Lead (mediana)</span>
            <span className="big">{d.ttl_median == null ? "—" : fmtDur(d.ttl_median)}</span>
            <TtlStatus m={d.ttl_median} target={d.ttl_target} />
            <span className="meta">Tempo entre a chegada da lead ao sistema e a primeira chamada, atendida ou não, contado só no horário de trabalho (segunda a sexta, das 9:30 às 19:00, sem feriados). Conta só leads Meta e de portais; as leads BD ficam de fora.{" "}
              Objetivo: até {isAdmin
                ? <input aria-label="Objetivo do Time to Lead em minutos" type="number" min={1} max={240} defaultValue={d.ttl_target} key={d.ttl_target}
                    onBlur={(e) => Number(e.target.value) !== d.ttl_target && setTarget(e.target.value)}
                    style={{ width: 56, minHeight: 28, border: "1px solid var(--line2)", borderRadius: 6, padding: "0 6px" }} />
                : d.ttl_target} min. Média {d.ttl_avg == null ? "—" : fmtDur(d.ttl_avg)}.</span>
            <span className="meta"><b>{pct(d.ttl_in_target, d.ttl_n)}</b> contactadas em até {d.ttl_target} min · <b>{pct(d.ttl_in_60, d.ttl_n)}</b> em até 1 h · <b>{d.pending}</b> ainda por contactar</span>
            <Bars items={TTL_BUCKETS.map((l, i) => ({ l, v: d.ttl_buckets[i] }))} muteLast />
          </div>

          {opera && <div className="panel s6">
            <h3>Taxa de ocupação por gestor de leads</h3>
            <div className="sub" style={{ margin: "4px 0", fontSize: 13 }}>Máximo de {MAX_CLIENTS_PER_MANAGER} clientes por gestor</div>
            {managers.length === 0 && <div className="empty">Ainda não há gestores.</div>}
            {managers.map((m) => <Occupancy key={m.id} m={m} />)}
            {isAdmin && <div className="row" style={{ marginTop: 8 }}><button type="button" className="btn sm" onClick={() => ctx.onGo("clientes")}>Atribuir clientes a gestores</button></div>}
          </div>}

          <div className="stat s3"><span>Leads que entraram</span><b>{d.leads_in}</b><small>{dec(d.leads_in / d.days)} por dia</small></div>
          <div className="stat s3"><span>Chamadas feitas</span><b>{d.calls}</b><small>{pct(d.answered, d.calls)} atendidas · {d.leads_in ? dec(d.calls / d.leads_in) : "0"} por lead</small></div>
          <div className="stat s3"><span>Atividades concluídas</span><b>{d.acts.call + d.acts.meeting + d.acts.followup}</b>
            <small>{d.acts.call} chamadas · {d.acts.meeting} reuniões · {d.acts.followup} follow ups</small></div>
          <div className={`stat s3 ${d.overdue ? "warn" : ""}`}><span>Tarefas atrasadas agora</span><b>{d.overdue}</b><small>Independente do período</small></div>
          <div className="stat s3"><span>Leads qualificadas</span><b>{d.qual}</b><small>Tempo até qualificar: {d.time_to_qualify == null ? "—" : fmtDur(d.time_to_qualify)}</small></div>
          <div className="stat s3"><span>Leads desqualificadas</span><b>{d.desq}</b><small>No período</small></div>
          <div className="stat s3"><span>Taxa de qualificação</span><b>{pct(d.qual, d.qual + d.desq)}</b><small>Qualificadas sobre decididas</small></div>
          <div className="stat s3" style={{ borderColor: "#A7E3C0", background: "var(--greenSoft)" }}>
            <span style={{ color: "var(--greenText)" }}>Leads recuperadas</span><b style={{ color: "var(--greenText)" }}>{d.recovered}</b>
            <small style={{ color: "var(--greenText)" }}>Leads BD que passaram a qualificadas · {pct(d.recovered, d.bd_worked)} das leads BD trabalhadas</small></div>

          <div className="stat s3"><span>Qualificadas: compradores</span><b>{d.qual_types.comprador}</b><small>{pct(d.qual_types.comprador, d.qual)} das qualificadas</small></div>
          <div className="stat s3"><span>Qualificadas: proprietários</span><b>{d.qual_types.proprietario}</b><small>{pct(d.qual_types.proprietario, d.qual)} das qualificadas</small></div>
          <div className="stat s3"><span>Qualificadas: crédito</span><b>{d.qual_types.credito}</b><small>{pct(d.qual_types.credito, d.qual)} das qualificadas</small></div>
          <div className="stat s3"><span>Qualificadas sem tipo</span><b>{d.qual_types.sem_tipo}</b><small>Uma lead pode ter mais de um tipo</small></div>

          {period !== "1" && (
            <div className="panel s12">
              <div className="top" style={{ gap: 8 }}><h3>Leads que entraram por dia</h3>
                <span className="sub" style={{ margin: 0, fontSize: 13 }}>
                  Total {d.per_day.reduce((a, b) => a + b.v, 0)} · média {dec(d.per_day.reduce((a, b) => a + b.v, 0) / d.per_day.length)} por dia · máximo {Math.max(0, ...d.per_day.map((a) => a.v))}</span></div>
              <LineChart data={d.per_day} />
            </div>
          )}
          <div className="panel s6"><h3>Leads por origem</h3>{d.by_source.length ? <Bars items={d.by_source} /> : <div className="empty">Sem leads no período.</div>}</div>
          <div className="panel s6"><h3>Atividades concluídas por tipo</h3>
            <Bars items={[{ l: "Chamada", v: d.acts.call }, { l: "Reunião", v: d.acts.meeting }, { l: "Follow up", v: d.acts.followup }]} /></div>

          {opera && !client && (
            <div className="panel s12"><h3>Por cliente</h3>
              <div className="tbl"><table>
                <thead><tr><th>Cliente</th><th>Gestor</th><th className="n">Leads</th><th className="n">Time to Lead</th><th className="n">Até {d.ttl_target} min</th>
                  <th className="n">Chamadas</th><th className="n">Qualificadas</th><th className="n">Desqualificadas</th><th className="n">Taxa</th><th className="n">Recuperadas</th><th className="n">Atrasadas</th></tr></thead>
                <tbody>{d.per_client.map((c) => (
                  <tr key={c.id}>
                    <td><button type="button" className="link" onClick={() => setClient(c.id)}>{c.name}</button></td>
                    <td>{c.manager || "Sem gestor"}</td><td className="n">{c.leads_in}</td>
                    <td className="n">{c.ttl_median == null ? "—" : fmtDur(c.ttl_median)}</td><td className="n">{pct(c.ttl_in_target, c.ttl_n)}</td>
                    <td className="n">{c.calls}</td><td className="n">{c.qual}</td><td className="n">{c.desq}</td><td className="n">{pct(c.qual, c.qual + c.desq)}</td>
                    <td className="n">{c.recovered}</td><td className="n">{c.overdue}</td>
                  </tr>))}</tbody>
              </table></div>
            </div>
          )}
        </div>
      )}
      <div className="foot">Os números são calculados a partir do histórico de cada lead: chamadas registadas, mudanças de etapa e tarefas concluídas.</div>
    </>
  );
}

function TtlStatus({ m, target }) {
  if (m == null) return null;
  if (m <= target) return <span className="status st-good">✓ Dentro do objetivo</span>;
  if (m <= 60) return <span className="status st-warn">! Acima do objetivo</span>;
  return <span className="status st-bad">! Lento</span>;
}

// Barras horizontais com o valor escrito ao lado (o título dá o valor ao passar o rato).
function Bars({ items, muteLast }) {
  const max = Math.max(1, ...items.map((i) => i.v));
  return (
    <div className="bars">{items.map((i, k) => (
      <div key={i.l} className="bar" title={`${i.l}: ${i.v}`}>
        <span className="bl">{i.l}</span>
        <span className="bt"><span className={`bf ${muteLast && k === items.length - 1 ? "mute" : ""}`} style={{ width: `${(i.v / max) * 100}%` }} /></span>
        <span className="bv">{i.v}</span>
      </div>))}
    </div>
  );
}

function Occupancy({ m }) {
  const n = m.clients.length;
  const r = n / MAX_CLIENTS_PER_MANAGER;
  const st = r >= 1 ? <span className="status st-bad">■ Cheio</span>
    : n >= 6 ? <span className="status st-warn">▲ Quase cheio</span> : <span className="status st-good">● Com capacidade</span>;
  return (
    <div className="occ">
      <div className="hd"><b style={{ flex: 1 }}>{m.name}</b>{st}<b style={{ fontVariantNumeric: "tabular-nums" }}>{Math.round(r * 100)}%</b></div>
      <div className="meter" role="img" aria-label={`${n} de ${MAX_CLIENTS_PER_MANAGER} clientes`}>
        {Array.from({ length: MAX_CLIENTS_PER_MANAGER }, (_, i) => <span key={i} className={`seg ${i < n ? "on" : ""} ${r >= 1 ? "full" : ""}`} />)}
      </div>
      <div className="sub" style={{ margin: 0, fontSize: 13 }}>
        {n} de {MAX_CLIENTS_PER_MANAGER} clientes{n ? `: ${m.clients.map((c) => c.name).join(", ")}` : ""} · {m.leads_working} leads em trabalho · {m.overdue} tarefas atrasadas</div>
    </div>
  );
}

// Linha das leads por dia, como no protótipo: grelha discreta, área suave e dica ao passar o rato em cada dia.
function LineChart({ data }) {
  const W = 900, H = 220, L = 36, R = 12, T = 14, B = 28, n = data.length;
  const raw = Math.max(1, ...data.map((a) => a.v));
  const step = raw <= 4 ? 1 : raw <= 10 ? 2 : raw <= 20 ? 5 : raw <= 100 ? 10 : Math.ceil(raw / 50) * 10;
  const m = Math.ceil(raw / step) * step;
  const x = (i) => L + (n === 1 ? 0 : (i * (W - L - R)) / (n - 1));
  const y = (v) => T + (H - T - B) * (1 - v / m);
  const line = data.map((a, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(a.v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(n - 1).toFixed(1)} ${y(0)} L${x(0).toFixed(1)} ${y(0)} Z`;
  const grid = []; for (let v = 0; v <= m; v += step) grid.push(v);
  const fmtD = (d) => new Date(`${d}T12:00:00`).toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit" });
  const every = Math.ceil(n / 8);
  const slot = (W - L - R) / Math.max(1, n - 1);
  return (
    <svg className="lc" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Leads por dia, de ${fmtD(data[0].d)} a hoje`}>
      {grid.map((v) => (
        <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="gr" /><text x={L - 8} y={y(v) + 4} textAnchor="end" className="ax">{v}</text></g>))}
      <path d={area} className="ar" /><path d={line} className="ln" />
      {data.map((a, i) => ((i % every === 0 && n - 1 - i >= Math.ceil(every * 0.7)) || i === n - 1) && (
        <text key={`x${i}`} x={x(i)} y={H - 8} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} className="ax">{i === n - 1 ? "Hoje" : fmtD(a.d)}</text>))}
      {data.map((a, i) => (
        <g key={`p${i}`} className="pt">
          <rect x={x(i) - slot / 2} y={T} width={slot} height={H - T - B} className="hit" />
          <line x1={x(i)} x2={x(i)} y1={T} y2={y(0)} className="cr" />
          <circle cx={x(i)} cy={y(a.v)} r={4.5} className="dt" />
          <text x={Math.min(Math.max(x(i), L + 40), W - R - 40)} y={Math.max(y(a.v) - 12, T + 10)} textAnchor="middle" className="tip">
            {fmtD(a.d)}: {a.v} {a.v === 1 ? "lead" : "leads"}</text>
        </g>))}
    </svg>
  );
}
