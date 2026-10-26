// OPERA Leads: CloudTalk. Corre no Supabase (UE). Uma conta e um número para todos os clientes.
//
// Pedidos da aplicação (com a sessão de quem está a trabalhar, só equipa OPERA com dois passos):
//   { action: "call", lead_id }       cria ou atualiza o contacto ("Nome · Cliente"), pede a chamada ao agente
//                                     e regista a chamada na lead
//   { action: "recording", call_id }  devolve o áudio da gravação (fica no registo de atividade)
//   { action: "ci", call_id }         vai buscar outra vez o resumo, as notas e a transcrição da chamada
//   { action: "nota", call_id }       pede outra vez ao Claude a nota da chamada (a partir da transcrição guardada)
// Webhook da CloudTalk (assinado, cabeçalhos svix-*): call.ended, call.recording_ready, e da Conversation
// Intelligence transcript.ready e cidata.ready (resumo, notas inteligentes, sentimento, temas e transcrição).
//
// A nota da chamada que o cliente vê é escrita pelo Claude a partir da transcrição, como se fosse o gestor do cliente:
// um diagnóstico de qualificação detalhado, sem a transcrição. A transcrição fica só para a equipa OPERA.
// Com a nota vêm os campos de qualificação ouvidos na chamada; a lead só recebe os que ainda estão vazios.
//
// Segredos (Supabase, Edge Functions): CLOUDTALK_API_KEY_ID, CLOUDTALK_API_KEY_SECRET, CLOUDTALK_WEBHOOK_SECRET.
// Opcional: ANTHROPIC_API_KEY (sem ela, a nota fica com o resumo curto da CloudTalk).
// Sem as chaves, "call" devolve configured:false e a aplicação liga pelo telefone, como antes.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

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
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const claude = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;
const NOTE_MODEL = "claude-opus-5-5";

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

// ------------------------------------------------------------ CONVERSATION INTELLIGENCE
// Outro servidor (api.cloudtalk.io/v1), as mesmas chaves; as respostas não vêm dentro de responseData.
const CI_API = "https://api.cloudtalk.io/v1/ai/calls";
async function ciGet(callId: string, path: string, query = "") {
  const res = await fetch(`${CI_API}/${encodeURIComponent(callId)}/${path}${query}`, {
    headers: { Authorization: `Basic ${btoa(`${CT_ID}:${CT_SECRET}`)}`, Accept: "application/json" },
  });
  // Ainda não existe, a chamada não tem análise, ou o id não é de uma chamada da CloudTalk.
  if ([400, 404, 422].includes(res.status)) return null;
  if (res.status === 401 || res.status === 403) {
    const body = await res.json().catch(() => ({}));
    throw new CiDenied(`CloudTalk IA ${res.status} em ${path} (${String(body?.code ?? body?.responseData?.message ?? "sem código")})`);
  }
  if (!res.ok) throw new Error(`CloudTalk IA ${res.status} em ${path}`);
  return await res.json().catch(() => null);
}
// A chave não dá acesso à IA (conta sem Conversation Intelligence ou chave sem acesso): não adianta repetir.
class CiDenied extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string => typeof v === "string" ? v.trim()
  : typeof v === "number" ? String(v)
  : isObj(v) ? text(v.text ?? v.note ?? v.content ?? v.value ?? v.summary ?? v.name ?? v.title ?? "") : "";
// Desce por data/summary/items até chegar ao conteúdo, seja qual for o embrulho.
const unwrap = (v: unknown, keys: string[]): unknown => {
  let cur = v;
  for (let i = 0; i < 3 && isObj(cur); i++) {
    const k = keys.find((x) => x in (cur as Obj));
    if (!k) break;
    cur = (cur as Obj)[k];
  }
  return cur;
};
// Notas inteligentes: lista de textos; os grupos (ex.: "action_items") ficam como prefixo, em português.
const NOTE_GROUP: Record<string, string> = {
  action_items: "Próximos passos", next_steps: "Próximos passos", decisions: "Decisões",
  open_questions: "Perguntas em aberto", questions: "Perguntas", dates: "Datas", key_dates: "Datas",
};
function notesList(v: unknown): string[] {
  const out: string[] = [];
  const walk = (x: unknown, prefix: string) => {
    if (Array.isArray(x)) x.forEach((y) => walk(y, prefix));
    else if (typeof x === "string") x.split("\n").map((s) => s.replace(/^[-*•]\s*/, "").trim()).filter(Boolean).forEach((s) => out.push(prefix + s));
    else if (isObj(x)) {
      const t = text(x);
      if (t) out.push(prefix + t);
      else for (const [k, y] of Object.entries(x)) walk(y, `${NOTE_GROUP[k] ?? k.replace(/_/g, " ")}: `);
    }
  };
  walk(v, "");
  return out.slice(0, 50);
}

// Resumo, notas, sentimento e temas a partir das respostas (da API ou do próprio evento cidata.ready).
function analysis(sum: unknown, notes: unknown, sent: unknown, topics: unknown) {
  const sumVal = unwrap(sum, ["data", "summary"]);
  const t = unwrap(topics, ["data", "topics"]);
  return {
    summary: typeof sumVal === "string" ? sumVal.trim() : text(sumVal),
    notes: notesList(unwrap(notes, ["data", "smart_notes", "smartNotes", "notes"])),
    sentiment: text(unwrap(sent, ["data", "overall_sentiment", "sentiment"])),
    topics: (Array.isArray(t) ? t.map(text) : []).filter(Boolean).slice(0, 20),
  };
}
// cidata.ready já traz a análise: summary (com smart_notes), sentiment e topics.
export function analysisFromEvent(d: Obj) {
  const sum = d.summary;
  return analysis(sum, isObj(sum) ? (sum.smart_notes ?? sum.smartNotes) : d.smart_notes, d.sentiment ?? d.overall_sentiment, d.topics);
}

async function fetchTranscript(callId: string) {
  const transcript: { s: string; t: number | null; x: string }[] = [];
  let lang = "";
  for (let offset = 0, page = 0; page < 40; page++) {
    const r = await ciGet(callId, "transcription", `?limit=100&offset=${offset}`);
    if (!r) break;
    if (isObj(r) && !lang) lang = text(r.language ?? r.lang ?? (isObj(r.data) ? (r.data as Obj).language : ""));
    const segs = unwrap(r, ["data", "transcription", "transcript", "segments", "items", "results"]);
    const list = Array.isArray(segs) ? segs : [];
    for (const s of list) {
      if (!isObj(s)) continue;
      const who = s.caller ?? s.speaker ?? s.participant ?? s.channel ?? s.role ?? "";
      const x = text(s.text ?? s.transcript ?? s.content ?? s.sentence ?? "");
      if (!x) continue;
      const t = Number(s.start ?? s.start_time ?? s.from ?? s.offset ?? s.begin);
      transcript.push({ s: text(who) || String(who ?? ""), t: Number.isFinite(t) ? t : null, x });
    }
    if (list.length < 100) break;
    offset += list.length;
  }
  return { transcript, lang };
}

// Para diagnóstico: só os nomes dos campos, nunca o conteúdo.
const keys = (v: unknown) => isObj(v) ? Object.keys(v) : Array.isArray(v) ? ["[array]"] : [];

// part: "analysis" (resumo e afins), "transcript", ou "all". fromEvent: a análise que já veio no cidata.ready.
async function storeCI(callId: string, part: "analysis" | "transcript" | "all", fromEvent?: Obj) {
  let ci: Obj = {};
  let shape: Obj = {};
  try {
    if (part !== "transcript") {
      const ev = fromEvent ? analysisFromEvent(fromEvent) : null;
      if (ev && (ev.summary || ev.notes.length || ev.sentiment || ev.topics.length)) {
        ci = { ...ev };
        shape = { evento: keys(fromEvent) };
      } else {
        const [sum, notes, sent, topics] = await Promise.all([
          ciGet(callId, "summary"), ciGet(callId, "smart-notes"), ciGet(callId, "overall-sentiment"), ciGet(callId, "topics"),
        ]);
        ci = analysis(sum, notes, sent, topics);
        shape = { summary: keys(sum), notes: keys(notes), sentiment: keys(sent), topics: keys(topics) };
      }
    }
    if (part !== "analysis") {
      const tr = await fetchTranscript(callId);
      ci = { ...ci, ...tr };
      shape = { ...shape, transcript: tr.transcript.length };
    }
  } catch (e) {
    if (!(e instanceof CiDenied)) throw e;
    console.error("leads-cloudtalk:", e.message);
    if (!Object.keys(ci).length) {
      return { status: "ignorado", motivo: "A chave da CloudTalk não tem acesso à análise das chamadas.", shape };
    }
  }
  const has = (v: unknown) => Array.isArray(v) ? v.length > 0 : !!v;
  const empty = !["summary", "notes", "sentiment", "topics", "transcript"].some((k) => has(ci[k]));
  if (empty) return { status: "ignorado", motivo: "A CloudTalk ainda não tem análise desta chamada.", shape };
  // Só o que veio preenchido: uma parte vazia não apaga o que já estava guardado.
  const p = Object.fromEntries(Object.entries(ci).filter(([, v]) => has(v)));
  const r = await must(admin.rpc("leads_cloudtalk_ci", { p_call_id: callId, p }), "Análise da chamada") as Obj;
  return { ...r, shape };
}

// ------------------------------------------------------------ NOTA DA CHAMADA (CLAUDE)
const NOTE_SYSTEM = `Escreves notas de chamadas para o OPERA Leads, o sistema onde a OPERA (a equipa que contacta e qualifica leads imobiliárias para agências e consultores) regista o trabalho feito com cada lead.

Recebes a transcrição de uma chamada feita pelo gestor da OPERA a uma lead de um cliente, e os dados que já existem sobre a lead. Escreve a nota que esse gestor escreveria no histórico logo a seguir à chamada: na primeira pessoa, em português de Portugal, com um tom profissional e direto, como um consultor experiente que passa a um colega tudo o que apurou. Não é uma transcrição nem um resumo genérico: é um diagnóstico de qualificação, o mais completo e detalhado possível, com tudo o que for útil a quem vai trabalhar esta lead a seguir. Quem a lê é a equipa OPERA e o cliente (o consultor ou a agência que vai acompanhar a lead).

Regras:
Usa só o que foi dito na chamada ou consta dos dados da lead. Nunca inventes nem deduzas valores, datas, zonas ou nomes; quando um ponto não foi falado, escreve "não falado".
Escreve números, valores, zonas, tipologias, prazos, nomes e datas exatamente como foram ditos.
Não cites a conversa palavra a palavra, não incluas a transcrição e nunca a menciones (nem a gravação): escreves como quem esteve na chamada. Se um nome ou uma zona parece mal transcrito, usa a forma correta só quando for evidente; se não for, escreve como ouviste.
Escreve texto simples, sem markdown (sem cardinais, asteriscos ou tabelas). Não uses travessões nem hífenes como pontuação.
Se não houve conversa útil (caixa de correio, número errado, pediu para ligar mais tarde, desligou), escreve só duas ou três frases a dizer o que aconteceu e qual é o próximo passo.

Estrutura, com cada título numa linha própria:
Resumo
Três a cinco frases: quem é, o que procura ou quer fazer, em que ponto está e como correu a chamada.

Diagnóstico de qualificação
Objetivo: comprar, vender, arrendar, crédito ou investir, e porquê.
Imóvel procurado ou a vender: tipologia, zona, características e estado.
Budget:
Financiamento: crédito, capitais próprios, pré aprovação, banco.
Prazo:
Tem imóvel para vender:
Disponibilidade para visita:
Quem decide e situação: só o que for relevante e tiver sido dito.

Motivação e contexto

Objeções, dúvidas ou receios

Temperatura: quente, morno ou frio, e porquê.

Próximos passos: o que ficou combinado, com datas e horas se foram ditas.

Devolves também os campos de qualificação da lead, com o que foi dito na chamada, numa frase curta cada (por exemplo "300 000 €", "3 meses", "crédito com 10% de entrada, sem pré aprovação", "sim, T2 em Odivelas", "sábados de manhã"). Usa null quando o ponto não foi falado ou não ficou claro; nunca deduzas. No objetivo, escolhe só o que a pessoa disse querer: Comprador (quer comprar), Proprietário (quer vender ou arrendar um imóvel seu) e Crédito (quer ajuda com o crédito habitação); lista vazia se não ficou claro.`;

// Formato da resposta: a nota e os campos de qualificação (structured outputs).
const NOTE_FORMAT = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["nota", "qualificacao"],
    properties: {
      nota: { type: "string" },
      qualificacao: {
        type: "object",
        additionalProperties: false,
        required: ["objetivo", "budget", "prazo", "financiamento", "imovel_para_vender", "disponibilidade_visita"],
        properties: {
          objetivo: { type: "array", items: { type: "string", enum: ["Comprador", "Proprietário", "Crédito"] } },
          budget: { type: ["string", "null"] },
          prazo: { type: ["string", "null"] },
          financiamento: { type: ["string", "null"] },
          imovel_para_vender: { type: ["string", "null"] },
          disponibilidade_visita: { type: ["string", "null"] },
        },
      },
    },
  },
};
type NoteOut = {
  nota: string;
  qualificacao: { objetivo: string[]; budget: string | null; prazo: string | null; financiamento: string | null;
                  imovel_para_vender: string | null; disponibilidade_visita: string | null };
};
// Nomes dos campos como estão na lead (iguais aos do ecrã de qualificação).
function qualFields(q: NoteOut["qualificacao"]) {
  const out: Record<string, string> = {};
  const set = (k: string, v: string | null | undefined) => { if (v && v.trim()) out[k] = v.trim(); };
  set("Objetivo", (q.objetivo ?? []).join(", "));
  set("Budget", q.budget);
  set("Prazo", q.prazo);
  set("Financiamento", q.financiamento);
  set("Tem imóvel para vender", q.imovel_para_vender);
  set("Disponibilidade para visita", q.disponibilidade_visita);
  return out;
}

type Ci = { summary?: string; notes?: string[]; transcript?: { s: string; t: number | null; x: string }[] };

// Escreve (ou volta a escrever) a nota da chamada com o Claude. Só corre quando já há transcrição.
async function writeAiNote(callId: string, force = false) {
  if (!claude) return { status: "sem_chave" };
  const { data: ins } = await admin.from("lead_call_insights").select("lead_id,ci").eq("call_id", callId).maybeSingle();
  const ci = (ins?.ci ?? {}) as Ci;
  if (!ins || !ci.transcript?.length) return { status: "sem_transcricao" };
  const { data: current } = await admin.from("lead_events").select("meta").eq("lead_id", ins.lead_id).eq("type", "note")
    .eq("meta->>ci_call_id", callId).maybeSingle();
  if (!force && (current?.meta as Obj | undefined)?.ai) return { status: "ja_escrita" };

  const { data: lead } = await admin.from("leads")
    .select("name,interest,source,qualification,created_at,client_id,anonymized").eq("id", ins.lead_id).single();
  if (!lead || lead.anonymized) return { status: "sem_lead" };
  const { data: client } = await admin.from("clients").select("name,manager_id").eq("id", lead.client_id).single();
  const { data: manager } = client?.manager_id
    ? await admin.from("profiles").select("full_name").eq("id", client.manager_id).maybeSingle() : { data: null };
  const { data: form } = await admin.from("lead_events").select("body").eq("lead_id", ins.lead_id).eq("type", "note")
    .eq("title", "Respostas do formulário").limit(1).maybeSingle();
  const { data: call } = await admin.from("lead_events").select("created_at,meta").eq("type", "call")
    .eq("meta->>call_id", callId).limit(1).maybeSingle();

  const gestor = manager?.full_name ?? "o gestor da OPERA";
  const qual = Object.entries((lead.qualification ?? {}) as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join("\n");
  const context = [
    `Gestor da OPERA que fez a chamada: ${gestor}`,
    `Cliente da OPERA (quem vai acompanhar a lead): ${client?.name ?? ""}`,
    `Lead: ${lead.name}`,
    lead.interest ? `Interesse registado: ${lead.interest}` : "",
    lead.source ? `Origem: ${lead.source}` : "",
    `Chamada: ${call?.created_at ?? ""}, ${(call?.meta as Obj | undefined)?.duration_s ?? "?"} segundos de conversa`,
    qual ? `Qualificação já registada:\n${qual}` : "",
    form?.body ? `Respostas do formulário:\n${form.body}` : "",
    ci.summary ? `Resumo automático da CloudTalk (pode estar incompleto):\n${ci.summary}` : "",
  ].filter(Boolean).join("\n\n");
  const transcript = ci.transcript.map((x) => `${x.s || "Interlocutor"}: ${x.x}`).join("\n");

  const ask = (withFields: boolean) => claude.beta.messages.create({
    model: NOTE_MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: withFields ? { effort: "medium", format: NOTE_FORMAT } : { effort: "medium" },
    system: NOTE_SYSTEM,
    messages: [{
      role: "user",
      content: `${context}\n\nTranscrição da chamada (o agente é ${gestor}):\n${transcript}\n\nEscreve a nota de ${gestor} sobre esta chamada.`,
    }],
  });
  // Se o formato com os campos for recusado, a nota sai na mesma, só sem preencher a qualificação.
  let withFields = true;
  let response;
  try {
    response = await ask(true);
  } catch (e) {
    if (!(e instanceof Anthropic.BadRequestError)) throw e;
    console.error("leads-cloudtalk: formato da nota recusado:", e.message.slice(0, 200));
    withFields = false;
    response = await ask(false);
  }
  if (response.stop_reason === "refusal") return { status: "recusada" };
  if (response.stop_reason === "max_tokens") return { status: "cortada" };
  const raw = response.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("").trim();
  let out: NoteOut | null = null;
  if (withFields) {
    try { out = JSON.parse(raw); } catch { return { status: "formato_invalido" }; }
  }
  const nota = out ? out.nota : raw;
  if (!nota?.trim()) return { status: "vazia" };
  return await must(admin.rpc("leads_cloudtalk_ai_note", {
    p_call_id: callId, p_body: nota, p_model: response.model, p_fields: out?.qualificacao ? qualFields(out.qualificacao) : {},
  }), "Nota da chamada") as Obj;
}

// Depois de responder à CloudTalk: a nota demora alguns segundos e a CloudTalk não espera por ela.
function writeAiNoteLater(callId: string) {
  const job = writeAiNote(callId).then((r) => console.log("leads-cloudtalk: nota", r.status))
    .catch((e) => console.error("leads-cloudtalk: nota:", e instanceof Error ? e.message.slice(0, 200) : "erro"));
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(job);
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
    } else if (d.call_id && (type === "cidata.ready" || (type === "transcript.ready" && CT_ID && CT_SECRET))) {
      const { shape, ...r } = type === "cidata.ready"
        ? await storeCI(String(d.call_id), "analysis", d)
        : await storeCI(String(d.call_id), "transcript");
      // Só os nomes dos campos que a CloudTalk devolveu, para confirmar o formato; nunca o conteúdo.
      console.log(`leads-cloudtalk: ${type}`, r.status, JSON.stringify(shape));
      result = r;
      if (r.status === "processado") writeAiNoteLater(String(d.call_id));
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
  if (!me) {
    // Por agora a equipa OPERA partilha a conta da CloudTalk do admin: quem não tem agente próprio liga por ela.
    // Não fica guardado no perfil, para passar a usar o agente próprio assim que for criado com o mesmo email.
    if (["admin", "gestor"].includes(p.leads_role ?? "")) {
      const { data: shared } = await admin.from("profiles").select("cloudtalk_agent_id")
        .eq("leads_role", "admin").eq("leads_status", "ativo").not("cloudtalk_agent_id", "is", null)
        .order("created_at").limit(1).maybeSingle<{ cloudtalk_agent_id: number }>();
      if (shared?.cloudtalk_agent_id) return shared.cloudtalk_agent_id;
    }
    throw new Error("O teu email não corresponde a nenhum agente da CloudTalk. Pede ao admin para o criar com o mesmo email.");
  }
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

  if (body.action === "ci") {
    // O RLS decide se quem pede vê esta chamada.
    const { data: ev } = await userDb.from("lead_events").select("id").eq("type", "call")
      .eq("meta->>call_id", String(body.call_id ?? "")).maybeSingle();
    if (!ev) return fail("Chamada não encontrada.", 404);
    if (!CT_ID || !CT_SECRET) return fail("A CloudTalk ainda não está ligada.");
    const r = await storeCI(String(body.call_id), "all");
    if (r.status === "processado") writeAiNoteLater(String(body.call_id));
    return json(r);
  }

  if (body.action === "nota") {
    // O RLS decide se quem pede vê esta chamada.
    const { data: ev } = await userDb.from("lead_events").select("id").eq("type", "call")
      .eq("meta->>call_id", String(body.call_id ?? "")).maybeSingle();
    if (!ev) return fail("Chamada não encontrada.", 404);
    if (!claude) return fail("Falta a chave do Claude (ANTHROPIC_API_KEY) no Supabase.");
    const r = await writeAiNote(String(body.call_id), true);
    if (r.status === "sem_transcricao") return fail("Esta chamada ainda não tem transcrição.");
    if (r.status !== "processado") return fail("Não foi possível escrever a nota. Tenta outra vez.");
    return json(r);
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
