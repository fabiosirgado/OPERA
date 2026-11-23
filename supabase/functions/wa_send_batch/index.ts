// OPERA Leads, WhatsApp: envios (especificação REATIVACAO_WHATSAPP, secções 6 a 8). Corre no Supabase (UE).
//
// Chamada a cada minuto pela base de dados (pg_cron + pg_net, só quando há um cliente com WhatsApp ligado),
// com a chave das entradas automáticas no cabeçalho x-opera-secret:
//   { action: "process" }     atualiza o estado dos modelos na Meta (a cada 30 min), planeia o dia de reativação
//                             (wa_planear, dentro da janela) e envia o que está vencido em wa_queue (modelos e M3).
// Pelo ecrã WhatsApp do OPERA Leads (só admin, com a sessão do utilizador):
//   { action: "templates" }   lê o estado dos modelos na Meta (GET /{WABA_ID}/message_templates)
//   { action: "estado" }      número (qualidade, limite), apps subscritas na WABA
//   { action: "configurar" }  subscreve a app à WABA e configura o webhook da app (campo messages)
//
// Segredos (Supabase, Edge Functions): WHATSAPP_ACCESS_TOKEN (utilizador de sistema da Meta) e WA_APP_SECRET
// (só para "configurar"). Os ids da Meta e o token de verificação do webhook vêm da base de dados (wa_config).
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const GRAPH = "https://graph.facebook.com/v23.0";
const SECRET_KEY = (() => {
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  return keys ? JSON.parse(keys).default : Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
})();
const URL_ = Deno.env.get("SUPABASE_URL")!;
const db = createClient(URL_, SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const TOKEN = Deno.env.get("WHATSAPP_ACCESS_TOKEN") ?? "";
const APP_SECRET = Deno.env.get("WA_APP_SECRET") ?? "";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-opera-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Cfg = { phone_number_id: string | null; waba_id: string | null; app_id: string | null; verify_token: string; functions_url: string };
type Envio = { queue_id: number; lead_id: string; to: string; modelo: string; template_name: string | null; language: string;
               variaveis: Record<string, string>; texto: string };

async function config(): Promise<Cfg> {
  const { data, error } = await db.rpc("wa_config");
  if (error) throw error;
  return data as Cfg;
}

async function graph(path: string, init: RequestInit = {}, token = TOKEN) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${GRAPH}${path}${init.method && init.method !== "GET" ? "" : `${sep}access_token=${encodeURIComponent(token)}`}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.method && init.method !== "GET" ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (body as { error?: { code?: number; message?: string; error_data?: { details?: string } } }).error;
    throw new Error(`${e?.code ?? res.status} · ${e?.message ?? "erro"}${e?.error_data?.details ? ` · ${e.error_data.details}` : ""}`);
  }
  return body as Record<string, unknown>;
}

// Estado dos modelos na Meta (APPROVED, PENDING, REJECTED…). Só os aprovados são usados.
async function syncTemplates(cfg: Cfg) {
  if (!cfg.waba_id || !TOKEN) return [];
  const r = await graph(`/${cfg.waba_id}/message_templates?fields=name,status,language&limit=200`);
  const list = (r.data as { name: string; status: string; language: string }[]) ?? [];
  const pt = list.filter((t) => t.language === "pt_PT" || t.language?.startsWith("pt"));
  await db.rpc("wa_templates_atualizar", { p: pt.map((t) => ({ name: t.name, status: t.status, language: t.language })) });
  return pt;
}

function corpo(e: Envio) {
  if (e.modelo === "M3") {
    return {
      messaging_product: "whatsapp", to: e.to, type: "interactive",
      interactive: {
        type: "button", body: { text: e.texto },
        action: { buttons: [
          { type: "reply", reply: { id: "asap", title: "Assim que possível" } },
          { type: "reply", reply: { id: "manha", title: "Amanhã de manhã" } },
          { type: "reply", reply: { id: "tarde", title: "Amanhã à tarde" } },
        ] },
      },
    };
  }
  // Modelos com variáveis por nome: cada parâmetro leva o parameter_name.
  return {
    messaging_product: "whatsapp", to: e.to, type: "template",
    template: {
      name: e.template_name, language: { code: e.language || "pt_PT" },
      components: [{ type: "body", parameters: Object.entries(e.variaveis).map(([k, v]) => ({ type: "text", parameter_name: k, text: v })) }],
    },
  };
}

async function processar() {
  const t0 = Date.now();
  const cfg = await config();
  if (!cfg.phone_number_id || !TOKEN) return { ok: false, motivo: "Falta o Phone Number ID ou o WHATSAPP_ACCESS_TOKEN." };
  // Modelos: a cada 30 minutos (ou quando nunca foram vistos).
  const { data: tpl } = await db.from("wa_templates").select("checked_at");
  const stale = !tpl?.length || tpl.some((t) => !t.checked_at || Date.now() - Date.parse(t.checked_at) > 30 * 60e3);
  if (stale) await syncTemplates(cfg).catch((e) => console.error("wa: modelos", String(e)));
  const plan = await db.rpc("wa_planear");
  if (plan.error) console.error("wa: planear", plan.error.message);
  let enviados = 0, falhados = 0;
  while (Date.now() - t0 < 40e3) {
    const { data, error } = await db.rpc("wa_reservar", { p_limite: 10 });
    if (error) throw error;
    const lote = (data ?? []) as Envio[];
    if (!lote.length) break;
    for (const e of lote) {
      try {
        const r = await graph(`/${cfg.phone_number_id}/messages`, { method: "POST", body: JSON.stringify(corpo(e)) });
        const id = ((r.messages as { id: string }[]) ?? [])[0]?.id ?? null;
        await db.rpc("wa_registar_envio", { p_queue: e.queue_id, p_wa_id: id, p_erro: null });
        enviados++;
      } catch (err) {
        await db.rpc("wa_registar_envio", { p_queue: e.queue_id, p_wa_id: null, p_erro: String((err as Error).message ?? err).slice(0, 500) });
        falhados++;
      }
    }
  }
  return { ok: true, planeados: plan.data ?? 0, enviados, falhados };
}

async function isAdmin(req: Request) {
  const auth = req.headers.get("Authorization");
  if (!auth) return false;
  const user = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: auth } },
  });
  const { error } = await user.rpc("wa_painel");
  return !error;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: { action?: string } = {};
  try { body = await req.json(); } catch { /* sem corpo */ }
  const action = body.action ?? "process";
  try {
    // A própria base de dados (chave das entradas automáticas) pode correr todas as ações; o ecrã, só o admin.
    const servidor = Boolean((await db.rpc("leads_inbound_verify", { p_secret: req.headers.get("x-opera-secret") ?? "" })).data);
    if (action === "process") {
      if (!servidor) return json({ error: "Sem acesso." }, 401);
      return json(await processar());
    }
    if (!servidor && !(await isAdmin(req))) return json({ error: "Só o administrador." }, 403);
    const cfg = await config();
    if (action === "templates") return json({ modelos: await syncTemplates(cfg) });
    if (action === "estado") {
      const numero = cfg.phone_number_id
        ? await graph(`/${cfg.phone_number_id}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier,name_status,code_verification_status`).catch((e) => ({ erro: String(e.message) }))
        : null;
      const apps = cfg.waba_id ? await graph(`/${cfg.waba_id}/subscribed_apps`).catch((e) => ({ erro: String(e.message) })) : null;
      return json({ numero, apps, token: Boolean(TOKEN), app_secret: Boolean(APP_SECRET && APP_SECRET !== "COLAR_AQUI") });
    }
    if (action === "configurar") {
      if (!cfg.waba_id || !cfg.app_id) return json({ error: "Faltam o WABA ID ou o App ID nas definições." }, 400);
      const sub = await graph(`/${cfg.waba_id}/subscribed_apps`, { method: "POST" }).catch((e) => ({ erro: String(e.message) }));
      let hook: unknown = { erro: "Falta o segredo WA_APP_SECRET nas Edge Functions do Supabase." };
      if (APP_SECRET && APP_SECRET !== "COLAR_AQUI") {
        const params = new URLSearchParams({
          object: "whatsapp_business_account", callback_url: `${cfg.functions_url}/wa_webhook`,
          verify_token: cfg.verify_token, fields: "messages", access_token: `${cfg.app_id}|${APP_SECRET}`,
        });
        const r = await fetch(`${GRAPH}/${cfg.app_id}/subscriptions`, { method: "POST", body: params });
        hook = await r.json().catch(() => ({ erro: `HTTP ${r.status}` }));
      }
      return json({ subscricao_waba: sub, webhook: hook });
    }
    return json({ error: "Ação desconhecida." }, 400);
  } catch (e) {
    console.error("wa_send_batch", action, String(e));
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
