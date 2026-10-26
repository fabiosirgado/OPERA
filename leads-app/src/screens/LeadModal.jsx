import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addNote, addTask, businessMinutes, clientUsers, completeTask, deleteTask, eraseSubject, getLead, leadEvents, leadTasks,
  callAnalysis, callLead, callRecording, snoozeTask, toggleLabel, updateEvent, updateLead,
} from "../lib/leadsApi.js";
import { exportSubject } from "../lib/exportSubject.js";
import {
  LABEL_COLORS, OBJETIVOS, QUALIFIED_POSITION, QUAL_FIELDS, TASK_TYPES, objetivoTipos, fmtDur, fmtRel, localInput, waLink,
} from "../lib/format.js";
import { Modal, useAction, useToast } from "../ui/feedback.jsx";
import { ClientTag, Icon, LabelTags, TaskTag } from "../ui/bits.jsx";

const EVENT_ICON = {
  call: ["TEL", "#DCE8FF", "#1E3A8A"], note: ["NOTA", "#FEF3C7", "#78350F"], auto: ["AUTO", "#ECE3FB", "#5B21B6"],
  stage: ["ETAPA", "#E8F8EF", "#14532D"], act: ["FEITO", "#F1F5F9", "#334155"],
};
const OUTCOMES = ["Não atendeu", "Pediu para ligar mais tarde", "Número errado", "Sem interesse", "Marcou visita"];

function presetTime(key) {
  const n = Date.now();
  if (key === "3h") return n + 3 * 3600e3;
  if (key === "3d") return n + 3 * 864e5;
  if (key === "tom") { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); return d.getTime(); }
  return n + 3600e3;
}

// Ficha da lead. ctx: { me, opera, stages, labels, clients, onChanged, onOpenLabels }
export default function LeadModal({ id, ctx, onClose }) {
  const { me, opera, stages, labels, clients } = ctx;
  const [lead, setLead] = useState(null);
  const [events, setEvents] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [users, setUsers] = useState([]);
  const [tForm, setTForm] = useState({ type: "call", due: localInput(Date.now() + 3600e3), note: "" });
  const [note, setNote] = useState({ body: "", pinned: false });
  const [editing, setEditing] = useState(null);
  const [audio, setAudio] = useState({});
  const [firstCallMin, setFirstCallMin] = useState(null);
  const [run, busy] = useAction();
  const toast = useToast();

  const load = useCallback(async () => {
    const [l, e, t] = await Promise.all([getLead(id), leadEvents(id), leadTasks(id)]);
    if (!l) { toast("Esta lead já não está disponível."); onClose(); return; }
    setLead(l); setEvents(e); setTasks(t);
    clientUsers(l.client_id).then(setUsers).catch(() => setUsers([]));
    if (opera && l.first_call_at) businessMinutes(l.created_at, l.first_call_at).then(setFirstCallMin).catch(() => setFirstCallMin(null));
    else setFirstCallMin(null);
  }, [id, onClose, toast, opera]);
  useEffect(() => { load().catch((e) => toast(e.message)); }, [load, toast]);
  // Atualiza sozinha quando alguém mexe nesta lead (tempo real).
  useEffect(() => { if (ctx.version) load().catch(() => {}); }, [ctx.version, load]);

  const stageById = useMemo(() => Object.fromEntries(stages.map((s) => [s.id, s])), [stages]);
  if (!lead) return <Modal title="A carregar…" onClose={onClose} wide><div className="empty">A carregar…</div></Modal>;

  const cur = stageById[lead.stage_id];
  const cols = stages.filter((s) => s.client_id === null || s.client_id === lead.client_id);
  const ci = cols.findIndex((s) => s.id === lead.stage_id);
  const readOnly = !opera && cur.position < QUALIFIED_POSITION;
  const canMoveTo = (s) => opera || s.position >= QUALIFIED_POSITION;
  const openTasks = tasks.filter((t) => !t.done_at);
  const pins = events.filter((e) => e.pinned);
  const labelIds = lead.links.map((x) => x.label_id);
  const after = async (fn, ok) => { const r = await run(fn, ok); if (r) { await load(); ctx.onChanged(); } return r; };

  const save = (patch) => after(() => updateLead(lead.id, patch));
  const moveTo = (s) => {
    if (s.id === lead.stage_id) return;
    if (s.key === "desq" && !confirm(`Passar ${lead.name} para Lead desqualificada? As tarefas em aberto são canceladas.`)) return;
    after(() => updateLead(lead.id, { stage_id: s.id }),
      s.key === "qualificada" && cur.position < QUALIFIED_POSITION ? `Lead qualificada. ${lead.client.name} vai ser avisado.` : `Movida para ${s.name}`);
  };
  const changeClient = (clientId) => {
    const patch = { client_id: clientId, owner_user_id: null };
    if (cur.client_id) patch.stage_id = stages.find((s) => s.key === "qualificada").id;
    after(() => updateLead(lead.id, patch), "Cliente alterado");
  };
  const call = () => after(() => callLead(lead),
    (via) => (via === "cloudtalk" ? `A CloudTalk vai ligar-te primeiro e depois a ${lead.name}` : `A ligar a ${lead.name}`));
  // Gravação da CloudTalk: só a equipa OPERA a ouve, e fica no registo de atividade.
  const listen = (callId) => run(async () => {
    const blob = await callRecording(callId);
    setAudio((a) => ({ ...a, [callId]: URL.createObjectURL(blob) }));
  });
  // Resumo e transcrição da CloudTalk: chegam sozinhos; o botão só volta a pedir quando ainda não chegaram.
  const fetchAnalysis = (callId) => after(async () => {
    const r = await callAnalysis(callId);
    if (r.status !== "processado") throw new Error(r.status === "ignorado" && r.motivo?.includes("chave")
      ? r.motivo : "A CloudTalk ainda não tem o resumo desta chamada. Tenta daqui a uns minutos.");
  }, "Resumo da chamada atualizado");
  const qualSave = (field, value) => {
    const q = { ...lead.qualification };
    if (value.trim()) q[field] = value.trim(); else delete q[field];
    save({ qualification: q });
  };
  const toggleObjetivo = (o) => {
    const cur = objetivoTipos(lead.qualification.Objetivo);
    qualSave("Objetivo", OBJETIVOS.filter((x) => (x === o ? !cur.includes(x) : cur.includes(x))).join(", "));
  };
  const chip = (o) => {
    setNote((n) => ({ ...n, body: n.body ? `${n.body}. ${o}` : o }));
    if (o === "Não atendeu" || o === "Pediu para ligar mais tarde") {
      setTForm({ type: "call", due: localInput(Date.now() + (o === "Não atendeu" ? 3 : 24) * 3600e3), note: "Ligar de novo" });
      toast("Sugestão: cria a chamada seguinte nas tarefas");
    }
    if (o === "Marcou visita") setTForm((t) => ({ ...t, type: "meeting", note: "Visita" }));
  };
  const saveNote = () => {
    if (!note.body.trim()) return toast("Escreve a nota primeiro");
    const isCall = /atendeu|ligar mais tarde|número errado/i.test(note.body);
    after(() => addNote(lead.id, note.body.trim(), note.pinned, isCall ? "Resultado da chamada" : "Nota"), "Nota guardada")
      .then((ok) => ok && setNote({ body: "", pinned: false }));
  };
  const saveTask = () => {
    if (!tForm.due) return toast("Escolhe quando");
    after(() => addTask(lead.id, tForm.type, tForm.due, tForm.note.trim()), `${TASK_TYPES[tForm.type]} marcada para ${fmtRel(tForm.due)}`)
      .then((ok) => ok && setTForm({ type: "call", due: localInput(Date.now() + 3600e3), note: "" }));
  };
  const erase = () => {
    if (prompt(`Apagar os dados pessoais de ${lead.name}? Não se pode desfazer. Escreve APAGAR para confirmar.`) !== "APAGAR") return;
    after(() => eraseSubject(lead.id), "Dados pessoais apagados");
  };

  // Histórico: eventos e tarefas concluídas, do mais recente para o mais antigo.
  const timeline = [
    ...events.map((e) => ({ ...e, when: e.created_at, kind: e.type })),
    ...tasks.filter((t) => t.done_at).map((t) => ({
      id: `t${t.id}`, kind: "act", when: t.done_at, title: `${TASK_TYPES[t.type]} concluída`, body: t.note,
      author: t.doer,
    })),
  ].sort((a, b) => new Date(b.when) - new Date(a.when));
  const eventTitle = (e) => {
    if (e.kind === "stage") return "Mudou de etapa";
    if (e.kind === "call") {
      const m = e.meta || {};
      return `Chamada${m.answered === true ? " atendida" : m.answered === false ? " não atendida" : ""}${m.duration_s ? ` · ${fmtDur(m.duration_s / 60)}` : ""}`;
    }
    return e.title || "Nota";
  };
  const eventBody = (e) => e.kind === "stage"
    ? `${stageById[e.from_stage_id]?.name ?? "Etapa apagada"} → ${stageById[e.to_stage_id]?.name ?? "Etapa apagada"}`
    : e.body;
  // Sem autor: escrito pelo sistema (entradas automáticas, CloudTalk, avisos). Com autor apagado: alguém da OPERA.
  const author = (e) => e.author ? (e.author.full_name || e.author.email) : (!e.author_id ? "Automático" : "Equipa OPERA");
  const canEdit = (e) => e.kind === "note" && !readOnly && (opera || e.author_id === me);

  return (
    <Modal wide onClose={onClose} title={
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div className="tags">
          <ClientTag name={lead.client.name} color={lead.client.color} />
          {lead.source && <span className="src">Origem: {lead.source}</span>}
          <span style={{ fontSize: 12, color: "var(--mute)", fontWeight: 400 }}>
            Entrou {fmtRel(lead.created_at)}{opera && firstCallMin != null && ` · Time to Lead ${fmtDur(firstCallMin)}`}
          </span>
        </div>
        <span>{lead.name}</span>
        <LabelTags ids={labelIds} labels={labels} />
      </div>}>
      {pins.length > 0 && (
        <div className="banner pin" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {pins.map((p) => (
            <div key={p.id} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <Icon.pin />
              <span style={{ flex: 1, whiteSpace: "pre-line" }}>{p.body}
                <span style={{ fontSize: 12, opacity: 0.75 }}> · {author({ ...p, kind: p.type })}, {fmtRel(p.created_at)}</span></span>
              {canEdit({ ...p, kind: p.type }) && <button type="button" className="link" onClick={() => after(() => updateEvent(p.id, { pinned: false }), "Nota desafixada")}>Desafixar</button>}
            </div>
          ))}
        </div>
      )}

      <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="row">
          {opera && <button type="button" className="btn primary" disabled={busy || !lead.phone || lead.anonymized} onClick={call}
            aria-describedby={!lead.phone && !lead.anonymized ? "sem-telefone" : undefined}><Icon.phone />Ligar</button>}
          {opera && !lead.phone && !lead.anonymized && (
            <span id="sem-telefone" style={{ fontSize: 13, color: "var(--mute)" }}>Sem telemóvel: escreve-o em Contacto para poder ligar.</span>
          )}
          {lead.phone && <a className="btn" href={waLink(lead.phone)} target="_blank" rel="noopener noreferrer">WhatsApp</a>}
          {lead.email && <a className="btn" href={`mailto:${lead.email}`}>Email</a>}
          {opera && (
            <label className="f" style={{ flexDirection: "row", alignItems: "center", gap: 8, marginLeft: "auto" }}>Cliente
              <select value={lead.client_id} onChange={(e) => changeClient(e.target.value)} style={{ minHeight: 40 }} disabled={busy}>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          )}
        </div>
        <div className="stagesBar" role="group" aria-label="Etapa da lead">
          {cols.map((s, i) => (
            <button key={s.id} type="button" className={i < ci ? "past" : i === ci ? "cur" : ""} aria-pressed={i === ci}
              disabled={busy || readOnly || !canMoveTo(s) || lead.anonymized} onClick={() => moveTo(s)}>{s.name}</button>
          ))}
        </div>
        {readOnly && <span className="sub" style={{ margin: 0 }}>Esta lead ainda está a ser trabalhada pela OPERA. Passa a ser vossa quando ficar qualificada.</span>}
      </div>

      <div className="det">
        <aside>
          <div className="panel">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3>Etiquetas</h3>
              {opera && <button type="button" className="link" onClick={ctx.onOpenLabels}>Gerir etiquetas</button>}
            </div>
            <div className="chips" style={{ marginTop: 10 }} role="group" aria-label="Etiquetas da lead">
              {labels.map((x) => {
                const on = labelIds.includes(x.id);
                const [bg, fg] = LABEL_COLORS[x.color] || LABEL_COLORS.cinzento;
                return (
                  <button key={x.id} type="button" className="chip" aria-pressed={on} disabled={busy || readOnly}
                    onClick={() => after(() => toggleLabel(lead.id, x.id, !on))}
                    style={on ? { background: bg, color: fg, borderColor: fg, fontWeight: 600 } : undefined}>{on ? "✓ " : ""}{x.name}</button>
                );
              })}
            </div>
          </div>
          <div className="panel"><h3>Contacto</h3>
            {[["phone", "Telemóvel"], ["email", "Email"], ["interest", "Interesse ou imóvel"], ["name", "Nome"]].map(([f, label]) => (
              <label key={f} className="kv"><span>{label}</span>
                <input defaultValue={lead[f] || ""} key={`${f}-${lead.updated_at}`} readOnly={readOnly}
                  onBlur={(e) => e.target.value.trim() !== (lead[f] || "") && save({ [f]: e.target.value.trim() || (f === "name" ? lead.name : null) })} /></label>
            ))}
          </div>
          <div className="panel">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3>Qualificação</h3>
              <span className="tag" style={{ background: "var(--greenSoft)", color: "var(--greenText)" }}>
                {QUAL_FIELDS.filter((q) => lead.qualification[q]).length} de {QUAL_FIELDS.length}</span>
            </div>
            <div className="kv"><span>Objetivo</span>
              <div className="pills" role="group" aria-label="Objetivo (pode escolher vários)">
                {OBJETIVOS.map((o) => {
                  const on = objetivoTipos(lead.qualification.Objetivo).includes(o);
                  return <button key={o} type="button" className={`pill ${on ? "on" : ""}`} aria-pressed={on} disabled={readOnly || busy}
                    onClick={() => toggleObjetivo(o)}>{o}</button>;
                })}
              </div></div>
            {QUAL_FIELDS.filter((q) => q !== "Objetivo").map((q) => (
              <label key={q} className="kv"><span>{q}</span>
                <input defaultValue={lead.qualification[q] || ""} key={`${q}-${lead.updated_at}`} readOnly={readOnly}
                  placeholder={q === "Budget" ? "Ex.: 400 000 €" : "Por perguntar"}
                  onBlur={(e) => e.target.value.trim() !== (lead.qualification[q] || "") && qualSave(q, e.target.value)} /></label>
            ))}
          </div>
          <div className="panel"><h3>Responsável no cliente</h3>
            <label className="f" style={{ marginTop: 10 }}><span className="vh">Responsável</span>
              <select value={lead.owner_user_id || ""} disabled={busy || readOnly} onChange={(e) => save({ owner_user_id: e.target.value || null })}>
                <option value="">Todos os utilizadores do cliente</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.email}</option>)}
              </select>
            </label>
            <span className="sub" style={{ margin: "6px 0 0", fontSize: 12 }}>Quem recebe o aviso quando a lead fica qualificada.</span>
          </div>
          {opera && cur.position < QUALIFIED_POSITION && !lead.anonymized && (
            <button type="button" className="btn green" disabled={busy} onClick={() => moveTo(stages.find((s) => s.key === "qualificada"))}>
              Marcar qualificada e avisar cliente</button>
          )}
          {opera && !lead.anonymized && (
            <details className="panel">
              <summary style={{ cursor: "pointer", fontWeight: 600, minHeight: 28 }}>Dados pessoais (RGPD)</summary>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
                <span className="sub" style={{ margin: 0, fontSize: 12 }}>Para pedidos do titular: acesso aos seus dados ou apagamento.</span>
                <button type="button" className="btn sm" disabled={busy} onClick={() => run(() => exportSubject(lead, events, tasks, labels), "Dados exportados")}>Exportar dados desta pessoa</button>
                <button type="button" className="btn sm" disabled={busy} onClick={erase} style={{ color: "#B91C1C" }}>Apagar a pedido do titular</button>
              </div>
            </details>
          )}
          {cur.key !== "desq" && !readOnly && !lead.anonymized && (
            <button type="button" className="btn" disabled={busy} style={{ color: "#B91C1C" }}
              onClick={() => moveTo(stages.find((s) => s.key === "desq"))}>Desqualificar</button>
          )}
        </aside>

        <section>
          <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3>Tarefas</h3><span className="sub" style={{ margin: 0, fontSize: 12 }}>{openTasks.length} em aberto</span>
            </div>
            {openTasks.length ? openTasks.map((t) => (
              <div key={t.id} className="task">
                <span className={`when ${new Date(t.due_at) < Date.now() ? "late" : ""}`}>{fmtRel(t.due_at)}</span>
                <TaskTag type={t.type} /><span className="nt">{t.note}</span>
                {!readOnly && (
                  <>
                    <button type="button" className="btn xs" disabled={busy} onClick={() => after(() => completeTask(t.id), "Tarefa concluída")}>Feita</button>
                    <button type="button" className="btn xs" disabled={busy} onClick={() => after(() => snoozeTask(t))}>Adiar 1 dia</button>
                    {opera && <button type="button" className="link" disabled={busy} style={{ color: "var(--mute)" }}
                      onClick={() => after(() => deleteTask(t.id), "Tarefa apagada")}>Apagar</button>}
                  </>
                )}
              </div>
            )) : <div className="sub" style={{ margin: "4px 0" }}>Sem tarefas em aberto. Uma lead sem próxima tarefa é uma lead esquecida.</div>}
            {!readOnly && !lead.anonymized && (
              <div style={{ borderTop: "1px solid var(--line)", marginTop: 10, paddingTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                <div className="chips" role="group" aria-label="Tipo de tarefa">
                  <span style={{ fontSize: 12, color: "var(--mute)", fontWeight: 600 }}>Nova tarefa:</span>
                  {Object.entries(TASK_TYPES).map(([k, v]) => (
                    <button key={k} type="button" className={`btn xs ${tForm.type === k ? "on" : ""}`} aria-pressed={tForm.type === k}
                      onClick={() => setTForm({ ...tForm, type: k })}>{v}</button>
                  ))}
                </div>
                <div className="g2">
                  <label className="f">Quando<input type="datetime-local" value={tForm.due} onChange={(e) => setTForm({ ...tForm, due: e.target.value })} /></label>
                  <label className="f">Nota da tarefa<input value={tForm.note} onChange={(e) => setTForm({ ...tForm, note: e.target.value })}
                    placeholder={tForm.type === "meeting" ? "Ex.: Reunião por videochamada" : tForm.type === "followup" ? "Ex.: Enviar imóveis" : "Ex.: Ligar de novo"} /></label>
                </div>
                <div className="chips">
                  <span style={{ fontSize: 12, color: "var(--mute)" }}>Rápido:</span>
                  {[["1h", "Daqui a 1 h"], ["3h", "Daqui a 3 h"], ["tom", "Amanhã 10:00"], ["3d", "Daqui a 3 dias"]].map(([k, v]) => (
                    <button key={k} type="button" className="chip" onClick={() => setTForm({ ...tForm, due: localInput(presetTime(k)) })}>{v}</button>
                  ))}
                  <button type="button" className="btn sm primary" style={{ marginLeft: "auto" }} disabled={busy} onClick={saveTask}>Criar tarefa</button>
                </div>
              </div>
            )}
          </div>

          {!readOnly && !lead.anonymized && (
            <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label className="f">Registar nota<textarea value={note.body} onChange={(e) => setNote({ ...note, body: e.target.value })} placeholder="O que aconteceu?" /></label>
              <div className="chips"><span style={{ fontSize: 12, color: "var(--mute)" }}>Resultado rápido:</span>
                {OUTCOMES.map((o) => <button key={o} type="button" className="chip" onClick={() => chip(o)}>{o}</button>)}</div>
              <div className="actions" style={{ alignItems: "center" }}>
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginRight: "auto" }}>
                  <input type="checkbox" checked={note.pinned} onChange={(e) => setNote({ ...note, pinned: e.target.checked })} />Afixar no topo</label>
                <button type="button" className="btn primary" disabled={busy} onClick={saveNote}>Guardar nota</button>
              </div>
            </div>
          )}

          <div className="panel"><h3 style={{ marginBottom: 6 }}>Histórico</h3>
            {timeline.map((e) => {
              const [label, bg, fg] = EVENT_ICON[e.kind] || EVENT_ICON.act;
              const body = eventBody(e);
              return (
                <div key={e.id} className="tl">
                  <span className="ic" style={{ background: bg, color: fg }}>{label}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <b>{eventTitle(e)}</b>{e.pinned && <span style={{ color: "var(--pinText)" }}> <Icon.pin /></span>}
                    {e.internal && <span className="tag" style={{ marginLeft: 8, background: "#EEF2F7", color: "#334155" }} title="O cliente não vê esta nota">Só equipa OPERA</span>}
                    <span className="w">{fmtRel(e.when)} · {author(e)}{e.edited_at ? " · editada" : ""}</span>
                    {editing?.id === e.id ? (
                      <>
                        <textarea aria-label="Editar nota" autoFocus value={editing.body} onChange={(ev) => setEditing({ ...editing, body: ev.target.value })} />
                        <div className="tools">
                          <button type="button" className="btn xs primary" disabled={busy} onClick={() => {
                            if (!editing.body.trim()) return toast("A nota não pode ficar vazia");
                            after(() => updateEvent(e.id, { body: editing.body.trim() }), "Nota atualizada").then((ok) => ok && setEditing(null));
                          }}>Guardar</button>
                          <button type="button" className="btn xs" onClick={() => setEditing(null)}>Cancelar</button>
                        </div>
                      </>
                    ) : (
                      <>
                        {body && <p>{body}</p>}
                        {e.kind === "call" && opera && e.meta?.call_id && e.meta?.answered && !events.some((n) => n.meta?.ci_call_id === e.meta.call_id) && (
                          <div className="tools"><button type="button" className="link" disabled={busy} onClick={() => fetchAnalysis(e.meta.call_id)}>Buscar resumo e transcrição</button></div>
                        )}
                        {e.kind === "call" && opera && e.meta?.recorded && e.meta?.call_id && (
                          audio[e.meta.call_id]
                            ? <audio controls autoPlay src={audio[e.meta.call_id]} style={{ width: "100%", marginTop: 6 }} />
                            : <div className="tools"><button type="button" className="link" disabled={busy} onClick={() => listen(e.meta.call_id)}>Ouvir gravação</button></div>
                        )}
                        {canEdit(e) && (
                          <div className="tools">
                            <button type="button" className="link" onClick={() => setEditing({ id: e.id, body: e.body || "" })}>Editar</button>
                            <button type="button" className="link" onClick={() => after(() => updateEvent(e.id, { pinned: !e.pinned }), e.pinned ? "Nota desafixada" : "Nota afixada")}>
                              {e.pinned ? "Desafixar" : "Afixar"}</button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </Modal>
  );
}

