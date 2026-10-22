import { useCallback, useEffect, useState } from "react";
import { usersOfClient } from "../lib/api.js";
import { useAction } from "../ui/feedback.jsx";
import { InviteForm, UserTable } from "./users.jsx";

// "A minha equipa": o admin do cliente convida e desativa os utilizadores do seu cliente.
export default function Equipa({ profile, client }) {
  const [users, setUsers] = useState(null);
  const [run] = useAction();
  const load = useCallback(() => run(() => usersOfClient(client.id)).then((u) => u && setUsers(u)), [run, client.id]);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <div className="top"><div>
        <h1>A minha equipa</h1>
        <div className="sub">Quem da {client.name} tem acesso às vossas leads. Todos os utilizadores veem todas as leads do cliente; o responsável de cada lead é quem recebe os avisos.</div>
      </div></div>
      <div className="panel">
        {users ? <UserTable users={users} me={profile.id} manage onChange={load} /> : <div className="empty">A carregar…</div>}
        <InviteForm clientId={client.id} roles={["cliente", "cliente_admin"]} onDone={load} />
      </div>
    </>
  );
}
