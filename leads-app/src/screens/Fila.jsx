import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { callLead, fila, filaResultado, internalClientIds } from "../lib/leadsApi.js";
import { dueFrom, localInput } from "../lib/format.js";
import { useAction } from "../ui/feedback.jsx";
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

  const load = useCallback(async () => {
    const r = await fila(mode);
    setRows(r);
    if (mode) {
      const all = await fila(null);
      setOthers(all.filter((x) => x.grupo_ordem <= 3 && x.client_id !== mode).length);
    } else setOthers(0);
  }, [mode]);
  useEffect(() => { load().catch((e) => setMsg({ erro: true, texto: e.message })); }, [load, version]);

  // As que foram passadas com "Seguinte" vão para o fim do seu grupo, por ordem de quando foram passadas.
  const queue = useMemo(() => {
    if (!rows) return [];
    return rows.map((r, i) => ({ ...r, i })).sort((a, b) =>
      a.grupo_ordem - b.grupo_ordem || (skipped.get(a.lead_id) ?? 0) - (skipped.get(b.lead_id) ?? 0) || a.i - b.i);
  }, [rows, skipped]);

  // A lead aberta fica fixa: se entrar outra mais prioritária, só aparece quando se passa à seguinte.
  useEffect(() => {
    if (!curId && queue.length) setCurId(queue[0].lead_id);
  }, [curId, queue]);

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
  const ligar = () => cur && run(() => callLead({ id: cur.lead_id, phone: cur.phone }),
    (via) => (via === "cloudtalk" ? `A CloudTalk vai ligar-te primeiro e depois a ${cur.name}` : `A ligar a ${cur.name}`))
    .then((ok) => ok && ctx.onChanged());

  const resultado = (tipo, quando, nota) => {
    const id = curId;
    return run(async () => {
      const r = await filaResultado(id, tipo, quando, nota);
      setHistory((h) => [...h, id]);
      setPick(null);
      setMsg({ texto: r?.mensagem || "Registado." });
      setCurId(null);
      await load();
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
        <button type="button" className={`pill ${!mode ? "on" : ""}`} onClick={() => { setMode(null); setCurId(null); setHistory([]); }}>Fila automática</button>
        {clients.map((c) => (
          <button key={c.id} type="button" className={`pill ${mode === c.id ? "on" : ""}`} onClick={() => { setMode(c.id); setCurId(null); setHistory([]); }}>
            <span className="dot" style={{ width: 8, height: 8, flex: "0 0 8px", background: c.color }}></span>{c.name}</button>
        ))}
      </div>

      {mode && others > 0 && (
        <div className="banner orange" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
          <span style={{ flex: 1, minWidth: 220 }}><b>{others} leads novas ou com hora marcada de outros clientes à espera.</b> O Time to Lead está a contar.</span>
          <button type="button" className="btn dark sm" onClick={() => { setMode(null); setCurId(null); }}>Voltar à fila automática</button>
        </div>
      )}

      {msg && <div className={`banner ${msg.erro ? "orange" : "blue"}`}>{msg.texto}</div>}

      {!rows && <div className="empty">A carregar a fila…</div>}
      {rows && !cur && !curId && <div className="panel"><b>A fila está vazia.</b><div className="sub">Não há leads para trabalhar agora. Volta a ver mais tarde ou escolhe um cliente em Trabalhar.</div></div>}

      {curId && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "flex-start" }}>
          <div style={{ flex: "999 1 640px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>

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
                <span>1. Leads novas sempre primeiro: as que entraram há menos de 1 hora, a mais antiga primeiro; depois as restantes.</span>
                <span>2. Chamadas com hora marcada, até 3 horas depois da hora.</span>
                <span>3. Follow ups de hoje ou atrasados, agrupados por cliente. Fazem-se antes de qualquer BD.</span>
                <span>4. BD cliente a cliente, até às leads do dia de cada um (25). O dia começa pelo cliente com menos leads trabalhadas na semana.</span>
                <span>5. Seguinte passa à próxima sem registar resultado: a lead vai para o fim do seu grupo.</span>
                <span>6. Uma lead com tarefa marcada para mais tarde sai da fila e volta à hora certa.</span>
                <span>7. Não atendeu 2 vezes seguidas: sai da fila à espera do WhatsApp. Volta à fila se alguém lhe marcar uma chamada ou follow up.</span>
              </div>
            </details>
          </div>
        </div>
      )}
    </>
  );
}
