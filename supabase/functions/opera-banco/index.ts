// OPERA · Banco: liga a conta Millennium da Grabbingstars ao Dashboard Admin através do Enable Banking
// (PSD2, só leitura). Lê o saldo e os movimentos; nunca faz pagamentos.
//
// Segredos (Supabase → Edge Functions → Secrets):
//   ENABLE_BANKING_APP_ID        id da aplicação no Enable Banking (também é o nome do ficheiro .pem)
//   ENABLE_BANKING_PRIVATE_KEY   conteúdo do ficheiro .pem dessa aplicação
//
// Ações (POST com JSON):
//   { action: "ligar", redirect_url }   → { url } para autorizar no Millennium (só nível total do Dashboard Admin)
//   { action: "concluir", code, state } → cria a sessão e sincroniza (só nível total)
//   { action: "sync" }                  → saldo e movimentos (nível total, ou a base de dados com x-opera-secret)
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const API = "https://api.enablebanking.com";
const SECRET_KEY = (() => {
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  return keys ? JSON.parse(keys).default : Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
})();
const db = createClient(Deno.env.get("SUPABASE_URL")!, SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const ALLOWED_REDIRECT = [/^https:\/\/opera-os\.com\/leads\/?$/, /^http:\/\/localhost:\d+\/leads\/?$/];
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-opera-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const fail = (message: string, status = 400) => json({ error: message }, status);

class EBError extends Error { constructor(public status: number, message: string) { super(message); } }

// ---------- JWT para o Enable Banking (RS256, válido 1 hora)
const b64url = (data: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = ""; bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
let keyCache: CryptoKey | null = null;
async function privateKey() {
  if (keyCache) return keyCache;
  const pem = (Deno.env.get("ENABLE_BANKING_PRIVATE_KEY") ?? "").trim();
  if (!pem) throw new EBError(500, "Falta o segredo ENABLE_BANKING_PRIVATE_KEY no Supabase.");
  if (pem.includes("BEGIN RSA PRIVATE KEY")) throw new EBError(500, "A chave tem de estar no formato PKCS#8 (BEGIN PRIVATE KEY).");
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  keyCache = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  return keyCache;
}
async function jwt() {
  const appId = Deno.env.get("ENABLE_BANKING_APP_ID");
  if (!appId) throw new EBError(500, "Falta o segredo ENABLE_BANKING_APP_ID no Supabase.");
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ typ: "JWT", alg: "RS256", kid: appId }));
  const body = b64url(JSON.stringify({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat: now, exp: now + 3600 }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await privateKey(), new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}
async function eb(path: string, init: RequestInit = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${await jwt()}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  if (!res.ok) throw new EBError(res.status, data?.message || data?.detail || `Enable Banking respondeu ${res.status}`);
  return data;
}

// ---------- Quem chama
async function nivelDe(req: Request): Promise<"total" | "sistema" | null> {
  const secret = req.headers.get("x-opera-secret");
  if (secret) {
    const { data } = await db.rpc("leads_inbound_verify", { p_secret: secret });
    return data === true ? "sistema" : null;
  }
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth, error } = await db.auth.getUser(token);
  if (error || !auth.user) return null;
  // A equipa OPERA só age com verificação em dois passos (aal2), como no resto do OPERA Leads.
  const aal = (() => { try { return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).aal; } catch { return null; } })();
  if (aal !== "aal2") return null;
  const { data: a } = await db.from("opera_admin_acessos").select("nivel").eq("user_id", auth.user.id).maybeSingle();
  const { data: p } = await db.from("profiles").select("leads_status").eq("id", auth.user.id).maybeSingle();
  return a?.nivel === "total" && p?.leads_status === "ativo" ? "total" : null;
}

// ---------- Ações
async function ligar(redirectUrl: string) {
  if (!ALLOWED_REDIRECT.some((r) => r.test(redirectUrl))) throw new EBError(400, "Endereço de regresso inválido.");
  const { aspsps } = await eb("/aspsps?country=PT&psu_type=business");
  const bank = (aspsps ?? []).find((a: any) => /millennium/i.test(a.name));
  if (!bank) throw new EBError(404, "O Millennium não aparece na lista do Enable Banking para contas de empresa.");
  const segundos = Math.min(Number(bank.maximum_consent_validity) || 90 * 86400, 180 * 86400);
  const state = "opera-banco-" + crypto.randomUUID();
  const r = await eb("/auth", {
    method: "POST",
    body: JSON.stringify({
      access: { valid_until: new Date(Date.now() + segundos * 1000 - 60_000).toISOString() },
      aspsp: { name: bank.name, country: "PT" },
      state, redirect_url: redirectUrl, psu_type: "business", language: "pt",
    }),
  });
  await db.from("opera_banco_ligacao").delete().eq("estado", "pendente");
  const { error } = await db.from("opera_banco_ligacao").insert({ aspsp: bank.name, estado: "pendente", auth_state: state });
  if (error) throw new Error(error.message);
  return { url: r.url };
}

async function concluir(code: string, state: string) {
  const { data: pend } = await db.from("opera_banco_ligacao").select("*").eq("estado", "pendente").eq("auth_state", state).maybeSingle();
  if (!pend) throw new EBError(400, "Este pedido de ligação já não é válido. Começa outra vez em Ligar Millennium.");
  const s = await eb("/sessions", { method: "POST", body: JSON.stringify({ code }) });
  const contas = (s.accounts ?? []).map((a: any) => ({ uid: a.uid, iban: a.account_id?.iban ?? null, nome: a.name ?? null, moeda: a.currency ?? "EUR" }));
  if (!contas.length) throw new EBError(400, "O banco não devolveu nenhuma conta. Confirma que escolheste a conta da Grabbingstars.");
  // A ligação nova substitui as anteriores (as antigas ficam como expiradas, para histórico).
  await db.from("opera_banco_ligacao").update({ estado: "expirada" }).eq("estado", "ativa");
  const { error } = await db.from("opera_banco_ligacao").update({
    estado: "ativa", session_id: s.session_id, contas, valido_ate: s.access?.valid_until ?? null, auth_state: null, ultimo_erro: null,
  }).eq("id", pend.id);
  if (error) throw new Error(error.message);
  return await sync();
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const ORDEM_SALDO = ["ITAV", "CLAV", "XPCD", "ITBD", "CLBD", "OPBD"];

async function sync() {
  const { data: lig } = await db.from("opera_banco_ligacao").select("*").eq("estado", "ativa").order("criado_em", { ascending: false }).limit(1).maybeSingle();
  if (!lig) return { ok: false, message: "Não há conta ligada." };
  if (lig.valido_ate && new Date(lig.valido_ate) < new Date()) {
    await db.from("opera_banco_ligacao").update({ estado: "expirada", ultimo_erro: "O consentimento do banco expirou." }).eq("id", lig.id);
    return { ok: false, message: "O consentimento do banco expirou. Liga outra vez." };
  }
  try {
    let saldoTotal = 0, novos = 0;
    const desde = iso(new Date(lig.ultima_sync ? new Date(lig.ultima_sync).getTime() - 7 * 86400e3 : Date.now() - 90 * 86400e3));
    for (const conta of lig.contas as Array<{ uid: string }>) {
      const { balances } = await eb(`/accounts/${conta.uid}/balances`);
      const b = [...(balances ?? [])].sort((x: any, y: any) => {
        const ix = ORDEM_SALDO.indexOf(x.balance_type), iy = ORDEM_SALDO.indexOf(y.balance_type);
        return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy);
      })[0];
      if (b) saldoTotal += Number(b.balance_amount?.amount) || 0;

      let cont: string | null = null;
      const linhas: Record<string, unknown>[] = [];
      do {
        const q = new URLSearchParams({ date_from: desde, transaction_status: "BOOK" });
        if (cont) q.set("continuation_key", cont);
        const r = await eb(`/accounts/${conta.uid}/transactions?${q}`);
        for (const t of r.transactions ?? []) {
          const valor = Math.abs(Number(t.transaction_amount?.amount) || 0) * (t.credit_debit_indicator === "DBIT" ? -1 : 1);
          const data = t.booking_date || t.value_date || t.transaction_date;
          if (!data || !valor) continue;
          const descricao = (t.remittance_information ?? []).join(" ").trim() || null;
          const contraparte = (t.credit_debit_indicator === "DBIT" ? t.creditor?.name : t.debtor?.name) || null;
          const ref = t.entry_reference || t.transaction_id || `${data}|${valor}|${descricao ?? ""}|${contraparte ?? ""}`;
          linhas.push({ conta_uid: conta.uid, ref: String(ref).slice(0, 200), data, valor, moeda: t.transaction_amount?.currency ?? "EUR",
            contraparte: contraparte?.slice(0, 200) ?? null, descricao: descricao?.slice(0, 500) ?? null });
        }
        cont = r.continuation_key || null;
      } while (cont);
      if (linhas.length) {
        const { data: ins, error } = await db.from("opera_banco_movimentos")
          .upsert(linhas, { onConflict: "conta_uid,ref", ignoreDuplicates: true }).select("id");
        if (error) throw new Error(error.message);
        novos += ins?.length ?? 0;
      }
    }
    // Saldo do dia: substitui o registo automático de hoje, se já houver.
    const hoje = iso(new Date());
    await db.from("opera_saldo").delete().eq("data", hoje).eq("notas", "Millennium (automático)");
    await db.from("opera_saldo").insert({ data: hoje, valor: Math.round(saldoTotal * 100) / 100, notas: "Millennium (automático)" });
    await db.from("opera_banco_ligacao").update({ ultima_sync: new Date().toISOString(), ultimo_erro: null }).eq("id", lig.id);
    return { ok: true, saldo: saldoTotal, novos };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const expirou = e instanceof EBError && (e.status === 401 || e.status === 403);
    await db.from("opera_banco_ligacao").update({ ultimo_erro: msg, ...(expirou ? { estado: "expirada" } : {}) }).eq("id", lig.id);
    throw e;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return fail("Método não permitido.", 405);
  try {
    const nivel = await nivelDe(req);
    if (!nivel) return fail("Sem acesso.", 403);
    let body: Record<string, string> = {};
    try { body = await req.json(); } catch { return fail("Pedido inválido."); }
    if (body.action === "sync") return json(await sync());
    if (nivel !== "total") return fail("Sem acesso.", 403);
    if (body.action === "ligar") return json(await ligar(String(body.redirect_url ?? "")));
    if (body.action === "concluir") return json(await concluir(String(body.code ?? ""), String(body.state ?? "")));
    return fail("Ação desconhecida.");
  } catch (e) {
    console.error("opera-banco:", e instanceof Error ? e.message : e);
    return fail(e instanceof Error ? e.message : "Erro no servidor.", e instanceof EBError && e.status < 500 ? 400 : 500);
  }
});
