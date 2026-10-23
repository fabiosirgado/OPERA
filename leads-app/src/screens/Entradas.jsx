import { useCallback, useEffect, useState } from "react";
import { sb } from "../supabase.js";
import { fmtWhen } from "../lib/format.js";
import { Modal, useAction, useToast } from "../ui/feedback.jsx";

const STATUS = {
  processado: ["ok", "Criada"],
  revisao: ["rev", "Criada, precisa de revisão"],
  duplicado: ["off", "Repetida, juntada à existente"],
  sem_cliente: ["rev", "Sem cliente"],
  erro: ["del", "Erro"],
  recebido: ["inv", "A processar"],
};
const CHANNEL = { meta: "Meta", email: "Email de portal" };
// Endereços que nunca são do cliente (o Make e os remetentes dos portais), escondidos na lista.
const NOT_CLIENT = /make\.com$|no-?reply|idealista|imovirtual|sapo\.pt|supercasa/i;
const PORTAL_SENDERS ="idealista.com OR imovirtual.com OR casa.sapo.pt OR supercasa.pt";

function Status({ s }) {
  const [cls, label] = STATUS[s] || ["off", s];
  const style = cls === "rev" ? { background: "var(--orangeSoft)", color: "var(--orangeText)" } : undefined;
  return <span className={`state ${cls === "rev" ? "inv" : cls}`} style={style}>{label}</span>;
}

const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };

// Entradas automáticas (equipa OPERA): formulários Meta e emails dos portais, ambos pelo Make.
export default function Entradas({ ctx, isAdmin }) {
  const [d, setD] = useState(null);
  const [modal, setModal] = useState(null);
  const [run] = useAction();

  const load = useCallback(() => run(async () => setD(await must(sb.rpc("leads_inbound_overview")))), [run]);
  useEffect(() => { load(); }, [load, ctx.version]);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, 30000);
    return () => clearInterval(t);
  }, [load]);

  if (!d) return <div className="empty">A carregar…</div>;

  return (
    <>
      <div className="top">
        <div><h1>Entradas automáticas</h1><div className="sub">Como as leads chegam sozinhas a cada cliente: formulários Meta e emails dos portais imobiliários (lidos por IA), ambos através do Make</div></div>
      </div>

      <div className="dgrid">
        <InboundAddress value={d.inbound_email} isAdmin={isAdmin} onSaved={load} />
        {d.codes.length > 0 && <Codes codes={d.codes} onDone={load} />}
        {d.unassigned.length > 0 && <Unassigned items={d.unassigned} clients={d.clients} onDone={() => { load(); ctx.onChanged(); }} />}

        {d.clients.map((c) => (
          <ClientCard key={c.id} c={c} onChanged={load} onInstructions={() => setModal({ kind: "fwd", client: c })} />
        ))}
        {d.clients.length === 0 && <div className="panel s12 empty">Ainda não há clientes ativos no Leads.</div>}

        <div className="panel s12">
          <h3>Últimas entradas</h3>
          <div className="sub" style={{ margin: "4px 0 0", fontSize: 13 }}>Cada entrada fica registada, mesmo quando falha, para nenhuma lead se perder. O email original fica guardado 30 dias.</div>
          <div className="tbl">
            <table>
              <thead><tr><th>Quando</th><th>Cliente</th><th>Canal</th><th>Resultado</th><th>Lead</th><th></th></tr></thead>
              <tbody>
                {d.recent.length ? d.recent.map((i) => (
                  <tr key={i.id}>
                    <td style={{ whiteSpace: "nowrap" }}>{fmtWhen(i.received_at)}</td>
                    <td>{i.client || "—"}</td>
                    <td>{CHANNEL[i.channel] || i.channel}</td>
                    <td><Status s={i.status} />{i.status === "erro" && i.error && <div className="sub" style={{ margin: "4px 0 0", fontSize: 12 }}>{i.error}</div>}</td>
                    <td>{i.lead_id ? <button type="button" className="link" onClick={() => ctx.onOpenLead(i.lead_id)}>{i.lead_name || "Abrir"}</button> : "—"}</td>
                    <td>{i.has_raw && <button type="button" className="link" onClick={() => setModal({ kind: "raw", id: i.id })}>Ver original</button>}</td>
                  </tr>
                )) : <tr><td colSpan={6} className="empty">Ainda sem entradas. Quando o Make estiver ligado, cada lead aparece aqui.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {modal?.kind === "fwd" && <ForwardModal client={modal.client} inbound={d.inbound_email} onClose={() => setModal(null)} />}
      {modal?.kind === "raw" && <RawModal id={modal.id} onClose={() => setModal(null)} />}
    </>
  );
}

// Endereço de receção do Make: o admin escreve-o uma vez; aparece nas instruções aos clientes.
function InboundAddress({ value, isAdmin, onSaved }) {
  const [v, setV] = useState(value || "");
  const [run, busy] = useAction();
  useEffect(() => setV(value || ""), [value]);
  const save = () => run(async () => {
    await must(sb.from("leads_settings").update({ inbound_email: v.trim().toLowerCase() || null }).eq("id", true));
    onSaved();
  }, "Endereço guardado");
  return (
    <div className="panel s12" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <h3>Endereço de receção dos emails</h3>
      <span className="sub" style={{ margin: 0, fontSize: 13 }}>
        É o endereço do Make para onde todos os clientes reencaminham os emails dos portais. A OPERA identifica o cliente pelo endereço onde o email chegou primeiro.
      </span>
      {isAdmin ? (
        <form className="row inline-f" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <input type="email" value={v} onChange={(e) => setV(e.target.value)} placeholder="ex.: abc123@hook.eu1.make.com" style={{ flex: "1 1 260px" }} aria-label="Endereço de receção" />
          <button type="submit" className="btn sm" disabled={busy || v.trim() === (value || "")}>Guardar</button>
        </form>
      ) : <b style={{ wordBreak: "break-all" }}>{value || "Ainda por configurar (só o admin muda)"}</b>}
    </div>
  );
}

// Códigos de confirmação do Gmail: a OPERA envia o código ao cliente para o reencaminhamento ficar ativo.
function Codes({ codes, onDone }) {
  const [run] = useAction();
  const toast = useToast();
  const copy = async (code) => { try { await navigator.clipboard.writeText(code); toast("Código copiado"); } catch { toast(code); } };
  return (
    <div className="panel s12 banner orange" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <b>Códigos de confirmação do Gmail por enviar</b>
      <span style={{ fontSize: 13 }}>Envia o código ao cliente: ele escreve-o no Gmail (Encaminhamento e POP/IMAP) para o reencaminhamento ficar ativo.</span>
      {codes.map((c) => (
        <div key={c.id} className="row" style={{ justifyContent: "space-between", gap: 10, flexWrap: "wrap", borderTop: "1px solid var(--orangeLine)", paddingTop: 8 }}>
          <span style={{ minWidth: 0, wordBreak: "break-all" }}>
            <b style={{ fontSize: 18, letterSpacing: 1 }}>{c.code || "sem código"}</b> · {c.address || "endereço desconhecido"}{c.client ? ` · ${c.client}` : ""} · {fmtWhen(c.received_at)}
          </span>
          <span className="row" style={{ gap: 8 }}>
            {c.code && <button type="button" className="btn sm" onClick={() => copy(c.code)}>Copiar código</button>}
            <button type="button" className="btn sm" onClick={() => run(async () => { await must(sb.rpc("leads_inbound_code_done", { p_log_id: c.id })); onDone(); }, "Marcado como enviado")}>Já enviei</button>
          </span>
        </div>
      ))}
    </div>
  );
}

// Entradas que não foi possível ligar a um cliente: a equipa escolhe o cliente e a lead é criada.
function Unassigned({ items, clients, onDone }) {
  const [pick, setPick] = useState({});
  const [run] = useAction();
  const assign = (id) => run(async () => {
    const r = await must(sb.rpc("leads_inbound_assign", { p_log_id: id, p_client_id: pick[id] }));
    onDone();
    return r;
  }, (r) => (r?.status === "duplicado" ? "Juntada à lead que já existia" : "Lead criada"));
  return (
    <div className="panel s12">
      <h3>Entradas sem cliente</h3>
      <div className="sub" style={{ margin: "4px 0 0", fontSize: 13 }}>Não foi possível saber de que cliente são. Escolhe o cliente e, para as próximas, junta o endereço ou o formulário ao cartão do cliente.</div>
      <div className="tbl">
        <table>
          <thead><tr><th>Quando</th><th>Canal</th><th>Nome</th><th>Origem</th><th>Cliente</th></tr></thead>
          <tbody>
            {items.map((u) => (
              <tr key={u.id}>
                <td style={{ whiteSpace: "nowrap" }}>{fmtWhen(u.received_at)}</td>
                <td>{CHANNEL[u.channel]}</td>
                <td>{u.name || "Sem nome"}</td>
                <td style={{ overflowWrap: "anywhere", fontSize: 13, minWidth: 140 }}>
                  {u.channel === "meta" ? `Página ${u.page_id || "?"}${u.form_id ? `, formulário ${u.form_id}` : ""}`
                    : (u.recipients || []).filter((a) => !NOT_CLIENT.test(a)).map((a) => <div key={a}>{a}</div>)}
                </td>
                <td>
                  <div className="row inline-f" style={{ gap: 6, flexWrap: "nowrap" }}>
                    <select value={pick[u.id] || ""} onChange={(e) => setPick((p) => ({ ...p, [u.id]: e.target.value }))} aria-label="Cliente">
                      <option value="">Escolher…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <button type="button" className="btn sm" disabled={!pick[u.id]} onClick={() => assign(u.id)}>Criar lead</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ClientCard({ c, onChanged, onInstructions }) {
  const [run, busy] = useAction();
  const [addr, setAddr] = useState("");
  const [form, setForm] = useState({ page_id: "", form_id: "", label: "" });
  const addAddress = () => run(async () => {
    await must(sb.from("client_inbox_addresses").insert({ client_id: c.id, address: addr.trim().toLowerCase() }));
    setAddr(""); onChanged();
  }, "Endereço juntado");
  const removeAddress = (a) => run(async () => { await must(sb.from("client_inbox_addresses").delete().eq("address", a)); onChanged(); }, "Endereço retirado");
  const addForm = () => run(async () => {
    if (!form.page_id.trim() && !form.form_id.trim()) throw new Error("Indica a página, o formulário, ou os dois.");
    await must(sb.from("lead_meta_forms").insert({ client_id: c.id, page_id: form.page_id.trim() || null, form_id: form.form_id.trim() || null, label: form.label.trim() || null }));
    setForm({ page_id: "", form_id: "", label: "" }); onChanged();
  }, "Formulário juntado");
  const removeForm = (id) => run(async () => { await must(sb.from("lead_meta_forms").delete().eq("id", id)); onChanged(); }, "Formulário retirado");
  const section = { display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid var(--line)", paddingTop: 10 };

  return (
    <div className="panel s6" style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <div className="tags"><span className="dot" style={{ background: c.color }}></span><b style={{ fontSize: 15 }}>{c.name}</b></div>

      <div style={section}>
        <b style={{ fontSize: 13 }}>Formulários Meta</b>
        <span className="sub" style={{ margin: 0, fontSize: 13 }}>
          As leads destes formulários (ou de todos os formulários de uma página) entram em <b>Nova Lead Meta</b>. Última entrada: {c.meta_last ? fmtWhen(c.meta_last) : "ainda sem entradas"}.
        </span>
        {c.forms.map((f) => (
          <div key={f.id} className="row" style={{ justifyContent: "space-between", fontSize: 13, gap: 8 }}>
            <span style={{ minWidth: 0, wordBreak: "break-all" }}>{f.label ? <b>{f.label} </b> : null}{f.form_id ? `Formulário ${f.form_id}` : `Página ${f.page_id}, todos os formulários`}</span>
            <button type="button" className="link" style={{ color: "#B91C1C" }} disabled={busy} onClick={() => removeForm(f.id)}>Retirar</button>
          </div>
        ))}
        <form className="row inline-f" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); addForm(); }}>
          <input value={form.page_id} onChange={(e) => setForm({ ...form, page_id: e.target.value })} placeholder="Página (opcional)" aria-label="Id da página" pattern="[0-9A-Za-z_-]{1,64}" style={{ flex: "1 1 120px" }} />
          <input value={form.form_id} onChange={(e) => setForm({ ...form, form_id: e.target.value })} placeholder="Formulário" aria-label="Id do formulário" pattern="[0-9A-Za-z_-]{1,64}" style={{ flex: "1 1 160px" }} />
          <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Nome (opcional)" aria-label="Nome do formulário" style={{ flex: "1 1 120px" }} />
          <button type="submit" className="btn sm" disabled={busy}>Juntar</button>
        </form>
      </div>

      <div style={section}>
        <b style={{ fontSize: 13 }}>Emails dos portais</b>
        <span className="sub" style={{ margin: 0, fontSize: 13 }}>
          Endereços onde o cliente recebe os emails do Idealista, Imovirtual e Casa Sapo. A IA lê cada email e cria a lead em <b>Nova lead imóveis</b>. Última entrada: {c.email_last ? fmtWhen(c.email_last) : "ainda sem entradas"}.
        </span>
        {c.addresses.map((a) => (
          <div key={a} className="row" style={{ justifyContent: "space-between", fontSize: 13, gap: 8 }}>
            <span style={{ minWidth: 0, wordBreak: "break-all" }}>{a}</span>
            <button type="button" className="link" style={{ color: "#B91C1C" }} disabled={busy} onClick={() => removeAddress(a)}>Retirar</button>
          </div>
        ))}
        <form className="row inline-f" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); addAddress(); }}>
          <input type="email" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="ex.: geral@agencia.pt" aria-label="Endereço de email do cliente" required style={{ flex: "1 1 200px" }} />
          <button type="submit" className="btn sm" disabled={busy}>Juntar</button>
        </form>
        <div className="row"><button type="button" className="link" onClick={onInstructions}>Instruções para o cliente</button></div>
      </div>
    </div>
  );
}

function ForwardModal({ client, inbound, onClose }) {
  const to = inbound || "o endereço de receção (ainda por configurar)";
  return (
    <Modal title="Reencaminhar emails dos portais" onClose={onClose} wide>
      <span className="sub" style={{ margin: 0 }}>Basta fazer isto uma vez. A partir daí, cada contacto dos portais chega sozinho à OPERA. O cliente continua a receber os emails normalmente.</span>
      {client.addresses.length === 0 && (
        <div className="banner orange">Junta primeiro, no cartão de {client.name}, o endereço onde o cliente recebe os emails dos portais. É assim que a OPERA sabe que os emails são deste cliente.</div>
      )}
      <div className="panel"><h3>Gmail</h3>
        <ol style={{ margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.7, fontSize: 14 }}>
          <li>Definições, Ver todas as definições, Encaminhamento e POP/IMAP: <b>Adicionar um endereço de encaminhamento</b> e escrever <b style={{ wordBreak: "break-all" }}>{to}</b>.</li>
          <li>O Gmail envia um código de confirmação para esse endereço. <b>A OPERA recebe o código e envia ao cliente</b> (aparece no topo deste ecrã).</li>
          <li>Em Filtros, criar um filtro com De: <b>{PORTAL_SENDERS}</b> e escolher <b>Reencaminhar para</b> esse endereço.</li>
        </ol>
      </div>
      <div className="panel"><h3>Outlook</h3>
        <ol style={{ margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.7, fontSize: 14 }}>
          <li>Definições, Correio, Regras: <b>Adicionar nova regra</b>.</li>
          <li>Condição: o remetente contém <b>idealista.com</b>, <b>imovirtual.com</b>, <b>casa.sapo.pt</b> ou <b>supercasa.pt</b>.</li>
          <li>Ação: <b>Redirecionar para</b> <b style={{ wordBreak: "break-all" }}>{to}</b>.</li>
        </ol>
      </div>
      <div className="actions"><button type="button" className="btn primary" onClick={onClose}>Fechar</button></div>
    </Modal>
  );
}

// Email original, como chegou do Make (só a equipa OPERA; fica registado quem o viu).
function RawModal({ id, onClose }) {
  const [raw, setRaw] = useState(null);
  const [run] = useAction();
  useEffect(() => { run(async () => setRaw(await must(sb.rpc("leads_inbound_original", { p_log_id: id })))); }, [id, run]);
  const text = raw && (raw.type === "email"
    ? [`De: ${raw.from ?? ""}`, `Para: ${raw.to ?? ""}`, `Assunto: ${raw.subject ?? ""}`, "", raw.text || (raw.html ? new DOMParser().parseFromString(raw.html, "text/html").body.innerText : "")].join("\n")
    : JSON.stringify(raw, null, 2));
  return (
    <Modal title="Entrada original" onClose={onClose} wide>
      {!raw ? <div className="empty">A carregar…</div>
        : <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 13, maxHeight: "60vh", overflow: "auto", margin: 0 }}>{text}</pre>}
      <div className="actions"><button type="button" className="btn primary" onClick={onClose}>Fechar</button></div>
    </Modal>
  );
}
