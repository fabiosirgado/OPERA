// Peças partilhadas por "Clientes e acessos" e "A minha equipa": tabela de utilizadores e convite.
import { useState } from "react";
import { ROLE_LABEL, fmtDate } from "../lib/format.js";
import { cancelInvite, inviteUser, resendInvite, setUserStatus } from "../lib/api.js";
import { useAction } from "../ui/feedback.jsx";

const STATE = {
  ativo: <span className="state ok">Ativo</span>,
  convidado: <span className="state inv">Convite enviado</span>,
  desativado: <span className="state off">Desativado</span>,
};

export function UserTable({ users, me, manage, onChange }) {
  const [run, busy] = useAction();
  const act = async (fn, ok) => { if (await run(fn, ok)) onChange(); };

  return (
    <div className="tbl" style={{ margin: 0 }}>
      <table>
        <thead><tr><th>Nome</th><th>Email</th><th>Papel</th><th>Estado</th>{manage && <th></th>}</tr></thead>
        <tbody>
          {users.length === 0 && <tr><td colSpan={manage ? 5 : 4} className="empty">Ainda sem utilizadores.</td></tr>}
          {users.map((u) => (
            <tr key={u.id}>
              <td><b>{u.full_name || "Sem nome"}</b></td>
              <td>{u.email}</td>
              <td>{ROLE_LABEL[u.leads_role]}</td>
              <td>{STATE[u.leads_status]}{u.leads_status === "convidado" && u.leads_invited_at &&
                <span className="sub" style={{ display: "block", margin: 0, fontSize: 12 }}>a {fmtDate(u.leads_invited_at)}</span>}</td>
              {manage && (
                <td style={{ whiteSpace: "nowrap" }}>
                  {u.id === me ? <span className="sub" style={{ fontSize: 12 }}>Tu</span>
                    : u.leads_status === "convidado" ? (
                      <>
                        <button type="button" className="link" disabled={busy}
                          onClick={() => act(() => resendInvite(u.id), `Convite reenviado para ${u.email}`)}>Reenviar convite</button>
                        {" · "}
                        <button type="button" className="link" disabled={busy}
                          onClick={() => confirm(`Cancelar o convite de ${u.email}?`) && act(() => cancelInvite(u.id), "Convite cancelado")}>Cancelar</button>
                      </>
                    ) : u.leads_status === "ativo" ? (
                      <button type="button" className="link" disabled={busy}
                        onClick={() => confirm(`Desativar ${u.full_name || u.email}? Deixa de conseguir entrar e as leads de que é responsável ficam sem responsável.`)
                          && act(() => setUserStatus(u.id, "desativado"), "Utilizador desativado")}>Desativar</button>
                    ) : (
                      <button type="button" className="link" disabled={busy}
                        onClick={() => act(() => setUserStatus(u.id, "ativo"), "Utilizador reativado")}>Reativar</button>
                    )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Formulário de convite. roles: lista de papéis que quem convida pode atribuir.
export function InviteForm({ clientId, roles, onDone }) {
  const [run, busy] = useAction();
  const [form, setForm] = useState({ name: "", email: "", role: roles[0] });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    const r = await run(() => inviteUser({ ...form, client_id: clientId }),
      (res) => res.message || `Convite enviado para ${form.email.trim()}`);
    if (r) { setForm({ name: "", email: "", role: roles[0] }); onDone(); }
  };

  return (
    <form onSubmit={submit} style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end", marginTop: 12 }}>
      <label className="f" style={{ flex: "1 1 160px" }}>Nome<input required value={form.name} onChange={set("name")} /></label>
      <label className="f" style={{ flex: "1 1 200px" }}>Email<input type="email" required value={form.email} onChange={set("email")} /></label>
      {roles.length > 1 && (
        <label className="f" style={{ flex: "0 1 200px" }}>Papel
          <select value={form.role} onChange={set("role")}>{roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select>
        </label>
      )}
      <button type="submit" className="btn primary" disabled={busy}>Enviar convite</button>
    </form>
  );
}
