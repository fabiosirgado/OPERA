// OPERA Leads: CloudTalk. Corre no Supabase (UE). Uma conta e um número para todos os clientes.
//
// Pedidos da aplicação (com a sessão de quem está a trabalhar, só equipa OPERA com dois passos):
//   { action: "call", lead_id }       cria ou atualiza o contacto ("Nome · Cliente"), pede a chamada ao agente
//                                     e regista a chamada na lead
//   { action: "recording", call_id }  devolve o áudio da gravação (fica no registo de atividade)
// Webhook da CloudTalk (assinado, cabeçalhos svix-*): call.ended e call.recording_ready.
//
// Segredos (Supabase, Edge Functions): CLOUDTALK_API_KEY_ID, CLOUDTALK_API_KEY_SECRET, CLOUDTALK_WEBHOOK_SECRET.
// Sem as chaves, "call" devolve configured:false e a aplicação liga pelo telefone, como antes.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const URL_SB = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEY = (() => {
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  return keys ? JSON.parse(keys).default : Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
})();
const PUBLIC_KEY = (() => {
  const keys = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  return keys ? JSON.parse(keys).default : Deno.env.get("SUPABASE_ANON_KEY")!;
})();
const admin = createClient(URL_SB, SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const CT_ID = Deno.env.get("CLOUDTALK_API_KEY_ID");
const CT_SECRET = Deno.env.get("CLOUDTALK_API_KEY_SECRET");
const CT_WEBHOOK = Deno.env.get("CLOUDTALK_WEBHOOK_SECRET");
const CT_API = "https://my.cloudtalk.io/api";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const fail = (message: string, status = 400) => json({ error: message }, status);

async function must<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}

// ------------------------------------------------------------ CLOUDTALK
async function ct(method: string, path: string, body?: unknown, accept = "application/json") {
  const res = await fetch(`${CT_API}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${btoa(`${CT_ID}:${CT_SECRET}`)}`,
      Accept: accept,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}
async function ctJson(method: string, path: string, body?: unknown) {
  const res = await ct(method, path, body);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 429) throw new Error("A CloudTalk recebeu demasiados pedidos. Tenta daqui a um minuto.");
    throw new Error(`CloudTalk ${res.status}: ${String(data?.responseData?.message ?? data?.message ?? "erro").slice(0, 200)}`);
  }
  return data?.responseData ?? data;
}

// Telefone em E.164 (a CloudTalk exige-o). Números portugueses de 9 dígitos ganham o +351.
export function e164(phone: string) {
  const raw = phone.trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (raw.startsWith("+")) return `+${digits}`;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  if (digits.length === 9) return `+351${digits}`;
  return `+${digits}`;
}

// ------------------------------------------------------------ ASSINATURA DO WEBHOOK (esquema Svix)
async function verifySvix(req: Request, raw: string) {
  if (!CT_WEBHOOK) return false;
  const id = req.headers.get("svix-id") ?? "";
  const ts = req.headers.get("svix-timestamp") ?? "";
  const sigs = (req.headers.get("svix-signature") ?? "").split(" ");
  if (!id || !ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const secret = Uint8Array.from(atob(CT_WEBHOOK.replace(/^whsec_/, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${raw}`)));
  const expected = btoa(String.fromCharCode(...mac));
  return sigs.some((s) => {
    const [v, sig] = s.split(",");
    if (v !== "v1" || !sig || sig.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  });
}

async function webhook(req: Request) {
  const raw = await req.text();
  const signed = await verifySvix(req, raw);
  // Alternativa sem assinatura: a chave das entradas automáticas (usada nos testes ou por um cenário do Make).
  const shared = !signed && req.headers.get("x-opera-secret")
    ? (await admin.rpc("leads_inbound_verify", { p_secret: req.headers.get("x-opera-secret") })).data === true
    : false;
  if (!signed && !shared) return fail("Assinatura inválida.", 401);

  let ev: { event_id?: string; type?: string; data?: Record<string, unknown> };
  try { ev = JSON.parse(raw); } catch { return fail("JSON inválido."); }
  const eventId = String(ev.event_id ?? req.headers.get("svix-id") ?? "");
  const type = String(ev.type ?? "");
  const d = ev.data ?? {};
  if (!eventId || !type) return fail("Evento sem id ou tipo.");

  // Entrega pelo menos uma vez: um evento repetido não volta a ser tratado.
  const { error: dup } = await admin.from("cloudtalk_events").insert({ event_id: eventId, type, payload: ev });
  if (dup) {
    if (dup.code === "23505") return json({ ok: true, repetido: true });
    throw new Error(`Registo do evento: ${dup.message}`);
  }

  try {
    let result: Record<string, unknown> = { status: "ignorado" };
    if (type === "call.ended") {
      const user = (d.user ?? {}) as Record<string, unknown>;
      result = await must(admin.rpc("leads_cloudtalk_call_ended", { p: {
        call_id: d.call_id, call_uuid: d.call_uuid, direction: d.direction, external_number: d.external_number,
        started_at: d.started_at, ended_at: d.ended_at, talking_time: d.talking_time, duration: d.duration,
        recorded: d.recorded, agent_id: user.id, agent_email: user.email,
      } }), "Fim de chamada") as Record<string, unknown>;
    } else if (type === "call.recording_ready") {
      result = await must(admin.rpc("leads_cloudtalk_recording_ready", { p_call_id: String(d.call_id ?? "") }),
        "Gravação") as Record<string, unknown>;
    }
    // A conta da CloudTalk envia todas as chamadas; das que não são de nenhuma lead não se guarda o conteúdo (RGPD).
    await admin.from("cloudtalk_events")
      .update({ status: result.status, lead_id: result.lead_id ?? null, ...(result.status === "processado" ? {} : { payload: null }) })
      .eq("event_id", eventId);
    return json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "erro";
    console.error(`leads-cloudtalk: evento ${eventId}:`, message);
    // Volta a deixar o evento livre para a CloudTalk o reenviar.
    await admin.from("cloudtalk_events").delete().eq("event_id", eventId);
    return fail("Erro ao tratar o evento.", 500);
  }
}

// ------------------------------------------------------------ PEDIDOS DA APLICAÇÃO
type Profile = { id: string; email: string | null; leads_role: string | null; leads_status: string; cloudtalk_agent_id: number | null };

async function agentFor(p: Profile) {
  if (p.cloudtalk_agent_id) return p.cloudtalk_agent_id;
  const list = await ctJson("GET", "/agents/index.json?limit=1000");
  const agents = (list?.data ?? []).map((x: { Agent?: Record<string, unknown> }) => x.Agent ?? x);
  const me = agents.find((a: Record<string, unknown>) => String(a.email ?? "").toLowerCase() === (p.email ?? "").toLowerCase());
  if (!me) throw new Error("O teu email não corresponde a nenhum agente da CloudTalk. Pede ao admin para o criar com o mesmo email.");
  await must(admin.from("profiles").update({ cloudtalk_agent_id: Number(me.id) }).eq("id", p.id), "Guardar agente");
  return Number(me.id);
}

async function app(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !auth.user) return fail("Sessão inválida.", 401);
  const aal = (() => {
    try { return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).aal ?? "aal1"; }
    catch { return "aal1"; }
  })();
  const { data: me } = await admin.from("profiles")
    .select("id,email,leads_role,leads_status,cloudtalk_agent_id").eq("id", auth.user.id).single<Profile>();
  if (!me || me.leads_status !== "ativo" || !["admin", "gestor"].includes(me.leads_role ?? "") || aal !== "aal2") {
    return fail("Só a equipa OPERA, com verificação em dois passos, liga pela CloudTalk.", 403);
  }
  // Cliente com a sessão de quem chama: o RLS decide o que pode ver e fazer.
  const userDb = createClient(URL_SB, PUBLIC_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  let body: Record<string, string>;
  try { body = await req.json(); } catch { return fail("Pedido inválido."); }

  if (body.action === "call") {
    const { data: lead } = await userDb.from("leads")
      .select("id,name,phone,email,cloudtalk_contact_id,anonymized,client:clients(name)").eq("id", body.lead_id).maybeSingle();
    if (!lead) return fail("Lead não encontrada.", 404);
    if (lead.anonymized || !lead.phone) return fail("Esta lead não tem telefone.");
    if (!CT_ID || !CT_SECRET) return json({ configured: false });

    const number = e164(lead.phone);
    const agent = await agentFor(me);

    // Contacto na CloudTalk com o cliente no nome, para reconhecer devoluções de chamada. Uma falha aqui não impede a chamada.
    const clientName = (lead.client as { name?: string } | null)?.name ?? "";
    const contact = {
      name: `${lead.name} · ${clientName}`.slice(0, 255),
      ContactNumber: [{ public_number: number }],
      ...(lead.email ? { ContactEmail: [{ email: lead.email }] } : {}),
    };
    try {
      if (lead.cloudtalk_contact_id) {
        await ctJson("POST", `/contacts/edit/${lead.cloudtalk_contact_id}.json`, contact);
      } else {
        const created = await ctJson("PUT", "/contacts/add.json", contact);
        const id = created?.data?.id;
        if (id) await admin.from("leads").update({ cloudtalk_contact_id: String(id) }).eq("id", lead.id);
      }
    } catch (e) {
      console.error("leads-cloudtalk: contacto:", e instanceof Error ? e.message.slice(0, 200) : "erro");
    }

    await ctJson("POST", "/calls/create.json", { agent_id: agent, callee_number: number });
    await must(userDb.rpc("leads_register_call", { p_lead_id: lead.id, p_meta: { via: "cloudtalk", agent_id: String(agent) } }),
      "Registar chamada");
    return json({ configured: true, ok: true });
  }

  if (body.action === "recording") {
    await must(userDb.rpc("leads_can_hear_recording", { p_call_id: body.call_id }), "Gravação");
    if (!CT_ID || !CT_SECRET) return fail("A CloudTalk ainda não está ligada.");
    const res = await ct("GET", `/calls/recording/${encodeURIComponent(body.call_id)}.json`, undefined, "audio/x-wav, audio/*");
    if (!res.ok) return fail("A gravação não está disponível.", 404);
    return new Response(res.body, { headers: { ...CORS, "Content-Type": res.headers.get("Content-Type") ?? "audio/x-wav" } });
  }

  return fail("Ação desconhecida.");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return fail("Método não permitido.", 405);
  try {
    if (req.headers.get("svix-id") || req.headers.get("x-opera-secret")) return await webhook(req);
    return await app(req);
  } catch (e) {
    const message = e instanceof Error ? e.message : "erro";
    console.error("leads-cloudtalk:", message.slice(0, 300));
    return fail(message.startsWith("CloudTalk") || message.includes("agente") || message.includes("demasiados")
      ? message : "Erro no servidor. Tenta outra vez.", 502);
  }
});
