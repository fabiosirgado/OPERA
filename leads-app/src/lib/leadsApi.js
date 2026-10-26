// Dados do pipeline e da ficha da lead. As listas vêm de funções no servidor, que filtram, ordenam e paginam.
import { sb, SUPABASE_URL } from "../supabase.js";
import { PAGE, dueFrom, isAllDay, localInput } from "./format.js";
import { sessionEnded } from "./api.js";

const must = async (query) => {
  const { data, error } = await query;
  if (error) throw error;
  return data;
};

// ---------- Referências
export const listStages = () => must(sb.from("lead_stages").select("*").order("position"));
export const listLabels = () => must(sb.from("lead_labels").select("*").order("name"));
export const activeClients = () => must(sb.rpc("leads_clients_overview")).then((cs) => cs.filter((c) => c.leads_status === "ativo"));

// ---------- Pipeline
export const pipeline = ({ client, stage, label, q, mine, sort, dir = 1, offset = 0, limit = PAGE }) =>
  must(sb.rpc("leads_pipeline", {
    p_client: client || null, p_stage: stage || null, p_label: label || null, p_q: q || null,
    p_mine: !!mine, p_sort: sort, p_dir: dir, p_offset: offset, p_limit: limit,
  }));

export const pipelineCounts = ({ client, label, q, mine }) =>
  must(sb.rpc("leads_pipeline_counts", { p_client: client || null, p_label: label || null, p_q: q || null, p_mine: !!mine }))
    .then((rows) => Object.fromEntries(rows.map((r) => [r.stage_id, Number(r.n)])));

export const pipelineKpis = (client) => must(sb.rpc("leads_pipeline_kpis", { p_client: client || null })).then((r) => r[0]);
export const today = (client, q) => must(sb.rpc("leads_today", { p_client: client || null, p_q: q || null }));
export const search = (q) => must(sb.rpc("leads_search", { p_q: q }));

// ---------- Lead
export const getLead = (id) =>
  must(sb.from("leads").select("*, client:clients(id,name,color), links:lead_label_links(label_id)").eq("id", id).maybeSingle());

export const leadEvents = (id) =>
  must(sb.from("lead_events").select("*, author:profiles!lead_events_author_id_fkey(full_name,email)")
    .eq("lead_id", id).order("created_at", { ascending: false }).limit(300));

export const leadTasks = (id) =>
  must(sb.from("lead_tasks").select("*, doer:profiles!lead_tasks_done_by_fkey(full_name)")
    .eq("lead_id", id).is("canceled_at", null).order("due_at"));

export const clientUsers = (clientId) =>
  must(sb.from("profiles").select("id,full_name,email").eq("client_id", clientId).eq("leads_status", "ativo")
    .in("leads_role", ["cliente_admin", "cliente"]).order("full_name"));

export const updateLead = (id, patch) => must(sb.from("leads").update(patch).eq("id", id).select("id"))
  .then((r) => { if (!r.length) throw new Error("Sem permissão para mudar esta lead."); });

export const createLead = (p) => must(sb.rpc("leads_create", { p }));
export const findDuplicate = (clientId, phone, email) =>
  must(sb.rpc("leads_find_duplicate", { p_client_id: clientId, p_phone: phone || null, p_email: email || null })).then((r) => r[0] || null);
// Time to Lead: minutos dentro do horário de trabalho (segunda a sexta, 9:30 às 19:00, sem feriados), como no Dashboard.
export const businessMinutes = (from, to) => must(sb.rpc("leads_business_minutes", { p_from: from, p_to: to })).then(Number);
export const registerCall = (id, meta = {}) => must(sb.rpc("leads_register_call", { p_lead_id: id, p_meta: meta }));

// ---------- CloudTalk (função leads-cloudtalk; as chaves ficam no servidor)
async function cloudtalk(payload, asBlob = false) {
  const { data: s } = await sb.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/leads-cloudtalk`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${s.session?.access_token ?? ""}`,
    },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) await sessionEnded();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "A CloudTalk não respondeu. Tenta outra vez.");
  }
  return asBlob ? res.blob() : res.json();
}

// Ligar: pela CloudTalk quando está configurada; senão pelo telefone, como antes. Devolve "cloudtalk" ou "telefone".
export async function callLead(lead) {
  const r = await cloudtalk({ action: "call", lead_id: lead.id });
  if (r.configured) return "cloudtalk";
  window.location.href = `tel:${lead.phone}`;
  await registerCall(lead.id, { via: "telefone" });
  return "telefone";
}
export const callRecording = (callId) => cloudtalk({ action: "recording", call_id: callId }, true);
export const callAnalysis = (callId) => cloudtalk({ action: "ci", call_id: callId });
// Nota da chamada escrita pelo Claude a partir da transcrição (pede outra vez, mesmo que já exista).
export const callNote = (callId) => cloudtalk({ action: "nota", call_id: callId });
export const eraseSubject = (id) => must(sb.rpc("leads_erase_subject", { p_lead_id: id, p_confirm: "APAGAR" }));

export const toggleLabel = (leadId, labelId, on) => on
  ? must(sb.from("lead_label_links").insert({ lead_id: leadId, label_id: labelId }))
  : must(sb.from("lead_label_links").delete().eq("lead_id", leadId).eq("label_id", labelId));

export const addTask = async (leadId, type, dueAt, note) => {
  const { data: s } = await sb.auth.getUser();
  return must(sb.from("lead_tasks").insert({ lead_id: leadId, type, due_at: new Date(dueAt).toISOString(), note: note || null, created_by: s.user.id }));
};
export const completeTask = (taskId) => must(sb.from("lead_tasks").update({ done_at: new Date().toISOString() }).eq("id", taskId));
// Adiar 1 dia: a tarefa sem hora continua sem hora (no dia seguinte, mesmo com mudança de hora de verão).
export const snoozeTask = (task) => {
  const base = new Date(Math.max(new Date(task.due_at), Date.now()) + 864e5);
  const due = isAllDay(task.due_at) ? dueFrom(localInput(base).slice(0, 10), "") : base.toISOString();
  return must(sb.from("lead_tasks").update({ due_at: due }).eq("id", task.id));
};
export const updateTask = (taskId, { type, due, note }) =>
  must(sb.from("lead_tasks").update({ type, due_at: due, note: note || null }).eq("id", taskId).select("id"))
    .then((r) => { if (!r.length) throw new Error("Sem permissão para mudar esta tarefa."); });
export const deleteTask = (taskId) => must(sb.from("lead_tasks").delete().eq("id", taskId));

export const addNote = async (leadId, body, pinned, title = "Nota") => {
  const { data: s } = await sb.auth.getUser();
  return must(sb.from("lead_events").insert({ lead_id: leadId, type: "note", title, body, pinned, author_id: s.user.id }));
};
export const updateEvent = (id, patch) => must(sb.from("lead_events").update(patch).eq("id", id).select("id"))
  .then((r) => { if (!r.length) throw new Error("Só podes editar as tuas notas."); });

// ---------- Etapas e etiquetas
export const createStage = (row) => must(sb.from("lead_stages").insert(row));
// Mudar e apagar etapas: o RLS só deixa mexer nas etapas que não são base (a OPERA em todas, o cliente nas suas).
export const updateStage = (id, patch) => must(sb.from("lead_stages").update(patch).eq("id", id).select("id"))
  .then((r) => { if (!r.length) throw new Error("Sem permissão para mudar esta etapa."); });
export const deleteStage = async (id) => {
  const { data, error } = await sb.from("lead_stages").delete().eq("id", id).select("id");
  if (error?.code === "23503") throw new Error("Esta etapa tem leads. Muda-as para outra etapa antes de a apagar.");
  if (error) throw error;
  if (!data.length) throw new Error("Sem permissão para apagar esta etapa.");
};
export const createLabel = (name, color) => must(sb.from("lead_labels").insert({ name, color }));
export const updateLabel = (id, patch) => must(sb.from("lead_labels").update(patch).eq("id", id));
export const deleteLabel = (id) => must(sb.from("lead_labels").delete().eq("id", id));
export const labelUsage = () => must(sb.from("lead_label_links").select("label_id"))
  .then((rows) => rows.reduce((m, r) => ({ ...m, [r.label_id]: (m[r.label_id] || 0) + 1 }), {}));

// ---------- Conversas entre a OPERA e cada cliente (só texto; mudar ou apagar nos primeiros 15 minutos)
export const EDIT_WINDOW_MS = 15 * 60 * 1000;
export const conversations = () => must(sb.rpc("leads_conversations"));
export const conversation = (clientId, before = null, limit = 50) =>
  must(sb.rpc("leads_conversation", { p_client_id: clientId, p_before: before, p_limit: limit })).then((r) => r.reverse());
export const sendMessage = (clientId, body, leadId = null, audio = null) =>
  must(sb.rpc("leads_message_send", {
    p_client_id: clientId, p_body: body || null, p_lead_id: leadId,
    p_audio_path: audio?.path ?? null, p_audio_seconds: audio?.seconds ?? null,
  }));
// Mensagens de voz: ficheiro privado na pasta do cliente; ouve-se com um link assinado que dura uma hora.
export const VOICE_MAX_SECONDS = 300;
const VOICE_EXT = { "audio/webm": "webm", "audio/mp4": "mp4", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/aac": "aac" };
export async function uploadVoice(clientId, blob) {
  const type = (blob.type || "audio/webm").split(";")[0];
  const ext = VOICE_EXT[type];
  if (!ext) throw new Error("Este browser grava num formato que não é aceite. Experimenta o Chrome ou o Safari.");
  const path = `${clientId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await sb.storage.from("conversas").upload(path, blob, { contentType: type, upsert: false });
  if (error) throw new Error("Não foi possível guardar a gravação. Tenta outra vez.");
  return path;
}
export const voiceUrl = (path) => sb.storage.from("conversas").createSignedUrl(path, 3600).then(({ data, error }) => {
  if (error) throw error;
  return data.signedUrl;
});
export const editMessage = (id, body) => must(sb.rpc("leads_message_edit", { p_id: id, p_body: body }));
export const deleteMessage = (id) => must(sb.rpc("leads_message_delete", { p_id: id }));
export const markConversationRead = (clientId) => must(sb.rpc("leads_conversation_mark_read", { p_client_id: clientId }));
// Leads que se podem juntar a uma mensagem: do mesmo cliente, em qualquer etapa (o cliente só vê as suas).
export const attachableLeads = (clientId, q) => {
  let query = sb.from("leads").select("id,name,stage_id").eq("client_id", clientId).eq("anonymized", false)
    .order("updated_at", { ascending: false }).limit(20);
  const term = (q || "").replace(/[%_,()*\\]/g, " ").trim();
  if (term) query = query.ilike("name", `%${term}%`);
  return must(query);
};
export const exportConversation = (clientId) => must(sb.rpc("leads_messages_export", { p_client_id: clientId }));

// ---------- Tempo real: avisa quando muda alguma coisa nas leads que quem está na sessão pode ver.
// O tempo real filtra pelas regras de acesso com a sessão do momento em que se liga. Logo a seguir à verificação em
// dois passos, a ligação ainda pode ter a sessão anterior (sem os dois passos) e a equipa OPERA não receberia nada:
// por isso entrega-se primeiro a sessão atual e volta-se a ligar quando a sessão muda.
// Lead nova: entrou por uma entrada automática (Meta, portais) e ainda ninguém lhe pegou. Igual ao is_new do pipeline.
export const isAutoNewLead = (l, stageById) => !!l && l.created_by == null && !l.imported && !l.attempts
  && !l.last_contact_at && (stageById[l.stage_id]?.position ?? 999) < 50;
export const countNewLeads = (entryStageIds) => entryStageIds.length
  ? sb.from("leads").select("id", { count: "exact", head: true }).is("created_by", null).eq("imported", false)
    .eq("attempts", 0).is("last_contact_at", null).eq("anonymized", false).in("stage_id", entryStageIds).then((r) => r.count ?? 0)
  : Promise.resolve(0);

export function subscribeChanges(onChange) {
  let ch = null;
  let stopped = false;
  const connect = async () => {
    const { data } = await sb.auth.getSession();
    if (stopped) return;
    if (data.session) await sb.realtime.setAuth(data.session.access_token);
    const again = !!ch;
    if (ch) await sb.removeChannel(ch);
    ch = sb.channel(`leads-${Math.random().toString(36).slice(2)}`);
    for (const table of ["leads", "lead_tasks", "lead_events", "lead_label_links", "client_messages", "client_message_reads"]) {
      ch.on("postgres_changes", { event: "*", schema: "public", table }, (payload) => onChange(table, payload));
    }
    // Ao voltar a ligar, pede os dados outra vez: o que mudou entretanto não se perde.
    ch.subscribe((status) => { if (status === "SUBSCRIBED" && again) onChange("*"); });
  };
  connect();
  const { data: auth } = sb.auth.onAuthStateChange((event) => {
    if (event === "MFA_CHALLENGE_VERIFIED" || event === "TOKEN_REFRESHED" || event === "SIGNED_IN") setTimeout(connect, 0);
  });
  return () => { stopped = true; auth.subscription.unsubscribe(); if (ch) sb.removeChannel(ch); };
}
