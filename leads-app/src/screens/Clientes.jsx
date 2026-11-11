import { useCallback, useEffect, useState } from "react";
import {
  assignManager, clientsOverview, createClient, crmClientsNotEnabled, deactivateClient, enableCrmClient,
  inviteUser, operaTeam, purgeClientNow, reactivateClient, setManagers, usersOfClient,
} from "../lib/api.js";
import { CLIENT_COLORS, MAX_CLIENTS_PER_MANAGER, RETENTION_MONTHS, fmtDate } from "../lib/format.js";
import { Modal, useAction, useToast } from "../ui/feedback.jsx";
import { exportLeads } from "../lib/exportLeads.js";
import { downloadXlsx, fileSafe } from "../lib/excel.js";
import { exportConversation } from "../lib/leadsApi.js";
import { InviteForm, UserTable } from "./users.jsx";

const INBOX_DOMAIN = "leads.opera-os.com";

// "Clientes e acessos" (equipa OPERA): clientes, gestor atribuído e utilizadores com acesso.
export default function Clientes({ profile }) {
  const isAdmin = profile.leads_role === "admin";
  const [clients, setClients] = useState(null);
  const [team, setTeam] = useState([]);
  const [modal, setModal] = useState(null);
  const [run] = useAction();

  const load = useCallback(async () => {
    const [c, t] = await Promise.all([run(clientsOverview), run(operaTeam)]);
    if (c) setClients(c);
    if (t) setTeam(t);
  }, [run]);
  useEffect(() => { load(); }, [load]);

  const managers = team.filter((u) => u.leads_status === "ativo" || (u.leads_status === "convidado" && ["admin", "gestor"].includes(u.leads_role)));
  const loadOf = (id) => (clients || []).filter((c) => (c.manager_ids || []).includes(id) && c.leads_status === "ativo").length;
  const close = () => setModal(null);
  const closeAndReload = () => { setModal(null); load(); };

  return (
    <>
      <div className="top">
        <div><h1>Clientes e acessos</h1><div className="sub">Clientes da OPERA, gestor atribuído e utilizadores com acesso</div></div>
        <div className="row">
          {isAdmin && <button type="button" className="btn" onClick={() => setModal({ kind: "managers" })}>Atribuir gestores</button>}
          {isAdmin && <button type="button" className="btn primary" onClick={() => setModal({ kind: "new" })}>Novo cliente</button>}
        </div>
      </div>

      <div className="tbl" style={{ margin: 0, background: "#fff" }}>
        <table>
          <thead><tr><th>Cliente</th><th>Gestores</th><th className="n">Utilizadores</th><th className="n">Leads</th><th>Estado</th></tr></thead>
          <tbody>
            {!clients && <tr><td colSpan={5} className="empty">A carregar…</td></tr>}
            {clients?.length === 0 && <tr><td colSpan={5} className="empty">Ainda não há clientes no OPERA Leads.</td></tr>}
            {clients?.map((c) => (
              <tr key={c.id} className="rowL" tabIndex={0} onClick={() => setModal({ kind: "client", id: c.id })}
                onKeyDown={(e) => e.key === "Enter" && setModal({ kind: "client", id: c.id })}>
                <td><span className="tags"><span className="dot" style={{ background: c.color }}></span><b>{c.name}</b></span></td>
                <td>{c.manager_name || "Sem gestor"}</td>
                <td className="n">{c.users_active}{c.users_invited > 0 && <> <span className="state inv">+{c.users_invited} convite</span></>}</td>
                <td className="n">{c.leads_count}</td>
                <td>{c.leads_status === "inativo"
                  ? <span className="state del">Desativado · apagado a {fmtDate(c.leads_purge_at)}</span>
                  : <span className="state ok">Ativo</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isAdmin && (
        <div className="panel">
          <h3>Equipa OPERA</h3>
          <div className="sub" style={{ margin: "4px 0 12px", fontSize: 13 }}>Admin e gestores de leads. Cada gestor tem no máximo {MAX_CLIENTS_PER_MANAGER} clientes.</div>
          <UserTable users={team} me={profile.id} manage onChange={load} />
          <InviteForm clientId={null} roles={["gestor", "admin"]} onDone={load} />
        </div>
      )}
      <div className="foot">A equipa OPERA (admin e gestores) entra com verificação em dois passos. Os clientes entram só por convite.</div>

      {modal?.kind === "client" && (
        <ClientModal client={clients.find((c) => c.id === modal.id)} isAdmin={isAdmin} me={profile.id}
          onClose={close} onChanged={load} />
      )}
      {modal?.kind === "new" && <NewClientModal managers={managers} loadOf={loadOf} onClose={close} onDone={closeAndReload} />}
      {modal?.kind === "managers" && (
        <ManagersModal clients={clients.filter((c) => c.leads_status === "ativo")} managers={managers} loadOf={loadOf}
          onClose={close} onChanged={load} />
      )}
    </>
  );
}

function ClientModal({ client: c, isAdmin, me, onClose, onChanged }) {
  const [users, setUsers] = useState(null);
  const [run, busy] = useAction();
  const toast = useToast();
  const loadUsers = useCallback(() => run(() => usersOfClient(c.id)).then((u) => u && setUsers(u)), [run, c.id]);
  useEffect(() => { loadUsers(); }, [loadUsers]);
  const changed = () => { loadUsers(); onChanged(); };
  const inactive = c.leads_status === "inativo";

  const deactivate = async () => {
    if (!confirm(`Desativar ${c.name}? Todos os acessos deste cliente ficam bloqueados já. As leads ficam guardadas ${RETENTION_MONTHS} meses e depois são apagadas automaticamente.`)) return;
    if (await run(() => deactivateClient(c.id), "Cliente desativado")) onChanged();
  };
  // Para entregar ao cliente que sai: todas as leads, com histórico.
  const exportClient = () => run(() => exportLeads({ client: c.id, history: true, fileName: `leads_${fileSafe(c.name)}.xlsx` }), (n) => `${n} leads exportadas`);
  // A conversa com a OPERA, para entregar ao cliente junto com as leads.
  const exportChat = () => run(async () => {
    const rows = await exportConversation(c.id);
    if (!rows.length) throw new Error("Ainda não há mensagens na conversa com este cliente.");
    downloadXlsx(rows.map((m) => ({
      Data: new Date(m.created_at).toLocaleString("pt-PT"), Autor: m.author, Lado: m.side === "opera" ? "OPERA" : "Cliente",
      Mensagem: m.deleted ? "Mensagem apagada" : m.body, Lead: m.lead || "", Editada: m.edited ? "Sim" : "",
    })), `conversa_${fileSafe(c.name)}.xlsx`, "Conversa");
    return rows.length;
  }, (n) => `${n} mensagens exportadas`);
  const purge = async () => {
    const typed = prompt(`Para apagar já todas as leads de ${c.name}, escreve o nome do cliente:`);
    if (typed === null) return;
    if (typed !== c.name) return toast("O nome não corresponde. Nada foi apagado.");
    if (await run(() => purgeClientNow(c.id, typed), (n) => `${n} leads apagadas`)) onChanged();
  };

  return (
    <Modal title={c.name} onClose={onClose} wide>
      <div className="row"><span className="sub" style={{ margin: 0 }}>
        {(c.manager_ids || []).length > 1 ? "Gestores" : "Gestor"}: <b>{c.manager_name || "Sem gestor"}</b> · {c.leads_count} leads
        {c.inbox_alias && <> · emails dos portais para <b>{c.inbox_alias}@{INBOX_DOMAIN}</b></>}
      </span></div>
      {inactive && <div className="banner orange">Cliente desativado a {fmtDate(c.leads_deactivated_at)}. Ninguém deste cliente consegue entrar. Os dados são apagados automaticamente a <b>{fmtDate(c.leads_purge_at)}</b>.</div>}

      <h3 style={{ margin: 0, fontSize: 15 }}>Utilizadores</h3>
      {users ? <UserTable users={users} me={me} manage={!inactive} onChange={changed} /> : <div className="empty">A carregar…</div>}
      {!inactive && <InviteForm clientId={c.id} roles={["cliente", "cliente_admin"]} onDone={changed} />}

      {isAdmin && (
        <div className="danger">
          {!inactive ? (
            <>
              <b>Desativar cliente</b>
              <span className="sub" style={{ margin: 0, fontSize: 13 }}>Usar quando o cliente deixa de trabalhar com a OPERA. Todos os acessos são bloqueados já. As leads deixam de aparecer no pipeline e ficam guardadas {RETENTION_MONTHS} meses; depois são apagadas automaticamente. Entrega primeiro a exportação ao cliente.</span>
              <div className="row"><button type="button" className="btn sm" disabled={busy} onClick={exportClient}>Exportar leads deste cliente</button>
                <button type="button" className="btn sm" disabled={busy} onClick={exportChat}>Exportar conversa</button>
                <button type="button" className="btn sm" disabled={busy} onClick={deactivate}
                style={{ color: "#B91C1C", borderColor: "#F5C2C2" }}>Desativar cliente</button></div>
            </>
          ) : (
            <>
              <b>Cliente desativado</b>
              <div className="row">
                <button type="button" className="btn sm" disabled={busy}
                  onClick={async () => (await run(() => reactivateClient(c.id), "Cliente reativado")) && onChanged()}>Reativar cliente</button>
                <button type="button" className="btn sm" disabled={busy} onClick={exportClient}>Exportar leads</button>
                <button type="button" className="btn sm" disabled={busy} onClick={exportChat}>Exportar conversa</button>
                <button type="button" className="btn sm" disabled={busy} onClick={purge}
                  style={{ color: "#B91C1C", borderColor: "#F5C2C2" }}>Apagar já todos os dados</button>
              </div>
            </>
          )}
        </div>
      )}
      <div className="actions"><button type="button" className="btn primary" onClick={onClose}>Fechar</button></div>
    </Modal>
  );
}

function NewClientModal({ managers, loadOf, onClose, onDone }) {
  const [run, busy] = useAction();
  const toast = useToast();
  const [crm, setCrm] = useState([]);
  const [form, setForm] = useState({ source: "novo", crmId: "", name: "", alias: "", color: CLIENT_COLORS[0], manager: "", uname: "", uemail: "" });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  useEffect(() => { run(crmClientsNotEnabled).then((r) => r && setCrm(r)); }, [run]);

  const submit = async (e) => {
    e.preventDefault();
    const alias = form.alias.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9.-]{0,40}$/.test(alias)) return toast("O alias só pode ter letras minúsculas, números, pontos e traços.");
    const ok = await run(async () => {
      let id;
      if (form.source === "crm") {
        id = form.crmId;
        await enableCrmClient({ id, color: form.color, inbox_alias: alias, manager_id: form.manager || null });
      } else {
        id = (await createClient({ name: form.name.trim(), color: form.color, inbox_alias: alias })).id;
        if (form.manager) await assignManager(id, form.manager);
      }
      await inviteUser({ name: form.uname, email: form.uemail, role: "cliente_admin", client_id: id });
    }, "Cliente criado e convite enviado");
    if (ok) onDone();
  };

  return (
    <Modal title="Novo cliente" onClose={onClose}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {crm.length > 0 && (
          <div className="chips" role="radiogroup" aria-label="Origem do cliente">
            <label className="pill"><input type="radio" name="src" checked={form.source === "novo"} onChange={() => setForm({ ...form, source: "novo" })} /> Cliente novo</label>
            <label className="pill"><input type="radio" name="src" checked={form.source === "crm"} onChange={() => setForm({ ...form, source: "crm" })} /> Cliente que já está no CRM</label>
          </div>
        )}
        <div className="g2">
          {form.source === "crm" ? (
            <label className="f">Cliente do CRM *<select required value={form.crmId} onChange={set("crmId")}>
              <option value="">Escolher…</option>{crm.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          ) : (
            <label className="f">Nome do cliente *<input required value={form.name} onChange={set("name")} /></label>
          )}
          <label className="f">Alias do email dos portais *<input required value={form.alias} onChange={set("alias")} placeholder="ex.: joana" /></label>
        </div>
        {form.alias && <span className="sub" style={{ margin: 0, fontSize: 12 }}>Os emails dos portais vão para <b>{form.alias.trim().toLowerCase()}@{INBOX_DOMAIN}</b></span>}
        <div className="f">Cor
          <div className="chips">{CLIENT_COLORS.map((d, i) => (
            <label key={d} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 999, border: "1px solid var(--line2)", fontSize: 12, fontWeight: 600, minHeight: 32 }}>
              <input type="radio" name="dot" value={d} checked={form.color === d} onChange={set("color")} />
              <span className="dot" style={{ background: d }}></span>Cor {i + 1}
            </label>))}
          </div>
        </div>
        <label className="f">Gestor de leads<select value={form.manager} onChange={set("manager")}>
          <option value="">Sem gestor por agora</option>
          {managers.map((m) => { const n = loadOf(m.id); return (
            <option key={m.id} value={m.id} disabled={n >= MAX_CLIENTS_PER_MANAGER}>{m.full_name || m.email} ({n}/{MAX_CLIENTS_PER_MANAGER})</option>); })}
        </select></label>
        <div className="panel" style={{ padding: 14 }}>
          <b style={{ fontSize: 14 }}>Primeiro utilizador (admin do cliente)</b>
          <span className="sub" style={{ display: "block", margin: "4px 0 10px", fontSize: 12 }}>Recebe o convite por email e pode convidar o resto da sua equipa.</span>
          <div className="g2">
            <label className="f">Nome *<input required value={form.uname} onChange={set("uname")} /></label>
            <label className="f">Email *<input type="email" required value={form.uemail} onChange={set("uemail")} /></label>
          </div>
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn primary" disabled={busy}>Criar cliente e enviar convite</button>
        </div>
      </form>
    </Modal>
  );
}

function ManagersModal({ clients, managers, loadOf, onClose, onChanged }) {
  const [run, busy] = useAction();
  const name = (id) => { const m = managers.find((x) => x.id === id); return m ? m.full_name || m.email : "Gestor"; };
  const save = async (c, ids, msg) => {
    if (await run(() => setManagers(c.id, ids), msg)) onChanged();
  };
  return (
    <Modal title="Atribuir clientes a gestores" onClose={onClose}>
      <div className="row" style={{ gap: 8 }}>
        {managers.map((m) => { const n = loadOf(m.id); return (
          <span key={m.id} className={`state ${n >= MAX_CLIENTS_PER_MANAGER ? "del" : n >= 6 ? "inv" : "ok"}`}>
            {m.full_name || m.email}: {n}/{MAX_CLIENTS_PER_MANAGER}</span>); })}
      </div>
      <div className="sub" style={{ margin: 0, fontSize: 13 }}>Um cliente pode ter mais do que um gestor. O primeiro é o principal: recebe as respostas dos emails de leads qualificadas.</div>
      <div className="tbl" style={{ margin: 0 }}>
        <table>
          <thead><tr><th>Cliente</th><th>Gestores</th></tr></thead>
          <tbody>
            {clients.map((c) => {
              const ids = c.manager_ids || [];
              const free = managers.filter((m) => !ids.includes(m.id));
              return (
                <tr key={c.id}>
                  <td><span className="tags"><span className="dot" style={{ background: c.color }}></span>{c.name}</span></td>
                  <td>
                    <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                      {ids.length === 0 && <span className="sub" style={{ margin: 0 }}>Sem gestor</span>}
                      {ids.map((id, i) => (
                        <span key={id} className="pill" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          {name(id)}{i === 0 && ids.length > 1 && <small style={{ color: "var(--mute)" }}>principal</small>}
                          <button type="button" className="link" disabled={busy} aria-label={`Tirar ${name(id)} de ${c.name}`}
                            onClick={() => save(c, ids.filter((x) => x !== id), "Gestor retirado")}>×</button>
                        </span>))}
                      {free.length > 0 && (
                        <select aria-label={`Juntar gestor a ${c.name}`} value="" disabled={busy}
                          onChange={(e) => e.target.value && save(c, [...ids, e.target.value], "Gestor atribuído")}
                          style={{ minHeight: 36, borderRadius: 8, border: "1px solid var(--line2)", padding: "0 8px" }}>
                          <option value="">{ids.length ? "+ Juntar gestor" : "Escolher gestor"}</option>
                          {free.map((m) => { const n = loadOf(m.id); const full = n >= MAX_CLIENTS_PER_MANAGER; return (
                            <option key={m.id} value={m.id} disabled={full}>{m.full_name || m.email} ({n}/{MAX_CLIENTS_PER_MANAGER}){full ? " · cheio" : ""}</option>); })}
                        </select>)}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="actions"><button type="button" className="btn primary" onClick={onClose}>Fechar</button></div>
    </Modal>
  );
}
