// OPERA Leads: avisos por email (Resend, região UE). Corre no Supabase (UE).
//
// Chamada pela própria base de dados (pg_net), com a chave das entradas automáticas no cabeçalho x-opera-secret:
//   { action: "process" }             envia os avisos pendentes (até 20 de cada vez)
//   { action: "preview", id }         devolve o email de um aviso sem o enviar (testes)
//
// Segredos (Supabase, Edge Functions): RESEND_API_KEY. Opcional: LEADS_EMAIL_FROM ("OPERA Leads <leads@opera-os.com>").
// Sem RESEND_API_KEY os avisos ficam pendentes e saem quando a chave existir.
// No ambiente de testes, private.leads_config.email_redirect_to manda todos os emails para um só endereço.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const SECRET_KEY = (() => {
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  return keys ? JSON.parse(keys).default : Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
})();
const db = createClient(Deno.env.get("SUPABASE_URL")!, SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
const FROM = Deno.env.get("LEADS_EMAIL_FROM") ?? "OPERA Leads <leads@opera-os.com>";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Payload = {
  id: number; kind: "qualificada" | "nova_lead_do_cliente"; attempts: number; app_url: string | null; redirect_to: string | null;
  lead: { id: string; name: string; phone: string | null; email: string | null; source: string | null; interest: string | null;
          qualification: Record<string, string>; created_at: string; stage: string };
  client: string; manager: { name: string | null; email: string | null } | null; pinned: string[]; to: string[];
};

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const QUAL = ["Objetivo", "Budget", "Prazo", "Financiamento", "Tem imóvel para vender", "Disponibilidade para visita"];

// Email em português de Portugal, sem hífenes no texto, simples para abrir bem em qualquer programa de email.
export function render(p: Payload) {
  const l = p.lead;
  const link = p.app_url ? `${p.app_url}${p.app_url.includes("?") ? "&" : "?"}lead=${l.id}` : null;
  const qualified = p.kind === "qualificada";
  const subject = qualified ? `Lead qualificada: ${l.name}` : `${p.client} criou uma lead para a OPERA contactar: ${l.name}`;
  const intro = qualified
    ? `A equipa OPERA qualificou uma lead para ${p.client}. O contacto é vosso a partir de agora.`
    : `${p.client} juntou uma lead e pediu à OPERA que a contacte.`;
  const rows: [string, string][] = [
    ["Nome", l.name], ["Telefone", l.phone ?? ""], ["Email", l.email ?? ""], ["Interesse", l.interest ?? ""], ["Origem", l.source ?? ""],
    ...QUAL.filter((k) => l.qualification?.[k]).map((k) => [k, l.qualification[k]] as [string, string]),
  ].filter(([, v]) => v);
  const table = rows.map(([k, v]) =>
    `<tr><td style="padding:6px 12px 6px 0;color:#64748b;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;color:#0f172a"><b>${esc(v)}</b></td></tr>`).join("");
  const notes = p.pinned.length
    ? `<h3 style="font-size:15px;margin:24px 0 8px">Notas importantes</h3>${p.pinned.map((n) =>
        `<p style="margin:0 0 8px;padding:10px 12px;background:#fef9c3;border-radius:8px;white-space:pre-line">${esc(n)}</p>`).join("")}`
    : "";
  const button = link
    ? `<p style="margin:24px 0"><a href="${esc(link)}" style="background:#1d4ed8;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">Abrir a lead</a></p>`
    : "";
  const reply = qualified && p.manager?.name ? `<p style="color:#64748b;font-size:13px">Dúvidas sobre esta lead? Responda a este email e fala com ${esc(p.manager.name)}, da OPERA.</p>` : "";
  const html = `<!doctype html><html lang="pt"><body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:24px"><div style="background:#fff;border-radius:12px;padding:28px">
<p style="margin:0 0 4px;font-size:13px;color:#64748b"><b style="color:#0f172a">OPERA</b> Leads · ${esc(p.client)}</p>
<h2 style="margin:0 0 12px;font-size:20px;color:#0f172a">${esc(subject)}</h2>
<p style="margin:0 0 16px;color:#334155">${esc(intro)}</p>
<table style="border-collapse:collapse;font-size:14px">${table}</table>${notes}${button}${reply}
</div><p style="font-size:12px;color:#94a3b8;text-align:center">Recebe este email porque tem acesso ao OPERA Leads de ${esc(p.client)}.</p></div></body></html>`;
  const text = [subject, "", intro, "", ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(p.pinned.length ? ["", "Notas importantes:", ...p.pinned] : []), ...(link ? ["", `Abrir a lead: ${link}`] : [])].join("\n");
  return { subject, html, text, link };
}

async function send(p: Payload) {
  const to = p.redirect_to ? [p.redirect_to] : p.to;
  if (!to.length) return { ok: false, error: "Sem destinatários.", to };
  const mail = render(p);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json", "Idempotency-Key": `aviso-${p.id}-${p.attempts}` },
    body: JSON.stringify({
      from: FROM, to, subject: p.redirect_to ? `Teste para ${p.to.join(", ") || "ninguém"}: ${mail.subject}` : mail.subject,
      html: mail.html, text: mail.text,
      ...(p.kind === "qualificada" && p.manager?.email ? { reply_to: p.manager.email } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: `Resend ${res.status}: ${String(body?.message ?? "erro").slice(0, 200)}`, to };
  return { ok: true, id: String(body?.id ?? ""), to };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Só POST." }, 405);
  const ok = await db.rpc("leads_inbound_verify", { p_secret: req.headers.get("x-opera-secret") ?? "" });
  if (ok.error || ok.data !== true) return json({ error: "Chave inválida." }, 401);
  let body: { action?: string; id?: number };
  try { body = await req.json(); } catch { return json({ error: "JSON inválido." }, 400); }

  if (body.action === "preview") {
    const { data, error } = await db.rpc("leads_notification_preview", { p_id: body.id });
    if (error || !data) return json({ error: "Aviso não encontrado." }, 404);
    const p = data as Payload;
    return json({ to: p.redirect_to ? [p.redirect_to] : p.to, real_to: p.to, reply_to: p.manager?.email ?? null, ...render(p) });
  }

  if (body.action === "process") {
    if (!RESEND_KEY) return json({ configured: false });
    const { data, error } = await db.rpc("leads_notifications_claim", { p_limit: 20 });
    if (error) return json({ error: "Não foi possível ler a fila." }, 500);
    const results = [];
    for (const p of (data ?? []) as Payload[]) {
      let r: { ok: boolean; error?: string; id?: string; to: string[] };
      try { r = await send(p); } catch (e) { r = { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : "erro", to: p.to }; }
      await db.rpc("leads_notification_done", { p_id: p.id, p_ok: r.ok, p_error: r.error ?? null, p_provider_id: r.id ?? null, p_recipients: r.to });
      if (!r.ok) console.error(`leads-notify: aviso ${p.id}:`, r.error);
      results.push({ id: p.id, ok: r.ok });
    }
    return json({ configured: true, sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
  }

  return json({ error: "Ação desconhecida." }, 400);
});
