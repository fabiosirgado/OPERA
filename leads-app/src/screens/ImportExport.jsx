import { useEffect, useMemo, useState } from "react";
import { sb } from "../supabase.js";
import { FIELD_LABEL, TEMPLATE_ROWS, buildRows, downloadXlsx, fileSafe, guessField, matchStage, readWorkbook, stageValues } from "../lib/excel.js";
import { exportLeads } from "../lib/exportLeads.js";
import { useAction, useToast } from "../ui/feedback.jsx";

const BATCH = 250;

// "Importar e exportar" (equipa OPERA). Ficheiros .xlsx, .xls ou .csv.
export default function ImportExport({ ctx }) {
  return (
    <>
      <div className="top"><div><h1>Importar e exportar leads</h1><div className="sub">Só a equipa OPERA vê este ecrã. Ficheiros .xlsx, .xls ou .csv.</div></div></div>
      <div className="det">
        <Importer ctx={ctx} />
        <Exporter ctx={ctx} />
      </div>
    </>
  );
}

function Importer({ ctx }) {
  const { clients, stages } = ctx;
  const [imp, setImp] = useState(null);
  const [dups, setDups] = useState(null);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const toast = useToast();

  const readFile = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    f.arrayBuffer().then((buf) => {
      const { headers, rows } = readWorkbook(buf);
      if (!rows.length) return toast("O ficheiro não tem linhas.");
      const map = Object.fromEntries(headers.map((h) => [h, guessField(h)]));
      const has = (field) => headers.some((h) => map[h] === field);
      setResult(null);
      setImp({
        file: f.name, rows, headers, map, dup: "ignore", stageMap: {},
        client: has("client") ? "__col" : ctx.filterClient || clients[0]?.id,
        stage: has("stage") ? "__col" : stages.find((s) => s.key === "bd").id,
      });
    }).catch(() => toast("Não consegui ler este ficheiro."));
  };

  const built = useMemo(() => (imp ? buildRows(imp, clients, stages) : null), [imp, clients, stages]);

  // Duplicados contra a base de dados, de cada vez que muda o cliente ou o mapeamento.
  useEffect(() => {
    if (!built) return undefined;
    let cancel = false;
    setDups(null);
    const t = setTimeout(async () => {
      const found = new Set();
      for (let i = 0; i < built.valid.length; i += 1000) {
        const chunk = built.valid.slice(i, i + 1000).map((o, k) => ({ i: i + k, client_id: o.client_id, phone: o.phone, email: o.email }));
        const { data, error } = await sb.rpc("leads_import_check", { p_rows: chunk });
        if (error) { toast(error.message); return; }
        data.forEach((d) => found.add(d.i));
      }
      if (!cancel) setDups(found);
    }, 300);
    return () => { cancel = true; clearTimeout(t); };
  }, [built, toast]);

  const stageName = (id) => stages.find((s) => s.id === id)?.name ?? "Etapa";
  const newRows = built && dups ? built.valid.filter((_, i) => !dups.has(i)) : [];
  const dupRows = built && dups ? built.valid.filter((_, i) => dups.has(i)) : [];
  const toSend = imp?.dup === "ignore" ? newRows : built?.valid ?? [];
  const willCreate = newRows.length + (imp?.dup === "create" ? dupRows.length : 0);
  const perStage = {};
  for (const o of [...newRows, ...(imp?.dup === "create" ? dupRows : [])]) perStage[o.stage_id] = (perStage[o.stage_id] || 0) + 1;

  const run = async () => {
    const totals = { created: 0, updated: 0, ignored: 0, errors: [] };
    setProgress({ done: 0, total: toSend.length });
    try {
      for (let i = 0; i < toSend.length; i += BATCH) {
        const { data, error } = await sb.rpc("leads_import_batch", { p_rows: toSend.slice(i, i + BATCH), p_dup: imp.dup, p_file: imp.file });
        if (error) throw error;
        totals.created += data.created; totals.updated += data.updated; totals.ignored += data.ignored;
        totals.errors.push(...data.errors);
        setProgress({ done: Math.min(i + BATCH, toSend.length), total: toSend.length });
      }
      totals.errors.push(...built.bad.map((b) => ({ line: b.line, reason: b.why })));
      await sb.rpc("leads_log_import", { p_file: imp.file, p_created: totals.created, p_updated: totals.updated,
        p_ignored: totals.ignored + (imp.dup === "ignore" ? dupRows.length : 0), p_errors: totals.errors.length });
      setResult(totals);
      setImp(null);
      ctx.onRefsChanged();
      toast(`${totals.created} leads importadas${totals.updated ? `, ${totals.updated} atualizadas` : ""}`);
    } catch (e) {
      toast(`A importação parou: ${e.message}. As linhas já gravadas ficam.`);
      setResult(totals);
    } finally {
      setProgress(null);
    }
  };

  const set = (patch) => setImp((p) => ({ ...p, ...patch }));
  const stageOpts = stages.filter((s) => s.client_id === null || s.client_id === imp?.client);

  return (
    <section className="panel" style={{ flex: "3 1 560px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="top"><h2 style={{ margin: 0, fontSize: 18 }}>Importar</h2>
        <button type="button" className="link" onClick={() => downloadXlsx(TEMPLATE_ROWS, "modelo_importacao_opera.xlsx")}>Descarregar modelo Excel</button></div>

      {result && (
        <div className={`banner ${result.errors.length ? "orange" : "green"}`}>
          <b>{result.created} leads criadas</b>{result.updated ? `, ${result.updated} atualizadas` : ""}{result.ignored ? `, ${result.ignored} ignoradas` : ""}.
          {result.errors.length > 0 && (
            <details style={{ marginTop: 8 }}><summary style={{ cursor: "pointer", fontWeight: 600 }}>{result.errors.length} linhas não entraram</summary>
              <div className="list" style={{ marginTop: 8 }}>{result.errors.slice(0, 200).map((e, k) => (
                <div key={k} className="item" style={{ padding: "8px 14px" }}><span>Linha {e.line}</span><span style={{ color: "var(--redText)" }}>{e.reason}</span></div>))}</div>
            </details>
          )}
        </div>
      )}

      {!imp ? (
        <label className="banner blue" style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
          <b>Escolhe um ficheiro Excel ou CSV</b>
          <span>A primeira linha tem de ter os nomes das colunas. As colunas são reconhecidas pelo nome.</span>
          <input type="file" accept=".xlsx,.xls,.csv" onChange={readFile} />
        </label>
      ) : (
        <>
          <div className="banner blue" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
            <div style={{ flex: 1 }}><b>{imp.file}</b><div style={{ fontSize: 12 }}>{imp.rows.length} linhas encontradas</div></div>
            <button type="button" className="btn sm" disabled={!!progress} onClick={() => setImp(null)}>Trocar ficheiro</button>
          </div>
          <div className="g2">
            <label className="f">Para que cliente?<select value={imp.client} disabled={!!progress}
              onChange={(e) => {
                // Uma etapa só de outro cliente deixa de servir: volta para Nova Lead BD.
                const st = stages.find((s) => s.id === imp.stage);
                set({ client: e.target.value, stage: imp.stage === "__col" || !st?.client_id ? imp.stage : stages.find((s) => s.key === "bd").id });
              }}>
              <option value="__col">Usar a coluna Cliente do ficheiro</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label className="f">Etapa onde entram<select value={imp.stage} disabled={!!progress} onChange={(e) => set({ stage: e.target.value })}>
              {stageOpts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              <option value="__col">Usar a coluna Etapa do ficheiro</option></select></label>
          </div>
          {imp.stage === "__col" && (
            <StageMapping imp={imp} stageOpts={stageOpts} stages={stages} disabled={!!progress}
              onChange={(value, id) => set({ stageMap: { ...imp.stageMap, [value]: id } })} />
          )}
          <div>
            <h3 style={{ margin: "0 0 4px", fontSize: 14 }}>Correspondência de colunas</h3>
            <div className="sub" style={{ margin: "0 0 8px" }}>Reconhecidas automaticamente. Ajusta se for preciso.</div>
            <div className="tbl" style={{ margin: 0 }}>
              <table><thead><tr><th>Coluna no Excel</th><th>Exemplo</th><th>Campo no OPERA Leads</th></tr></thead>
                <tbody>{imp.headers.map((h) => (
                  <tr key={h}><td><b>{h}</b></td><td style={{ color: "var(--mute)" }}>{String(imp.rows[0]?.[h] ?? "").slice(0, 40)}</td>
                    <td><select aria-label={`Campo para ${h}`} value={imp.map[h]} disabled={!!progress}
                      onChange={(e) => set({ map: { ...imp.map, [h]: e.target.value } })}>
                      {Object.entries(FIELD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td></tr>))}
                </tbody></table>
            </div>
          </div>
          <div className="sum">
            <div style={{ background: "var(--greenSoft)", color: "var(--greenText)" }}><b>{dups ? newRows.length : "…"}</b><span style={{ fontSize: 12 }}>leads novas</span></div>
            <div style={{ background: "var(--orangeSoft)", color: "#7C2D12" }}><b>{dups ? dupRows.length : "…"}</b><span style={{ fontSize: 12 }}>já existem</span></div>
            <div style={{ background: "var(--redSoft)", color: "var(--redText)" }}><b>{built.bad.length}</b><span style={{ fontSize: 12 }}>com problemas</span></div>
          </div>
          {Object.keys(perStage).length > 0 && (
            <div className="sub" style={{ margin: 0 }}>Vão entrar em: {Object.entries(perStage).map(([id, n], k) => (
              <span key={id}>{k ? " · " : ""}<b>{stageName(id)}</b> {n}</span>))}</div>
          )}
          {built.bad.length > 0 && (
            <details><summary style={{ cursor: "pointer", fontWeight: 600, minHeight: 32 }}>Ver linhas com problemas</summary>
              <div className="list" style={{ marginTop: 8 }}>{built.bad.slice(0, 50).map((b) => (
                <div key={b.line} className="item" style={{ padding: "8px 14px" }}><span>Linha {b.line}</span>
                  <span style={{ color: "var(--mute)" }}>{b.name || "sem nome"}</span><span style={{ color: "var(--redText)" }}>{b.why}</span></div>))}</div>
            </details>
          )}
          <fieldset style={{ border: 0, margin: 0, padding: 0, display: "flex", flexWrap: "wrap", gap: 16 }}>
            <legend style={{ fontWeight: 600, marginBottom: 8 }}>Leads que já existem</legend>
            {[["ignore", "Ignorar"], ["fill", "Atualizar dados em falta"], ["create", "Criar na mesma"]].map(([v, l]) => (
              <label key={v} style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 32 }}>
                <input type="radio" name="dup" checked={imp.dup === v} disabled={!!progress} onChange={() => set({ dup: v })} />{l}</label>))}
          </fieldset>
          {progress && (
            <div role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} aria-label="Progresso da importação">
              <div style={{ height: 10, borderRadius: 999, background: "var(--col)", overflow: "hidden" }}>
                <div style={{ width: `${(progress.done / progress.total) * 100}%`, height: "100%", background: "var(--blue)", transition: "width .3s" }} />
              </div>
              <span className="sub" style={{ margin: "6px 0 0", display: "block", fontSize: 12 }}>{progress.done} de {progress.total} linhas</span>
            </div>
          )}
          <div className="actions">
            <button type="button" className="btn primary" disabled={!dups || !!progress || !(willCreate || (dupRows.length && imp.dup === "fill"))} onClick={run}>
              {imp.dup === "fill" && dupRows.length ? `Importar ${willCreate} e atualizar ${dupRows.length}` : `Importar ${willCreate} leads`}</button>
          </div>
        </>
      )}
    </section>
  );
}

// Etapas do ficheiro (por exemplo as de uma conta Pipedrive) e a etapa da OPERA para onde vai cada uma.
function StageMapping({ imp, stageOpts, stages, disabled, onChange }) {
  const values = stageValues(imp);
  const bd = stages.find((s) => s.key === "bd")?.id;
  const hasStatus = Object.values(imp.map).includes("status");
  if (!values.length) return null;
  return (
    <div>
      <h3 style={{ margin: "0 0 4px", fontSize: 14 }}>Etapas do ficheiro</h3>
      <div className="sub" style={{ margin: "0 0 8px" }}>
        Escolhe para onde vai cada etapa.{hasStatus ? " Os negócios ganhos entram em Lead Qualificada e os perdidos em Lead desqualificada, seja qual for a etapa." : ""}
      </div>
      <div className="tbl" style={{ margin: 0 }}>
        <table><thead><tr><th>Etapa no ficheiro</th><th>Linhas</th><th>Etapa no OPERA Leads</th></tr></thead>
          <tbody>{values.map(([v, n]) => (
            <tr key={v}><td><b>{v}</b></td><td>{n}</td>
              <td><select aria-label={`Etapa para ${v}`} disabled={disabled}
                value={imp.stageMap[v] || matchStage(v, imp.client, stages) || bd} onChange={(e) => onChange(v, e.target.value)}>
                {stageOpts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></td></tr>))}
          </tbody></table>
      </div>
    </div>
  );
}

function Exporter({ ctx }) {
  const { clients, stages } = ctx;
  const [f, setF] = useState({ client: "", stages: null, days: 0, history: true, pipedrive: false });
  const [progress, setProgress] = useState(null);
  const [run, busy] = useAction();
  const visibleStages = stages.filter((s) => !s.client_id || !f.client || s.client_id === f.client);
  const checked = (id) => !f.stages || f.stages.includes(id);
  const toggle = (id) => {
    const cur = f.stages || visibleStages.map((s) => s.id);
    setF({ ...f, stages: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  };
  const go = () => run(async () => {
    const client = clients.find((c) => c.id === f.client);
    const n = await exportLeads({
      client: f.client || null, stages: f.stages, history: f.history, pipedrive: f.pipedrive,
      since: f.days ? new Date(Date.now() - f.days * 864e5).toISOString() : null,
      fileName: `leads_${client ? fileSafe(client.name) : "todos"}${f.pipedrive ? "_pipedrive" : ""}.xlsx`,
      onProgress: (done, total) => setProgress({ done, total }),
    });
    setProgress(null);
    return n;
  }, (n) => `${n} leads exportadas`).finally(() => setProgress(null));

  return (
    <section className="panel" style={{ flex: "2 1 320px", display: "flex", flexDirection: "column", gap: 14 }}>
      <h2 style={{ margin: 0, fontSize: 18 }}>Exportar</h2>
      <label className="f">Cliente<select value={f.client} onChange={(e) => setF({ ...f, client: e.target.value, stages: null })}>
        <option value="">Todos os clientes</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <fieldset style={{ border: 0, margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        <legend style={{ fontWeight: 600, marginBottom: 6 }}>Etapas</legend>
        {visibleStages.map((s) => (
          <label key={s.id} style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 30 }}>
            <input type="checkbox" checked={checked(s.id)} onChange={() => toggle(s.id)} />{s.name}
            {s.client_id && <span style={{ color: "var(--mute2)", fontSize: 12 }}>({clients.find((c) => c.id === s.client_id)?.name})</span>}</label>))}
      </fieldset>
      <label className="f">Período<select value={f.days} onChange={(e) => setF({ ...f, days: Number(e.target.value) })}>
        <option value={0}>Sempre</option><option value={30}>Últimos 30 dias</option><option value={90}>Últimos 3 meses</option></select></label>
      <label style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 32 }}><input type="checkbox" checked={f.history} onChange={(e) => setF({ ...f, history: e.target.checked })} />Incluir notas e histórico</label>
      <label style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 32 }}><input type="checkbox" checked={f.pipedrive} onChange={(e) => setF({ ...f, pipedrive: e.target.checked })} />Formato pronto para importar no Pipedrive</label>
      {progress && <span className="sub" style={{ margin: 0, fontSize: 12 }}>A preparar {progress.done} de {progress.total} leads…</span>}
      <button type="button" className="btn dark" disabled={busy || (f.stages && !f.stages.length)} onClick={go}>Exportar .xlsx</button>
      <span className="sub" style={{ margin: 0, fontSize: 12 }}>As exportações ficam no registo de atividade.</span>
    </section>
  );
}
