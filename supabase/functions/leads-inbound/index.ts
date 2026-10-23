// OPERA Leads: entradas automáticas. Corre no Supabase (UE) e é chamada pelo Make.
//
// POST com JSON e o cabeçalho x-opera-secret (chave guardada no Vault do Supabase):
//   { type: "meta",  page_id, form_id, lead_id, created_time, field_data: [{ name, values }], client? }
//   { type: "email", from, to, cc, subject, text, html, headers }
//
// Regras:
//   * o conteúdo bruto fica no inbound_log antes de qualquer outra coisa: um erro nunca perde uma lead;
//   * nos emails, a IA só recebe o assunto e o texto do email, nada mais;
//   * os emails de confirmação do Gmail não são leads: guarda-se o código para o ecrã Entradas automáticas;
//   * em caso de erro devolve 500, para o Make avisar por email; os logs nunca levam dados da lead.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import Anthropic from "npm:@anthropic-ai/sdk@0.132.0";

const SECRET_KEY = (() => {
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  return keys ? JSON.parse(keys).default : Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
})();
const db = createClient(Deno.env.get("SUPABASE_URL")!, SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const ai = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY, maxRetries: 2, timeout: 60_000 }) : null;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Parsed = Record<string, unknown>;
type Body = Record<string, unknown>;

async function must<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v)).trim();
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const emailsIn = (v: unknown) => (str(Array.isArray(v) ? v.join(" ") : typeof v === "object" && v ? JSON.stringify(v) : v)
  .match(EMAIL_RE) ?? []).map((e) => e.toLowerCase());

// ------------------------------------------------------------ META
// Aceita o formato do módulo "Facebook Lead Ads" do Make (field_data) ou campos já mapeados.
function parseMeta(b: Body): Parsed {
  const fields: Record<string, string> = {};
  const answers: { q: string; a: string }[] = [];
  if (Array.isArray(b.field_data)) {
    for (const f of b.field_data as { name?: string; values?: unknown[] }[]) {
      const name = str(f?.name);
      const value = Array.isArray(f?.values) ? f.values.map(str).filter(Boolean).join(", ") : str(f?.values);
      if (name) fields[name.toLowerCase()] = value;
    }
  }
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = str(b[k]) || fields[k];
      if (v) return v;
    }
    return "";
  };
  const name = pick("name", "full_name", "nome", "nome_completo") ||
    [pick("first_name"), pick("last_name")].filter(Boolean).join(" ");
  const used = new Set(["name", "full_name", "nome", "nome_completo", "first_name", "last_name",
    "phone", "phone_number", "telefone", "email"]);
  for (const [q, a] of Object.entries(fields)) if (!used.has(q) && a) answers.push({ q: q.replace(/_/g, " "), a });
  if (Array.isArray(b.answers)) {
    for (const x of b.answers as { q?: unknown; a?: unknown }[]) if (str(x?.a)) answers.push({ q: str(x?.q), a: str(x?.a) });
  }
  return {
    name, phone: pick("phone", "phone_number", "telefone"), email: pick("email"),
    source: "Meta", answers,
    external_id: str(b.lead_id || b.leadgen_id || b.id) ? `meta:${str(b.lead_id || b.leadgen_id || b.id)}` : "",
    source_created_at: str(b.created_time || b.created_at),
    page_id: str(b.page_id), form_id: str(b.form_id), client: str(b.client),
  };
}

// ------------------------------------------------------------ EMAIL
function header(b: Body, name: string): string {
  const h = b.headers;
  const want = name.toLowerCase();
  if (Array.isArray(h)) {
    return (h as { name?: string; value?: string }[]).filter((x) => str(x?.name).toLowerCase() === want)
      .map((x) => str(x?.value)).join(" ");
  }
  if (h && typeof h === "object") {
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) if (k.toLowerCase() === want) return str(v);
    return "";
  }
  if (typeof h === "string") {
    const m = h.match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
    return m ? m[1].trim() : "";
  }
  return "";
}

function htmlToText(html: string) {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}

const emailText = (b: Body) => str(b.text) || htmlToText(str(b.html));

// Endereços por onde o email passou: o original do cliente vem no X-Forwarded-For do Gmail ou no To.
// Quando o Outlook reencaminha, o remetente passa a ser o próprio cliente, por isso o From também conta.
function recipients(b: Body) {
  return [...new Set([
    ...emailsIn(header(b, "X-Forwarded-For")), ...emailsIn(header(b, "X-Original-To")),
    ...emailsIn(header(b, "Delivered-To")), ...emailsIn(b.to), ...emailsIn(b.cc),
    ...emailsIn(header(b, "To")), ...emailsIn(header(b, "Cc")),
    ...emailsIn(b.from), ...emailsIn(header(b, "From")),
  ])];
}

function gmailCode(b: Body): Parsed | null {
  const from = emailsIn(b.from).concat(emailsIn(header(b, "From")));
  if (!from.some((e) => e === "forwarding-noreply@google.com")) return null;
  const subject = str(b.subject);
  const text = emailText(b);
  const code = subject.match(/\(#\s*(\d{6,12})\)/)?.[1] ??
    text.match(/(?:code|código)\D{0,30}(\d{6,12})/i)?.[1] ?? "";
  const address = emailsIn(subject).find((e) => !e.endsWith("google.com")) ??
    emailsIn(text).find((e) => !e.endsWith("google.com") && !e.endsWith("make.com")) ?? "";
  const link = text.match(/https:\/\/(?:mail-settings\.google\.com|mail\.google\.com)\/\S+/)?.[0] ?? "";
  return { code, address, link };
}

const PORTALS: [RegExp, string][] = [
  [/idealista/i, "Idealista"], [/imovirtual/i, "Imovirtual"], [/casa\.?sapo|casasapo/i, "Casa Sapo"],
  [/supercasa/i, "Supercasa"], [/custojusto/i, "CustoJusto"], [/olx\./i, "OLX"],
];
function portalOf(b: Body) {
  const hay = [str(b.from), header(b, "From"), header(b, "Reply-To"), str(b.subject)].join(" ");
  return PORTALS.find(([re]) => re.test(hay))?.[1] ?? "";
}

// Sem IA: telefone e email pelo padrão, e a lead fica marcada para revisão.
function regexExtract(text: string, ignore: string[]) {
  const phone = text.match(/(?:\+?351[\s.-]?)?(?:9[1236]\d|2\d{2})[\s.-]?\d{3}[\s.-]?\d{3}\b/)?.[0] ?? "";
  const email = emailsIn(text).find((e) => !ignore.includes(e) && !/no-?reply|idealista|imovirtual|sapo\.pt|supercasa/i.test(e)) ?? "";
  return { phone, email };
}

const LeadSchema = {
  type: "object",
  properties: {
    is_lead: { type: "boolean", description: "true se o email é um pedido de contacto de uma pessoa interessada num imóvel" },
    name: { type: "string", description: "nome da pessoa interessada, ou vazio" },
    phone: { type: "string", description: "telefone da pessoa interessada, como aparece no email, ou vazio" },
    email: { type: "string", description: "email da pessoa interessada (nunca o do portal nem o da agência), ou vazio" },
    message: { type: "string", description: "mensagem escrita pela pessoa interessada, sem alterações, ou vazio" },
    property: { type: "string", description: "descrição curta do imóvel (tipologia e zona), ou vazio" },
    reference: { type: "string", description: "referência ou código do anúncio, ou vazio" },
    portal: { type: "string", description: "nome do portal imobiliário de onde veio o pedido, ou vazio" },
  },
  required: ["is_lead", "name", "phone", "email", "message", "property", "reference", "portal"],
  additionalProperties: false,
} as const;

const SYSTEM = "Recebes emails de portais imobiliários portugueses (Idealista, Imovirtual, Casa Sapo e outros), " +
  "reencaminhados por uma agência imobiliária. Extrai os dados da pessoa interessada no imóvel. " +
  "Os dados de contacto da agência, do portal ou de quem reencaminhou não são da pessoa interessada. " +
  "Não inventes dados: o que não estiver no email fica vazio.";

async function aiExtract(subject: string, text: string) {
  if (!ai) return null;
  const response = await ai.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: LeadSchema } },
    system: SYSTEM,
    messages: [{ role: "user", content: `Assunto: ${subject}\n\n${text}` }],
  } as Anthropic.Beta.MessageCreateParamsNonStreaming);
  if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") return null;
  const out = response.content.find((c) => c.type === "text");
  return out && out.type === "text" ? JSON.parse(out.text) as Record<string, string | boolean> : null;
}

async function parseEmail(b: Body): Promise<Parsed> {
  const subject = str(b.subject);
  const text = emailText(b);
  const to = recipients(b);
  const portal = portalOf(b);
  let x: Record<string, string | boolean> | null = null;
  let aiFailed = false;
  try {
    // O texto vai inteiro; um email de portal tem poucos milhares de caracteres.
    x = await aiExtract(subject, text);
  } catch (e) {
    aiFailed = true;
    // A mensagem de erro da API descreve o pedido (modelo, parâmetros, saldo), nunca o conteúdo do email.
    console.error("leads-inbound: IA indisponível:",
      e instanceof Anthropic.APIError ? `${e.status} ${e.message.slice(0, 300)}` : "erro");
  }
  if (!x) {
    const r = regexExtract(text, to);
    return {
      name: "", phone: r.phone, email: r.email, message: "", interest: str(subject).slice(0, 160),
      reference: "", source: portal || "Portal", recipients: to, review: true,
      review_reason: ai && !aiFailed ? "A IA não conseguiu ler este email; confirmar os dados no email original."
        : "A leitura automática não estava disponível; confirmar os dados no email original.",
    };
  }
  const notLead = x.is_lead === false;
  return {
    name: str(x.name), phone: str(x.phone), email: str(x.email), message: str(x.message),
    interest: str(x.property), reference: str(x.reference), source: portal || str(x.portal) || "Portal",
    recipients: to, review: notLead,
    review_reason: notLead ? "Este email pode não ser um pedido de contacto." : "",
  };
}

// ------------------------------------------------------------ PEDIDO
Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Só POST." }, 405);
  const ok = await db.rpc("leads_inbound_verify", { p_secret: req.headers.get("x-opera-secret") ?? "" });
  if (ok.error || ok.data !== true) return json({ error: "Chave inválida." }, 401);

  // JSON, ou formulário (o Make envia assim os emails: escapa sozinho aspas e mudanças de linha);
  // no formulário os cabeçalhos do email chegam em headers_json.
  let body: Body;
  try {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
      const form = await req.formData();
      body = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
      if (body.headers_json) {
        try { body.headers = JSON.parse(String(body.headers_json)); } catch { body.headers = String(body.headers_json); }
        delete body.headers_json;
      }
    } else {
      body = await req.json();
    }
  } catch {
    return json({ error: "O corpo tem de ser JSON ou um formulário." }, 400);
  }
  delete body.attachments; // os anexos nunca são precisos e não se guardam
  const type = str(body.type).toLowerCase();
  if (type !== "meta" && type !== "email") return json({ error: "type tem de ser meta ou email." }, 400);

  // 1. Guardar primeiro, tal como chegou.
  let logId: number;
  try {
    const row = await must(db.from("inbound_log").insert({ channel: type, raw: body, status: "recebido" })
      .select("id").single(), "Registo da entrada");
    logId = (row as { id: number }).id;
  } catch (e) {
    console.error("leads-inbound:", e instanceof Error ? e.message : "erro");
    return json({ error: "Não foi possível guardar a entrada." }, 500);
  }

  try {
    // 2. Confirmação do reencaminhamento do Gmail: guardar o código, não é lead.
    if (type === "email") {
      const g = gmailCode(body);
      if (g) {
        const addr = str(g.address);
        const owner = addr
          ? await must(db.from("client_inbox_addresses").select("client_id").eq("address", addr).maybeSingle(), "Endereço")
          : null;
        await must(db.from("inbound_log").update({
          kind: "gmail_code", parsed: g, status: "processado",
          client_id: (owner as { client_id?: string } | null)?.client_id ?? null,
        }).eq("id", logId), "Código do Gmail");
        return json({ ok: true, status: "codigo_gmail", log_id: logId });
      }
    }

    // 3. Extrair os dados e criar a lead (ou juntar à existente).
    const parsed = type === "meta" ? parseMeta(body) : await parseEmail(body);
    await must(db.from("inbound_log").update({ parsed }).eq("id", logId), "Dados extraídos");
    const result = await must(db.rpc("leads_inbound_process", { p_log_id: logId }), "Criar lead") as Record<string, unknown>;
    return json({ ok: true, log_id: logId, ...result, alert: result.status === "sem_cliente" });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Erro desconhecido";
    console.error(`leads-inbound: entrada ${logId}:`, message);
    await db.from("inbound_log").update({ status: "erro", error: message.slice(0, 500) }).eq("id", logId);
    return json({ error: "A entrada ficou guardada mas não foi processada.", log_id: logId }, 500);
  }
});
