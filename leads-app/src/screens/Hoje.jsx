import { useEffect, useState } from "react";
import { callLead, completeTask, today } from "../lib/leadsApi.js";
import { useAction } from "../ui/feedback.jsx";
import { ClientTag, Icon, TaskTag } from "../ui/bits.jsx";
import { isAllDay } from "../lib/format.js";

// "Hoje": tarefas atrasadas, de hoje e de amanhã, de todos os clientes.
export default function Hoje({ ctx }) {
  const { clients, version } = ctx;
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  const [run, busy] = useAction();
  const client = ctx.filterClient;

  useEffect(() => {
    const t = setTimeout(() => run(() => today(client, q)).then((r) => r && setRows(r)), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [client, q, version, run]);

  const now = Date.now();
  const endToday = new Date(); endToday.setHours(23, 59, 59, 999);
  const groups = [
    ["Atrasadas", "#C2410C", (rows || []).filter((r) => new Date(r.due_at) < now)],
    ["Ainda hoje", "#1D4ED8", (rows || []).filter((r) => new Date(r.due_at) >= now && new Date(r.due_at) <= endToday)],
    ["Amanhã", "#475569", (rows || []).filter((r) => new Date(r.due_at) > endToday)],
  ];
  const whenText = (d) => {
    const x = new Date(d);
    return x < now && x.toDateString() !== new Date().toDateString()
      ? x.toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit" })
      : isAllDay(x) ? "Sem hora" : x.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
  };
  const call = (r) => run(() => callLead({ id: r.lead_id, phone: r.phone }),
    (via) => (via === "cloudtalk" ? `A CloudTalk vai ligar-te primeiro e depois a ${r.lead_name}` : `A ligar a ${r.lead_name}`))
    .then((ok) => ok && ctx.onChanged());

  return (
    <>
      <div className="top">
        <div><h1>Hoje</h1><div className="sub">Todas as tarefas de todos os clientes, por ordem de urgência</div></div>
        <label className="search"><Icon.search /><span className="vh">Procurar</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Procurar" /></label>
      </div>
      <div className="pills" role="group" aria-label="Filtrar por cliente">
        <button type="button" className={`pill ${!client ? "on" : ""}`} onClick={() => ctx.setFilterClient(null)}>Todos os clientes</button>
        {clients.map((c) => (
          <button key={c.id} type="button" className={`pill ${client === c.id ? "on" : ""}`} onClick={() => ctx.setFilterClient(c.id)}>
            <span className="dot" style={{ width: 8, height: 8, flex: "0 0 8px", background: c.color }}></span>{c.name}</button>
        ))}
      </div>
      {!rows && <div className="empty">A carregar…</div>}
      {rows && groups.map(([title, color, items]) => (
        <div key={title} style={{ display: "contents" }}>
          <h3 className="grpT" style={{ color }}>{title} · {items.length}</h3>
          <div className="list">
            {items.length === 0 && <div className="empty">Nada aqui.</div>}
            {items.slice(0, 150).map((r) => (
              <div key={r.task_id} className="item">
                <span className="t" style={{ color }}>{whenText(r.due_at)}</span>
                <span className="ty"><TaskTag type={r.task_type} /></span>
                <div className="who">
                  <div className="tags"><b>{r.lead_name}</b><ClientTag name={r.client_name} color={r.client_color} /><span className="src">{r.stage_name}</span></div>
                  <span className="cint">{r.task_note || r.interest}</span>
                </div>
                <div className="row">
                  {r.phone && <button type="button" className="btn primary sm" disabled={busy} onClick={() => call(r)}><Icon.phone />Ligar</button>}
                  <button type="button" className="btn sm" onClick={() => ctx.onOpenLead(r.lead_id)}>Abrir</button>
                  <button type="button" className="btn sm" disabled={busy}
                    onClick={() => run(() => completeTask(r.task_id), "Tarefa concluída").then((ok) => ok && ctx.onChanged())}>Feita</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
