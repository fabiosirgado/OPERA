// OPERA Leads, WhatsApp: webhook da Meta (especificação REATIVACAO_WHATSAPP, secções 7 e 11). Corre no Supabase (UE).
//
// GET  verificação do webhook: responde ao hub.challenge quando o hub.verify_token é o guardado no cofre
//      da base de dados (wa_verify_token).
// POST eventos do campo "messages": valida a assinatura X-Hub-Signature-256 com o WA_APP_SECRET, entrega cada
//      alteração à base de dados (wa_receber: estados de entrega, respostas, idempotência pelo wa_message_id) e
//      envia as respostas automáticas R1, R2 e R3 (mensagens de sessão). Nunca respondemos por texto à lead.
//
// Segredos (Supabase, Edge Functions): WA_APP_SECRET (chave secreta da app na Meta) e WHATSAPP_ACCESS_TOKEN.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const GRAPH = "https://graph.facebook.com/v23.0";
const SECRET_KEY = (() => {
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  return keys ? JSON.parse(keys).default : Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
})();
const db = createClient(Deno.env.get("SUPABASE_URL")!, SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const TOKEN = Deno.env.get("WHATSAPP_ACCESS_TOKEN") ?? "";
const APP_SECRET = Deno.env.get("WA_APP_SECRET") ?? "";

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

// Comparação em tempo constante.
function iguais(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function assinaturaValida(raw: string, header: string | null) {
  if (!APP_SECRET || APP_SECRET === "COLAR_AQUI" || !header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  return iguais(sig, header.slice(7).toLowerCase());
}

async function enviarTexto(phoneId: string, to: string, texto: string) {
  const res = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: texto } }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${body?.error?.code ?? res.status} · ${body?.error?.message ?? "erro"}`);
  return (body?.messages?.[0]?.id as string) ?? null;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET") {
    const { data: cfg } = await db.rpc("wa_config");
    const ok = url.searchParams.get("hub.mode") === "subscribe" && cfg?.verify_token
      && iguais(url.searchParams.get("hub.verify_token") ?? "", cfg.verify_token);
    return ok ? new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 }) : new Response("Proibido", { status: 403 });
  }
  if (req.method !== "POST") return new Response("Método não suportado", { status: 405 });

  const raw = await req.text();
  if (!(await assinaturaValida(raw, req.headers.get("x-hub-signature-256")))) {
    console.error("wa_webhook: assinatura inválida ou WA_APP_SECRET em falta");
    return new Response("Assinatura inválida", { status: 401 });
  }
  let payload: { entry?: { changes?: { field?: string; value?: Record<string, unknown> }[] }[] } = {};
  try { payload = JSON.parse(raw); } catch { return new Response("JSON inválido", { status: 400 }); }

  const { data: cfg } = await db.rpc("wa_config");
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages" || !change.value) continue;
      const { data, error } = await db.rpc("wa_receber", { p_value: change.value });
      if (error) { console.error("wa_webhook: wa_receber", error.message); continue; }
      for (const r of (data?.respostas ?? []) as { lead_id: string; to: string; codigo: string; texto: string }[]) {
        let id: string | null = null, erro: string | null = null;
        try {
          if (!cfg?.phone_number_id || !TOKEN) throw new Error("Falta o Phone Number ID ou o token");
          id = await enviarTexto(cfg.phone_number_id, r.to, r.texto);
        } catch (e) { erro = String((e as Error).message ?? e).slice(0, 500); }
        await db.rpc("wa_registar_sessao", { p_lead: r.lead_id, p_codigo: r.codigo, p_texto: r.texto, p_wa_id: id, p_erro: erro });
      }
    }
  }
  return new Response("ok", { status: 200 });
});
