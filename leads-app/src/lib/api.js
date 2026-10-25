// Acesso aos dados. Tudo passa pelo RLS do Supabase; as ações de administração são funções no servidor
// que voltam a verificar o papel de quem chama.
import { sb, SUPABASE_URL } from "../supabase.js";

const must = async (query) => {
  const { data, error } = await query;
  if (error) throw error;
  return data;
};

export const appUrl = () => `${window.location.origin}/leads/`;

// ---------- Perfil e cliente de quem está na sessão
export const getMyProfile = (userId) =>
  must(sb.from("profiles").select("id,email,full_name,client_id,leads_role,leads_status").eq("id", userId).maybeSingle());

export const getClient = (id) =>
  must(sb.from("clients").select("id,name,color,inbox_alias,leads_enabled,leads_status").eq("id", id).maybeSingle());

// ---------- Clientes
export const clientsOverview = () => must(sb.rpc("leads_clients_overview"));

export const crmClientsNotEnabled = () =>
  must(sb.from("clients").select("id,name").eq("leads_enabled", false).order("name"));

export const createClient = ({ name, color, inbox_alias }) =>
  must(sb.from("clients").insert({ name, color, inbox_alias, leads_enabled: true }).select("id").single());

export const enableCrmClient = ({ id, color, inbox_alias, manager_id }) =>
  must(sb.rpc("leads_enable_client", { p_client_id: id, p_color: color, p_inbox_alias: inbox_alias, p_manager_id: manager_id }));

export const assignManager = (clientId, managerId) =>
  must(sb.rpc("leads_assign_manager", { p_client_id: clientId, p_manager_id: managerId }));
export const deactivateClient = (id) => must(sb.rpc("leads_deactivate_client", { p_client_id: id }));
export const reactivateClient = (id) => must(sb.rpc("leads_reactivate_client", { p_client_id: id }));
export const purgeClientNow = (id, name) => must(sb.rpc("leads_purge_client_now", { p_client_id: id, p_confirm_name: name }));

// ---------- Utilizadores
const USER_COLS = "id,email,full_name,client_id,leads_role,leads_status,leads_invited_at";

export const usersOfClient = (clientId) =>
  must(sb.from("profiles").select(USER_COLS).eq("client_id", clientId).not("leads_role", "is", null).order("full_name"));

export const operaTeam = () =>
  must(sb.from("profiles").select(USER_COLS).in("leads_role", ["admin", "gestor"]).order("full_name"));

export const setUserStatus = (userId, status) =>
  must(sb.rpc("leads_set_user_status", { p_user_id: userId, p_status: status }));

// Convites: Edge Function no Supabase (UE), com a chave secreta só no servidor.
async function usersFn(payload) {
  const { data: s } = await sb.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/leads-users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${s.session?.access_token ?? ""}`,
    },
    body: JSON.stringify({ redirect_to: appUrl(), ...payload }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) await sessionEnded();
  if (!res.ok) throw new Error(body.error || "Não foi possível concluir o pedido.");
  return body;
}
// Sessão que o servidor já não reconhece (por exemplo, entrou outra conta neste browser, ao abrir um convite):
// sai e volta ao login, em vez de mostrar um erro.
export async function sessionEnded() {
  await sb.auth.signOut({ scope: "local" }).catch(() => {});
  throw new Error("A sessão terminou, provavelmente porque entrou outra conta neste browser. Entra outra vez.");
}
export const inviteUser = ({ email, name, role, client_id }) => usersFn({ action: "invite", email, name, role, client_id });
export const resendInvite = (userId) => usersFn({ action: "resend", user_id: userId });
export const cancelInvite = (userId) => usersFn({ action: "cancel", user_id: userId });

// ---------- Privacidade
export const auditLog = () =>
  must(sb.from("audit_log").select("id,created_at,action,detail,actor:profiles(full_name,email)")
    .order("created_at", { ascending: false }).limit(200));

export const getSettings = () => must(sb.from("leads_settings").select("*").eq("id", true).single());
export const setAnonymizeAfter = (months) =>
  must(sb.from("leads_settings").update({ anonymize_after_months: months }).eq("id", true));

export const acceptInvite = () => must(sb.rpc("leads_accept_invite"));
export const logLogin = () => must(sb.rpc("leads_log_login"));
