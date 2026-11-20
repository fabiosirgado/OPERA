import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { callLead, fila, filaBdCandidatas, filaClienteAtiva, filaClientes, filaEscolher, filaEtapas, filaResultado, internalClientIds } from "../lib/leadsApi.js";
import { dueFrom, fmtDate, localInput } from "../lib/format.js";
import { Modal, useAction } from "../ui/feedback.jsx";
import { ClientTag, Icon } from "../ui/bits.jsx";
import LeadModal from "./LeadModal.jsx";

// "Fila": uma lead de cada vez, pela ordem certa, de todos os clientes do gestor (pedido do Fábio, 2026-11-19).
// A ordem vem da base de dados (leads_fila): leads novas, hora marcada, follow ups por cliente e BD por cliente.
// O resultado da chamada faz o resto sozinho (leads_fila_resultado): tarefa seguinte, etapa e regra das 2 tentativas.

const GRUPO_COR = { 1: "#15803D", 2: "#0B1B3A", 3: "#1D4ED8", 4: "#78350F", 5: "#334155" };
const GRUPO_FUNDO = { 1: "#DCFCE7", 2: "#E2E8F0", 3: "#DCE8FF", 4: "#FEF3C7", 5: "#EEF2F7" };

const at = (h, m = 0, dias = 0) => { const d = new Date(); d.setDate(d.getDate() + dias); d.setHours(h, m, 0, 0); return d.getTime(); };
const allDay = (dias) => { const d = new Date(); d.setDate(d.getDate() + dias); return dueFrom(localInput(d).slice(0, 10), ""); };

function opcoesMaisTarde() {
  const now = Date.now();
  const o = [["Daqui a 1 h", now + 3600e3], ["Daqui a 3 h", now + 3 * 3600e3]];
  if (at(18) - now > 3600e3) o.push(["Hoje às 18:00", at(18)]);
  o.push(["Amanhã às 10:00", at(10, 0, 1)], ["Amanhã às 18:00", at(18, 0, 1)]);
  return o;
}
const OPCOES_FU = () => [["Amanhã", allDay(1)], ["Daqui a 3 dias", allDay(3)], ["Daqui a 1 semana", allDay(7)]];
const MOTIVOS = ["Sem interesse", "Já comprou ou vendeu", "Contacto errado", "Fora da zona", "Outro"];

export default function Fila({ ctx }) {
  const { version } = ctx;
  const [internos, setInternos] = useState([]);
  useEffect(() => { internalClientIds().then(setInternos).catch(() => setInternos([])); }, []);
  const clients = ctx.clients.filter((c) => !internos.includes(c.id));
  const [rows, setRows] = useState(null);
  const [mode, setMode] = useState(null);
  const [others, setOthers] = useState(0);
  const [curId, setCurId] = useState(null);
  const [history, setHistory] = useState([]);
  const [skipped, setSkipped] = useState(() => new Map());
  const [pick, setPick] = useState(null);
  const [msg, setMsg] = useState(null);
  const [run, busy] = useAction();
  const topRef = useRef(null);

  const [resumo, setResumo] = useState(null);
  const [etapas, setEtapas] = useState(null);
  const [feitas, setFeitas] = useState([]);
  const [escolher, setEscolher] = useState(false);
  // Cada carregamento tem um número: uma resposta antiga (de outro cliente ou da fila anterior) nunca substitui a mais recente.
  const reqRef = useRef(0);
  const load = useCallback(async () => {
    const req = ++reqRef.current;
    const r = await fila(mode);
    const all = mode ? await fila(null) : null;
    if (req !== reqRef.current) return;
    setRows(r);
    setOthers(all ? all.filter((x) => x.grupo_ordem <= 3 && x.client_id !== mode).length : 0);
  }, [mode]);
  const loadPaineis = useCallback(() => {
    filaClientes().then(setResumo).catch(() => setResumo([]));
    filaEtapas().then(setEtapas).catch(() => setEtapas([]));
  }, []);
  useEffect(() => { load().catch((e) => setMsg({ erro: true, texto: e.message })); }, [load, version]);
  useEffect(() => { loadPaineis(); }, [loadPaineis, version]);
  // Rede de segurança do tempo real: a fila e os painéis voltam a ser pedidos a cada 30 segundos (com a janela à vista),
  // para uma lead nova aparecer mesmo que o aviso em tempo real se perca (ligação caída, portátil a dormir).
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      loadPaineis(); load().catch(() => {});
    }, 30000);
    const onVisible = () => { if (document.visibilityState === "visible") { loadPaineis(); load().catch(() => {}); } };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVisible); };
  }, [load, loadPaineis]);

  // Trocar entre a fila automática e um cliente: a fila antiga sai logo, para a próxima lead vir da fila nova.
  const trocar = (m) => {
    vistas.current = null; setChegou(null);
    setMode(m); setRows(null); setCurId(null); setHistory([]); setSkipped(new Map()); setPick(null); setMsg(null);
  };
  const toggleAtiva = (c) => run(() => filaClienteAtiva(c.client_id, !c.ativa),
    c.ativa ? `${c.name} saiu da fila automática` : `${c.name} voltou à fila automática`).then((ok) => { if (ok) { loadPaineis(); load(); } });

  // As que foram passadas com "Seguinte" vão para o fim do seu grupo, por ordem de quando foram passadas.
  const queue = useMemo(() => {
    if (!rows) return [];
    return rows.map((r, i) => ({ ...r, i })).sort((a, b) =>
      a.grupo_ordem - b.grupo_ordem || (skipped.get(a.lead_id) ?? 0) - (skipped.get(b.lead_id) ?? 0) || a.i - b.i);
  }, [rows, skipped]);

  useEffect(() => {
    if (!curId && queue.length) setCurId(queue[0].lead_id);
  }, [curId, queue]);

  // Lead nova a entrar em tempo real: as leads novas passam à frente de tudo, pela ordem de chegada (a mais antiga
  // primeiro). Se a lead aberta for um follow up ou BD, salta-se logo para a lead nova mais antiga, a não ser que já
  // se esteja a ligar ou a escolher um resultado: aí aparece um aviso para passar para ela.
  // Se a lead aberta já for uma lead nova, a que entrou fica na lista, pela ordem.
  const [ligouId, setLigouId] = useState(null);
  const [chegou, setChegou] = useState(null);
  const vistas = useRef(null);
  useEffect(() => {
    if (!rows) return;
    const novas = rows.filter((r) => r.grupo_ordem === 1);
    if (vistas.current === null) { vistas.current = new Set(novas.map((r) => r.lead_id)); return; }
    const chegadas = novas.filter((r) => !vistas.current.has(r.lead_id));
    novas.forEach((r) => vistas.current.add(r.lead_id));
    if (chegou && !rows.some((r) => r.lead_id === chegou.lead_id)) setChegou(null);
    if (!chegadas.length || !curId) return;
    const atual = rows.find((r) => r.lead_id === curId);
    if (atual && atual.grupo_ordem === 1) return;
    const n = novas.find((r) => r.lead_id !== curId);
    if (!n) return;
    if (atual && ligouId !== curId && !pick) {
      setHistory((h) => [...h, curId]);
      setCurId(n.lead_id); setChegou(null);
      setMsg({ texto: `Entrou uma lead nova (${chegadas[0].name}, ${chegadas[0].client_name}). As leads novas passam à frente: começa por ${n.name}, a que espera há mais tempo.` });
      goTop();
    } else setChegou(n);
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const passarPara = () => {
    if (!chegou) return;
    if (curId) setHistory((h) => [...h, curId]);
    setCurId(chegou.lead_id); setChegou(null); setPick(null); setMsg(null); goTop();
  };

  const cur = queue.find((q) => q.lead_id === curId) || null;
  const pos = cur ? queue.indexOf(cur) + 1 : 0;
  const goTop = () => topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  const seguinte = () => {
    if (!curId) return;
    const sk = new Map(skipped); sk.set(curId, Date.now());
    setSkipped(sk);
    setHistory((h) => [...h, curId]);
    const nextQ = queue.filter((q) => q.lead_id !== curId);
    setCurId(nextQ.length ? nextQ.find((q) => !sk.has(q.lead_id))?.lead_id ?? nextQ[0].lead_id : null);
    setPick(null); setMsg(null); goTop();
  };
  const voltar = () => {
    if (!history.length) return;
    const prev = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    const sk = new Map(skipped); sk.delete(prev); setSkipped(sk);
    setCurId(prev); setPick(null);
    setMsg({ texto: "Voltaste à lead anterior. Se lhe deste um resultado, corrige-o na ficha (etapa ou tarefas)." });
    goTop();
  };
  const ligar = () => cur && (setLigouId(cur.lead_id), run(() => callLead({ id: cur.lead_id, phone: cur.phone }),
    (via) => (via === "cloudtalk" ? `A CloudTalk vai ligar-te primeiro e depois a ${cur.name}` : `A ligar a ${cur.name}`))
    .then((ok) => ok && ctx.onChanged()));

  const resultado = (tipo, quando, nota) => {
    const id = curId;
    return run(async () => {
      const r = await filaResultado(id, tipo, quando, nota);
      const lead = queue.find((q) => q.lead_id === id);
      setFeitas((f) => [{ id, name: lead?.name ?? "Lead", client: lead?.client_name, color: lead?.client_color, tipo, at: Date.now() }, ...f]);
      setHistory((h) => [...h, id]);
      setRows(null);
      setPick(null);
      setMsg({ texto: r?.mensagem || "Registado." });
      setCurId(null);
      await load();
      loadPaineis();
      ctx.onChanged();
      goTop();
    });
  };

  const waiting = queue.filter((q) => q.grupo_ordem <= 3).length;
  const nextList = queue.filter((q) => q.lead_id !== curId).slice(0, 12);
  const grupoLabel = (q) => (q.grupo_ordem >= 4 ? `${q.grupo} · ${q.client_name}` : q.grupo);

  return (
    <>
      <div className="top" ref={topRef}>
        <div><h1>Fila</h1><div className="sub">As leads dos teus clientes, uma de cada vez, pela ordem certa</div></div>
      </div>

      <div className="stats">
        <div className="stat"><span>Na fila</span><b>{rows ? queue.length : "…"}</b><small>{mode ? `só ${clients.find((c) => c.id === mode)?.name ?? ""}` : "todos os teus clientes"}</small></div>
        <div className={`stat ${waiting ? "warn" : ""}`}><span>Leads novas e com hora marcada</span><b>{waiting}</b><small>passam à frente de tudo</small></div>
        <div className="stat"><span>Follow ups</span><b>{queue.filter((q) => q.grupo_ordem === 4).length}</b><small>de hoje ou atrasados</small></div>
        <div className="stat"><span>BD para hoje</span><b>{queue.filter((q) => q.grupo_ordem === 5).length}</b><small>até às leads do dia de cada cliente</small></div>
      </div>

      <div className="pills" role="group" aria-label="Trabalhar">
        <button type="button" className={`pill ${!mode ? "on" : ""}`} onClick={() => trocar(null)}>Fila automática</button>
        {clients.map((c) => (
          <button key={c.id} type="button" className={`pill ${mode === c.id ? "on" : ""}`} onClick={() => trocar(c.id)}>
            <span className="dot" style={{ width: 8, height: 8, flex: "0 0 8px", background: c.color }}></span>{c.name}</button>
        ))}
      </div>

      {mode && (
        <div className="row" style={{ alignItems: "center" }}>
          <button type="button" className="btn sm" onClick={() => setEscolher(true)}>Escolher leads de BD</button>
          <span style={{ fontSize: 12, color: "var(--mute)" }}>
            Escolhe as leads de BD de {clients.find((c) => c.id === mode)?.name ?? "este cliente"} que queres na fila: passam à frente da BD automática, dentro das leads do dia.
          </span>
        </div>
      )}
      {escolher && mode && (
        <EscolherBD client={clients.find((c) => c.id === mode)} onClose={() => setEscolher(false)}
          onSaved={() => { setEscolher(false); load().catch(() => {}); ctx.onChanged(); }} />
      )}

      {mode && others > 0 && (
        <div className="banner orange" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
          <span style={{ flex: 1, minWidth: 220 }}><b>{others} leads novas ou com hora marcada de outros clientes à espera.</b> O Time to Lead está a contar.</span>
          <button type="button" className="btn dark sm" onClick={() => trocar(null)}>Voltar à fila automática</button>
        </div>
      )}

      {msg && <div className={`banner ${msg.erro ? "orange" : "blue"}`}>{msg.texto}</div>}
      {chegou && chegou.lead_id !== curId && (
        <div className="banner green" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
          <span style={{ flex: 1, minWidth: 220 }}><b>Há leads novas à espera.</b> A que espera há mais tempo é {chegou.name} ({chegou.client_name}). O Time to Lead está a contar.</span>
          <button type="button" className="btn dark sm" onClick={passarPara}>Passar para ela</button>
          <button type="button" className="link" onClick={() => setChegou(null)}>Depois</button>
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "flex-start" }}>
          <div style={{ flex: "999 1 640px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
            {!rows && <div className="empty">A carregar a fila…</div>}
            {rows && !curId && <div className="panel"><b>A fila está vazia.</b><div className="sub">Não há leads para trabalhar agora. Volta a ver mais tarde ou escolhe um cliente em Trabalhar.</div></div>}
            {curId && (<>

            <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 12, position: "sticky", top: 0, zIndex: 4 }}>
              {cur && (
                <div className="tags">
                  <span className="tag" style={{ background: GRUPO_FUNDO[cur.grupo_ordem], color: GRUPO_COR[cur.grupo_ordem] }}>{cur.grupo}</span>
                  <ClientTag name={cur.client_name} color={cur.client_color} />
                  <span style={{ fontSize: 12, color: "var(--mute)" }}>{cur.motivo}</span>
                  <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--mute2)" }}>Posição {pos} de {queue.length}</span>
                </div>
              )}
              <div className="row">
                <button type="button" className="btn" disabled={busy || !history.length} onClick={voltar}>Voltar atrás</button>
                <button type="button" className="btn primary" style={{ flex: 1, minWidth: 180, justifyContent: "center" }}
                  disabled={busy || !cur?.phone} onClick={ligar}><Icon.phone />Ligar{cur ? ` a ${cur.name.split(" ")[0]}` : ""}</button>
                <button type="button" className="btn dark" disabled={busy} onClick={seguinte}>Seguinte</button>
              </div>
              {!pick && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <span style={{ fontSize: 12, color: "var(--mute)", fontWeight: 600 }}>Resultado da chamada · o resto é automático</span>
                  <div className="row">
                    <button type="button" className="btn sm" disabled={busy} onClick={() => resultado("nao_atendeu")}>Não atendeu</button>
                    <button type="button" className="btn sm" disabled={busy} onClick={() => setPick("tarde")}>Ligar mais tarde</button>
                    <button type="button" className="btn sm" disabled={busy} onClick={() => setPick("fu")}>Follow up</button>
                    <button type="button" className="btn sm green" disabled={busy} onClick={() => resultado("qualificada")}>Qualificada</button>
                    <button type="button" className="btn sm" disabled={busy} style={{ color: "#B91C1C" }} onClick={() => setPick("desq")}>Desqualificar</button>
                  </div>
                </div>
              )}
              {pick && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{pick === "tarde" ? "Quando voltar a ligar?" : pick === "fu" ? "Próximo contacto" : "Motivo"}</span>
                  <div className="chips">
                    {pick === "tarde" && opcoesMaisTarde().map(([l, t]) => (
                      <button key={l} type="button" className="chip" disabled={busy} onClick={() => resultado("mais_tarde", t)}>{l}</button>))}
                    {pick === "fu" && OPCOES_FU().map(([l, t]) => (
                      <button key={l} type="button" className="chip" disabled={busy} onClick={() => resultado("follow_up", t)}>{l}</button>))}
                    {pick === "desq" && MOTIVOS.map((m) => (
                      <button key={m} type="button" className="chip" disabled={busy} onClick={() => resultado("desqualificada", null, `Desqualificada: ${m}`)}>{m}</button>))}
                    <button type="button" className="link" onClick={() => setPick(null)}>Voltar aos resultados</button>
                  </div>
                </div>
              )}
              <span style={{ fontSize: 12, color: "var(--mute2)" }}>
                Não atendeu à 1.ª: fica marcada a 2.ª tentativa daqui a 3 h. À 2.ª seguida: sai da fila e fica à espera da mensagem de WhatsApp. Volta quando lhe marcares uma chamada ou follow up.
              </span>
            </div>

            <LeadModal key={curId} id={curId} ctx={ctx} inline onClose={seguinte} />
            </>)}
          </div>

          <div style={{ flex: "1 1 280px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="panel" style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h3>A seguir</h3><span className="sub" style={{ margin: 0, fontSize: 12 }}>{queue.length} na fila</span>
              </div>
              {nextList.length === 0 && <div className="sub" style={{ fontSize: 13 }}>Nada mais por agora.</div>}
              {nextList.map((q, k) => {
                const head = k === 0 || grupoLabel(nextList[k - 1]) !== grupoLabel(q);
                return (
                  <div key={q.lead_id}>
                    {head && <div style={{ margin: "12px 0 2px", fontSize: 11, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: GRUPO_COR[q.grupo_ordem] }}>{grupoLabel(q)}</div>}
                    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid #EEF2F7" }}>
                      <span className="dot" style={{ background: q.client_color }}></span>
                      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                        <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{q.name}</span>
                        <span style={{ fontSize: 12, color: "var(--mute)" }}>{q.grupo_ordem >= 4 ? q.motivo : q.client_name}</span>
                      </div>
                      {skipped.has(q.lead_id) && <span className="src">passada</span>}
                    </div>
                  </div>
                );
              })}
            </div>
            <details className="panel">
              <summary style={{ cursor: "pointer", fontWeight: 600, minHeight: 28 }}>Regras da fila</summary>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10, fontSize: 13, color: "#334155", lineHeight: 1.5 }}>
                <span>1. Leads novas sempre primeiro, pela ordem de chegada: a que espera há mais tempo primeiro. Quando entra uma lead nova e estás num follow up ou BD, a fila passa logo para as leads novas (se já estiveres a ligar, aparece um aviso).</span>
                <span>2. Chamadas com hora marcada, até 3 horas depois da hora.</span>
                <span>3. Follow ups de hoje ou atrasados, agrupados por cliente. Fazem-se antes de qualquer BD.</span>
                <span>4. BD cliente a cliente, até às leads do dia de cada um (25). O dia começa pelo cliente com menos leads trabalhadas na semana.</span>
                <span>5. Seguinte passa à próxima sem registar resultado: a lead vai para o fim do seu grupo.</span>
                <span>6. Uma lead com tarefa marcada para mais tarde sai da fila e volta à hora certa.</span>
                <span>7. Não atendeu 2 vezes seguidas: sai da fila à espera do WhatsApp. Volta à fila se alguém lhe marcar uma chamada ou follow up.</span>
                <span>8. Leads de BD escolhidas à mão (com um cliente selecionado, "Escolher leads de BD") passam à frente da BD automática desse cliente, mesmo com 2 ou mais tentativas, dentro das leads do dia (25): as que não couberem entram nos dias seguintes. Saem da escolha quando lhes dás um resultado.</span>
              </div>
            </details>
            <PainelClientes resumo={resumo} busy={busy} onToggle={toggleAtiva} />
            <PainelEtapas etapas={etapas} />
            <PainelFeitas feitas={feitas} />
          </div>
      </div>
    </>
  );
}

const RESULTADO = { nao_atendeu: "Não atendeu", mais_tarde: "Ligar mais tarde", follow_up: "Follow up", qualificada: "Qualificada", desqualificada: "Desqualificada" };
const hora = (t) => new Date(t).toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
const Barra = ({ pct, cor }) => (
  <div style={{ height: 8, borderRadius: 999, background: "#EEF2F7", overflow: "hidden" }}>
    <div style={{ width: `${Math.min(100, Math.max(0, pct))}%`, height: "100%", borderRadius: 999, background: cor }} />
  </div>
);

// Leads trabalhadas hoje e na semana por cliente, contra as leads do dia, e se o cliente entra na fila automática.
function PainelClientes({ resumo, busy, onToggle }) {
  return (
    <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <h3>Clientes na fila e leads do dia</h3>
      {!resumo && <div className="sub" style={{ fontSize: 13 }}>A carregar…</div>}
      {resumo?.map((c) => {
        const completo = c.hoje >= c.leads_dia;
        return (
          <div key={c.client_id} style={{ display: "flex", flexDirection: "column", gap: 6, opacity: c.ativa ? 1 : 0.6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="dot" style={{ background: c.color }}></span>
              <b style={{ flex: 1, minWidth: 0, fontSize: 14 }}>{c.name}</b>
              <span style={{ fontSize: 13, color: completo ? "var(--greenText)" : "#334155", whiteSpace: "nowrap" }}>hoje {c.hoje} de {c.leads_dia}{completo ? " · completo" : ""}</span>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer", minHeight: 28 }}>
              <input type="checkbox" checked={c.ativa} disabled={busy} onChange={() => onToggle(c)} />Na fila automática
            </label>
            <Barra pct={(c.hoje / Math.max(1, c.leads_dia)) * 100} cor={c.color} />
            <span style={{ fontSize: 12, color: "var(--mute)" }}>Semana: {c.semana} de {c.leads_dia * c.dias}</span>
          </div>
        );
      })}
      <span style={{ fontSize: 12, color: "var(--mute2)", lineHeight: 1.5 }}>
        Cada cliente tem direito a 25 leads trabalhadas por dia por cada slot contratado. Um cliente fora da fila automática deixa de ter
        follow ups e BD na fila (trabalham-se escolhendo o cliente em cima), mas as leads novas e as chamadas com hora marcada dele entram sempre.
      </span>
    </div>
  );
}

// Quantas leads há em cada etapa, em todos os clientes da fila. Atualiza a cada 30 segundos e a cada resultado.
function PainelEtapas({ etapas }) {
  const max = Math.max(1, ...(etapas ?? []).map((e) => e.n));
  return (
    <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h3>Etapas no Pipeline · em tempo real</h3>
      {!etapas && <div className="sub" style={{ fontSize: 13 }}>A carregar…</div>}
      {etapas?.map((e) => (
        <div key={e.stage_id} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 90px 48px", alignItems: "center", gap: 10, fontSize: 13 }}>
          <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.name}</span>
          <Barra pct={(e.n / max) * 100} cor={e.color || "#3B6FE0"} />
          <b style={{ textAlign: "right" }}>{e.n.toLocaleString("pt-PT")}</b>
        </div>
      ))}
    </div>
  );
}

// Resultados registados nesta sessão do ecrã (desde que a Fila foi aberta).
function PainelFeitas({ feitas }) {
  return (
    <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3>Feitas nesta sessão</h3>{feitas.length > 0 && <span className="sub" style={{ margin: 0, fontSize: 12 }}>{feitas.length}</span>}
      </div>
      {feitas.length === 0 && <div className="sub" style={{ fontSize: 13 }}>Ainda nada.</div>}
      {feitas.map((f) => (
        <div key={`${f.id}-${f.at}`} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: "1px solid #EEF2F7", fontSize: 13 }}>
          <span className="dot" style={{ background: f.color }}></span>
          <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontWeight: 600 }}>{f.name}</span>
          <span style={{ color: "var(--mute)" }}>{RESULTADO[f.tipo]}</span>
          <span style={{ color: "var(--mute2)", fontSize: 12 }}>{hora(f.at)}</span>
        </div>
      ))}
    </div>
  );
}

// Escolher à mão as leads de BD de um cliente que entram na fila (pedido do Fábio, 2026-11-20).
// Vêm todas as leads de BD do cliente (todas as etapas de entrada, sem limite); o filtro por etapa e a pesquisa são feitos aqui.
const MOSTRAR = 400;
const so = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
function EscolherBD({ client, onClose, onSaved }) {
  const [q, setQ] = useState("");
  const [etapa, setEtapa] = useState(null);
  const [list, setList] = useState(null);
  const [inicial, setInicial] = useState(() => new Set());
  const [sel, setSel] = useState(() => new Set());
  const [mostrar, setMostrar] = useState(MOSTRAR);
  const [run, busy] = useAction();
  useEffect(() => {
    let vivo = true;
    filaBdCandidatas(client.id).then((r) => {
      if (!vivo) return;
      const ja = new Set(r.filter((x) => x.escolhida).map((x) => x.lead_id));
      setList(r); setInicial(ja); setSel(new Set(ja));
    }).catch(() => vivo && setList([]));
    return () => { vivo = false; };
  }, [client.id]);
  useEffect(() => { setMostrar(MOSTRAR); }, [q, etapa]);

  const etapas = useMemo(() => {
    const m = new Map();
    (list ?? []).forEach((l) => m.set(l.stage_name, (m.get(l.stage_name) ?? 0) + 1));
    return [...m.entries()];
  }, [list]);
  const visiveis = useMemo(() => {
    const t = so(q.trim());
    const dig = q.replace(/\D/g, "");
    return (list ?? []).filter((l) => (!etapa || l.stage_name === etapa)
      && (!t || so(l.name).includes(t) || (dig && String(l.phone || "").replace(/\D/g, "").includes(dig))));
  }, [list, q, etapa]);
  const todasMarcadas = visiveis.length > 0 && visiveis.every((l) => sel.has(l.lead_id));
  const marcarVisiveis = () => setSel((s0) => {
    const n = new Set(s0);
    visiveis.forEach((l) => (todasMarcadas ? n.delete(l.lead_id) : n.add(l.lead_id)));
    return n;
  });
  const toggle = (id) => setSel((s0) => { const n = new Set(s0); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const add = [...sel].filter((id) => !inicial.has(id));
  const rem = [...inicial].filter((id) => !sel.has(id));
  const guardar = () => run(async () => {
    for (let i = 0; i < add.length; i += 500) await filaEscolher(add.slice(i, i + 500), true);
    for (let i = 0; i < rem.length; i += 500) await filaEscolher(rem.slice(i, i + 500), false);
  }, `${sel.size} ${sel.size === 1 ? "lead escolhida" : "leads escolhidas"} para a fila de ${client.name}`).then((ok) => ok && onSaved());

  return (
    <Modal title={`Leads de BD de ${client.name}`} onClose={onClose} wide>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <span className="sub" style={{ margin: 0, fontSize: 13 }}>
          Marca as que queres na fila. Passam à frente da BD automática deste cliente, dentro das leads do dia (25): as que não couberem hoje entram nos dias seguintes. Saem da escolha quando lhes dás um resultado.
          Aparecem todas as leads de BD sem tarefa marcada, de todas as etapas de entrada.
        </span>
        <div className="chips">
          <button type="button" className={`pill ${!etapa ? "on" : ""}`} onClick={() => setEtapa(null)}>Todas · {(list?.length ?? 0).toLocaleString("pt-PT")}</button>
          {etapas.map(([nome, n]) => (
            <button key={nome} type="button" className={`pill ${etapa === nome ? "on" : ""}`} onClick={() => setEtapa(nome)}>{nome} · {n.toLocaleString("pt-PT")}</button>
          ))}
        </div>
        <div className="row" style={{ alignItems: "center" }}>
          <label className="search" style={{ flex: 1, minWidth: 200 }}>
            <input style={{ width: "100%" }} placeholder="Procurar por nome ou telefone" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          </label>
          <button type="button" className="btn sm" disabled={!visiveis.length} onClick={marcarVisiveis}>
            {todasMarcadas ? "Desmarcar" : "Marcar"} {visiveis.length === list?.length ? "todas" : `as ${visiveis.length.toLocaleString("pt-PT")}`}
          </button>
        </div>
        <div style={{ maxHeight: "50vh", overflowY: "auto", border: "1px solid var(--line)", borderRadius: 10 }}>
          {!list && <div className="sub" style={{ padding: 14, fontSize: 13 }}>A carregar todas as leads de BD…</div>}
          {list && visiveis.length === 0 && <div className="sub" style={{ padding: 14, fontSize: 13 }}>Nenhuma lead de BD{q || etapa ? " com este filtro" : ""}.</div>}
          {visiveis.slice(0, mostrar).map((l) => (
            <label key={l.lead_id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: "1px solid #EEF2F7", cursor: "pointer", background: sel.has(l.lead_id) ? "#F0F6FF" : "#fff" }}>
              <input type="checkbox" checked={sel.has(l.lead_id)} onChange={() => toggle(l.lead_id)} />
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.name}</span>
                <span style={{ fontSize: 12, color: "var(--mute)" }}>
                  {[l.phone, l.stage_name, `${l.attempts} ${l.attempts === 1 ? "tentativa" : "tentativas"}`,
                    l.last_contact_at ? `último contacto ${fmtDate(l.last_contact_at)}` : "nunca contactada",
                    l.aguarda_whatsapp ? "à espera do WhatsApp" : null].filter(Boolean).join(" · ")}
                </span>
              </div>
            </label>
          ))}
          {visiveis.length > mostrar && (
            <button type="button" className="link" style={{ padding: "10px 14px" }} onClick={() => setMostrar((m) => m + MOSTRAR)}>
              Mostrar mais ({(visiveis.length - mostrar).toLocaleString("pt-PT")} por mostrar)
            </button>
          )}
        </div>
        <div className="row" style={{ alignItems: "center" }}>
          <span style={{ flex: 1, fontSize: 13 }}><b>{sel.size.toLocaleString("pt-PT")}</b> {sel.size === 1 ? "escolhida" : "escolhidas"}{add.length || rem.length ? ` · ${add.length} a juntar, ${rem.length} a tirar` : ""}</span>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="button" className="btn primary" disabled={busy || (!add.length && !rem.length)} onClick={guardar}>Guardar</button>
        </div>
      </div>
    </Modal>
  );
}
