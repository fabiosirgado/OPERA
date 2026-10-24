// Nova lead, Nova etapa e Gerir etiquetas, como no protótipo.
import { useEffect, useMemo, useState } from "react";
import { createLabel, createLead, createStage, deleteLabel, findDuplicate, labelUsage, updateLabel } from "../lib/leadsApi.js";
import { LABEL_COLORS, QUALIFIED_POSITION, SOURCES } from "../lib/format.js";
import { Modal, useAction, useToast } from "../ui/feedback.jsx";
import { LabelTag } from "../ui/bits.jsx";

// ctx: { opera, myClient, clients, stages, defaultClient, onChanged, onOpenLead }
export function NewLeadModal({ ctx, onClose }) {
  const { opera, myClient, clients } = ctx;
  const blank = { client_id: myClient?.id || ctx.defaultClient || clients[0]?.id || "", name: "", phone: "", email: "",
    source: "Referência", interest: "", budget: "", stage: "auto", note: "", note_pinned: false };
  const [f, setF] = useState(blank);
  const [dup, setDup] = useState(null);
  const [run, busy] = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });

  // Aviso de duplicado: mesmo telemóvel ou email no mesmo cliente.
  useEffect(() => {
    const t = setTimeout(() => {
      if (!f.client_id || (f.phone.replace(/\D/g, "").length < 6 && !f.email.includes("@"))) return setDup(null);
      findDuplicate(f.client_id, f.phone, f.email).then(setDup).catch(() => setDup(null));
    }, 350);
    return () => clearTimeout(t);
  }, [f.client_id, f.phone, f.email]);

  const submit = async (e) => {
    e.preventDefault();
    const again = e.nativeEvent.submitter?.name === "again";
    const p = { ...f };
    const fromClient = !opera && f.stage === "auto";
    const id = await run(() => createLead(p), fromClient ? "Lead criada. A OPERA vai contactar." : `Lead criada: ${f.name.trim()}`);
    if (!id) return;
    ctx.onChanged();
    if (again) setF({ ...blank, client_id: f.client_id, source: f.source }); else onClose();
  };

  return (
    <Modal title="Nova lead" onClose={onClose}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {opera && (
          <label className="f">Cliente *<select value={f.client_id} onChange={set("client_id")} required>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        )}
        <div className="g2">
          <label className="f">Nome *<input required value={f.name} onChange={set("name")} autoFocus /></label>
          <label className="f">Telemóvel *<input type="tel" required value={f.phone} onChange={set("phone")} /></label>
          <label className="f">Email<input type="email" value={f.email} onChange={set("email")} placeholder="opcional" /></label>
          <label className="f">Origem<select value={f.source} onChange={set("source")}>{SOURCES.map((s) => <option key={s}>{s}</option>)}</select></label>
        </div>
        {dup && (
          <div className="banner orange" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            <span style={{ flex: "1 1 260px" }}>Já existe uma lead com este contacto neste cliente: {dup.name}, {dup.stage_name}.</span>
            <button type="button" className="btn sm" onClick={() => { onClose(); ctx.onOpenLead(dup.id); }}>Abrir a existente</button>
          </div>
        )}
        <div className="g2">
          <label className="f">Interesse ou imóvel<input value={f.interest} onChange={set("interest")} placeholder="Ex.: T3 Telheiras" /></label>
          <label className="f">Budget<input value={f.budget} onChange={set("budget")} placeholder="Ex.: 450 000 €" /></label>
        </div>
        {opera ? (
          <label className="f">Etapa inicial<select value={f.stage} onChange={set("stage")}>
            <option value="auto">Automática pela origem</option>
            {ctx.stages.filter((s) => s.is_base && s.key !== "desq").map((s) => <option key={s.id} value={s.key}>{s.name}</option>)}
          </select></label>
        ) : (
          <fieldset style={{ border: 0, margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            <legend className="f" style={{ marginBottom: 8 }}>Quem trata desta lead?</legend>
            <label className="radio"><input type="radio" name="who" checked={f.stage === "auto"} onChange={() => setF({ ...f, stage: "auto" })} />A OPERA contacta e qualifica</label>
            <label className="radio"><input type="radio" name="who" checked={f.stage === "qualificada"} onChange={() => setF({ ...f, stage: "qualificada" })} />Fico eu com ela (já está qualificada)</label>
          </fieldset>
        )}
        <label className="f">Nota<textarea value={f.note} onChange={set("note")} placeholder="Contexto, quem referenciou, o que pediu" /></label>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}><input type="checkbox" checked={f.note_pinned} onChange={set("note_pinned")} />Afixar esta nota no topo da lead</label>
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="submit" name="again" className="btn" disabled={busy} style={{ borderColor: "var(--blue)", color: "var(--blueDark)", fontWeight: 600 }}>Criar e adicionar outra</button>
          <button type="submit" className="btn primary" disabled={busy}>Criar lead</button>
        </div>
      </form>
    </Modal>
  );
}

export function StageModal({ ctx, onClose }) {
  const { opera, myClient, clients, stages } = ctx;
  const [f, setF] = useState({ name: "", scope: opera ? "client" : "client", clientId: myClient?.id || ctx.defaultClient || clients[0]?.id, after: "", owner: "cliente" });
  const [run, busy] = useAction();
  const cid = f.scope === "all" ? null : f.clientId;
  const all = useMemo(() => stages.filter((s) => s.client_id === null || s.client_id === cid).sort((a, b) => a.position - b.position), [stages, cid]);
  const afterOpts = all.filter((s) => s.position >= QUALIFIED_POSITION && s.key !== "desq");
  const afterId = afterOpts.some((s) => s.id === f.after) ? f.after : afterOpts[afterOpts.length - 1]?.id;
  const idx = all.findIndex((s) => s.id === afterId);
  const preview = all.map((s) => s.name);
  preview.splice(idx + 1, 0, null);
  const client = clients.find((c) => c.id === cid);

  const submit = async (e) => {
    e.preventDefault();
    const a = all[idx].position, b = all[idx + 1] ? all[idx + 1].position : a + 10;
    const ok = await run(() => createStage({
      name: f.name.trim(), color: client?.color || "#475569", position: (a + b) / 2, client_id: cid,
      owner: opera ? f.owner : "cliente", is_base: false,
    }), `Etapa criada${client ? ` para ${client.name}` : " para todos os clientes"}`);
    if (ok) { ctx.onChanged(); onClose(); }
  };

  return (
    <Modal title="Nova etapa" onClose={onClose}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <label className="f">Nome da etapa<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Ex.: Proposta enviada" autoFocus /></label>
        {opera && (
          <fieldset style={{ border: 0, margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            <legend className="f" style={{ marginBottom: 8 }}>Para quem é esta etapa</legend>
            <label className="radio"><input type="radio" checked={f.scope === "all"} onChange={() => setF({ ...f, scope: "all" })} />Todos os clientes</label>
            <div className="radio" style={{ flexWrap: "wrap", padding: "6px 12px" }}>
              <label style={{ display: "flex", gap: 10, alignItems: "center" }}><input type="radio" checked={f.scope === "client"} onChange={() => setF({ ...f, scope: "client" })} />Só um cliente:</label>
              <select aria-label="Cliente" value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value, scope: "client" })}
                style={{ flex: "1 1 200px", minHeight: 38, border: "1px solid var(--line2)", borderRadius: 8, padding: "0 10px", background: "#fff" }}>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            </div>
          </fieldset>
        )}
        <div className="g2">
          <label className="f">Posição: depois de<select value={afterId} onChange={(e) => setF({ ...f, after: e.target.value })}>
            {afterOpts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          {opera && (
            <label className="f">Quem trabalha esta etapa<select value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })}>
              <option value="cliente">Cliente</option><option value="opera">OPERA</option><option value="ambos">Ambos</option></select></label>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="f">Como fica o pipeline</span>
          <div className="preview">{preview.map((n, i) => n === null
            ? <span key="new" className="new">{f.name.trim() || "Nova etapa"}</span> : <span key={i}>{n}</span>)}</div>
          <span className="sub" style={{ margin: 0, fontSize: 12 }}>Só dá para acrescentar etapas depois de Lead Qualificada. Até aí o funil é igual para todos os clientes.</span>
        </div>
        <div className="actions"><button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn primary" disabled={busy}>Criar etapa</button></div>
      </form>
    </Modal>
  );
}

export function LabelsModal({ ctx, onClose }) {
  const { labels } = ctx;
  const [usage, setUsage] = useState({});
  const [f, setF] = useState({ name: "", color: "vermelho" });
  const [run, busy] = useAction();
  const toast = useToast();
  useEffect(() => { labelUsage().then(setUsage).catch(() => {}); }, [labels]);
  const after = async (fn, ok) => { if (await run(fn, ok)) ctx.onChanged(); };

  const create = async (e) => {
    e.preventDefault();
    const n = f.name.trim();
    if (labels.some((x) => x.name.toLowerCase() === n.toLowerCase())) return toast("Já existe uma etiqueta com esse nome");
    await after(() => createLabel(n, f.color), "Etiqueta criada");
    setF({ name: "", color: "vermelho" });
  };

  return (
    <Modal title="Etiquetas" onClose={onClose}>
      <div className="sub" style={{ margin: 0 }}>As etiquetas servem para todos os clientes. Mudar o nome ou a cor atualiza todas as leads que a têm.</div>
      <div className="list">{labels.map((x) => (
        <div key={x.id} className="item" style={{ padding: "10px 14px" }}>
          <LabelTag label={x} />
          <label className="f" style={{ flex: "1 1 160px" }}><span className="vh">Nome</span>
            <input defaultValue={x.name} key={x.name} style={{ minHeight: 38 }}
              onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== x.name && after(() => updateLabel(x.id, { name: e.target.value.trim() }))} /></label>
          <label className="f"><span className="vh">Cor</span>
            <select value={x.color} style={{ minHeight: 38 }} onChange={(e) => after(() => updateLabel(x.id, { color: e.target.value }))}>
              {Object.entries(LABEL_COLORS).map(([k, v]) => <option key={k} value={k}>{v[2]}</option>)}</select></label>
          <span className="sub" style={{ margin: 0, fontSize: 12 }}>{usage[x.id] || 0} leads</span>
          <button type="button" className="link" disabled={busy} style={{ color: "#B91C1C" }}
            onClick={() => confirm(`Apagar a etiqueta ${x.name}?${usage[x.id] ? ` Sai de ${usage[x.id]} leads.` : ""}`) && after(() => deleteLabel(x.id), "Etiqueta apagada")}>Apagar</button>
        </div>))}
      </div>
      <form onSubmit={create} style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
        <label className="f" style={{ flex: "1 1 200px" }}>Nova etiqueta<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Ex.: Urgente" /></label>
        <div className="f" style={{ flex: "2 1 300px" }}>Cor
          <div className="chips" role="radiogroup" aria-label="Cor">{Object.entries(LABEL_COLORS).map(([k, v]) => (
            <label key={k} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 999, background: v[0], color: v[1], fontSize: 12, fontWeight: 600, minHeight: 32, cursor: "pointer" }}>
              <input type="radio" name="color" value={k} checked={f.color === k} onChange={() => setF({ ...f, color: k })} />{v[2]}</label>))}
          </div>
        </div>
        <button type="submit" className="btn primary" disabled={busy}>Criar etiqueta</button>
      </form>
      <div className="actions"><button type="button" className="btn" onClick={onClose}>Fechar</button></div>
    </Modal>
  );
}
