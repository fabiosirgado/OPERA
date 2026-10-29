import { useCallback, useEffect, useMemo, useState } from "react";
import { pipeline, pipelineBoard, pipelineCounts, pipelineKpis, updateLead } from "../lib/leadsApi.js";
import { exportLeads } from "../lib/exportLeads.js";
import { fileSafe } from "../lib/excel.js";
import { PAGE, TASK_TYPES, ago, fmtRel } from "../lib/format.js";
import { useAction, useToast } from "../ui/feedback.jsx";
import { ClientTag, Icon, LabelTags } from "../ui/bits.jsx";

const SORTS = [["next", "Próxima tarefa"], ["recent", "Mais recentes"], ["old", "Mais antigas"], ["name", "Nome A a Z"], ["stale", "Mais tempo sem contacto"], ["attempts", "Mais tentativas"]];
const BOARD_DIR = { attempts: -1 };
const LIST_COLS = [["name", "Nome"], ["client", "Cliente"], ["stage", "Etapa"], ["source", "Origem"], ["created", "Entrada"], ["nextlist", "Próxima tarefa"], ["last", "Último contacto"], ["attempts", "Tentativas"]];

const PREF_KEY = "opera-leads-pipeline";
const readPrefs = () => { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; } };
const savePrefs = (p) => { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* sem armazenamento */ } };

// ctx: { opera, myClient, stages, labels, clients, version, onOpenLead, onNewLead, onNewStage, filterClient, setFilterClient }
export default function Pipeline({ ctx }) {
  const { opera, myClient, stages, labels, clients, version } = ctx;
  const [prefs, setPrefs] = useState(() => ({ layout: "board", sort: "next", label: "", lsort: "created", ldir: -1, mine: false, ...readPrefs() }));
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [cols, setCols] = useState({});
  const [counts, setCounts] = useState({});
  const [kpis, setKpis] = useState(null);
  const [list, setList] = useState({ rows: [], total: 0 });
  const [run] = useAction();
  const toast = useToast();
  const setPref = (k, v) => setPrefs((p) => { const n = { ...p, [k]: v }; savePrefs(n); return n; });
  useEffect(() => { const t = setTimeout(() => setQDebounced(q), 300); return () => clearTimeout(t); }, [q]);

  const client = opera ? ctx.filterClient : myClient?.id;
  const filters = useMemo(() => ({ client, label: prefs.label, q: qDebounced, mine: !opera && prefs.mine }),
    [client, prefs.label, qDebounced, opera, prefs.mine]);
  const columns = useMemo(() => stages.filter((s) => s.client_id === null || s.client_id === client), [stages, client]);

  const loadBoard = useCallback(async () => {
    const b = await pipelineBoard({ ...filters, sort: prefs.sort, dir: BOARD_DIR[prefs.sort] || 1, limit: PAGE, kpis: opera });
    setCounts(b.counts);
    setCols(b.cols);
    if (b.kpis) setKpis(b.kpis);
  }, [filters, prefs.sort, opera]);

  const loadList = useCallback(async (more = false) => {
    const offset = more ? list.rows.length : 0;
    const [rows, c] = await Promise.all([
      pipeline({ ...filters, sort: prefs.lsort, dir: prefs.ldir, offset, limit: PAGE }),
      more ? Promise.resolve(null) : pipelineCounts(filters),
    ]);
    if (c) setCounts(c);
    setList((l) => ({
      rows: more ? [...l.rows, ...rows] : rows,
      total: c ? Object.values(c).reduce((a, b) => a + b, 0) : l.total,
    }));
  }, [filters, prefs.lsort, prefs.ldir, list.rows.length]);

  useEffect(() => {
    if (prefs.layout !== "list") { run(loadBoard); return; }
    run(() => loadList(false));
    if (opera) pipelineKpis(client).then(setKpis).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, prefs.layout, prefs.sort, prefs.lsort, prefs.ldir, version, columns.length]);

  const more = async (stageId) => {
    const have = cols[stageId] || [];
    const rows = await run(() => pipeline({ ...filters, stage: stageId, sort: prefs.sort, dir: BOARD_DIR[prefs.sort] || 1, offset: have.length, limit: PAGE }));
    if (rows) setCols((c) => ({ ...c, [stageId]: [...have, ...rows] }));
  };

  // Arrastar entre etapas (computador). No telemóvel muda-se a etapa na ficha da lead.
  const drop = async (stage, leadId, fromStage) => {
    if (!leadId || stage.id === fromStage) return;
    if (stage.key === "desq" && !confirm("Passar esta lead para Lead desqualificada? As tarefas em aberto são canceladas.")) return;
    if (await run(() => updateLead(leadId, { stage_id: stage.id }), stage.key === "qualificada" ? (opera ? "Lead qualificada. O cliente vai ser avisado." : "Lead qualificada.") : `Movida para ${stage.name}`)) loadBoard();
    // Sem Objetivo não se qualifica: abre a ficha para o indicar.
    else if (stage.key === "qualificada") ctx.onOpenLead(leadId);
  };

  // Exportação rápida do que está filtrado por cliente (todas as etapas, com histórico).
  const [exporting, setExporting] = useState(false);
  const quickExport = async () => {
    setExporting(true);
    const name = client ? clients.find((c) => c.id === client)?.name : "todos";
    await run(() => exportLeads({ client: client || null, history: true, fileName: `leads_${fileSafe(name)}.xlsx` }), (n) => `${n} leads exportadas`);
    setExporting(false);
  };

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const qualifiedId = stages.find((s) => s.key === "qualificada")?.id;
  const sortList = (key) => setPrefs((p) => {
    const n = { ...p, lsort: key, ldir: p.lsort === key ? -p.ldir : (["name", "client", "stage", "source", "nextlist"].includes(key) ? 1 : -1) };
    savePrefs(n); return n;
  });

  return (
    <>
      <div className="top">
        <div>
          <h1>{opera ? "Pipeline geral" : "As vossas leads"}</h1>
          <div className="sub">{opera ? "Todas as leads de todos os clientes, num só quadro" : `Só vêem as leads de ${myClient.name}. A OPERA trabalha as primeiras etapas por vós.`}</div>
        </div>
        <div className="row">
          <label className="search"><Icon.search /><span className="vh">Procurar</span>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrar nome, telefone ou imóvel" /></label>
          {prefs.layout !== "list" && (
            <label className="f" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><span className="vh">Ordenar</span>
              <select value={prefs.sort} onChange={(e) => setPref("sort", e.target.value)} style={{ minHeight: 44 }}>
                {SORTS.map(([k, v]) => <option key={k} value={k}>Ordenar: {v}</option>)}</select></label>
          )}
          <div className="seg2" role="group" aria-label="Vista">
            <button type="button" className={prefs.layout !== "list" ? "on" : ""} aria-pressed={prefs.layout !== "list"} onClick={() => setPref("layout", "board")}>Quadro</button>
            <button type="button" className={prefs.layout === "list" ? "on" : ""} aria-pressed={prefs.layout === "list"} onClick={() => setPref("layout", "list")}>Lista</button>
          </div>
          <label className="f" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><span className="vh">Etiqueta</span>
            <select value={prefs.label} onChange={(e) => setPref("label", e.target.value)} style={{ minHeight: 44 }}>
              <option value="">Todas as etiquetas</option>{labels.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
          {!opera && (
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, minHeight: 44 }}>
              <input type="checkbox" checked={prefs.mine} onChange={(e) => setPref("mine", e.target.checked)} />Só as minhas</label>
          )}
          {opera && <button type="button" className="btn" onClick={() => ctx.onGo("io")}>Importar Excel</button>}
          <button type="button" className="btn" disabled={exporting} onClick={quickExport}>{opera ? "Exportar Excel" : "Exportar contactos"}</button>
          <button type="button" className="btn primary" onClick={ctx.onNewLead}>Nova lead</button>
        </div>
      </div>

      {opera ? (
        <>
          <div className="pills" role="group" aria-label="Filtrar por cliente">
            <button type="button" className={`pill ${!client ? "on" : ""}`} onClick={() => ctx.setFilterClient(null)}>Todos os clientes</button>
            {clients.map((c) => (
              <button key={c.id} type="button" className={`pill ${client === c.id ? "on" : ""}`} onClick={() => ctx.setFilterClient(c.id)}>
                <span className="dot" style={{ width: 8, height: 8, flex: "0 0 8px", background: c.color }}></span>{c.name}</button>
            ))}
          </div>
          <div className="stats">
            <div className="stat"><span>Entraram hoje</span><b>{kpis?.entraram_hoje ?? "…"}</b></div>
            <div className="stat"><span>Por contactar</span><b>{kpis?.por_contactar ?? "…"}</b></div>
            <div className="stat warn"><span>Tarefas atrasadas</span><b>{kpis?.tarefas_atrasadas ?? "…"}</b></div>
            <div className="stat"><span>Qualificadas por entregar</span><b>{kpis?.qualificadas ?? "…"}</b></div>
          </div>
        </>
      ) : (
        <div className={`banner ${counts[qualifiedId] ? "green" : "blue"}`}>
          <b>{counts[qualifiedId] ? `${counts[qualifiedId]} ${counts[qualifiedId] > 1 ? "leads qualificadas à vossa espera." : "lead qualificada à vossa espera."}` : "Sem leads qualificadas pendentes."}</b>
          {" "}Recebem aviso por email sempre que a OPERA qualifica uma lead.
          {" "}Para os contactos dos portais chegarem sozinhos, a OPERA envia as instruções para reencaminhar os emails.
        </div>
      )}

      {prefs.layout === "list" ? (
        <>
          <div className="tbl" style={{ margin: 0, background: "#fff" }}>
            <table>
              <thead><tr>
                {LIST_COLS.filter(([k]) => opera || k !== "client").map(([k, label]) => (
                  <th key={k} className={k === "attempts" ? "n" : ""} aria-sort={prefs.lsort === k ? (prefs.ldir > 0 ? "ascending" : "descending") : "none"}>
                    <button type="button" className={`sort ${prefs.lsort === k ? "on" : ""}`} onClick={() => sortList(k)}>
                      {label}{prefs.lsort === k ? (prefs.ldir > 0 ? " ↑" : " ↓") : ""}</button>
                  </th>))}
                <th>Etiquetas</th>
              </tr></thead>
              <tbody>
                {list.rows.length === 0 && <tr><td colSpan={9} className="empty">Sem leads com estes filtros.</td></tr>}
                {list.rows.map((l) => {
                  const late = l.next_task_at && new Date(l.next_task_at) < Date.now();
                  return (
                    <tr key={l.id} className={`rowL ${l.is_new ? "is-new" : ""}`} tabIndex={0} onClick={() => ctx.onOpenLead(l.id)} onKeyDown={(e) => e.key === "Enter" && ctx.onOpenLead(l.id)}>
                      <td>{l.is_new && <><span className="nova">Nova</span> </>}<b>{l.name}</b>{l.pinned_note && <span style={{ color: "var(--pinText)" }} title="Tem nota afixada"> <Icon.pin /></span>}<div className="cint">{l.phone}</div></td>
                      {opera && <td><ClientTag name={l.client_name} color={l.client_color} /></td>}
                      <td>{l.stage_name}</td><td>{l.source}</td>
                      <td style={{ whiteSpace: "nowrap" }}>{fmtRel(l.created_at)}</td>
                      <td style={{ whiteSpace: "nowrap", ...(late ? { color: "#C2410C", fontWeight: 600 } : {}) }}>
                        {l.next_task_at ? `${TASK_TYPES[l.next_task_type]} · ${fmtRel(l.next_task_at)}` : <span style={{ color: "var(--mute2)" }}>Sem tarefa</span>}</td>
                      <td style={{ whiteSpace: "nowrap" }}>{l.last_contact_at ? ago(l.last_contact_at) : <span style={{ color: "#C2410C" }}>Nunca</span>}</td>
                      <td className="n">{l.attempts}</td>
                      <td><LabelTags ids={l.label_ids} labels={labels} /></td>
                    </tr>);
                })}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="sub" style={{ margin: 0 }}>{list.rows.length} de {list.total} leads</span>
            {list.total > list.rows.length && <button type="button" className="more" onClick={() => run(() => loadList(true))}>Mostrar mais {Math.min(PAGE, list.total - list.rows.length)}</button>}
          </div>
        </>
      ) : (
        <div className="boardWrap"><div className="board">
          {columns.map((s) => {
            const items = cols[s.id] || [];
            const n = counts[s.id] || 0;
            const ownerTxt = s.client_id ? `Etapa só de ${clients.find((c) => c.id === s.client_id)?.name ?? myClient?.name ?? "um cliente"}`
              : s.owner === "opera" ? "Trabalhado pela OPERA" : s.owner === "cliente" ? "Etapa do cliente" : "OPERA e cliente";
            const ownerCol = s.client_id ? "#9A3412" : s.owner === "opera" ? "#1D4ED8" : s.owner === "cliente" ? "#9A3412" : "#166534";
            return (
              <section key={s.id} className={`colm ${s.client_id ? "client" : ""}`}
                onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add("drop"); }}
                onDragLeave={(e) => e.currentTarget.classList.remove("drop")}
                onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove("drop"); const [id, from] = e.dataTransfer.getData("text/plain").split("|"); drop(s, id, from); }}>
                <header>
                  <div className="h"><span style={{ borderRadius: "50%", width: 8, height: 8, flex: "0 0 8px", background: s.color }}></span><h2>{s.name}</h2><span className="count">{n}</span></div>
                  <span className="owner" style={{ color: ownerCol }}>{ownerTxt}</span>
                </header>
                {items.map((l) => <Card key={l.id} l={l} opera={opera} labels={labels}
                  draggable onOpen={() => ctx.onOpenLead(l.id)} />)}
                {n > items.length && <button type="button" className="more" onClick={() => more(s.id)}>Mostrar mais {Math.min(PAGE, n - items.length)} de {n - items.length}</button>}
              </section>
            );
          })}
          <button type="button" className="addStage" onClick={ctx.onNewStage}><Icon.plus />Etapas
            <small>criar, mudar a ordem, o nome ou apagar, depois de Qualificada</small></button>
        </div></div>
      )}
      <div className="foot">{total} leads com estes filtros.</div>
    </>
  );
}

function Card({ l, opera, labels, draggable, onOpen }) {
  const late = l.next_task_at && new Date(l.next_task_at) < Date.now();
  return (
    <div role="button" tabIndex={0} className={`cardL ${l.is_new ? "is-new" : ""}`} aria-label={`Abrir ${l.name}${l.is_new ? ", lead nova" : ""}`} draggable={draggable}
      onDragStart={(e) => e.dataTransfer.setData("text/plain", `${l.id}|${l.stage_id}`)}
      onClick={onOpen} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}>
      <div className="tags">{l.is_new && <span className="nova">Nova</span>}{opera && <ClientTag name={l.client_name} color={l.client_color} />}{l.source && <span className="src">{l.source}</span>}</div>
      <span className="cname">{l.name}</span>
      {l.interest && <span className="cint">{l.interest}</span>}
      <LabelTags ids={l.label_ids} labels={labels} />
      {l.owner_name && <span className="cint">Responsável: {l.owner_name}</span>}
      {l.pinned_note && <span className="pinline"><Icon.pin /> {l.pinned_note}</span>}
      <span className={`cnext ${late ? "late" : ""}`}><Icon.clock />
        <span>{l.next_task_at ? `${TASK_TYPES[l.next_task_type]} · ${fmtRel(l.next_task_at)}` : "Sem tarefa"}</span>
        <em>{l.attempts ? `${l.attempts} tent.` : ago(l.created_at)}</em></span>
    </div>
  );
}
