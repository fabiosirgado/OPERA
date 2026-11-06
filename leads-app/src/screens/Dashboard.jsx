import { Fragment, useEffect, useState } from "react";
import { sb } from "../supabase.js";
import { MAX_CLIENTS_PER_MANAGER, fmtDur, localInput } from "../lib/format.js";
import { useAction } from "../ui/feedback.jsx";

const PERIODS = [["1", "Hoje"], ["7", "7 dias"], ["30", "30 dias"], ["0", "Tudo"], ["custom", "Personalizado"]];
const TTL_BUCKETS = ["Até 15 min", "15 a 30 min", "30 a 60 min", "1 a 4 h", "Mais de 4 h", "Por contactar"];
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const dec = (n) => n.toFixed(1).replace(".", ",");
// Segundos em minutos e segundos (ex.: 3:25); totais longos em horas.
const mmss = (s) => { if (s == null) return "—"; const t = Math.round(s); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };
const hours = (s) => (s >= 3600 ? `${dec(s / 3600)} h` : `${Math.round(s / 60)} min`);
const todayISO = () => localInput(Date.now()).slice(0, 10);
const monthStartISO = () => `${todayISO().slice(0, 8)}01`;

// Gráfico por dia; em períodos de mais de 3 meses, os dias juntam-se por semana (a começar no primeiro dia).
function perBucket(days) {
  if (days.length <= 92) return { unit: "dia", data: days };
  const data = [];
  for (let i = 0; i < days.length; i += 7) {
    const w = days.slice(i, i + 7);
    data.push({ d: w[0].d, v: w.reduce((a, b) => a + b.v, 0) });
  }
  return { unit: "semana", data };
}

// Dashboard: a equipa OPERA vê todos os clientes; cada cliente vê só os seus números (sem a ocupação dos gestores).
// Números calculados no servidor.
export default function Dashboard({ ctx, isAdmin, opera }) {
  const { clients } = ctx;
  const [client, setClient] = useState("");
  const [period, setPeriod] = useState("7");
  const [range, setRange] = useState(() => ({ from: monthStartISO(), to: todayISO() }));
  const rangeOk = range.from && range.to && range.from <= range.to;
  const [d, setD] = useState(null);
  const [managers, setManagers] = useState([]);
  const [rank, setRank] = useState(null);
  const [activity, setActivity] = useState(null);
  const [run] = useAction();

  useEffect(() => {
    if (period === "custom" && !rangeOk) return;
    const custom = period === "custom" ? { p_from: range.from, p_to: range.to } : {};
    run(async () => {
      const [dash, load, rk, act] = await Promise.all([
        sb.rpc("leads_dashboard", { p_client: client || null, p_period: period, ...custom }),
        isAdmin ? sb.rpc("leads_managers_load") : Promise.resolve({ data: [] }),
        opera ? sb.rpc("leads_qualified_ranking", { p_client: client || null, p_period: period, ...custom }) : Promise.resolve({ data: null }),
        isAdmin ? sb.rpc("leads_managers_activity", { p_period: period, ...custom }) : Promise.resolve({ data: null }),
      ]);
      if (dash.error) throw dash.error;
      setD(dash.data);
      setManagers(load.data || []);
      setRank(rk.data || null);
      setActivity(act.data || null);
    });
  }, [client, period, range.from, range.to, rangeOk, opera, isAdmin, ctx.version, run]);

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
          {period === "custom" && (
            <div className="row periodo" role="group" aria-label="Período personalizado">
              <label className="f">De
                <input type="date" value={range.from} max={range.to || undefined} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} /></label>
              <label className="f">Até
                <input type="date" value={range.to} min={range.from || undefined} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} /></label>
              {!rangeOk && <span className="sub" role="alert" style={{ margin: 0, color: "var(--redText)" }}>A data de início tem de ser antes da data de fim.</span>}
            </div>
          )}
        </div>
      </div>

      {!d ? <div className="empty">A calcular…</div> : (
        <div className="dgrid">
          {/* Time to Lead: só a equipa OPERA vê (mede a rapidez da OPERA, não do cliente). */}
          {opera && <div className={`panel ${isAdmin ? "s6" : "s12"} hero`}>
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
          </div>}

          {/* Ocupação dos gestores: só o admin vê (o servidor também o impõe). */}
          {isAdmin && <div className="panel s6">
            <h3>Clientes por gestor de leads</h3>
            <div className="sub" style={{ margin: "4px 0", fontSize: 13 }}>Máximo de {MAX_CLIENTS_PER_MANAGER} clientes por gestor</div>
            {managers.length === 0 && <div className="empty">Ainda não há gestores.</div>}
            {managers.map((m) => <Occupancy key={m.id} m={m} />)}
            {isAdmin && <div className="row" style={{ marginTop: 8 }}><button type="button" className="btn sm" onClick={() => ctx.onGo("clientes")}>Atribuir clientes a gestores</button></div>}
          </div>}

          <div className="stat s6"><span>Leads que entraram</span><b>{d.leads_in}</b><small>{dec(d.leads_in / d.days)} por dia{d.calls_new != null ? ` · ${d.calls_new} ${d.calls_new === 1 ? "chamada" : "chamadas"} a estas leads` : ""}</small></div>
          <div className={`stat s6 ${d.overdue ? "warn" : ""}`}><span>Tarefas atrasadas agora</span><b>{d.overdue}</b><small>Independente do período</small></div>
          {/* Chamadas feitas = atendidas (conversa de 10 segundos ou mais) + tentativas (não atendidas ou mais curtas). */}
          <div className="stat s4"><span>Chamadas feitas</span><b>{d.calls}</b>
            <small>A {d.leads_called ?? 0} leads · {d.leads_called ? dec(d.calls / d.leads_called) : "0"} por lead</small></div>
          <div className="stat s4"><span>Chamadas atendidas</span><b>{d.answered}</b>
            <small>{pct(d.answered, d.calls)} das chamadas feitas · conversa de 10 s ou mais</small></div>
          <div className="stat s4"><span>Tentativas</span><b>{d.attempts ?? d.calls - d.answered}</b>
            <small>{pct(d.attempts ?? d.calls - d.answered, d.calls)} das chamadas feitas · não atendidas ou com menos de 10 s</small></div>
          {/* Conversas: chamadas atendidas com 1 minuto ou mais. O tempo e as horas contam só estas. */}
          <div className="stat s4"><span>Conversas</span><b>{d.call_time?.n ?? 0}</b>
            <small>Chamadas atendidas com 1 min ou mais · {pct(d.call_time?.n ?? 0, d.answered)} das atendidas</small></div>
          <div className="stat s4"><span>Tempo médio de conversa</span><b>{mmss(d.call_time?.avg_s)}</b>
            <small>Mediana {mmss(d.call_time?.median_s)} · só conversas de 1 min ou mais</small></div>
          {/* Ocupação: todo o tempo em chamada (a chamar e em conversa), feitas e recebidas, atendidas ou não. */}
          <div className="stat s4"><span>Horas em chamada</span><b>{hours(d.call_hours?.total_s ?? 0)}</b>
            <small>Todo o tempo ao telefone, a chamar e em conversa{opera && !client ? ", incluindo as leads da OPERA" : ""} ·{hours(d.call_hours?.out_s ?? 0)} em chamadas feitas, {hours(d.call_hours?.in_s ?? 0)} em recebidas</small></div>
          <div className="stat s3"><span>Leads qualificadas</span><b>{d.qual}</b><small>Decididas no período, incluindo leads de antes · Tempo até qualificar: {d.time_to_qualify == null ? "—" : fmtDur(d.time_to_qualify)}</small></div>
          <div className="stat s3"><span>Leads desqualificadas</span><b>{d.desq}</b><small>Decididas no período, incluindo leads de antes</small></div>
          <div className="stat s3"><span>Taxa de qualificação</span><b>{pct(d.qual, d.qual + d.desq)}</b><small>Qualificadas sobre decididas</small></div>
          <div className="stat s3" style={{ borderColor: "#A7E3C0", background: "var(--greenSoft)" }}>
            <span style={{ color: "var(--greenText)" }}>Leads recuperadas</span><b style={{ color: "var(--greenText)" }}>{d.recovered}</b>
            <small style={{ color: "var(--greenText)" }}>Leads BD que passaram a qualificadas · {pct(d.recovered, d.bd_worked)} das leads BD trabalhadas</small></div>

          <div className="stat s4"><span>Qualificadas: compradores</span><b>{d.qual_types.comprador}</b><small>{pct(d.qual_types.comprador, d.qual)} das qualificadas</small></div>
          <div className="stat s4"><span>Qualificadas: proprietários</span><b>{d.qual_types.proprietario}</b><small>{pct(d.qual_types.proprietario, d.qual)} das qualificadas</small></div>
          <div className="stat s4"><span>Qualificadas: crédito</span><b>{d.qual_types.credito}</b><small>{pct(d.qual_types.credito, d.qual)} das qualificadas</small></div>
          <div className="stat s4"><span>Qualificadas: arrendamento</span><b>{d.qual_types.arrendamento ?? 0}</b><small>{pct(d.qual_types.arrendamento ?? 0, d.qual)} das qualificadas</small></div>
          <div className="stat s4"><span>Qualificadas: senhorios</span><b>{d.qual_types.senhorio ?? 0}</b><small>{pct(d.qual_types.senhorio ?? 0, d.qual)} das qualificadas</small></div>
          <div className="stat s4"><span>Qualificadas sem tipo</span><b>{d.qual_types.sem_tipo}</b><small>Uma lead pode ter mais de um tipo</small></div>

          {d.per_day.length > 1 && (() => {
            const b = perBucket(d.per_day);
            const total = d.per_day.reduce((a, x) => a + x.v, 0);
            return (
              <div className="panel s12">
                <div className="top" style={{ gap: 8 }}><h3>Leads que entraram por {b.unit}</h3>
                  <span className="sub" style={{ margin: 0, fontSize: 13 }}>
                    Total {total} · média {dec(total / d.per_day.length)} por dia · máximo {Math.max(0, ...b.data.map((a) => a.v))} por {b.unit}</span></div>
                <LineChart data={b.data} endsToday={d.to === todayISO()} unit={b.unit} />
              </div>
            );
          })()}
          <div className="panel s6"><h3>Leads por origem</h3>{d.by_source.length ? <Bars items={d.by_source} /> : <div className="empty">Sem leads no período.</div>}</div>
          <div className="panel s6"><h3>Atividades concluídas por tipo</h3>
            <div className="sub" style={{ margin: "4px 0", fontSize: 13 }}>Total {d.acts.call + d.acts.meeting + d.acts.followup} no período</div>
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

          {isAdmin && activity && <ManagersActivity a={activity} />}

          {opera && rank && <QualifiedRanking rank={rank} byClient={!client} periodAll={period === "0"} onClient={setClient} />}
        </div>
      )}
      <div className="foot">Os números são calculados a partir do histórico de cada lead: chamadas registadas, mudanças de etapa e tarefas concluídas.</div>
    </>
  );
}

// Segundos em horas e minutos (ex.: 6h 32m).
const hm = (s) => { const m = Math.round((s || 0) / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`; };
const fmtDia = (d) => new Date(`${d}T12:00:00`).toLocaleDateString("pt-PT", { weekday: "short", day: "2-digit", month: "2-digit" });

// Linha do dia: das 8:00 às 20:00, o tempo a trabalhar (da primeira à última chamada) com as pausas e o almoço por cima.
const DL_FROM = 8 * 60, DL_TO = 20 * 60;
const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const dlPos = (hhmm) => `${((Math.min(Math.max(toMin(hhmm), DL_FROM), DL_TO) - DL_FROM) / (DL_TO - DL_FROM)) * 100}%`;
const dlSpan = (a, b) => ({ left: dlPos(a), width: `calc(${dlPos(b)} - ${dlPos(a)})` });

function DayAxis() {
  return (
    <div className="dl-axis">{[8, 10, 12, 14, 16, 18, 20].map((h) => (
      <span key={h} style={{ left: dlPos(`${h}:00`) }}>{h}h</span>))}</div>
  );
}

function DayLine({ x }) {
  const segs = [
    ...(x.pausas_lista || []).map((p) => ({ ...p, kind: "pausa", label: `Pausa ${p.de}–${p.ate} · ${hm(p.s)}` })),
    ...(x.almoco_de ? [{ de: x.almoco_de, ate: x.almoco_ate, s: x.almoco_s, kind: "almoco", label: `Almoço ${x.almoco_de}–${x.almoco_ate} · ${hm(x.almoco_s)}` }] : []),
  ];
  return (
    <div className="dl" role="img" aria-label={`A trabalhar das ${x.primeira} às ${x.ultima}. ${segs.map((s) => s.label).join(". ")}`}>
      {[10, 12, 14, 16, 18].map((h) => <i key={h} className="dl-tick" style={{ left: dlPos(`${h}:00`) }} />)}
      <span className="dl-work" style={dlSpan(x.primeira, x.ultima)} title={`A trabalhar das ${x.primeira} às ${x.ultima}`} />
      {segs.map((s) => (
        <span key={s.de} className={`dl-seg ${s.kind === "almoco" ? "dl-lunch" : "dl-pause"}`} style={dlSpan(s.de, s.ate)} title={s.label} tabIndex={0}>
          {s.s >= 25 * 60 ? <em>{hm(s.s)}</em> : null}</span>))}
    </div>
  );
}

// Ocupação dos gestores a partir das chamadas, dia a dia (só o admin): tempo ao telefone, tempo ativo e ocupação
// sobre um dia de 8 horas. Os intervalos de mais de 10 minutos sem chamadas são pausas e não contam.
function ManagersActivity({ a }) {
  const [who, setWho] = useState("");
  const days = a.days.filter((x) => !who || x.user_id === who);
  const occ = (o) => <span className={`status ${o >= 0.75 ? "st-good" : o >= 0.5 ? "st-warn" : "st-bad"}`}>{Math.round(o * 100)}%</span>;
  return (
    <div className="panel s12"><h3>Ocupação dos gestores</h3>
      <div className="sub" style={{ margin: "4px 0", fontSize: 13 }}>
        Tempo ativo = tempo ao telefone (a chamar e em conversa, chamadas feitas e recebidas) mais os intervalos entre chamadas de até {a.pause_min} minutos.
        Intervalos maiores são pausas e não contam (o almoço fica de fora). Ocupação = tempo ativo sobre um dia de {a.workday_h} horas. As médias não contam o dia de hoje, que ainda está a decorrer. Só o admin vê.</div>
      {a.per_user.length === 0 ? <div className="empty">Sem chamadas no período.</div> : (
        <>
          <div className="tbl"><table>
            <thead><tr><th>Gestor</th><th className="n">Dias com chamadas</th><th className="n">Chamadas</th><th className="n">Conversas</th>
              <th className="n">Ao telefone por dia</th><th className="n">Tempo ativo por dia</th><th className="n">Ocupação média</th><th className="n">Total ativo</th></tr></thead>
            <tbody>{a.per_user.map((u) => (
              <tr key={u.user_id}><td><button type="button" className="link" onClick={() => setWho(who === u.user_id ? "" : u.user_id)}>{u.name}</button></td>
                <td className="n">{u.dias}</td><td className="n">{u.chamadas}</td><td className="n">{u.conversas}</td>
                <td className="n">{hm(u.phone_day_s)}</td><td className="n"><b>{hm(u.active_day_s)}</b></td><td className="n">{occ(u.ocupacao)}</td><td className="n">{hm(u.active_s)}</td></tr>))}</tbody>
          </table></div>
          <h3 style={{ margin: "16px 0 4px" }}>Dia a dia{who ? ` · ${a.per_user.find((u) => u.user_id === who)?.name}` : ""}</h3>
          <div className="sub" style={{ margin: "0 0 8px", fontSize: 13 }}>Carrega no nome de um gestor para ver só os dias dele.
            Na linha do dia, as pausas grandes mostram a duração; passa o rato por cima de qualquer pausa para ver as horas exatas.</div>
          <div className="row" style={{ gap: 14, fontSize: 12, margin: "0 0 6px" }} aria-hidden="true">
            <span><i className="dl-key" style={{ background: "var(--blue)" }} /> A trabalhar</span>
            <span><i className="dl-key" style={{ background: "#F59E0B" }} /> Pausa (mais de {a.pause_min} min)</span>
            <span><i className="dl-key dl-lunch" /> Almoço</span>
          </div>
          <div className="dl-grid">
            <span /><DayAxis />
            {days.map((x) => (
              <Fragment key={`${x.user_id}-${x.dia}`}>
                <span className="dl-label">{!who && <b>{x.name.split(" ")[0]} · </b>}{fmtDia(x.dia)}{x.em_curso ? " · em curso" : ""}</span>
                <DayLine x={x} />
              </Fragment>))}
          </div>
          <div className="tbl" style={{ marginTop: 12 }}><table>
            <thead><tr>{!who && <th>Gestor</th>}<th>Dia</th><th className="n">Primeira</th><th className="n">Última</th><th className="n">Tempo ativo</th><th className="n">Ocupação</th>
              <th className="n">Ao telefone</th><th className="n">Chamadas</th><th className="n">Conversas</th><th className="n">Almoço</th><th className="n">Pausas</th></tr></thead>
            <tbody>{days.map((x) => (
              <tr key={`${x.user_id}-${x.dia}`}>{!who && <td>{x.name}</td>}
                <td style={{ whiteSpace: "nowrap" }}>{fmtDia(x.dia)}{x.em_curso ? <div className="sub" style={{ margin: 0, fontSize: 12 }}>em curso</div> : ""}</td>
                <td className="n">{x.primeira}</td><td className="n">{x.ultima}</td>
                <td className="n"><b>{hm(x.active_s)}</b></td><td className="n">{occ(x.ocupacao)}</td>
                <td className="n">{hm(x.phone_s)}</td><td className="n">{x.chamadas}</td><td className="n">{x.conversas}</td>
                <td className="n" style={{ whiteSpace: "nowrap" }}>{x.almoco_de
                  ? <span style={x.almoco_s > 3600 ? { color: "var(--redText)", fontWeight: 600 } : undefined}>{hm(x.almoco_s)}</span> : "—"}</td>
                <td className="n" style={{ whiteSpace: "nowrap" }}>{x.pausas ? `${x.pausas} · ${hm(x.pausas_s)}` : "0"}</td></tr>))}</tbody>
          </table></div>
        </>
      )}
    </div>
  );
}

const QUAL_TYPES = [["comprador", "Comprador"], ["proprietario", "Proprietário"], ["credito", "Crédito"],
  ["arrendamento", "Arrendamento"], ["senhorio", "Senhorio"], ["sem_tipo", "Sem tipo"]];

// Rankings de leads qualificadas (só a equipa OPERA): por cliente, por gestor e, em cada tipo, os clientes com mais.
// Cada lead conta uma vez; uma lead pode ter vários tipos, por isso os tipos somam mais do que o total.
function QualifiedRanking({ rank, byClient, periodAll, onClient }) {
  const [sortBy, setSortBy] = useState("total");
  const rows = [...rank.by_client].sort((a, b) => b[sortBy] - a[sortBy] || b.total - a.total || a.name.localeCompare(b.name));
  const types = QUAL_TYPES.filter(([k]) => rank.types[k] > 0);
  const scope = periodAll ? "Desde o início" : "No período escolhido";
  return (
    <>
      {byClient && (
        <div className="panel s12"><h3>Ranking de leads qualificadas por cliente</h3>
          <div className="sub" style={{ margin: "4px 0", fontSize: 13 }}>{scope} · {rank.total} leads qualificadas · carrega num tipo para ordenar por ele. Uma lead pode ter mais de um tipo.</div>
          {rows.length === 0 ? <div className="empty">Sem leads qualificadas.</div> : (
            <div className="tbl"><table>
              <thead><tr><th className="n">#</th><th>Cliente</th>
                {[["total", "Total"], ...types].map(([k, l]) => (
                  <th key={k} className="n" aria-sort={sortBy === k ? "descending" : "none"}>
                    <button type="button" className={`sort ${sortBy === k ? "on" : ""}`} onClick={() => setSortBy(k)}>{l}</button></th>))}</tr></thead>
              <tbody>{rows.map((c, i) => (
                <tr key={c.id}>
                  <td className="n">{c[sortBy] ? i + 1 : "—"}</td>
                  <td><button type="button" className="link" onClick={() => onClient(c.id)}>
                    <span className="dot" style={{ width: 8, height: 8, flex: "0 0 8px", background: c.color, display: "inline-block", marginRight: 6 }}></span>{c.name}</button></td>
                  {[["total"], ...types].map(([k]) => <td key={k} className="n">{k === sortBy || k === "total" ? <b>{c[k]}</b> : c[k]}</td>)}
                </tr>))}</tbody>
            </table></div>
          )}
        </div>
      )}

      <div className="panel s12"><h3>Ranking de leads qualificadas por gestor</h3>
        <div className="sub" style={{ margin: "4px 0", fontSize: 13 }}>{scope} · quem passou a lead a qualificada</div>
        {rank.by_person.length === 0 ? <div className="empty">Sem leads qualificadas.</div> : (
          <div className="tbl"><table>
            <thead><tr><th className="n">#</th><th>Gestor</th><th className="n">Total</th>{types.map(([k, l]) => <th key={k} className="n">{l}</th>)}</tr></thead>
            <tbody>{rank.by_person.map((p, i) => (
              <tr key={p.name}><td className="n">{i + 1}</td><td>{p.name}</td><td className="n"><b>{p.total}</b></td>
                {types.map(([k]) => <td key={k} className="n">{p[k]}</td>)}</tr>))}</tbody>
          </table></div>
        )}
      </div>

      <div className="panel s12"><h3>Leads qualificadas por tipo</h3>
        <div className="sub" style={{ margin: "4px 0 10px", fontSize: 13 }}>{scope}{byClient ? " · ranking dos clientes em cada tipo" : ""}</div>
        {types.length === 0 ? <div className="empty">Sem leads qualificadas.</div> : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            {types.map(([k, l]) => {
              const top = byClient ? rank.by_client.filter((c) => c[k] > 0).sort((a, b) => b[k] - a[k] || a.name.localeCompare(b.name)) : [];
              return (
                <div key={k} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "12px 14px" }}>
                  <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}><b>{l}</b>
                    <span><b style={{ fontSize: 20 }}>{rank.types[k]}</b> <span className="sub" style={{ margin: 0, fontSize: 13 }}>{pct(rank.types[k], rank.total)}</span></span></div>
                  {top.length > 0 && (
                    <ol style={{ margin: "8px 0 0", paddingLeft: 20, fontSize: 13 }}>
                      {top.map((c) => <li key={c.id} style={{ padding: "2px 0" }}><span style={{ display: "inline-flex", justifyContent: "space-between", width: "100%" }}>
                        <span>{c.name}</span><b style={{ fontVariantNumeric: "tabular-nums" }}>{c[k]}</b></span></li>)}
                    </ol>)}
                </div>
              );
            })}
          </div>
        )}
      </div>
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
function LineChart({ data, endsToday, unit }) {
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
    <svg className="lc" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Leads por ${unit}, de ${fmtD(data[0].d)} a ${endsToday ? "hoje" : fmtD(data[n - 1].d)}`}>
      {grid.map((v) => (
        <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="gr" /><text x={L - 8} y={y(v) + 4} textAnchor="end" className="ax">{v}</text></g>))}
      <path d={area} className="ar" /><path d={line} className="ln" />
      {data.map((a, i) => ((i % every === 0 && n - 1 - i >= Math.ceil(every * 0.7)) || i === n - 1) && (
        <text key={`x${i}`} x={x(i)} y={H - 8} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} className="ax">{i === n - 1 && endsToday && unit === "dia" ? "Hoje" : fmtD(a.d)}</text>))}
      {data.map((a, i) => (
        <g key={`p${i}`} className="pt">
          <rect x={x(i) - slot / 2} y={T} width={slot} height={H - T - B} className="hit" />
          <line x1={x(i)} x2={x(i)} y1={T} y2={y(0)} className="cr" />
          <circle cx={x(i)} cy={y(a.v)} r={4.5} className="dt" />
          <text x={Math.min(Math.max(x(i), L + 40), W - R - 40)} y={Math.max(y(a.v) - 12, T + 10)} textAnchor="middle" className="tip">
            {unit === "semana" ? "Semana de " : ""}{fmtD(a.d)}: {a.v} {a.v === 1 ? "lead" : "leads"}</text>
        </g>))}
    </svg>
  );
}
