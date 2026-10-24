// OPERA Leads: convites e gestão de contas. Corre no Supabase (UE), com a chave secreta que o
// Supabase dá às Edge Functions, por isso nenhum segredo passa pelo browser.
//
// Ações (POST com JSON):
//   { action: "invite", email, name, role, client_id?, redirect_to }
//   { action: "resend", user_id, redirect_to }
//   { action: "cancel", user_id }
//
// Permissões (as mesmas do RLS):
//   admin          convida gestores, admins e utilizadores de qualquer cliente
//   gestor         convida utilizadores de qualquer cliente
//   cliente_admin  convida utilizadores do seu cliente
// A equipa OPERA só age com verificação em dois passos (aal2).
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const SECRET_KEY = (() => {
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  return keys ? JSON.parse(keys).default : Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
})();
const admin = createClient(Deno.env.get("SUPABASE_URL")!, SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Para onde podem apontar os links dos emails.
const ALLOWED_REDIRECT = [
  /^https:\/\/opera-os\.com\/leads\/?$/,
  /^https:\/\/[a-z0-9-]+--vocal-tartufo-a334b0\.netlify\.app\/leads\/?$/,
  /^http:\/\/localhost:\d+\/leads\/?$/,
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const fail = (message: string, status = 400) => json({ error: message }, status);

// Erros do envio de email, em português.
function mailError(message: string) {
  if (/rate limit|too many/i.test(message)) return "Foram enviados demasiados emails em pouco tempo. Tenta daqui a uns minutos.";
  if (/invalid|not authorized/i.test(message)) return "O servidor de email não aceitou este endereço. Confirma o email.";
  if (/already been registered|already registered/i.test(message)) return "Já existe uma conta com este email.";
  return "O email não foi enviado. Tenta outra vez.";
}

type Profile = {
  id: string; email: string | null; full_name: string | null; client_id: string | null;
  leads_role: string | null; leads_status: string;
};

const CLIENT_ROLES = ["cliente_admin", "cliente"];
const OPERA_ROLES = ["admin", "gestor"];

// Escritas com a chave secreta: qualquer erro tem de chegar a quem chamou, nunca ficar calado.
async function must<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}

async function audit(actor: string, action: string, detail: Record<string, unknown>) {
  await must(admin.from("audit_log").insert({ actor_id: actor, action, detail }), "Registo de atividade");
}

// Quem chama pode gerir contas com este papel e cliente?
function canManage(caller: Profile, aal: string, role: string, clientId: string | null) {
  const opera = OPERA_ROLES.includes(caller.leads_role ?? "") && aal === "aal2";
  if (OPERA_ROLES.includes(role)) return opera && caller.leads_role === "admin" && clientId === null;
  if (!CLIENT_ROLES.includes(role) || !clientId) return false;
  if (opera) return true;
  return caller.leads_role === "cliente_admin" && caller.client_id === clientId;
}

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    console.error("leads-users:", e instanceof Error ? e.message : e);
    return fail("Erro no servidor. Tenta outra vez.", 500);
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return fail("Método não permitido.", 405);

  // Quem chama: o token é validado pelo Auth antes de lermos o nível de verificação (aal).
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !auth.user) return fail("Sessão inválida.", 401);
  const aal = (() => {
    try { return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).aal ?? "aal1"; }
    catch { return "aal1"; }
  })();
  const { data: caller } = await admin.from("profiles")
    .select("id,email,full_name,client_id,leads_role,leads_status").eq("id", auth.user.id).single<Profile>();
  if (!caller || caller.leads_status !== "ativo" || !caller.leads_role) return fail("Sem acesso ao OPERA Leads.", 403);

  let body: Record<string, string | null>;
  try { body = await req.json(); } catch { return fail("Pedido inválido."); }
  const redirectTo = body.redirect_to ?? "";
  if (body.action !== "cancel" && !ALLOWED_REDIRECT.some((r) => r.test(redirectTo))) return fail("Endereço de regresso inválido.");

  if (body.action === "invite") {
    const email = String(body.email ?? "").trim().toLowerCase();
    const name = String(body.name ?? "").trim();
    const role = String(body.role ?? "");
    const clientId = CLIENT_ROLES.includes(role) ? (body.client_id ?? null) : null;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name) return fail("Indica nome e email válidos.");
    if (!canManage(caller, aal, role, clientId)) return fail("Sem permissão para este convite.", 403);
    if (clientId) {
      const { data: c } = await admin.from("clients").select("leads_enabled,leads_status").eq("id", clientId).single();
      if (!c?.leads_enabled || c.leads_status !== "ativo") return fail("Esse cliente não está ativo no OPERA Leads.");
    }

    // Já existe uma conta com este email (por exemplo, do CRM)? Dá acesso sem criar outra.
    const { data: existing } = await admin.from("profiles")
      .select("id,email,full_name,client_id,leads_role,leads_status").ilike("email", email).maybeSingle<Profile>();
    if (existing) {
      if (existing.leads_role) return fail("Este email já tem acesso ao OPERA Leads.");
      if (existing.client_id && clientId && existing.client_id !== clientId) return fail("Este email pertence a outro cliente.");
      await must(admin.from("profiles").update({
        leads_role: role, client_id: clientId ?? existing.client_id, leads_status: "ativo",
        leads_invited_at: new Date().toISOString(), leads_invited_by: caller.id,
        full_name: existing.full_name || name,
      }).eq("id", existing.id), "Atualizar perfil");
      await audit(caller.id, "acesso_dado", { user_id: existing.id, role, client_id: clientId });
      return json({ ok: true, status: "ativo", message: "Esta pessoa já tinha conta. O acesso ficou ativo e pode entrar com o mesmo email." });
    }

    const { data: invited, error } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { full_name: name }, redirectTo,
    });
    if (error || !invited.user) return fail(`Não foi possível enviar o convite. ${mailError(error?.message ?? "")}`, 502);
    await must(admin.from("profiles").update({
      leads_role: role, client_id: clientId, leads_status: "convidado", full_name: name,
      leads_invited_at: new Date().toISOString(), leads_invited_by: caller.id,
    }).eq("id", invited.user.id), "Atualizar perfil");
    await audit(caller.id, "convite_enviado", { user_id: invited.user.id, role, client_id: clientId });
    return json({ ok: true, status: "convidado", user_id: invited.user.id });
  }

  if (body.action === "resend" || body.action === "cancel") {
    const { data: target } = await admin.from("profiles")
      .select("id,email,full_name,client_id,leads_role,leads_status").eq("id", body.user_id ?? "").maybeSingle<Profile>();
    if (!target || target.leads_status !== "convidado" || !target.leads_role || !target.email) return fail("Convite não encontrado.", 404);
    if (!canManage(caller, aal, target.leads_role, target.client_id)) return fail("Sem permissão para este convite.", 403);

    if (body.action === "resend") {
      const { error } = await admin.auth.admin.inviteUserByEmail(target.email, { data: { full_name: target.full_name }, redirectTo });
      if (error) return fail(`Não foi possível reenviar o convite. ${mailError(error.message)}`, 502);
      await must(admin.from("profiles").update({ leads_invited_at: new Date().toISOString() }).eq("id", target.id), "Atualizar perfil");
      await audit(caller.id, "convite_reenviado", { user_id: target.id });
      return json({ ok: true });
    }

    // Cancelar: a conta nunca foi usada, por isso é apagada. Contas que também usam o CRM só perdem o acesso ao Leads.
    const { data: u } = await admin.auth.admin.getUserById(target.id);
    const usedBefore = Boolean(u?.user?.last_sign_in_at);
    if (usedBefore) {
      await must(admin.from("profiles").update({ leads_role: null, leads_status: "ativo" }).eq("id", target.id), "Atualizar perfil");
    } else {
      const { error } = await admin.auth.admin.deleteUser(target.id);
      if (error) throw new Error(`Apagar conta: ${error.message}`);
    }
    await audit(caller.id, "convite_cancelado", { user_id: target.id });
    return json({ ok: true });
  }

  return fail("Ação desconhecida.");
}
