const { useState, useEffect, useMemo, useRef } = React;
const { createClient } = window.supabase;
const sb = createClient(window.OPERA_CONFIG.SUPABASE_URL, window.OPERA_CONFIG.SUPABASE_ANON_KEY);

// ---------- Design tokens ----------
const C = {
  bg: "#0A0F1E",
  surface: "#121A2E",
  surfaceRaised: "#182444",
  border: "#26325A",
  text: "#EDEFF7",
  muted: "#8B93B5",
  accent: "#3D6BFF",
  accentSoft: "#1C2B5E",
  green: "#2ED8A7",
  amber: "#F5B942",
  red: "#F2617A",
};

const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@500;700;800&family=Inter:wght@400;500;600&display=swap');
.op-scroll::-webkit-scrollbar { height: 8px; }
.op-scroll::-webkit-scrollbar-thumb { background: #26325A; border-radius: 4px; }
.op-scroll::-webkit-scrollbar-track { background: transparent; }
@keyframes opPulse { 0% { box-shadow: 0 0 0 0 rgba(245,185,66,0.55); } 70% { box-shadow: 0 0 0 8px rgba(245,185,66,0); } 100% { box-shadow: 0 0 0 0 rgba(245,185,66,0); } }
.op-new-pulse { animation: opPulse 1.8s infinite; }
.op-card-hover { transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease; }
.op-card-hover:hover { transform: translateY(-2px); box-shadow: 0 6px 18px rgba(0,0,0,0.35); }
.op-type-btn { transition: transform 0.12s ease, border-color 0.12s ease, background 0.12s ease; }
.op-type-btn:hover { transform: translateY(-2px); border-color: #3D6BFF !important; }
@keyframes opFadeIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
.op-fade-in { animation: opFadeIn 0.3s ease; }
@keyframes opSpin { to { transform: rotate(360deg); } }
.op-spin { animation: opSpin 0.9s linear infinite; }`;

// ---------- Static business data (not stored in DB) ----------
const STAGE_ORDER = ["Lead", "Follow up", "R1", "R2", "Em Decisão", "Closed", "Em Onboarding", "Entrega de Serviço"];
const LOST_STAGE = "Não Quer Avançar";
const STAGE_COLUMNS = [...STAGE_ORDER, LOST_STAGE];
const STRIPE_COLORS = ["#2ED8A7", "#F5B942", "#E8734A", "#8B7CF6", "#3D6BFF"];
function hashId(id) {
  const s = String(id);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
const stripeFor = (id) => STRIPE_COLORS[hashId(id) % STRIPE_COLORS.length];
const OP_STAGES = ["Recebido", "Em Análise", "Em Execução", "Em Validação", "Concluído"];
const STAGE_META = {
  "Recebido": { color: "#3D6BFF", icon: "📥" },
  "Em Análise": { color: "#F5B942", icon: "🔍" },
  "Em Execução": { color: "#8B7CF6", icon: "⚙️" },
  "Em Validação": { color: "#2DC7D8", icon: "🧐" },
  "Concluído": { color: "#2ED8A7", icon: "🎉" },
};
const PRESET_TYPES = ["Nova Angariação", "CPCV", "Preparação de Escritura", "Factura", "Alteração de Anúncio", "Atualização de Documentação", "Relatório Financeiro", "Suporte Técnico"];
const TYPE_ICONS = {
  "Nova Angariação": "🏠", "CPCV": "📝", "Preparação de Escritura": "⚖️", "Factura": "🧾",
  "Alteração de Anúncio": "📢", "Campanha de Marketing": "📣", "Atualização de Documentação": "📁", "Relatório Financeiro": "📊",
  "Suporte Técnico": "🛠️", "Pedido Aberto": "💬",
};
const ACTIVE_STAGES = ["Em Onboarding", "Entrega de Serviço"];
const WON_STAGES = ["Closed", "Em Onboarding", "Entrega de Serviço"];
const ACTIVITY_TYPES = ["Chamada", "Reunião", "Email", "Tarefa"];

const today = new Date();

const PERIODS = [
  { key: "dia", label: "Dia", days: 1 },
  { key: "semana", label: "Semana", days: 7 },
  { key: "mes", label: "Mês", days: 30 },
  { key: "trimestre", label: "Trimestre", days: 90 },
  { key: "semestre", label: "Semestre", days: 182 },
  { key: "ano", label: "Ano", days: 365 },
];

function withinPeriod(date, days) {
  return (today - date) / (1000 * 60 * 60 * 24) <= days;
}

const CAN_DRAG = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(pointer: fine)").matches;

// ---------- Helpers ----------
const fmtEUR = (n) => Number(n || 0).toLocaleString("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const fmtDate = (d) => d.toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit" });
const fmtDateTime = (d) => `${d.toLocaleDateString("pt-PT")} ${d.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" })}`;
const pedidoTitle = (p) => (p.type === "Pedido Aberto" ? (p.customTitle || "Pedido Aberto") : p.type);
const safeStorageName = (name) => name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9.\-_]/g, "_");

// ================= DATA LAYER (Supabase) =================
const PEDIDO_SELECT = "*, clients(id,name), pedido_tasks(*), pedido_notes(*), pedido_attachments(*), pedido_mensagens(*)";

function mapDeal(row) {
  return {
    id: row.id, clientId: row.client_id, name: row.name, contact: row.contact,
    value: Number(row.value) || 0, stage: row.stage, owner: row.owner,
    date: new Date(row.created_at), stageEnteredAt: new Date(row.stage_entered_at),
    closedAt: row.closed_at ? new Date(row.closed_at) : null,
  };
}
function dealStagePatch(stage) {
  const patch = { stage, stage_entered_at: new Date().toISOString() };
  if (stage === "Closed") patch.closed_at = new Date().toISOString();
  return patch;
}
function mapClientNote(row) {
  return { id: row.id, text: row.text, pinned: row.pinned, date: new Date(row.created_at) };
}
function mapActivity(row) {
  return { id: row.id, type: row.type, text: row.text, due: row.due, done: row.done };
}
function mapPedido(row) {
  const tasks = (row.pedido_tasks || []).slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const notes = (row.pedido_notes || []).slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const attachments = (row.pedido_attachments || []).slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const messages = (row.pedido_mensagens || []).slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return {
    id: row.id,
    client: row.clients ? row.clients.name : "",
    clientId: row.client_id,
    type: row.type,
    customTitle: row.custom_title || "",
    description: row.description || "",
    propertyId: row.property_id || "",
    stage: row.stage,
    owner: row.owner,
    due: row.due ? new Date(row.due) : today,
    seen: row.seen,
    clientSeen: row.client_seen !== false,
    createdAt: row.created_at ? new Date(row.created_at) : today,
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    tasks: tasks.map((t) => ({ id: t.id, text: t.text, done: t.done })),
    notes: notes.map((n) => ({ id: n.id, text: n.text, date: new Date(n.created_at) })),
    attachments: attachments.map((a) => ({ id: a.id, name: a.name, storagePath: a.storage_path, uploadedBy: a.uploaded_by })),
    messages: messages.map((m) => ({ id: m.id, sender: m.sender, text: m.text, date: new Date(m.created_at) })),
  };
}

const db = {
  // -- auth / profile --
  async getProfile(userId) {
    const { data, error } = await sb.from("profiles").select("*").eq("id", userId).single();
    if (error) throw error;
    return data;
  },

  // -- clients --
  async listClients() {
    const { data, error } = await sb.from("clients").select("*").order("name");
    if (error) throw error;
    return data;
  },
  async getClient(id) {
    const { data, error } = await sb.from("clients").select("*").eq("id", id).single();
    if (error) throw error;
    return data;
  },
  async createClient(payload) {
    const { data, error } = await sb.from("clients").insert(payload).select().single();
    if (error) throw error;
    return data;
  },
  async updateClient(id, patch) {
    const { error } = await sb.from("clients").update(patch).eq("id", id);
    if (error) throw error;
  },

  // -- deals --
  async listDeals() {
    const { data, error } = await sb.from("deals").select("*").order("created_at");
    if (error) throw error;
    return data.map(mapDeal);
  },
  async createDeal(payload) {
    const { data, error } = await sb.from("deals").insert(payload).select().single();
    if (error) throw error;
    return mapDeal(data);
  },
  async updateDeal(id, patch) {
    const { error } = await sb.from("deals").update(patch).eq("id", id);
    if (error) throw error;
  },

  // -- pedidos --
  pedidosQuery() {
    return sb.from("pedidos").select(PEDIDO_SELECT)
      .order("created_at", { ascending: false, foreignTable: "pedido_notes" })
      .order("created_at", { ascending: true, foreignTable: "pedido_mensagens" })
      .order("created_at", { ascending: true, foreignTable: "pedido_tasks" })
      .order("created_at", { ascending: false });
  },
  async listPedidos() {
    const { data, error } = await this.pedidosQuery();
    if (error) throw error;
    return data.map(mapPedido);
  },
  async listPedidosForClient(clientId) {
    const { data, error } = await this.pedidosQuery().eq("client_id", clientId);
    if (error) throw error;
    return data.map(mapPedido);
  },
  async createPedido(payload) {
    const { data, error } = await sb.from("pedidos").insert(payload).select().single();
    if (error) throw error;
    return data;
  },
  async updatePedidoStage(id, stage) {
    const patch = { stage, completed_at: stage === "Concluído" ? new Date().toISOString() : null };
    const { error } = await sb.from("pedidos").update(patch).eq("id", id);
    if (error) throw error;
  },
  async updatePedidoFields(id, patch) {
    const dbPatch = {};
    if ("customTitle" in patch) dbPatch.custom_title = patch.customTitle;
    if ("propertyId" in patch) dbPatch.property_id = patch.propertyId;
    const { error } = await sb.from("pedidos").update(dbPatch).eq("id", id);
    if (error) throw error;
  },
  async markPedidoSeen(id) {
    const { error } = await sb.from("pedidos").update({ seen: true }).eq("id", id);
    if (error) throw error;
  },
  async markPedidoClientSeen(id) {
    const { error } = await sb.from("pedidos").update({ client_seen: true }).eq("id", id);
    if (error) throw error;
  },

  // -- pedido tasks / notes / messages / attachments --
  async addTask(pedidoId, text) {
    const { error } = await sb.from("pedido_tasks").insert({ pedido_id: pedidoId, text });
    if (error) throw error;
  },
  async toggleTask(taskId, done) {
    const { error } = await sb.from("pedido_tasks").update({ done }).eq("id", taskId);
    if (error) throw error;
  },
  async removeTask(taskId) {
    const { error } = await sb.from("pedido_tasks").delete().eq("id", taskId);
    if (error) throw error;
  },
  async addNote(pedidoId, text) {
    const { error } = await sb.from("pedido_notes").insert({ pedido_id: pedidoId, text });
    if (error) throw error;
  },
  async sendMessage(pedidoId, sender, text) {
    const { error } = await sb.from("pedido_mensagens").insert({ pedido_id: pedidoId, sender, text });
    if (error) throw error;
  },
  async removeMessage(id) {
    const { error } = await sb.from("pedido_mensagens").delete().eq("id", id);
    if (error) throw error;
  },
  async uploadAttachment(pedidoId, file, uploadedBy) {
    const path = `${pedidoId}/${Date.now()}_${safeStorageName(file.name)}`;
    const { error: upErr } = await sb.storage.from("attachments").upload(path, file);
    if (upErr) throw upErr;
    const { error } = await sb.from("pedido_attachments").insert({ pedido_id: pedidoId, name: file.name, storage_path: path, uploaded_by: uploadedBy });
    if (error) throw error;
  },
  async removeAttachment(id, storagePath) {
    const { error: rmErr } = await sb.storage.from("attachments").remove([storagePath]);
    if (rmErr) throw rmErr;
    const { error } = await sb.from("pedido_attachments").delete().eq("id", id);
    if (error) throw error;
  },
  async getAttachmentUrl(path) {
    const { data, error } = await sb.storage.from("attachments").createSignedUrl(path, 600, { download: true });
    if (error) throw error;
    return data.signedUrl;
  },

  // -- client notes / activities (ficha de cliente) --
  async listClientNotes(clientId) {
    const { data, error } = await sb.from("client_notes").select("*").eq("client_id", clientId).order("created_at", { ascending: false });
    if (error) throw error;
    return data.map(mapClientNote);
  },
  async addClientNote(clientId, text) {
    const { data, error } = await sb.from("client_notes").insert({ client_id: clientId, text }).select().single();
    if (error) throw error;
    return mapClientNote(data);
  },
  async toggleClientNotePin(id, pinned) {
    const { error } = await sb.from("client_notes").update({ pinned }).eq("id", id);
    if (error) throw error;
  },
  async removeClientNote(id) {
    const { error } = await sb.from("client_notes").delete().eq("id", id);
    if (error) throw error;
  },
  async listClientActivities(clientId) {
    const { data, error } = await sb.from("client_activities").select("*").eq("client_id", clientId).order("created_at", { ascending: false });
    if (error) throw error;
    return data.map(mapActivity);
  },
  async addClientActivity(clientId, payload) {
    const { data, error } = await sb.from("client_activities").insert({ client_id: clientId, ...payload }).select().single();
    if (error) throw error;
    return mapActivity(data);
  },
  async toggleClientActivity(id, done) {
    const { error } = await sb.from("client_activities").update({ done }).eq("id", id);
    if (error) throw error;
  },
  async removeClientActivity(id) {
    const { error } = await sb.from("client_activities").delete().eq("id", id);
    if (error) throw error;
  },

  // -- portal access (profiles <-> clients) --
  async listProfilesByClient(clientId) {
    const { data, error } = await sb.from("profiles").select("*").eq("client_id", clientId);
    if (error) throw error;
    return data;
  },
  async listClientInvites(clientId) {
    const { data, error } = await sb.from("client_invites").select("*").eq("client_id", clientId).order("created_at", { ascending: false });
    if (error) throw error;
    return data;
  },
  async inviteClientEmail(clientId, email) {
    const normalized = email.trim().toLowerCase();
    const { data: existing, error: findErr } = await sb.from("profiles").select("id, client_id").ilike("email", normalized).maybeSingle();
    if (findErr) throw findErr;
    if (existing) {
      const { error } = await sb.from("profiles").update({ client_id: clientId }).eq("id", existing.id);
      if (error) throw error;
      return { linked: true };
    }
    const { error } = await sb.from("client_invites").upsert({ client_id: clientId, email: normalized }, { onConflict: "email" });
    if (error) throw error;
    return { linked: false };
  },
  async removeClientInvite(id) {
    const { error } = await sb.from("client_invites").delete().eq("id", id);
    if (error) throw error;
  },

  // -- financeiro (despesas / receitas / extrato bancário) --
  async listDespesas(clientId) {
    const { data, error } = await sb.from("financeiro_despesas").select("*").eq("client_id", clientId).order("date", { ascending: false });
    if (error) throw error;
    return data;
  },
  async addDespesa(payload) {
    const { data, error } = await sb.from("financeiro_despesas").insert(payload).select().single();
    if (error) throw error;
    return data;
  },
  async updateDespesaRubrica(id, rubrica) {
    const { error } = await sb.from("financeiro_despesas").update({ rubrica }).eq("id", id);
    if (error) throw error;
  },
  async removeDespesa(id) {
    const { error } = await sb.from("financeiro_despesas").delete().eq("id", id);
    if (error) throw error;
  },
  async listReceitas(clientId) {
    const { data, error } = await sb.from("financeiro_receitas").select("*").eq("client_id", clientId).order("date", { ascending: false });
    if (error) throw error;
    return data;
  },
  async addReceita(payload) {
    const { data, error } = await sb.from("financeiro_receitas").insert(payload).select().single();
    if (error) throw error;
    return data;
  },
  async removeReceita(id) {
    const { error } = await sb.from("financeiro_receitas").delete().eq("id", id);
    if (error) throw error;
  },
  async listExtrato(clientId) {
    const { data, error } = await sb.from("financeiro_extrato").select("*").eq("client_id", clientId).order("date", { ascending: false });
    if (error) throw error;
    return data;
  },
  async addExtratoRows(rows) {
    const { error } = await sb.from("financeiro_extrato").insert(rows);
    if (error) throw error;
  },
  async confirmExtrato(id) {
    const { error } = await sb.from("financeiro_extrato").update({ status: "reconciliado" }).eq("id", id);
    if (error) throw error;
  },
  async removeExtrato(id) {
    const { error } = await sb.from("financeiro_extrato").delete().eq("id", id);
    if (error) throw error;
  },
  async iniciarRelatorioFinanceiro(clientId, ano, mes) {
    const { data, error } = await sb.rpc("iniciar_relatorio_financeiro", { p_client_id: clientId, p_ano: ano, p_mes: mes });
    if (error) throw error;
    return data;
  },
  async checkRelatorioStatus(id) {
    const { data, error } = await sb.from("financeiro_relatorios").select("*").eq("id", id).single();
    if (error) throw error;
    return data;
  },
  async uploadFinanceiroDoc(clientId, tipo, file) {
    const path = `${clientId}/${Date.now()}_${safeStorageName(file.name)}`;
    const { error: upErr } = await sb.storage.from("financeiro-docs").upload(path, file);
    if (upErr) throw upErr;
    const { data: signedData, error: signErr } = await sb.storage.from("financeiro-docs").createSignedUrl(path, 900);
    if (signErr) throw signErr;
    const mimeType = file.type || "application/pdf";
    let row;
    if (tipo === "custo") {
      const { data, error } = await sb.from("financeiro_despesas").insert({
        client_id: clientId, date: finDateStr(new Date()), vendor: "A processar…", rubrica: "Outros",
        amount: 0.01, source: "upload", storage_path: path, status: "processando",
      }).select().single();
      if (error) throw error;
      row = data;
    } else {
      const { data, error } = await sb.from("financeiro_receitas").insert({
        client_id: clientId, date: finDateStr(new Date()), description: "A processar…",
        amount: 0.01, source: "upload", storage_path: path, status: "processando",
      }).select().single();
      if (error) throw error;
      row = data;
    }
    const { error: rpcErr } = await sb.rpc("iniciar_leitura_documento", {
      p_row_id: row.id, p_tipo: tipo, p_mime_type: mimeType, p_file_url: signedData.signedUrl,
    });
    if (rpcErr) throw rpcErr;
    return row;
  },
  async checkDocStatus(tipo, id) {
    const table = tipo === "custo" ? "financeiro_despesas" : "financeiro_receitas";
    const { data, error } = await sb.from(table).select("*").eq("id", id).single();
    if (error) throw error;
    return data;
  },
};

// ---------- Shared UI atoms ----------
function MetricCard({ label, value, sub, color, icon }) {
  return (
    <div className="op-card-hover" style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "16px 18px", minWidth: 140, flex: "1 1 150px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.muted, fontFamily: "Inter, sans-serif", marginBottom: 6 }}>
        {icon && <span style={{ fontSize: 13 }}>{icon}</span>}{label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 800, color: color || C.text, fontFamily: "Manrope, sans-serif" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function DealCard({ deal, onDragStart, onOpen, onAdvance, isLast }) {
  const daysInStage = Math.floor((today - deal.stageEnteredAt) / (1000 * 60 * 60 * 24));
  const isStale = daysInStage > 10 && deal.stage !== "Closed" && deal.stage !== LOST_STAGE;
  return (
    <div draggable={CAN_DRAG} onDragStart={(e) => onDragStart(e, deal.id)} onClick={() => onOpen(deal)} className="op-card-hover"
      style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 8, cursor: "pointer", overflow: "hidden" }}>
      <div style={{ height: 4, background: stripeFor(deal.id) }} />
      <div style={{ padding: "10px 12px" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, fontFamily: "Inter, sans-serif" }}>{deal.name}</div>
        {deal.contact && deal.contact !== deal.name && <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{deal.contact}</div>}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
          <span style={{ fontSize: 12, color: C.accent, fontWeight: 600 }}>{fmtEUR(deal.value)}/mês</span>
          <span style={{ fontSize: 11, color: C.muted }}>{deal.owner}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
          <span style={{ fontSize: 10, color: isStale ? C.amber : C.muted, display: "flex", alignItems: "center", gap: 4 }}>
            {isStale && "⚠️"} {daysInStage}d na etapa
          </span>
          {!isLast && deal.stage !== LOST_STAGE && (
            <span onClick={(e) => { e.stopPropagation(); onAdvance(deal.id); }} title="Avançar etapa"
              style={{ cursor: "pointer", color: C.muted, fontSize: 14, background: C.surface, borderRadius: "50%", width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center" }}>
              ›
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function PedidoCard({ pedido, onDragStart, onOpen }) {
  const overdue = pedido.due < today && pedido.stage !== "Concluído";
  const doneTasks = pedido.tasks.filter((t) => t.done).length;
  const isNew = pedido.seen === false;
  const meta = STAGE_META[pedido.stage];
  return (
    <div draggable={CAN_DRAG} onDragStart={(e) => onDragStart(e, pedido.id)} onClick={() => onOpen(pedido.id)}
      className={`op-card-hover${isNew ? " op-new-pulse" : ""}`}
      style={{
        background: C.surfaceRaised, borderRadius: 8, padding: "10px 12px", marginBottom: 8, cursor: "pointer",
        border: isNew ? `1.5px solid ${C.amber}` : `1px solid ${C.border}`, borderLeftWidth: 3, borderLeftColor: meta.color, position: "relative",
      }}>
      {isNew && (
        <span style={{ position: "absolute", top: -8, right: 8, background: C.amber, color: "#1a1400", fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 4, letterSpacing: 0.5 }}>
          NOVO
        </span>
      )}
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 3 }}>{pedido.client}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: C.text, fontFamily: "Inter, sans-serif", display: "flex", alignItems: "center", gap: 5 }}>
        <span style={{ fontSize: 12 }}>{TYPE_ICONS[pedido.type] || "📄"}</span>{pedidoTitle(pedido)}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
        <span style={{ fontSize: 11, color: overdue ? C.red : C.muted }}>Prazo: {fmtDate(pedido.due)}</span>
        <span style={{ fontSize: 11, color: C.muted }}>{pedido.owner}</span>
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
        {pedido.propertyId && <span style={{ fontSize: 10, color: C.green }}>🏠 {pedido.propertyId}</span>}
        {pedido.tasks.length > 0 && <span style={{ fontSize: 10, color: C.accent }}>✓ {doneTasks}/{pedido.tasks.length}</span>}
        {pedido.notes.length > 0 && <span style={{ fontSize: 10, color: C.muted }}>{pedido.notes.length} nota{pedido.notes.length > 1 ? "s" : ""}</span>}
        {pedido.messages.length > 0 && <span style={{ fontSize: 10, color: C.amber }}>💬 {pedido.messages.length}</span>}
      </div>
    </div>
  );
}

function ChatThread({ messages, onSend, senderRole, onDelete }) {
  const [text, setText] = useState("");
  const send = () => { if (!text.trim()) return; onSend(text.trim()); setText(""); };
  return (
    <div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12, maxHeight: 280, overflowY: "auto" }}>
        {messages.length === 0 && <div style={{ fontSize: 12, color: C.muted }}>Ainda sem mensagens.</div>}
        {messages.map((m) => {
          const mine = m.sender === senderRole;
          const avatar = m.sender === "cliente" ? "🧑" : "🏢";
          return (
            <div key={m.id} style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start", gap: 8, flexDirection: mine ? "row-reverse" : "row", alignItems: "flex-start" }}>
              <div style={{ width: 24, height: 24, borderRadius: "50%", background: mine ? C.accent : C.surfaceRaised, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, flexShrink: 0 }}>{avatar}</div>
              <div style={{ maxWidth: "75%", background: mine ? C.accent : C.surfaceRaised, color: mine ? "#fff" : C.text, borderRadius: 10, padding: "8px 11px", position: "relative" }}>
                <div style={{ fontSize: 10, opacity: 0.75, marginBottom: 3 }}>{m.sender === "cliente" ? "Cliente" : "Equipa OPERA"}</div>
                <div style={{ fontSize: 13 }}>{m.text}</div>
                <div style={{ fontSize: 9, opacity: 0.6, marginTop: 3 }}>{fmtDateTime(m.date)}</div>
              </div>
              {onDelete && (
                <span onClick={() => onDelete(m)} title="Apagar mensagem"
                  style={{ cursor: "pointer", color: C.muted, fontSize: 13, flexShrink: 0, marginTop: 4 }}>×</span>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Escrever mensagem..." style={{ flex: 1, background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13 }} />
        <button onClick={send} style={{ background: C.accent, border: "none", borderRadius: 6, padding: "8px 14px", color: "#fff", fontSize: 13, cursor: "pointer" }}>Enviar</button>
      </div>
    </div>
  );
}

function SectionTitle({ children }) {
  return <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 10, marginTop: 4 }}>{children}</div>;
}

function SidePanel({ onClose, eyebrow, width = 380, children }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(4,7,16,0.6)", display: "flex", justifyContent: "flex-end", zIndex: 1000 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width, maxWidth: "90%", height: "100%", background: C.surface, borderLeft: `1px solid ${C.border}`, padding: 22, overflowY: "auto", fontFamily: "Inter, sans-serif" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
          <div style={{ fontSize: 11, color: C.muted }}>{eyebrow}</div>
          <span onClick={onClose} style={{ cursor: "pointer", color: C.muted, fontSize: 18, lineHeight: 1 }}>×</span>
        </div>
        {children}
      </div>
    </div>
  );
}

// Full-page detail view (replaces the current nav page's content, with a breadcrumb back link)
function PageBack({ onClose, eyebrow, maxWidth = 760, children }) {
  return (
    <div className="op-fade-in" style={{ maxWidth, fontFamily: "Inter, sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
        <span onClick={onClose} style={{ cursor: "pointer", color: C.accent, fontSize: 13, fontWeight: 600 }}>← Voltar</span>
        {eyebrow && (
          <>
            <span style={{ color: C.border }}>/</span>
            <span style={{ fontSize: 13, color: C.muted }}>{eyebrow}</span>
          </>
        )}
      </div>
      {children}
    </div>
  );
}

// Title (editable for "Pedido Aberto") + optional property-id editor
function PedidoHeader({ pedido, onUpdateHeader }) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(pedidoTitle(pedido));
  const [editingProp, setEditingProp] = useState(false);
  const [propDraft, setPropDraft] = useState(pedido.propertyId);

  const saveTitle = () => { onUpdateHeader({ customTitle: titleDraft.trim() || "Pedido Aberto" }); setEditingTitle(false); };
  const saveProp = () => { onUpdateHeader({ propertyId: propDraft.trim() }); setEditingProp(false); };

  return (
    <>
      {editingTitle ? (
        <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
          <input value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} autoFocus
            style={{ flex: 1, background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 10px", color: C.text, fontSize: 15, fontFamily: "Manrope, sans-serif", fontWeight: 700 }} />
          <button onClick={saveTitle} style={{ background: C.accent, border: "none", borderRadius: 6, padding: "0 12px", color: "#fff", fontSize: 12, cursor: "pointer" }}>OK</button>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <div style={{ fontFamily: "Manrope, sans-serif", fontWeight: 800, fontSize: 18, color: C.text }}>{pedidoTitle(pedido)}</div>
          {pedido.type === "Pedido Aberto" && (
            <span onClick={() => { setTitleDraft(pedidoTitle(pedido)); setEditingTitle(true); }} style={{ cursor: "pointer", fontSize: 13, color: C.muted }}>✎</span>
          )}
        </div>
      )}

      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>ID do Imóvel</div>
        {editingProp ? (
          <div style={{ display: "flex", gap: 6 }}>
            <input value={propDraft} onChange={(e) => setPropDraft(e.target.value)} autoFocus placeholder="ex. LX-231"
              style={{ flex: 1, background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 10px", color: C.text, fontSize: 13 }} />
            <button onClick={saveProp} style={{ background: C.accent, border: "none", borderRadius: 6, padding: "0 12px", color: "#fff", fontSize: 12, cursor: "pointer" }}>OK</button>
          </div>
        ) : pedido.propertyId ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, color: C.text, background: C.surfaceRaised, borderRadius: 6, padding: "4px 10px" }}>🏠 {pedido.propertyId}</span>
            <span onClick={() => { setPropDraft(pedido.propertyId); setEditingProp(true); }} style={{ cursor: "pointer", fontSize: 12, color: C.muted }}>✎</span>
          </div>
        ) : (
          <span onClick={() => { setPropDraft(""); setEditingProp(true); }} style={{ cursor: "pointer", fontSize: 12, color: C.accent }}>+ Adicionar ID do imóvel</span>
        )}
      </div>
    </>
  );
}

// ---------- Internal pedido detail (tasks + notes + chat) ----------
function PedidoDetailInternal({ pedido, onClose, onReload }) {
  const [newTask, setNewTask] = useState("");
  const [newNote, setNewNote] = useState("");

  const run = async (fn) => { try { await fn(); await onReload(); } catch (e) { alert(e.message); } };

  const addTask = () => { if (!newTask.trim()) return; const text = newTask.trim(); setNewTask(""); run(() => db.addTask(pedido.id, text)); };
  const toggleTask = (t) => run(() => db.toggleTask(t.id, !t.done));
  const removeTask = (id) => run(() => db.removeTask(id));
  const addNote = () => { if (!newNote.trim()) return; const text = newNote.trim(); setNewNote(""); run(() => db.addNote(pedido.id, text)); };
  const sendMessage = (text) => run(() => db.sendMessage(pedido.id, "equipa", text));
  const openAttachment = (a) => db.getAttachmentUrl(a.storagePath).then((url) => window.open(url, "_blank")).catch((e) => alert(e.message));
  const uploadFiles = (e) => {
    const chosen = Array.from(e.target.files || []);
    e.target.value = "";
    chosen.forEach((file) => run(() => db.uploadAttachment(pedido.id, file, "equipa")));
  };
  const removeAttachment = (a) => { if (window.confirm(`Apagar "${a.name}"?`)) run(() => db.removeAttachment(a.id, a.storagePath)); };
  const removeMessage = (m) => { if (window.confirm("Apagar esta mensagem?")) run(() => db.removeMessage(m.id)); };

  return (
    <PageBack onClose={onClose} eyebrow={pedido.client} maxWidth={820}>
      <PedidoHeader pedido={pedido} onUpdateHeader={(patch) => run(() => db.updatePedidoFields(pedido.id, patch))} />

      <div style={{ display: "flex", gap: 16, marginBottom: 20, fontSize: 12, color: C.muted, flexWrap: "wrap" }}>
        <div><div style={{ marginBottom: 2 }}>Estado</div><div style={{ color: C.text }}>{pedido.stage}</div></div>
        <div><div style={{ marginBottom: 2 }}>Responsável</div><div style={{ color: C.text }}>{pedido.owner}</div></div>
        <div><div style={{ marginBottom: 2 }}>Prazo</div><div style={{ color: C.text }}>{fmtDateTime(pedido.due)}</div></div>
      </div>

      {pedido.description && (
        <>
          <SectionTitle>Descrição do pedido</SectionTitle>
          <div style={{ fontSize: 13, color: C.text, background: C.surfaceRaised, borderRadius: 8, padding: 10, marginBottom: 18 }}>{pedido.description}</div>
        </>
      )}

      <SectionTitle>Ficheiros</SectionTitle>
      {pedido.attachments.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
          {pedido.attachments.map((a) => (
            <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.text, background: C.surfaceRaised, borderRadius: 8, padding: "8px 10px" }}>
              <span onClick={() => openAttachment(a)} style={{ flex: 1, cursor: "pointer" }}>📎 {a.name}</span>
              <span onClick={() => removeAttachment(a)} title="Apagar ficheiro" style={{ cursor: "pointer", color: C.muted, fontSize: 14 }}>×</span>
            </div>
          ))}
        </div>
      )}
      <label className="op-type-btn" style={{
        display: "inline-flex", alignItems: "center", gap: 6, border: `1.5px dashed ${C.border}`, borderRadius: 8,
        padding: "8px 12px", cursor: "pointer", color: C.muted, fontSize: 12, marginBottom: 18,
      }}>
        📎 Adicionar ficheiro
        <input type="file" multiple onChange={uploadFiles} style={{ display: "none" }} />
      </label>

      <SectionTitle>Tarefas</SectionTitle>
      {pedido.tasks.map((t) => (
        <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <input type="checkbox" checked={t.done} onChange={() => toggleTask(t)} />
          <span style={{ flex: 1, fontSize: 13, color: t.done ? C.muted : C.text, textDecoration: t.done ? "line-through" : "none" }}>{t.text}</span>
          <span onClick={() => removeTask(t.id)} style={{ cursor: "pointer", color: C.muted, fontSize: 14 }}>×</span>
        </div>
      ))}
      <div style={{ display: "flex", gap: 6, marginTop: 8, marginBottom: 22 }}>
        <input value={newTask} onChange={(e) => setNewTask(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTask()}
          placeholder="Nova tarefa..." style={{ flex: 1, background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 10px", color: C.text, fontSize: 13 }} />
        <button onClick={addTask} style={{ background: C.accent, border: "none", borderRadius: 6, padding: "6px 12px", color: "#fff", fontSize: 13, cursor: "pointer" }}>+</button>
      </div>

      <SectionTitle>Notas internas</SectionTitle>
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        <textarea value={newNote} onChange={(e) => setNewNote(e.target.value)} placeholder="Escrever uma nota..." rows={2}
          style={{ flex: 1, background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 10px", color: C.text, fontSize: 13, resize: "vertical" }} />
      </div>
      <button onClick={addNote} style={{ background: C.accentSoft, border: `1px solid ${C.accent}`, borderRadius: 6, padding: "6px 12px", color: C.text, fontSize: 12, cursor: "pointer", marginBottom: 16 }}>
        Adicionar nota
      </button>
      {pedido.notes.map((n) => (
        <div key={n.id} style={{ background: C.surfaceRaised, borderRadius: 8, padding: "10px 12px", marginBottom: 8 }}>
          <div style={{ fontSize: 13, color: C.text, marginBottom: 4 }}>{n.text}</div>
          <div style={{ fontSize: 10, color: C.muted }}>{fmtDateTime(n.date)}</div>
        </div>
      ))}

      <SectionTitle>Conversa com o cliente</SectionTitle>
      <ChatThread messages={pedido.messages} onSend={sendMessage} senderRole="equipa" onDelete={removeMessage} />
    </PageBack>
  );
}

// ---------- Client-facing pedido detail (stage tracker + chat only) ----------
function PedidoDetailClient({ pedido, onClose, onReload }) {
  const run = async (fn) => { try { await fn(); await onReload(); } catch (e) { alert(e.message); } };
  const sendMessage = (text) => run(() => db.sendMessage(pedido.id, "cliente", text));
  const openAttachment = (a) => db.getAttachmentUrl(a.storagePath).then((url) => window.open(url, "_blank")).catch((e) => alert(e.message));
  const uploadFiles = (e) => {
    const chosen = Array.from(e.target.files || []);
    e.target.value = "";
    chosen.forEach((file) => run(() => db.uploadAttachment(pedido.id, file, "cliente")));
  };
  const currentIndex = OP_STAGES.indexOf(pedido.stage);

  return (
    <PageBack onClose={onClose} eyebrow={pedido.client} maxWidth={820}>
      <PedidoHeader pedido={pedido} onUpdateHeader={(patch) => run(() => db.updatePedidoFields(pedido.id, patch))} />

      <SectionTitle>Estado do pedido</SectionTitle>
      <div style={{ display: "flex", alignItems: "flex-start", marginBottom: 18 }}>
        {OP_STAGES.map((s, i) => {
          const meta = STAGE_META[s];
          const reached = i <= currentIndex;
          const isCurrent = i === currentIndex;
          return (
            <React.Fragment key={s}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }}>
                <div style={{
                  width: 32, height: 32, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14,
                  background: reached ? meta.color : C.surfaceRaised, border: `2px solid ${reached ? meta.color : C.border}`,
                  boxShadow: isCurrent ? `0 0 0 5px ${meta.color}33` : "none", transition: "all 0.3s",
                }}>
                  {reached ? (i < currentIndex ? "✓" : meta.icon) : ""}
                </div>
                <div style={{ fontSize: 9, fontWeight: isCurrent ? 700 : 500, color: reached ? meta.color : C.muted, marginTop: 6, textAlign: "center", lineHeight: 1.25 }}>{s}</div>
              </div>
              {i < OP_STAGES.length - 1 && <div style={{ flex: 1, height: 3, borderRadius: 2, background: i < currentIndex ? STAGE_META[s].color : C.border, marginTop: 15, transition: "background 0.3s" }} />}
            </React.Fragment>
          );
        })}
      </div>

      <div className="op-fade-in" style={{
        background: `${STAGE_META[pedido.stage].color}1c`, border: `1px solid ${STAGE_META[pedido.stage].color}55`, borderRadius: 8,
        padding: "10px 12px", marginBottom: 20, display: "flex", alignItems: "center", gap: 10,
      }}>
        <span style={{ fontSize: 18 }}>{STAGE_META[pedido.stage].icon}</span>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: STAGE_META[pedido.stage].color }}>{pedido.stage}</div>
          <div style={{ fontSize: 11, color: C.muted }}>Prazo previsto: {fmtDateTime(pedido.due)}</div>
        </div>
      </div>

      {pedido.description && (
        <>
          <SectionTitle>A sua descrição</SectionTitle>
          <div style={{ fontSize: 13, color: C.text, background: C.surfaceRaised, borderRadius: 8, padding: 10, marginBottom: 18 }}>{pedido.description}</div>
        </>
      )}

      <SectionTitle>Ficheiros</SectionTitle>
      {pedido.attachments.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
          {pedido.attachments.map((a) => (
            <div key={a.id} onClick={() => openAttachment(a)} style={{ fontSize: 13, color: C.text, background: C.surfaceRaised, borderRadius: 8, padding: "8px 10px", cursor: "pointer" }}>📎 {a.name}</div>
          ))}
        </div>
      )}
      <label className="op-type-btn" style={{
        display: "inline-flex", alignItems: "center", gap: 6, border: `1.5px dashed ${C.border}`, borderRadius: 8,
        padding: "8px 12px", cursor: "pointer", color: C.muted, fontSize: 12, marginBottom: 18,
      }}>
        📎 Adicionar ficheiro
        <input type="file" multiple onChange={uploadFiles} style={{ display: "none" }} />
      </label>

      <SectionTitle>Conversa com a OPERA</SectionTitle>
      <ChatThread messages={pedido.messages} onSend={sendMessage} senderRole="cliente" />
    </PageBack>
  );
}

// ---------- Financeiro (P&L do cliente, gerido pela equipa OPERA) ----------
const fmtEURDec = (n) => Number(n || 0).toLocaleString("pt-PT", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
function finFileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
const FIN_RUBRICAS = [
  { name: "Manutenção", color: "#8B7CF6", icon: "🔧" },
  { name: "Condomínio", color: "#2DC7D8", icon: "🏢" },
  { name: "Seguros", color: "#F5B942", icon: "🛡️" },
  { name: "Limpeza", color: "#2ED8A7", icon: "🧹" },
  { name: "Marketing", color: "#E8734A", icon: "📣" },
  { name: "Impostos", color: "#F2617A", icon: "🧾" },
  { name: "Utilities", color: "#6B7CA0", icon: "💡" },
  { name: "Tecnologia", color: "#3D6BFF", icon: "💻" },
  { name: "Equipamentos", color: "#FB923C", icon: "🧰" },
  { name: "Material de Escritório", color: "#94A3B8", icon: "🗂️" },
  { name: "Outros", color: "#6B7CA0", icon: "📦" },
];
const finRubricaFor = (name) => FIN_RUBRICAS.find((r) => r.name === name) || FIN_RUBRICAS[FIN_RUBRICAS.length - 1];
const finParseDate = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const finDateStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const finMesesAbrev = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const FIN_PERIODS = [
  { key: "dia", label: "Dia" }, { key: "semana", label: "Semana" }, { key: "mes", label: "Mês" },
  { key: "trimestre", label: "Trimestre" }, { key: "semestre", label: "Semestre" }, { key: "ano", label: "Ano" },
];
const FIN_BUCKET_COUNT = { dia: 14, semana: 10, mes: 12, trimestre: 8, semestre: 6, ano: 3 };
function finIsoWeek(d) {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  return Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);
}
function finBucketInfo(d, granularity) {
  const y = d.getFullYear(), m = d.getMonth();
  if (granularity === "dia") return { key: `${y}-${m}-${d.getDate()}`, label: fmtDate(d) };
  if (granularity === "semana") { const w = finIsoWeek(d); return { key: `${y}-W${w}`, label: `S${w}` }; }
  if (granularity === "mes") return { key: `${y}-${m}`, label: `${finMesesAbrev[m]} ${String(y).slice(2)}` };
  if (granularity === "trimestre") { const q = Math.floor(m / 3) + 1; return { key: `${y}-T${q}`, label: `T${q} ${y}` }; }
  if (granularity === "semestre") { const s = m < 6 ? 1 : 2; return { key: `${y}-S${s}`, label: `S${s} ${y}` }; }
  return { key: `${y}`, label: `${y}` };
}
function finAggregateField(buckets, field) {
  const totals = {};
  buckets.forEach((b) => Object.entries(b[field] || {}).forEach(([k, v]) => { totals[k] = (totals[k] || 0) + v; }));
  return Object.entries(totals).sort((a, b) => b[1] - a[1]);
}
function finBuildBuckets(despesas, receitas, granularity) {
  const map = new Map();
  despesas.forEach((e) => {
    const date = finParseDate(e.date);
    const b = finBucketInfo(date, granularity);
    if (!map.has(b.key)) map.set(b.key, { key: b.key, label: b.label, receita: 0, despesa: 0, order: date, byRubrica: {}, byFornecedor: {} });
    const rec = map.get(b.key);
    rec.despesa += Number(e.amount);
    rec.byRubrica[e.rubrica] = (rec.byRubrica[e.rubrica] || 0) + Number(e.amount);
    rec.byFornecedor[e.vendor] = (rec.byFornecedor[e.vendor] || 0) + Number(e.amount);
    if (date > rec.order) rec.order = date;
  });
  receitas.forEach((r) => {
    const date = finParseDate(r.date);
    const b = finBucketInfo(date, granularity);
    if (!map.has(b.key)) map.set(b.key, { key: b.key, label: b.label, receita: 0, despesa: 0, order: date, byRubrica: {}, byFornecedor: {} });
    const rec = map.get(b.key);
    rec.receita += Number(r.amount);
    if (date > rec.order) rec.order = date;
  });
  return Array.from(map.values()).sort((a, b) => a.order - b.order).slice(-FIN_BUCKET_COUNT[granularity]);
}
function finParseAmount(raw) {
  if (!raw) return NaN;
  let s = String(raw).trim().replace(/[€\s]/g, "");
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  return parseFloat(s);
}
function finParseDateFlexible(s) {
  if (!s) return null;
  s = s.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}
function finParseCsv(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const delim = lines[0].includes(";") ? ";" : ",";
  const rows = lines.map((l) => l.split(delim).map((c) => c.trim().replace(/^"|"$/g, "")));
  const firstIsData = finParseDateFlexible(rows[0][0]);
  const dataRows = firstIsData ? rows : rows.slice(1);
  return dataRows.map((cols) => {
    const date = finParseDateFlexible(cols[0]);
    const description = cols[1] || "—";
    const amount = finParseAmount(cols[2]);
    return { date, description, amount };
  }).filter((r) => r.date && !isNaN(r.amount));
}

function FinDonutChart({ data, centerLabel, centerValue }) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  let acc = 0;
  const stops = data.map((d) => {
    const start = (acc / total) * 360;
    acc += d.value;
    const end = (acc / total) * 360;
    return `${d.color} ${start.toFixed(2)}deg ${end.toFixed(2)}deg`;
  });
  return (
    <div style={{ position: "relative", width: 140, height: 140, flexShrink: 0 }}>
      <div style={{ width: 140, height: 140, borderRadius: "50%", background: `conic-gradient(${stops.join(", ")})` }} />
      <div style={{ position: "absolute", inset: 20, borderRadius: "50%", background: C.surface, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <div style={{ fontSize: 10, color: C.muted }}>{centerLabel}</div>
        <div style={{ fontSize: 14, fontWeight: 800, color: C.text, fontFamily: "Manrope, sans-serif" }}>{centerValue}</div>
      </div>
    </div>
  );
}

function FinTrendChart({ buckets }) {
  const max = Math.max(1, ...buckets.map((b) => Math.max(b.receita, b.despesa)));
  const w = 680, h = 200, padL = 46, padB = 26, padT = 10;
  const groupW = (w - padL - 10) / Math.max(buckets.length, 1);
  const barW = Math.min(18, groupW / 3);
  const scaleY = (v) => (h - padB - padT) * (v / max);
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: "auto", overflow: "visible" }}>
      {ticks.map((t, i) => {
        const y = h - padB - scaleY(t);
        return (
          <g key={i}>
            <line x1={padL} y1={y} x2={w} y2={y} stroke={C.border} strokeWidth="1" strokeDasharray="3,3" />
            <text x={padL - 8} y={y + 4} textAnchor="end" fontSize="10" fill={C.muted}>{fmtEUR(t)}</text>
          </g>
        );
      })}
      {buckets.map((b, i) => {
        const x = padL + i * groupW + groupW / 2;
        return (
          <g key={b.key}>
            <rect x={x - barW - 2} y={h - padB - scaleY(b.receita)} width={barW} height={scaleY(b.receita)} rx="2" fill={C.accent} />
            <rect x={x + 2} y={h - padB - scaleY(b.despesa)} width={barW} height={scaleY(b.despesa)} rx="2" fill={C.red} />
            <text x={x} y={h - 8} textAnchor="middle" fontSize="10" fill={C.muted}>{b.label}</text>
          </g>
        );
      })}
      <g transform={`translate(${w - 150}, 0)`}>
        <rect x="0" y="0" width="10" height="10" rx="2" fill={C.accent} /><text x="14" y="9" fontSize="11" fill={C.muted}>Receita</text>
        <rect x="72" y="0" width="10" height="10" rx="2" fill={C.red} /><text x="86" y="9" fontSize="11" fill={C.muted}>Despesa</text>
      </g>
    </svg>
  );
}

function FinSectionCard({ title, icon, action, children, style: extraStyle }) {
  return (
    <div style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 10, padding: 18, ...extraStyle }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: C.text, fontFamily: "Manrope, sans-serif", display: "flex", alignItems: "center", gap: 8 }}>
          {icon && <span style={{ fontSize: 15 }}>{icon}</span>}{title}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function FinBadge({ text, color }) {
  return <span style={{ fontSize: 10, fontWeight: 700, color, background: `${color}22`, border: `1px solid ${color}55`, borderRadius: 20, padding: "3px 9px", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 4 }}>{text}</span>;
}

function FinMiniStat({ icon, label, value, color }) {
  return (
    <div style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 16px", flex: "1 1 0", minWidth: 190, display: "flex", alignItems: "center", gap: 12 }}>
      <div style={{ fontSize: 20, flexShrink: 0 }}>{icon}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
        <div style={{ fontSize: 16, fontWeight: 800, color: color || C.text, fontFamily: "Manrope, sans-serif" }}>{value}</div>
      </div>
    </div>
  );
}

const FIN_VENDOR_PALETTE = ["#3D6BFF", "#2DC7D8", "#8B7CF6", "#5AC8FA", "#4FD1C5", "#6C8EFF", "#F2994A", "#E8734A"];
function FinRankingPorCampo({ buckets, field, title, icon, colorFor, emptyLabel }) {
  const rows = finAggregateField(buckets, field).slice(0, 8);
  const total = rows.reduce((s, [, v]) => s + v, 0) || 1;
  const donutData = rows.map(([name, amount], i) => ({ name, value: amount, color: colorFor(name, i) }));
  return (
    <FinSectionCard title={title} icon={icon}>
      {rows.length === 0 ? (
        <div style={{ fontSize: 12, color: C.muted }}>{emptyLabel}</div>
      ) : (
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center" }}>
          <FinDonutChart data={donutData} centerLabel="Total" centerValue={fmtEUR(total)} />
          <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minWidth: 200 }}>
            {rows.map(([name, amount], i) => {
              const pct = (amount / total) * 100;
              const color = colorFor(name, i);
              return (
                <div key={name}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                    <span style={{ color: C.text }}>{name}</span>
                    <span style={{ color: C.muted, fontVariantNumeric: "tabular-nums" }}>{fmtEUR(amount)} · {pct.toFixed(0)}%</span>
                  </div>
                  <div style={{ height: 6, borderRadius: 3, background: C.surface, overflow: "hidden" }}>
                    <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 3 }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </FinSectionCard>
  );
}

// ---------- Relatório mensal (IA) ----------
function finParseInline(text) {
  const parts = String(text).split(/\*\*(.+?)\*\*/g);
  return parts.map((t, i) => ({ text: t, bold: i % 2 === 1 }));
}
function finParseMarkdown(md) {
  const lines = (md || "").split(/\r?\n/);
  const blocks = [];
  let listBuf = [];
  const flushList = () => { if (listBuf.length) { blocks.push({ type: "ul", items: listBuf }); listBuf = []; } };
  lines.forEach((line) => {
    const l = line.trim();
    if (!l) { flushList(); return; }
    if (/^###\s+/.test(l)) { flushList(); blocks.push({ type: "h3", text: l.replace(/^###\s+/, "") }); return; }
    if (/^##\s+/.test(l)) { flushList(); blocks.push({ type: "h2", text: l.replace(/^##\s+/, "") }); return; }
    if (/^#\s+/.test(l)) { flushList(); blocks.push({ type: "h1", text: l.replace(/^#\s+/, "") }); return; }
    if (/^[-*]\s+/.test(l)) { listBuf.push(l.replace(/^[-*]\s+/, "")); return; }
    flushList();
    blocks.push({ type: "p", text: l });
  });
  flushList();
  return blocks;
}
function FinInline({ text }) {
  return finParseInline(text).map((p, i) => (p.bold ? <strong key={i}>{p.text}</strong> : <React.Fragment key={i}>{p.text}</React.Fragment>));
}
function FinMarkdown({ md }) {
  const blocks = finParseMarkdown(md);
  return (
    <div>
      {blocks.map((b, i) => {
        if (b.type === "h1") return <div key={i} style={{ fontSize: 15, fontWeight: 800, color: C.text, fontFamily: "Manrope, sans-serif", marginTop: i ? 16 : 0, marginBottom: 8 }}><FinInline text={b.text} /></div>;
        if (b.type === "h2") return <div key={i} style={{ fontSize: 13, fontWeight: 700, color: C.text, marginTop: 14, marginBottom: 6 }}><FinInline text={b.text} /></div>;
        if (b.type === "h3") return <div key={i} style={{ fontSize: 12, fontWeight: 700, color: C.muted, marginTop: 10, marginBottom: 4 }}><FinInline text={b.text} /></div>;
        if (b.type === "ul") return (
          <ul key={i} style={{ margin: "4px 0 10px", paddingLeft: 18 }}>
            {b.items.map((it, j) => <li key={j} style={{ fontSize: 12, color: C.text, marginBottom: 4, lineHeight: 1.5 }}><FinInline text={it} /></li>)}
          </ul>
        );
        return <p key={i} style={{ fontSize: 12, color: C.text, marginBottom: 8, lineHeight: 1.5 }}><FinInline text={b.text} /></p>;
      })}
    </div>
  );
}
const finEscapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function finInlineToHtml(text) {
  return finParseInline(text).map((p) => (p.bold ? `<strong>${finEscapeHtml(p.text)}</strong>` : finEscapeHtml(p.text))).join("");
}
function finBlocksToHtml(blocks) {
  return blocks.map((b) => {
    if (b.type === "h1") return `<h1>${finInlineToHtml(b.text)}</h1>`;
    if (b.type === "h2") return `<h2>${finInlineToHtml(b.text)}</h2>`;
    if (b.type === "h3") return `<h3>${finInlineToHtml(b.text)}</h3>`;
    if (b.type === "ul") return `<ul>${b.items.map((it) => `<li>${finInlineToHtml(it)}</li>`).join("")}</ul>`;
    return `<p>${finInlineToHtml(b.text)}</p>`;
  }).join("\n");
}

function FinRelatorioMensal({ clientId, clientName, buckets, current }) {
  const [month, setMonth] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; });
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState("");
  const [error, setError] = useState("");

  const mesLabel = () => { const [y, m] = month.split("-").map(Number); return `${finMesesAbrev[m - 1]} de ${y}`; };

  const pollReport = (id) => {
    let tries = 0;
    const interval = setInterval(async () => {
      tries++;
      try {
        const row = await db.checkRelatorioStatus(id);
        if (row.status !== "processando" || tries > 20) {
          clearInterval(interval);
          setLoading(false);
          if (row.status === "processado") setReport(row.texto);
          else if (row.status === "erro") setError(row.ai_error || "Erro ao gerar relatório.");
          else setError("A IA está a demorar mais do que o normal. Tenta gerar novamente daqui a pouco.");
        }
      } catch (e2) { clearInterval(interval); setLoading(false); setError(e2.message); }
    }, 3000);
  };

  const gerar = async () => {
    setLoading(true); setError(""); setReport("");
    try {
      const [y, m] = month.split("-").map(Number);
      const rowId = await db.iniciarRelatorioFinanceiro(clientId, y, m);
      pollReport(rowId);
    } catch (e) { setError(e.message); setLoading(false); }
  };

  const download = () => {
    const bodyHtml = finBlocksToHtml(finParseMarkdown(report));
    const label = mesLabel();
    const receita = current ? current.receita : 0;
    const despesa = current ? current.despesa : 0;
    const margem = receita - despesa;
    const margemPositiva = margem >= 0;
    const maxVal = Math.max(receita, despesa, 1);
    const topRubricas = buckets ? finAggregateField(buckets, "byRubrica").slice(0, 6) : [];
    const totalRubricas = topRubricas.reduce((s, [, v]) => s + v, 0) || 1;

    let accDeg = 0;
    const donutStops = topRubricas.map(([name, amount]) => {
      const start = (accDeg / totalRubricas) * 360;
      accDeg += amount;
      const end = (accDeg / totalRubricas) * 360;
      return `${finRubricaFor(name).color} ${start.toFixed(1)}deg ${end.toFixed(1)}deg`;
    }).join(", ") || "#E4E9F8 0deg 360deg";

    const rubricaRowsHtml = topRubricas.map(([name, amount]) => {
      const pct = (amount / totalRubricas) * 100;
      const color = finRubricaFor(name).color;
      return `<div class="rubrica-row"><span class="rubrica-name"><span class="dot" style="background:${color}"></span>${finEscapeHtml(name)}</span><span class="rubrica-val">${fmtEUR(amount)} <b>${pct.toFixed(0)}%</b></span></div>`;
    }).join("");

    const html = `<!doctype html><html lang="pt-PT"><head><meta charset="UTF-8"><title>Relatório Financeiro — ${finEscapeHtml(clientName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; }
  @page { margin: 14mm 16mm; }
  html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: 'Inter', Arial, sans-serif; background:#F5F7FC; color:#1A2233; margin:0; line-height:1.55; }
  .page { max-width: 760px; margin: 0 auto; }
  .banner { background: linear-gradient(135deg, #3D6BFF 0%, #7B93FF 100%); padding: 34px 40px 56px; color:#fff; }
  .logo { font-family:'Manrope',sans-serif; font-weight:800; font-size:24px; letter-spacing:-0.3px; }
  .logo span { font-weight:500; opacity:.85; }
  .eyebrow { font-size:11px; text-transform:uppercase; letter-spacing:1.5px; opacity:.85; margin-top:6px; }
  .content { padding: 0 40px 40px; margin-top:-38px; }
  .title-card { background:#fff; border-radius:16px; padding:24px 28px; box-shadow:0 14px 30px rgba(30,50,110,0.10); margin-bottom:22px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; }
  .title-card h1 { font-family:'Manrope',sans-serif; font-size:22px; margin:0 0 4px; }
  .title-card .meta { color:#7C8AA5; font-size:13px; }
  .period-pill { background:#EEF2FF; color:#3D6BFF; font-family:'Manrope',sans-serif; font-weight:700; font-size:12px; padding:8px 14px; border-radius:100px; white-space:nowrap; }
  .kpis { display:flex; gap:16px; margin-bottom:22px; }
  .kpi { flex:1; background:#fff; border-radius:14px; padding:18px 18px 16px; box-shadow:0 8px 20px rgba(30,50,110,0.06); border-top:4px solid var(--kc); }
  .kpi .icon { font-size:18px; margin-bottom:10px; }
  .kpi .label { font-size:10.5px; color:#8A93AD; text-transform:uppercase; letter-spacing:.6px; margin-bottom:6px; font-weight:600; }
  .kpi .value { font-family:'Manrope',sans-serif; font-weight:800; font-size:23px; color:var(--kc); }
  .card { background:#fff; border-radius:14px; padding:22px 24px; margin-bottom:22px; box-shadow:0 8px 20px rgba(30,50,110,0.06); }
  .card-title { font-family:'Manrope',sans-serif; font-weight:700; font-size:13.5px; margin-bottom:16px; display:flex; align-items:center; gap:8px; }
  .bar-row { display:flex; align-items:center; gap:10px; margin-bottom:10px; }
  .bar-label { width:66px; font-size:12px; color:#7C8AA5; font-weight:600; }
  .bar-track { flex:1; background:#EEF1F8; border-radius:8px; height:16px; overflow:hidden; }
  .bar-fill { height:100%; border-radius:8px; }
  .bar-value { width:82px; text-align:right; font-size:12px; font-weight:700; font-family:'Manrope',sans-serif; }
  .rubrica-flex { display:flex; gap:26px; align-items:center; flex-wrap:wrap; }
  .donut { width:128px; height:128px; border-radius:50%; flex-shrink:0; position:relative; background: conic-gradient(${donutStops}); }
  .donut-hole { position:absolute; inset:22px; background:#fff; border-radius:50%; display:flex; flex-direction:column; align-items:center; justify-content:center; }
  .donut-hole .t { font-size:9px; color:#8A93AD; }
  .donut-hole .v { font-family:'Manrope',sans-serif; font-weight:800; font-size:13px; }
  .rubrica-list { flex:1; min-width:220px; }
  .rubrica-row { display:flex; justify-content:space-between; align-items:center; font-size:12.5px; padding:6px 0; border-bottom:1px solid #F1F3F9; }
  .rubrica-row:last-child { border-bottom:none; }
  .rubrica-name { display:flex; align-items:center; font-weight:600; }
  .rubrica-val { color:#8A93AD; }
  .rubrica-val b { color:#1A2233; font-weight:700; }
  .dot { width:9px; height:9px; border-radius:50%; display:inline-block; margin-right:8px; flex-shrink:0; }
  .insight-card { background:linear-gradient(180deg,#F5F8FF 0%,#ffffff 55%); border:1px solid #E7ECFA; border-radius:16px; padding:26px 28px; }
  .insight-card .card-title { color:#3D6BFF; }
  .insight-card h2 { font-family:'Manrope',sans-serif; font-size:16px; color:#1A2233; margin-top:0; }
  .insight-card h3 { font-size:12px; color:#8A93AD; text-transform:uppercase; letter-spacing:.4px; }
  .insight-card p, .insight-card li { font-size:13px; }
  .insight-card ul { padding-left:20px; }
  .footer { text-align:center; font-size:10px; color:#B0B8CC; margin-top:26px; }
  .noprint { text-align:center; padding:18px 0; background:#EDF1FA; }
  .noprint button { background:#1A2233; color:#fff; border:none; border-radius:10px; padding:13px 26px; font-size:14px; font-weight:700; cursor:pointer; font-family:'Manrope',sans-serif; box-shadow:0 8px 20px rgba(0,0,0,0.18); }
  @media print { .noprint { display:none; } }
</style></head>
<body>
  <div class="noprint"><button onclick="window.print()">🖨️ Imprimir / Guardar como PDF</button></div>

  <div class="page">
    <div class="banner">
      <div class="logo">OPERA <span>CRM</span></div>
      <div class="eyebrow">Relatório Financeiro Mensal</div>
    </div>

    <div class="content">
      <div class="title-card">
        <div>
          <h1>${finEscapeHtml(clientName)}</h1>
          <div class="meta">Gestão financeira do portefólio</div>
        </div>
        <div class="period-pill">${finEscapeHtml(label)}</div>
      </div>

      <div class="kpis">
        <div class="kpi" style="--kc:#3D6BFF;"><div class="icon">📈</div><div class="label">Receita</div><div class="value">${fmtEUR(receita)}</div></div>
        <div class="kpi" style="--kc:#F2994A;"><div class="icon">🧾</div><div class="label">Despesa</div><div class="value">${fmtEUR(despesa)}</div></div>
        <div class="kpi" style="--kc:${margemPositiva ? "#1BA97A" : "#E23D5C"};"><div class="icon">${margemPositiva ? "⚖️" : "⚠️"}</div><div class="label">Margem</div><div class="value">${fmtEUR(margem)}</div></div>
      </div>

      <div class="card">
        <div class="card-title">📊 Receita vs. Despesa</div>
        <div class="bar-row"><div class="bar-label">Receita</div><div class="bar-track"><div class="bar-fill" style="width:${((receita / maxVal) * 100).toFixed(0)}%; background:#3D6BFF;"></div></div><div class="bar-value">${fmtEUR(receita)}</div></div>
        <div class="bar-row" style="margin-bottom:0;"><div class="bar-label">Despesa</div><div class="bar-track"><div class="bar-fill" style="width:${((despesa / maxVal) * 100).toFixed(0)}%; background:#F2994A;"></div></div><div class="bar-value">${fmtEUR(despesa)}</div></div>
      </div>

      ${topRubricas.length > 0 ? `
      <div class="card">
        <div class="card-title">🏷️ Despesas por rubrica</div>
        <div class="rubrica-flex">
          <div class="donut"><div class="donut-hole"><div class="t">Total</div><div class="v">${fmtEUR(totalRubricas)}</div></div></div>
          <div class="rubrica-list">${rubricaRowsHtml}</div>
        </div>
      </div>` : ""}

      <div class="insight-card">
        <div class="card-title">✨ Análise da OPERA</div>
        ${bodyHtml}
      </div>

      <div class="footer">Gerado automaticamente pela OPERA CRM · opera-os.com</div>
    </div>
  </div>
</body></html>`;

    const win = window.open("", "_blank");
    if (!win) { alert("O browser bloqueou a nova janela. Permite pop-ups para opera-os.com e tenta outra vez."); return; }
    win.document.open();
    win.document.write(html);
    win.document.close();
  };

  return (
    <FinSectionCard title="Relatório mensal (IA)" icon="✨" style={{ marginTop: 20 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)}
          style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: "7px 10px", color: C.text, fontSize: 12 }} />
        <button onClick={gerar} disabled={loading} style={{ background: C.accent, border: "none", borderRadius: 6, padding: "8px 14px", color: "#fff", fontSize: 12, fontWeight: 700, cursor: loading ? "default" : "pointer", opacity: loading ? 0.7 : 1 }}>
          {loading ? "A gerar…" : "✨ Gerar relatório"}
        </button>
        {report && !loading && (
          <button onClick={download} style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 14px", color: C.text, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
            📄 Abrir relatório (PDF)
          </button>
        )}
      </div>
      {loading && <div style={{ fontSize: 12, color: C.muted, marginTop: 10 }}>A IA da OPERA está a analisar os dados financeiros deste mês — pode demorar até 20 segundos…</div>}
      {error && <div style={{ fontSize: 12, color: C.red, marginTop: 10 }}>{error}</div>}
      {report && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: 18, marginTop: 14 }}>
          <FinMarkdown md={report} />
        </div>
      )}
    </FinSectionCard>
  );
}

function FinVisaoGeral({ granularity, setGranularity, buckets, current, previous, extrato, isEquipa, clientId, clientName }) {
  const margem = current.receita - current.despesa;
  const margemPrev = previous.receita - previous.despesa;
  const delta = (now, prev) => (prev === 0 ? null : ((now - prev) / Math.abs(prev)) * 100);
  const dReceita = delta(current.receita, previous.receita);
  const dDespesa = delta(current.despesa, previous.despesa);
  const dMargem = delta(margem, margemPrev);
  const fmtDelta = (d) => (d === null ? "Sem período anterior" : `${d >= 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(0)}% vs período anterior`);
  const margemPct = current.receita ? (margem / current.receita) * 100 : null;
  const [topRubricaNome, topRubricaValor] = finAggregateField(buckets, "byRubrica")[0] || ["—", 0];
  const reconciliados = extrato.filter((b) => b.status === "reconciliado").length;
  const taxaReconciliacao = extrato.length ? (reconciliados / extrato.length) * 100 : null;

  return (
    <>
      <div style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", gap: 4, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 4, width: "fit-content", flexWrap: "wrap" }}>
          {FIN_PERIODS.map((p) => (
            <span key={p.key} onClick={() => setGranularity(p.key)}
              style={{ padding: "7px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", color: granularity === p.key ? "#fff" : C.muted, background: granularity === p.key ? C.accent : "transparent" }}>
              {p.label}
            </span>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 14, marginBottom: 14, flexWrap: "wrap" }}>
        <MetricCard label="Receita" value={fmtEUR(current.receita)} color={C.accent} sub={fmtDelta(dReceita)} />
        <MetricCard label="Despesa" value={fmtEUR(current.despesa)} color={C.red} sub={fmtDelta(dDespesa)} />
        <MetricCard label="Margem" value={fmtEUR(margem)} color={margem >= 0 ? C.green : C.red} sub={fmtDelta(dMargem)} />
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <FinMiniStat icon="📐" label="Margem sobre receita" value={margemPct === null ? "—" : `${margemPct.toFixed(0)}%`} color={margemPct >= 0 ? C.green : C.red} />
        <FinMiniStat icon="🏷️" label={`Maior despesa · ${topRubricaNome}`} value={fmtEUR(topRubricaValor)} color={C.red} />
        <FinMiniStat icon="🏦" label="Extrato reconciliado" value={taxaReconciliacao === null ? "—" : `${taxaReconciliacao.toFixed(0)}%`} color={taxaReconciliacao >= 90 ? C.green : C.amber} />
      </div>

      <FinSectionCard title="Receita vs. Despesa" icon="📈" style={{ marginBottom: 20 }}>
        {buckets.length === 0 ? <div style={{ fontSize: 12, color: C.muted }}>Ainda sem lançamentos neste período.</div> : <FinTrendChart buckets={buckets} />}
      </FinSectionCard>

      <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 380px" }}>
          <FinRankingPorCampo buckets={buckets} field="byRubrica" title="Despesas por rubrica" icon="🏷️"
            colorFor={(name) => finRubricaFor(name).color} emptyLabel="Ainda sem despesas neste período." />
        </div>
        <div style={{ flex: "1 1 380px" }}>
          <FinRankingPorCampo buckets={buckets} field="byFornecedor" title="Despesas por fornecedor" icon="🧑‍💼"
            colorFor={(name, i) => FIN_VENDOR_PALETTE[i % FIN_VENDOR_PALETTE.length]} emptyLabel="Ainda sem despesas neste período." />
        </div>
      </div>

      {isEquipa && <FinRelatorioMensal clientId={clientId} clientName={clientName} buckets={buckets} current={current} />}
    </>
  );
}

function FinUploadZone({ tipo, label, icon, clientId, onUploaded }) {
  const [busy, setBusy] = useState(false);
  const pollStatus = (id) => {
    let tries = 0;
    const interval = setInterval(async () => {
      tries++;
      try {
        const row = await db.checkDocStatus(tipo, id);
        if (row.status !== "processando" || tries > 20) {
          clearInterval(interval);
          setBusy(false);
          onUploaded(tipo, row);
          if (row.status === "erro") alert("Erro ao ler o documento: " + (row.ai_error || "desconhecido"));
          if (row.status === "processando") alert("A IA está a demorar mais do que o normal. O lançamento fica marcado como \"a processar\" e atualiza-se sozinho assim que estiver pronto.");
        }
      } catch (e2) { clearInterval(interval); setBusy(false); }
    }, 3000);
  };
  const handle = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    try {
      const row = await db.uploadFinanceiroDoc(clientId, tipo, file);
      onUploaded(tipo, row);
      pollStatus(row.id);
    } catch (err) { alert(err.message); setBusy(false); }
  };
  return (
    <label className="op-type-btn" style={{
      display: "flex", flexDirection: "column", alignItems: "center", gap: 4, border: `1.5px dashed ${C.border}`, borderRadius: 8,
      padding: "16px 10px", cursor: busy ? "default" : "pointer", color: C.muted, fontSize: 12, flex: "1 1 260px", textAlign: "center",
    }}>
      <span style={{ fontSize: 20 }}>{busy ? "⏳" : icon}</span>
      {busy ? "A carregar e a pedir à IA para ler…" : label}
      <input type="file" accept="image/*,application/pdf" style={{ display: "none" }} onChange={handle} disabled={busy} />
    </label>
  );
}

function FinLancamentos({ despesas, receitas, isEquipa, clientId, onAddDespesa, onAddReceita, onChangeRubrica, onDeleteDespesa, onDeleteReceita, onDocUploaded }) {
  const [novaDespesa, setNovaDespesa] = useState({ date: finDateStr(new Date()), vendor: "", rubrica: FIN_RUBRICAS[0].name, amount: "" });
  const [novaReceita, setNovaReceita] = useState({ date: finDateStr(new Date()), description: "", amount: "" });
  const [saving, setSaving] = useState(false);

  const submitDespesa = async () => {
    if (!novaDespesa.vendor.trim() || !novaDespesa.amount) return;
    setSaving(true);
    try {
      await onAddDespesa({ date: novaDespesa.date, vendor: novaDespesa.vendor.trim(), rubrica: novaDespesa.rubrica, amount: Number(novaDespesa.amount) });
      setNovaDespesa({ date: finDateStr(new Date()), vendor: "", rubrica: FIN_RUBRICAS[0].name, amount: "" });
    } catch (e) { alert(e.message); } finally { setSaving(false); }
  };
  const submitReceita = async () => {
    if (!novaReceita.description.trim() || !novaReceita.amount) return;
    setSaving(true);
    try {
      await onAddReceita({ date: novaReceita.date, description: novaReceita.description.trim(), amount: Number(novaReceita.amount) });
      setNovaReceita({ date: finDateStr(new Date()), description: "", amount: "" });
    } catch (e) { alert(e.message); } finally { setSaving(false); }
  };

  const combined = [
    ...despesas.map((d) => ({ ...d, tipo: "custo" })),
    ...receitas.map((r) => ({ ...r, tipo: "emitida" })),
  ].sort((a, b) => finParseDate(b.date) - finParseDate(a.date));

  const inputStyle = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: "7px 10px", color: C.text, fontSize: 12, boxSizing: "border-box" };

  return (
    <>
      <div style={{ display: "flex", gap: 14, marginBottom: 20, flexWrap: "wrap" }}>
        <FinUploadZone tipo="custo" icon="🧾" label="Anexar fatura de custo — lida automaticamente pela IA" clientId={clientId} onUploaded={onDocUploaded} />
        <FinUploadZone tipo="emitida" icon="📤" label="Anexar fatura emitida — lida automaticamente pela IA" clientId={clientId} onUploaded={onDocUploaded} />
      </div>

      {isEquipa && (
        <div style={{ display: "flex", gap: 14, marginBottom: 20, flexWrap: "wrap" }}>
          <FinSectionCard title="+ Nova despesa" icon="🧾" style={{ flex: "1 1 320px" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <input type="date" value={novaDespesa.date} onChange={(e) => setNovaDespesa({ ...novaDespesa, date: e.target.value })} style={inputStyle} />
              <input placeholder="Fornecedor" value={novaDespesa.vendor} onChange={(e) => setNovaDespesa({ ...novaDespesa, vendor: e.target.value })} style={inputStyle} />
              <select className="op-select" value={novaDespesa.rubrica} onChange={(e) => setNovaDespesa({ ...novaDespesa, rubrica: e.target.value })} style={inputStyle}>
                {FIN_RUBRICAS.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
              </select>
              <input type="number" step="0.01" placeholder="Valor (€)" value={novaDespesa.amount} onChange={(e) => setNovaDespesa({ ...novaDespesa, amount: e.target.value })} style={inputStyle} />
              <button onClick={submitDespesa} disabled={saving} style={{ background: C.red, border: "none", borderRadius: 6, padding: "8px 0", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Adicionar despesa</button>
            </div>
          </FinSectionCard>
          <FinSectionCard title="+ Nova receita" icon="📤" style={{ flex: "1 1 320px" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <input type="date" value={novaReceita.date} onChange={(e) => setNovaReceita({ ...novaReceita, date: e.target.value })} style={inputStyle} />
              <input placeholder="Descrição (ex. Renda — Apartamento X)" value={novaReceita.description} onChange={(e) => setNovaReceita({ ...novaReceita, description: e.target.value })} style={inputStyle} />
              <input type="number" step="0.01" placeholder="Valor (€)" value={novaReceita.amount} onChange={(e) => setNovaReceita({ ...novaReceita, amount: e.target.value })} style={inputStyle} />
              <button onClick={submitReceita} disabled={saving} style={{ background: C.accent, border: "none", borderRadius: 6, padding: "8px 0", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Adicionar receita</button>
            </div>
          </FinSectionCard>
        </div>
      )}

      <FinSectionCard title="Lançamentos" icon="📄">
        {combined.length === 0 ? (
          <div style={{ fontSize: 12, color: C.muted }}>Ainda não há lançamentos.</div>
        ) : (
          <div className="op-scroll" style={{ maxHeight: 380, overflowY: "auto", overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: "left", color: C.muted }}>
                  <th style={{ padding: "4px 8px", fontWeight: 500 }}>Data</th>
                  <th style={{ padding: "4px 8px", fontWeight: 500 }}>Descrição</th>
                  <th style={{ padding: "4px 8px", fontWeight: 500 }}>Tipo</th>
                  <th style={{ padding: "4px 8px", fontWeight: 500 }}>Rubrica</th>
                  <th style={{ padding: "4px 8px", fontWeight: 500, textAlign: "right" }}>Valor</th>
                  <th style={{ padding: "4px 8px", fontWeight: 500 }}>Estado</th>
                  <th style={{ padding: "4px 8px", fontWeight: 500 }}></th>
                </tr>
              </thead>
              <tbody>
                {combined.map((it) => (
                  <tr key={`${it.tipo}-${it.id}`} style={{ borderTop: `1px solid ${C.border}` }}>
                    <td style={{ padding: "8px", color: C.muted, whiteSpace: "nowrap" }}>{fmtDate(finParseDate(it.date))}</td>
                    <td style={{ padding: "8px", color: C.text }}>{it.tipo === "custo" ? it.vendor : it.description}</td>
                    <td style={{ padding: "8px" }}><FinBadge text={it.tipo === "custo" ? "Custo" : "Emitida"} color={it.tipo === "custo" ? C.red : C.accent} /></td>
                    <td style={{ padding: "8px" }}>
                      {it.status === "processando" ? (
                        <span style={{ color: C.muted }}>—</span>
                      ) : it.tipo === "emitida" ? (
                        <span style={{ color: C.muted }}>—</span>
                      ) : isEquipa ? (
                        <select className="op-select" value={it.rubrica} onChange={(e) => onChangeRubrica(it.id, e.target.value)}
                          style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, fontSize: 11, padding: "3px 6px" }}>
                          {FIN_RUBRICAS.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
                        </select>
                      ) : (
                        <FinBadge text={it.rubrica} color={finRubricaFor(it.rubrica).color} />
                      )}
                    </td>
                    <td style={{ padding: "8px", textAlign: "right", color: it.tipo === "emitida" ? C.accent : C.text, fontVariantNumeric: "tabular-nums" }}>
                      {it.status === "processando" ? <span style={{ color: C.muted }}>—</span> : <>{it.tipo === "emitida" ? "+" : "-"}{fmtEURDec(it.amount)}</>}
                    </td>
                    <td style={{ padding: "8px" }}>
                      {it.status === "processando" ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: C.accent, fontSize: 11, fontWeight: 700 }}>
                          <span className="op-spin" style={{ display: "inline-block", width: 10, height: 10, border: `2px solid ${C.accent}55`, borderTopColor: C.accent, borderRadius: "50%" }} />
                          A processar…
                        </span>
                      ) : it.status === "erro" ? (
                        <span title={it.ai_error || ""}><FinBadge text="Erro na leitura" color={C.red} /></span>
                      ) : (
                        <FinBadge text={it.source === "upload" ? "Lido pela IA" : "Manual"} color={C.green} />
                      )}
                    </td>
                    <td style={{ padding: "8px" }}>
                      <span onClick={() => (it.tipo === "custo" ? onDeleteDespesa(it.id) : onDeleteReceita(it.id))} style={{ cursor: "pointer", color: C.muted }} title="Apagar">×</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </FinSectionCard>
    </>
  );
}

function FinReconciliacao({ rows, isEquipa, onImportCsv, onConfirm, onDelete }) {
  const fileRef = useRef(null);
  const counts = rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  const handlePick = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const text = await file.text();
    const parsed = finParseCsv(text);
    if (!parsed.length) { alert("Não consegui ler linhas válidas deste CSV. Confirma que tem as colunas Data, Descrição, Valor."); return; }
    onImportCsv(parsed);
  };
  return (
    <>
      {isEquipa && (
        <div style={{ marginBottom: 20 }}>
          <div onClick={() => fileRef.current.click()} className="op-type-btn"
            style={{ border: `2px dashed ${C.border}`, borderRadius: 12, cursor: "pointer", background: C.surfaceRaised, textAlign: "center", padding: "16px 14px" }}>
            <div style={{ fontSize: 20, marginBottom: 6 }}>⬆️</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 3 }}>Importar extrato bancário (CSV)</div>
            <div style={{ fontSize: 11, color: C.muted }}>Ficheiro com 3 colunas, por esta ordem: Data, Descrição, Valor</div>
            <input ref={fileRef} type="file" accept=".csv" style={{ display: "none" }} onChange={handlePick} />
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
        <FinMiniStat icon="✅" label="reconciliados" value={counts.reconciliado || 0} color={C.green} />
        <FinMiniStat icon="⏳" label="por confirmar" value={counts.pendente || 0} color={C.amber} />
        <FinMiniStat icon="⚠️" label="sem correspondência" value={counts.sem_correspondencia || 0} color={C.red} />
      </div>
      <FinSectionCard title="Movimentos bancários" icon="🏦">
        {rows.length === 0 ? (
          <div style={{ fontSize: 12, color: C.muted }}>Ainda sem extrato importado.</div>
        ) : (
          <div className="op-scroll" style={{ maxHeight: 380, overflowY: "auto", overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: "left", color: C.muted }}>
                  <th style={{ padding: "4px 8px", fontWeight: 500 }}>Data</th>
                  <th style={{ padding: "4px 8px", fontWeight: 500 }}>Descrição</th>
                  <th style={{ padding: "4px 8px", fontWeight: 500, textAlign: "right" }}>Valor</th>
                  <th style={{ padding: "4px 8px", fontWeight: 500 }}>Estado</th>
                  <th style={{ padding: "4px 8px", fontWeight: 500 }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} style={{ borderTop: `1px solid ${C.border}` }}>
                    <td style={{ padding: "8px", color: C.muted, whiteSpace: "nowrap" }}>{fmtDate(finParseDate(r.date))}</td>
                    <td style={{ padding: "8px", color: C.text }}>{r.description}</td>
                    <td style={{ padding: "8px", textAlign: "right", color: r.amount >= 0 ? C.accent : C.text, fontVariantNumeric: "tabular-nums" }}>{fmtEURDec(r.amount)}</td>
                    <td style={{ padding: "8px" }}>
                      {isEquipa && r.status !== "reconciliado" ? (
                        <span onClick={() => onConfirm(r.id)} style={{ cursor: "pointer" }} title="Marcar como reconciliado">
                          <FinBadge text={(r.status === "pendente" ? "Por confirmar" : "Sem correspondência") + " · confirmar ✓"} color={r.status === "pendente" ? C.amber : C.red} />
                        </span>
                      ) : (
                        <FinBadge text={r.status === "reconciliado" ? "Reconciliado" : r.status === "pendente" ? "Por confirmar" : "Sem correspondência"} color={r.status === "reconciliado" ? C.green : r.status === "pendente" ? C.amber : C.red} />
                      )}
                    </td>
                    <td style={{ padding: "8px" }}>
                      <span onClick={() => onDelete(r.id)} style={{ cursor: "pointer", color: C.muted }} title="Apagar">×</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!isEquipa && <div style={{ marginTop: 14, fontSize: 11, color: C.muted }}>Reconciliação gerida pela equipa OPERA.</div>}
      </FinSectionCard>
    </>
  );
}

function FinanceiroPanel({ clientId, clientName, isEquipa }) {
  const [subTab, setSubTab] = useState("visao");
  const [granularity, setGranularity] = useState("mes");
  const [despesas, setDespesas] = useState([]);
  const [receitas, setReceitas] = useState([]);
  const [extrato, setExtrato] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const reload = () => Promise.all([db.listDespesas(clientId), db.listReceitas(clientId), db.listExtrato(clientId)])
    .then(([d, r, e]) => { setDespesas(d); setReceitas(r); setExtrato(e); });

  useEffect(() => {
    setLoading(true);
    reload().catch((e) => setLoadError(e.message)).finally(() => setLoading(false));
  }, [clientId]);

  if (loading) return <div style={{ fontSize: 13, color: C.muted, padding: 20 }}>A carregar…</div>;
  if (loadError) return <div style={{ fontSize: 13, color: C.red, padding: 20 }}>Erro ao carregar dados financeiros: {loadError}</div>;

  const buckets = finBuildBuckets(despesas, receitas, granularity);
  const current = buckets[buckets.length - 1] || { receita: 0, despesa: 0 };
  const previous = buckets[buckets.length - 2] || { receita: 0, despesa: 0 };

  const addDespesa = async (payload) => { const row = await db.addDespesa({ client_id: clientId, source: "manual", ...payload }); setDespesas((prev) => [row, ...prev]); };
  const addReceita = async (payload) => { const row = await db.addReceita({ client_id: clientId, source: "manual", ...payload }); setReceitas((prev) => [row, ...prev]); };
  const changeRubrica = (id, rubrica) => { setDespesas((prev) => prev.map((d) => (d.id === id ? { ...d, rubrica } : d))); db.updateDespesaRubrica(id, rubrica).catch((e) => alert(e.message)); };
  const deleteDespesa = (id) => { setDespesas((prev) => prev.filter((d) => d.id !== id)); db.removeDespesa(id).catch((e) => alert(e.message)); };
  const deleteReceita = (id) => { setReceitas((prev) => prev.filter((r) => r.id !== id)); db.removeReceita(id).catch((e) => alert(e.message)); };

  const importCsv = async (parsedRows) => {
    const despesaByKey = {}, receitaByKey = {};
    despesas.forEach((d) => { despesaByKey[`${d.date}|${Number(d.amount).toFixed(2)}`] = true; });
    receitas.forEach((r) => { receitaByKey[`${r.date}|${Number(r.amount).toFixed(2)}`] = true; });
    const rows = parsedRows.map((p) => {
      const key = `${p.date}|${Math.abs(p.amount).toFixed(2)}`;
      const matched = p.amount < 0 ? despesaByKey[key] : receitaByKey[key];
      return { client_id: clientId, date: p.date, description: p.description, amount: p.amount, status: matched ? "reconciliado" : "pendente" };
    });
    try {
      await db.addExtratoRows(rows);
      setExtrato((prev) => [...rows.map((r, i) => ({ ...r, id: `tmp${Date.now()}${i}` })), ...prev]);
      reload();
    } catch (e) { alert(e.message); }
  };
  const confirmExtrato = (id) => { setExtrato((prev) => prev.map((r) => (r.id === id ? { ...r, status: "reconciliado" } : r))); db.confirmExtrato(id).catch((e) => alert(e.message)); };
  const deleteExtrato = (id) => { setExtrato((prev) => prev.filter((r) => r.id !== id)); db.removeExtrato(id).catch((e) => alert(e.message)); };

  const TABS = [
    { key: "visao", label: "Visão Geral", icon: "📊" },
    { key: "lancamentos", label: "Lançamentos", icon: "📄" },
    { key: "reconciliacao", label: "Reconciliação", icon: "🏦" },
  ];

  return (
    <div>
      <div style={{ display: "flex", gap: 4, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 4, width: "fit-content", marginBottom: 20 }}>
        {TABS.map((t) => (
          <span key={t.key} onClick={() => setSubTab(t.key)}
            style={{ padding: "8px 16px", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: "pointer", color: subTab === t.key ? "#fff" : C.muted, background: subTab === t.key ? C.accent : "transparent", display: "flex", alignItems: "center", gap: 6 }}>
            <span>{t.icon}</span>{t.label}
          </span>
        ))}
      </div>

      {subTab === "visao" && <FinVisaoGeral granularity={granularity} setGranularity={setGranularity} buckets={buckets} current={current} previous={previous} extrato={extrato} isEquipa={isEquipa} clientId={clientId} clientName={clientName} />}
      {subTab === "lancamentos" && (
        <FinLancamentos despesas={despesas} receitas={receitas} isEquipa={isEquipa} clientId={clientId}
          onAddDespesa={addDespesa} onAddReceita={addReceita} onChangeRubrica={changeRubrica}
          onDeleteDespesa={deleteDespesa} onDeleteReceita={deleteReceita}
          onDocUploaded={(tipo, row) => {
            const setter = tipo === "custo" ? setDespesas : setReceitas;
            setter((prev) => (prev.some((r) => r.id === row.id) ? prev.map((r) => (r.id === row.id ? row : r)) : [row, ...prev]));
          }} />
      )}
      {subTab === "reconciliacao" && <FinReconciliacao rows={extrato} isEquipa={isEquipa} onImportCsv={importCsv} onConfirm={confirmExtrato} onDelete={deleteExtrato} />}
    </div>
  );
}

// ---------- Client detail panel (ficha de cliente, estilo Pipedrive) ----------
function ClientDetail({ client, deals, setDeals, setClients, pedidos, extra, onUpdateExtra, onClose, onOpenPedido, initialTab }) {
  const [tab, setTab] = useState(initialTab || "geral");
  useEffect(() => { if (initialTab) setTab(initialTab); }, [initialTab, client.id]);
  const [newNote, setNewNote] = useState("");
  const [newActType, setNewActType] = useState("Tarefa");
  const [newActText, setNewActText] = useState("");
  const [newActDue, setNewActDue] = useState("");
  const [editingContact, setEditingContact] = useState(false);
  const [contactDraft, setContactDraft] = useState({ contact: client.contact, email: client.email, phone: client.phone });
  const [linkedProfiles, setLinkedProfiles] = useState([]);
  const [pendingInvites, setPendingInvites] = useState([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);

  useEffect(() => {
    db.listProfilesByClient(client.id).then(setLinkedProfiles).catch(() => {});
    db.listClientInvites(client.id).then(setPendingInvites).catch(() => {});
  }, [client.id]);

  const sendInvite = async () => {
    const email = inviteEmail.trim();
    if (!email) return;
    setInviting(true);
    try {
      const result = await db.inviteClientEmail(client.id, email);
      if (result.linked) {
        setLinkedProfiles(await db.listProfilesByClient(client.id));
      } else {
        setPendingInvites(await db.listClientInvites(client.id));
      }
      setInviteEmail("");
    } catch (e) { alert(e.message); }
    finally { setInviting(false); }
  };

  const cancelInvite = async (id) => {
    setPendingInvites((prev) => prev.filter((i) => i.id !== id));
    try { await db.removeClientInvite(id); } catch (e) { alert(e.message); }
  };

  const saveContact = async () => {
    const patch = { contact: contactDraft.contact.trim() || "—", email: contactDraft.email.trim() || "—", phone: contactDraft.phone.trim() || "—" };
    setClients((prev) => prev.map((c) => (c.id === client.id ? { ...c, ...patch } : c)));
    setEditingContact(false);
    try { await db.updateClient(client.id, patch); } catch (e) { alert(e.message); }
  };

  const activeDeal = deals.find((d) => d.name === client.name && ACTIVE_STAGES.includes(d.stage));
  const pipelineDeal = deals.find((d) => d.name === client.name);
  const dealDaysInStage = pipelineDeal ? Math.floor((today - pipelineDeal.stageEnteredAt) / (1000 * 60 * 60 * 24)) : null;
  const markDealStage = async (stage) => {
    setDeals((prev) => prev.map((d) => (d.id === pipelineDeal.id ? { ...d, stage, stageEnteredAt: new Date(), closedAt: stage === "Closed" ? new Date() : d.closedAt } : d)));
    try { await db.updateDeal(pipelineDeal.id, dealStagePatch(stage)); } catch (e) { alert(e.message); }
  };
  const clientPedidos = pedidos.filter((p) => p.client === client.name).sort((a, b) => b.createdAt - a.createdAt);
  const notes = extra.notes || [];
  const activities = extra.activities || [];

  const pedidosEmAtraso = clientPedidos.filter((p) => p.due < today && p.stage !== "Concluído");
  const activitiesEmAtraso = activities.filter((a) => !a.done && a.due && new Date(a.due) < today);
  const alerts = [
    ...pedidosEmAtraso.map((p) => ({ id: `p${p.id}`, text: `Pedido "${pedidoTitle(p)}" está em atraso (prazo ${fmtDate(p.due)}).`, level: "red" })),
    ...activitiesEmAtraso.map((a) => ({ id: `a${a.id}`, text: `Atividade "${a.text}" está em atraso.`, level: "amber" })),
    ...(!activeDeal ? [{ id: "prospect", text: "Sem serviço ativo — cliente ainda em fase de prospecção.", level: "amber" }] : []),
  ];

  const addNote = async () => {
    if (!newNote.trim()) return;
    const text = newNote.trim();
    setNewNote("");
    try {
      const row = await db.addClientNote(client.id, text);
      onUpdateExtra({ ...extra, notes: [row, ...notes] });
    } catch (e) { alert(e.message); }
  };
  const togglePin = async (id) => {
    const note = notes.find((n) => n.id === id);
    onUpdateExtra({ ...extra, notes: notes.map((n) => (n.id === id ? { ...n, pinned: !n.pinned } : n)) });
    try { await db.toggleClientNotePin(id, !note.pinned); } catch (e) { alert(e.message); }
  };
  const removeNote = async (id) => {
    onUpdateExtra({ ...extra, notes: notes.filter((n) => n.id !== id) });
    try { await db.removeClientNote(id); } catch (e) { alert(e.message); }
  };

  const addActivity = async () => {
    if (!newActText.trim()) return;
    const payload = { type: newActType, text: newActText.trim(), due: newActDue || null, done: false };
    setNewActText(""); setNewActDue("");
    try {
      const row = await db.addClientActivity(client.id, payload);
      onUpdateExtra({ ...extra, activities: [row, ...activities] });
    } catch (e) { alert(e.message); }
  };
  const toggleActivity = async (id) => {
    const act = activities.find((a) => a.id === id);
    onUpdateExtra({ ...extra, activities: activities.map((a) => (a.id === id ? { ...a, done: !a.done } : a)) });
    try { await db.toggleClientActivity(id, !act.done); } catch (e) { alert(e.message); }
  };
  const removeActivity = async (id) => {
    onUpdateExtra({ ...extra, activities: activities.filter((a) => a.id !== id) });
    try { await db.removeClientActivity(id); } catch (e) { alert(e.message); }
  };

  const timeline = useMemo(() => {
    const events = [];
    if (pipelineDeal) events.push({ id: "deal", date: pipelineDeal.stageEnteredAt, icon: "💼", text: `Negócio em "${pipelineDeal.stage}" (${fmtEUR(pipelineDeal.value)}/mês)` });
    clientPedidos.forEach((p) => {
      events.push({ id: `p${p.id}`, date: p.due, icon: "📦", text: `Pedido "${pedidoTitle(p)}" — estado atual: ${p.stage}` });
      p.messages.forEach((m) => events.push({ id: `m${p.id}-${m.id}`, date: m.date, icon: "💬", text: `${m.sender === "cliente" ? "Cliente" : "Equipa"} em "${pedidoTitle(p)}": ${m.text}` }));
    });
    notes.forEach((n) => events.push({ id: `n${n.id}`, date: n.date, icon: "📝", text: n.text }));
    activities.filter((a) => a.done).forEach((a) => events.push({ id: `act${a.id}`, date: a.due ? new Date(a.due) : new Date(), icon: "✅", text: `${a.type} concluída: ${a.text}` }));
    return events.sort((a, b) => b.date - a.date);
  }, [pipelineDeal, clientPedidos, notes, activities]);

  const sortedNotes = [...notes].sort((a, b) => (b.pinned - a.pinned) || (b.date - a.date));

  const TABS = [
    { key: "geral", label: "Geral" },
    { key: "notas", label: `Notas${notes.length ? ` (${notes.length})` : ""}` },
    { key: "atividades", label: `Atividades${activities.filter((a) => !a.done).length ? ` (${activities.filter((a) => !a.done).length})` : ""}` },
    { key: "timeline", label: "Timeline" },
    { key: "financeiro", label: "Financeiro" },
    { key: "alertas", label: `Alertas${alerts.length ? ` (${alerts.length})` : ""}` },
  ];

  return (
    <PageBack onClose={onClose} eyebrow="Ficha de Cliente" maxWidth={tab === "financeiro" ? 1100 : 760}>
      <div style={{ fontFamily: "Manrope, sans-serif", fontWeight: 800, fontSize: 18, color: C.text, marginBottom: 10 }}>{client.name}</div>

      <div style={{ background: C.surfaceRaised, borderRadius: 8, padding: 12, marginBottom: 14 }}>
        {editingContact ? (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 8 }}>
              <input value={contactDraft.contact} onChange={(e) => setContactDraft({ ...contactDraft, contact: e.target.value })} placeholder="Nome do contacto"
                style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 10px", color: C.text, fontSize: 13 }} />
              <input value={contactDraft.email} onChange={(e) => setContactDraft({ ...contactDraft, email: e.target.value })} placeholder="Email"
                style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 10px", color: C.text, fontSize: 13 }} />
              <input value={contactDraft.phone} onChange={(e) => setContactDraft({ ...contactDraft, phone: e.target.value })} placeholder="Telefone"
                style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 10px", color: C.text, fontSize: 13 }} />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={saveContact} style={{ background: C.accent, border: "none", borderRadius: 6, padding: "6px 12px", color: "#fff", fontSize: 12, cursor: "pointer" }}>Guardar</button>
              <button onClick={() => setEditingContact(false)} style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 12px", color: C.muted, fontSize: 12, cursor: "pointer" }}>Cancelar</button>
            </div>
          </>
        ) : (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: C.text }}>
              <div><span style={{ color: C.muted }}>Contacto: </span>{client.contact}</div>
              <div><span style={{ color: C.muted }}>Email: </span>{client.email}</div>
              <div><span style={{ color: C.muted }}>Telefone: </span>{client.phone}</div>
            </div>
            <span onClick={() => { setContactDraft({ contact: client.contact, email: client.email, phone: client.phone }); setEditingContact(true); }}
              style={{ display: "inline-block", marginTop: 8, cursor: "pointer", fontSize: 12, color: C.accent }}>
              ✎ Editar contacto
            </span>
          </>
        )}
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <MetricCard label="MRR" value={activeDeal ? fmtEUR(activeDeal.value) : "—"} color={C.accent} />
        <MetricCard label="Estado" value={pipelineDeal ? pipelineDeal.stage : "Prospect"} color={activeDeal ? C.green : pipelineDeal && pipelineDeal.stage === LOST_STAGE ? C.red : C.amber} />
        <MetricCard label="Pedidos" value={clientPedidos.length} />
      </div>

      {alerts.length > 0 && tab !== "alertas" && (
        <div onClick={() => setTab("alertas")} style={{ background: "rgba(242,97,122,0.12)", border: `1px solid ${C.red}`, borderRadius: 8, padding: "8px 12px", fontSize: 12, color: C.red, marginBottom: 16, cursor: "pointer" }}>
          ⚠️ {alerts.length} alerta{alerts.length > 1 ? "s" : ""} — ver detalhe
        </div>
      )}

      <div className="op-scroll" style={{ display: "flex", gap: 4, borderBottom: `1px solid ${C.border}`, marginBottom: 16, overflowX: "auto" }}>
        {TABS.map((t) => (
          <div key={t.key} onClick={() => setTab(t.key)}
            style={{ padding: "8px 10px", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", cursor: "pointer",
              color: tab === t.key ? C.text : C.muted, borderBottom: tab === t.key ? `2px solid ${C.accent}` : "2px solid transparent" }}>
            {t.label}
          </div>
        ))}
      </div>

      {tab === "geral" && (
        <>
          {pipelineDeal && (
            <>
              <SectionTitle>Negócio no funil</SectionTitle>
              <div style={{ background: C.surfaceRaised, borderRadius: 8, padding: 12, marginBottom: 18 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontSize: 16, fontWeight: 800, color: C.accent, fontFamily: "Manrope, sans-serif" }}>{fmtEUR(pipelineDeal.value)}/mês</span>
                  <span style={{ fontSize: 11, color: pipelineDeal.stage === LOST_STAGE ? C.red : C.text, background: pipelineDeal.stage === LOST_STAGE ? "rgba(242,97,122,0.15)" : C.accentSoft, padding: "4px 10px", borderRadius: 6, fontWeight: 700 }}>
                    {pipelineDeal.stage}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>{dealDaysInStage}d nesta etapa · responsável {pipelineDeal.owner}</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => markDealStage("Closed")} style={{ flex: 1, background: C.green, border: "none", borderRadius: 6, padding: "8px 0", color: "#06281c", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Ganho</button>
                  <button onClick={() => markDealStage(LOST_STAGE)} style={{ flex: 1, background: "transparent", border: `1px solid ${C.red}`, borderRadius: 6, padding: "8px 0", color: C.red, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Perdido</button>
                </div>
              </div>
            </>
          )}

          <SectionTitle>Acesso ao portal</SectionTitle>
          <div style={{ background: C.surfaceRaised, borderRadius: 8, padding: 12, marginBottom: 18 }}>
            {linkedProfiles.length === 0 && pendingInvites.length === 0 && (
              <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>Ainda ninguém tem acesso ao portal para este cliente.</div>
            )}
            {linkedProfiles.map((p) => (
              <div key={p.id} style={{ fontSize: 13, color: C.text, marginBottom: 6 }}>👤 {p.full_name || p.email || p.id}</div>
            ))}
            {pendingInvites.map((inv) => (
              <div key={inv.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, color: C.muted, marginBottom: 6 }}>
                <span>✉️ {inv.email} — convite pendente</span>
                <span onClick={() => cancelInvite(inv.id)} style={{ cursor: "pointer", fontSize: 14 }}>×</span>
              </div>
            ))}
            <div style={{ fontSize: 11, color: C.muted, marginTop: 8, marginBottom: 6 }}>
              Escreve o email do contacto do cliente — quando ele entrar pela primeira vez em /crm/, fica logo ligado a este cliente.
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendInvite()}
                placeholder="email@cliente.pt"
                style={{ flex: 1, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 8px", color: C.text, fontSize: 12 }} />
              <button onClick={sendInvite} disabled={!inviteEmail.trim() || inviting} style={{ background: C.accent, border: "none", borderRadius: 6, padding: "6px 12px", color: "#fff", fontSize: 12, cursor: "pointer", opacity: inviteEmail.trim() && !inviting ? 1 : 0.5 }}>
                {inviting ? "..." : "Convidar"}
              </button>
            </div>
          </div>

          <SectionTitle>Pedidos deste cliente</SectionTitle>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {clientPedidos.map((p) => (
              <div key={p.id} onClick={() => onOpenPedido(p.id)}
                style={{ background: C.surfaceRaised, borderRadius: 8, padding: "10px 12px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div>
                  <div style={{ fontSize: 13, color: C.text, fontWeight: 600 }}>{pedidoTitle(p)}</div>
                  <div style={{ fontSize: 11, color: C.muted }}>{fmtDate(p.due)}{p.propertyId ? ` · 🏠 ${p.propertyId}` : ""}</div>
                </div>
                <span style={{ fontSize: 11, color: C.accent, background: C.accentSoft, padding: "4px 8px", borderRadius: 6 }}>{p.stage}</span>
              </div>
            ))}
            {clientPedidos.length === 0 && <div style={{ fontSize: 13, color: C.muted }}>Sem pedidos registados.</div>}
          </div>
        </>
      )}

      {tab === "notas" && (
        <>
          <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
            <textarea value={newNote} onChange={(e) => setNewNote(e.target.value)} rows={2} placeholder="Escrever uma nota sobre este cliente..."
              style={{ flex: 1, background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13, resize: "vertical" }} />
          </div>
          <button onClick={addNote} style={{ background: C.accentSoft, border: `1px solid ${C.accent}`, borderRadius: 6, padding: "6px 12px", color: C.text, fontSize: 12, cursor: "pointer", marginBottom: 16 }}>
            Adicionar nota
          </button>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {sortedNotes.map((n) => (
              <div key={n.id} style={{ background: n.pinned ? C.accentSoft : C.surfaceRaised, border: n.pinned ? `1px solid ${C.accent}` : "none", borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ fontSize: 13, color: C.text, flex: 1 }}>{n.text}</div>
                  <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                    <span onClick={() => togglePin(n.id)} title="Afixar nota" style={{ cursor: "pointer", color: n.pinned ? C.accent : C.muted, fontSize: 13 }}>📌</span>
                    <span onClick={() => removeNote(n.id)} style={{ cursor: "pointer", color: C.muted, fontSize: 14 }}>×</span>
                  </div>
                </div>
                <div style={{ fontSize: 10, color: C.muted, marginTop: 4 }}>{fmtDateTime(n.date)}{n.pinned ? " · afixada" : ""}</div>
              </div>
            ))}
            {sortedNotes.length === 0 && <div style={{ fontSize: 13, color: C.muted }}>Sem notas ainda.</div>}
          </div>
        </>
      )}

      {tab === "atividades" && (
        <>
          <div style={{ background: C.surfaceRaised, borderRadius: 8, padding: 12, marginBottom: 16 }}>
            <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
              {ACTIVITY_TYPES.map((t) => (
                <button key={t} onClick={() => setNewActType(t)}
                  style={{ background: newActType === t ? C.accent : C.surface, color: newActType === t ? "#fff" : C.text, border: `1px solid ${newActType === t ? C.accent : C.border}`, borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer" }}>
                  {t}
                </button>
              ))}
            </div>
            <input value={newActText} onChange={(e) => setNewActText(e.target.value)} placeholder="Descrever a atividade..."
              style={{ width: "100%", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13, marginBottom: 8, boxSizing: "border-box" }} />
            <div style={{ display: "flex", gap: 8 }}>
              <input type="date" value={newActDue} onChange={(e) => setNewActDue(e.target.value)}
                style={{ flex: 1, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13 }} />
              <button onClick={addActivity} style={{ background: C.accent, border: "none", borderRadius: 6, padding: "0 14px", color: "#fff", fontSize: 13, cursor: "pointer" }}>Adicionar</button>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {activities.map((a) => {
              const overdue = !a.done && a.due && new Date(a.due) < today;
              return (
                <div key={a.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, background: C.surfaceRaised, borderRadius: 8, padding: "10px 12px" }}>
                  <input type="checkbox" checked={a.done} onChange={() => toggleActivity(a.id)} style={{ marginTop: 3 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: C.accent, fontWeight: 700 }}>{a.type}</div>
                    <div style={{ fontSize: 13, color: a.done ? C.muted : C.text, textDecoration: a.done ? "line-through" : "none" }}>{a.text}</div>
                    {a.due && <div style={{ fontSize: 11, color: overdue ? C.red : C.muted, marginTop: 2 }}>Prazo: {fmtDate(new Date(a.due))}{overdue ? " · em atraso" : ""}</div>}
                  </div>
                  <span onClick={() => removeActivity(a.id)} style={{ cursor: "pointer", color: C.muted, fontSize: 14 }}>×</span>
                </div>
              );
            })}
            {activities.length === 0 && <div style={{ fontSize: 13, color: C.muted }}>Sem atividades registadas.</div>}
          </div>
        </>
      )}

      {tab === "timeline" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {timeline.map((e) => (
            <div key={e.id} style={{ display: "flex", gap: 10 }}>
              <div style={{ fontSize: 15 }}>{e.icon}</div>
              <div style={{ flex: 1, borderBottom: `1px solid ${C.border}`, paddingBottom: 8 }}>
                <div style={{ fontSize: 13, color: C.text }}>{e.text}</div>
                <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>{fmtDateTime(e.date)}</div>
              </div>
            </div>
          ))}
          {timeline.length === 0 && <div style={{ fontSize: 13, color: C.muted }}>Sem acontecimentos registados.</div>}
        </div>
      )}

      {tab === "financeiro" && <FinanceiroPanel clientId={client.id} clientName={client.name} isEquipa={true} />}

      {tab === "alertas" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {alerts.map((a) => (
            <div key={a.id} style={{
              background: a.level === "red" ? "rgba(242,97,122,0.12)" : "rgba(245,185,66,0.12)",
              border: `1px solid ${a.level === "red" ? C.red : C.amber}`, borderRadius: 8, padding: "10px 12px", fontSize: 13, color: C.text,
            }}>
              {a.level === "red" ? "🔴" : "🟠"} {a.text}
            </div>
          ))}
          {alerts.length === 0 && <div style={{ fontSize: 13, color: C.muted }}>Sem alertas para este cliente.</div>}
        </div>
      )}
    </PageBack>
  );
}

// ================= EQUIPA APP (Dashboard / CRM / Operacional / Clientes) =================
function EquipaApp({ profile }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [clients, setClients] = useState([]);
  const [deals, setDeals] = useState([]);
  const [pedidos, setPedidos] = useState([]);
  const [clientExtra, setClientExtra] = useState({});

  const [page, setPage] = useState("dashboard");
  const [period, setPeriod] = useState("mes");
  const [clientFilter, setClientFilter] = useState("Todos");
  const [typeFilter, setTypeFilter] = useState("Todos");
  const [propertySearch, setPropertySearch] = useState("");
  const [openPedidoId, setOpenPedidoId] = useState(null);
  const [openClientId, setOpenClientId] = useState(null);
  const [openClientTab, setOpenClientTab] = useState("geral");
  const [financeiroClientId, setFinanceiroClientId] = useState(null);
  const [addingDeal, setAddingDeal] = useState(false);
  const [newDeal, setNewDeal] = useState({ name: "", value: "", owner: "Fábio", contact: "", email: "", phone: "" });
  const [addingClient, setAddingClient] = useState(false);
  const [newClient, setNewClient] = useState({ name: "", contact: "", email: "", phone: "" });
  const [addingPedido, setAddingPedido] = useState(false);
  const [newPedido, setNewPedido] = useState({ clientId: "", type: PRESET_TYPES[0], customTitle: "", description: "", propertyId: "", owner: "Fábio", dueDate: "", dueTime: "" });

  const reloadClients = async () => setClients(await db.listClients());
  const reloadDeals = async () => setDeals(await db.listDeals());
  const reloadPedidos = async () => setPedidos(await db.listPedidos());
  const reloadClientExtra = async (clientId) => {
    const [notes, activities] = await Promise.all([db.listClientNotes(clientId), db.listClientActivities(clientId)]);
    setClientExtra((prev) => ({ ...prev, [clientId]: { notes, activities } }));
  };

  useEffect(() => {
    Promise.all([reloadClients(), reloadDeals(), reloadPedidos()])
      .catch((e) => setLoadError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const channel = sb.channel("equipa-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "pedidos" }, () => reloadPedidos())
      .on("postgres_changes", { event: "*", schema: "public", table: "pedido_mensagens" }, () => reloadPedidos())
      .on("postgres_changes", { event: "*", schema: "public", table: "deals" }, () => reloadDeals())
      .subscribe();
    return () => sb.removeChannel(channel);
  }, []);

  const openClient = (id, tab) => { setOpenClientId(id); setOpenClientTab(tab || "geral"); reloadClientExtra(id); };

  const periodDays = PERIODS.find((p) => p.key === period).days;

  const metrics = useMemo(() => {
    const inPeriod = (d) => withinPeriod(d.date, periodDays);
    const countStage = (stage) => deals.filter((d) => d.stage === stage && inPeriod(d)).length;
    const activeClients = deals.filter((d) => ACTIVE_STAGES.includes(d.stage));
    const mrr = activeClients.reduce((sum, d) => sum + d.value, 0);
    const arr = mrr * 12;
    const closedInPeriod = deals.filter((d) => WON_STAGES.includes(d.stage) && d.closedAt && withinPeriod(d.closedAt, periodDays));
    const faturacao = closedInPeriod.reduce((sum, d) => sum + d.value, 0);
    const totalLeadsAllTime = deals.length;
    const totalClosedAllTime = deals.filter((d) => WON_STAGES.includes(d.stage)).length;
    const conversao = totalLeadsAllTime > 0 ? Math.round((totalClosedAllTime / totalLeadsAllTime) * 100) : 0;
    const closedAllValues = deals.filter((d) => WON_STAGES.includes(d.stage));
    const ticketMedio = closedAllValues.length > 0 ? Math.round(closedAllValues.reduce((s, d) => s + d.value, 0) / closedAllValues.length) : 0;
    const pedidosVolume = pedidos.filter((p) => withinPeriod(p.due, periodDays)).length;
    return { leads: countStage("Lead"), r1: countStage("R1"), r2: countStage("R2"), closed: closedInPeriod.length, mrr, arr, faturacao, clientesAtivos: activeClients.length, conversao, ticketMedio, pedidosVolume };
  }, [deals, pedidos, periodDays]);

  const opStats = useMemo(() => {
    const total = pedidos.length;
    const emAtraso = pedidos.filter((p) => p.due < today && p.stage !== "Concluído").length;
    const concluidos = pedidos.filter((p) => p.stage === "Concluído").length;
    const noPrazo = concluidos > 0 ? Math.round(((concluidos - pedidos.filter((p) => p.stage === "Concluído" && p.due < today).length) / concluidos) * 100) : 100;

    const withCycle = pedidos.filter((p) => p.completedAt && p.createdAt);
    const avgCycleDays = withCycle.length > 0
      ? Math.round((withCycle.reduce((sum, p) => sum + (p.completedAt - p.createdAt), 0) / withCycle.length) / (1000 * 60 * 60 * 24) * 10) / 10
      : null;

    const in48h = new Date(today.getTime() + 48 * 60 * 60 * 1000);
    const aRisco = pedidos.filter((p) => p.stage !== "Concluído" && p.due >= today && p.due <= in48h).length;

    const newThisWeek = pedidos.filter((p) => p.createdAt && withinPeriod(p.createdAt, 7)).length;

    const byType = {};
    pedidos.forEach((p) => { const t = pedidoTitle(p); byType[t] = (byType[t] || 0) + 1; });
    const topTypes = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 6);

    const byOwner = {};
    pedidos.forEach((p) => { byOwner[p.owner] = (byOwner[p.owner] || 0) + 1; });

    return { total, emAtraso, concluidos, noPrazo, avgCycleDays, aRisco, newThisWeek, topTypes, byOwner };
  }, [pedidos]);

  const onDragStart = (e, id) => e.dataTransfer.setData("id", id);
  const onDropDeal = (e, stage) => {
    const id = e.dataTransfer.getData("id");
    setDeals((prev) => prev.map((d) => (d.id === id ? { ...d, stage, stageEnteredAt: new Date(), closedAt: stage === "Closed" ? new Date() : d.closedAt } : d)));
    db.updateDeal(id, dealStagePatch(stage)).catch((e) => { alert(e.message); reloadDeals(); });
  };
  const onAdvanceDeal = (id) => {
    const deal = deals.find((d) => d.id === id);
    if (!deal) return;
    const idx = STAGE_ORDER.indexOf(deal.stage);
    const next = idx >= 0 && idx < STAGE_ORDER.length - 1 ? STAGE_ORDER[idx + 1] : deal.stage;
    setDeals((prev) => prev.map((d) => (d.id === id ? { ...d, stage: next, stageEnteredAt: new Date(), closedAt: next === "Closed" ? new Date() : d.closedAt } : d)));
    db.updateDeal(id, dealStagePatch(next)).catch((e) => { alert(e.message); reloadDeals(); });
  };
  const onDropPedido = (e, stage) => {
    const id = e.dataTransfer.getData("id");
    setPedidos((prev) => prev.map((p) => (p.id === id ? { ...p, stage, completedAt: stage === "Concluído" ? new Date() : null } : p)));
    db.updatePedidoStage(id, stage).catch((e) => { alert(e.message); reloadPedidos(); });
  };
  const openPedidoSeen = (id) => {
    setPedidos((prev) => prev.map((p) => (p.id === id ? { ...p, seen: true } : p)));
    db.markPedidoSeen(id).catch(() => {});
    setOpenPedidoId(id);
  };

  const openClientByDeal = async (deal) => {
    let client = deal.clientId ? clients.find((c) => c.id === deal.clientId) : null;
    if (!client) client = clients.find((c) => c.name === deal.name);
    if (!client) {
      try {
        client = await db.createClient({ name: deal.name, contact: deal.contact || "—", email: null, phone: null });
        setClients((prev) => [...prev, client]);
        if (!deal.clientId) db.updateDeal(deal.id, { client_id: client.id }).then(reloadDeals);
      } catch (e) { alert(e.message); return; }
    }
    openClient(client.id);
  };

  const submitNewDeal = async () => {
    if (!newDeal.name.trim()) return;
    const name = newDeal.name.trim();
    try {
      let client = clients.find((c) => c.name === name);
      if (!client) {
        client = await db.createClient({
          name, contact: newDeal.contact.trim() || "—",
          email: newDeal.email.trim() || null, phone: newDeal.phone.trim() || null,
        });
        setClients((prev) => [...prev, client]);
      }
      await db.createDeal({
        client_id: client.id, name, contact: newDeal.contact.trim() || name,
        value: Number(newDeal.value) || 0, stage: "Lead", owner: newDeal.owner,
        stage_entered_at: new Date().toISOString(),
      });
      await reloadDeals();
      setNewDeal({ name: "", value: "", owner: "Fábio", contact: "", email: "", phone: "" });
      setAddingDeal(false);
      openClient(client.id);
    } catch (e) { alert(e.message); }
  };

  const submitNewClient = async () => {
    if (!newClient.name.trim()) return;
    const name = newClient.name.trim();
    try {
      const existing = clients.find((c) => c.name === name);
      if (existing) { setAddingClient(false); openClient(existing.id); return; }
      const client = await db.createClient({
        name, contact: newClient.contact.trim() || "—",
        email: newClient.email.trim() || null, phone: newClient.phone.trim() || null,
      });
      setClients((prev) => [...prev, client]);
      setNewClient({ name: "", contact: "", email: "", phone: "" });
      setAddingClient(false);
      openClient(client.id);
    } catch (e) { alert(e.message); }
  };

  const submitNewPedido = async () => {
    if (!newPedido.clientId) { alert("Escolhe um cliente."); return; }
    if (newPedido.type === "Pedido Aberto" && !newPedido.customTitle.trim()) { alert("Dá um título ao pedido."); return; }
    if (!newPedido.description.trim()) { alert("Descreve o pedido."); return; }
    if (!newPedido.dueDate) { alert("Indica o prazo."); return; }
    const due = new Date(`${newPedido.dueDate}T${newPedido.dueTime || "18:00"}:00`);
    try {
      await db.createPedido({
        client_id: newPedido.clientId,
        type: newPedido.type,
        custom_title: newPedido.type === "Pedido Aberto" ? newPedido.customTitle.trim() : null,
        description: newPedido.description.trim(),
        property_id: newPedido.propertyId.trim() || null,
        stage: "Recebido",
        owner: newPedido.owner,
        due: due.toISOString(),
        seen: true,
        client_seen: false,
      });
      await reloadPedidos();
      setNewPedido({ clientId: "", type: PRESET_TYPES[0], customTitle: "", description: "", propertyId: "", owner: "Fábio", dueDate: "", dueTime: "" });
      setAddingPedido(false);
    } catch (e) { alert(e.message); }
  };

  const filteredPedidos = pedidos.filter((p) => {
    if (clientFilter !== "Todos" && p.client !== clientFilter) return false;
    if (typeFilter !== "Todos" && pedidoTitle(p) !== typeFilter) return false;
    if (propertySearch.trim() && !p.propertyId.toLowerCase().includes(propertySearch.trim().toLowerCase())) return false;
    return true;
  });
  const openPedido = pedidos.find((p) => p.id === openPedidoId);
  const openClientObj = clients.find((c) => c.id === openClientId);
  const unseenCount = pedidos.filter((p) => p.seen === false).length;

  const NAV = [
    { key: "dashboard", label: "Dashboard", icon: "📊" },
    { key: "crm", label: "CRM Comercial", icon: "🧭" },
    { key: "operacional", label: "Operacional", icon: "🗂️", badge: unseenCount },
    { key: "clientes", label: "Clientes", icon: "👥" },
    { key: "financeiro", label: "Financeiro", icon: "💶" },
  ];

  if (loading) return <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 13 }}>A carregar…</div>;
  if (loadError) return <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: C.red, fontSize: 13, padding: 24, textAlign: "center" }}>Erro ao carregar dados: {loadError}</div>;

  return (
    <div style={{ display: "flex", flex: 1, position: "relative", minHeight: 0, minWidth: 0, overflow: "hidden" }}>
      <div style={{ width: 190, background: C.surface, borderRight: `1px solid ${C.border}`, padding: "20px 12px", flexShrink: 0 }}>
        {NAV.map((n) => (
          <div key={n.key} onClick={() => setPage(n.key)}
            style={{
              padding: "10px 12px", borderRadius: 8, marginBottom: 6, cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center",
              background: page === n.key ? C.accentSoft : "transparent", color: page === n.key ? C.text : C.muted, fontWeight: page === n.key ? 700 : 500, fontSize: 14,
              borderLeft: page === n.key ? `3px solid ${C.accent}` : "3px solid transparent", transition: "background 0.15s ease, border-color 0.15s ease",
            }}>
            <span style={{ display: "flex", alignItems: "center", gap: 9 }}><span style={{ fontSize: 15 }}>{n.icon}</span>{n.label}</span>
            {!!n.badge && (
              <span className="op-new-pulse" style={{ background: C.amber, color: "#1a1400", fontSize: 10, fontWeight: 800, borderRadius: 10, padding: "1px 7px" }}>{n.badge}</span>
            )}
          </div>
        ))}
      </div>

      <div key={openPedido ? `pedido-${openPedido.id}` : openClientObj ? `client-${openClientObj.id}` : page} className="op-fade-in" style={{ flex: 1, padding: "24px 28px", overflowX: "hidden", minWidth: 0, overflowY: "auto" }}>
        {openPedido ? (
          <PedidoDetailInternal pedido={openPedido} onClose={() => setOpenPedidoId(null)} onReload={reloadPedidos} />
        ) : openClientObj ? (
          <ClientDetail client={openClientObj} deals={deals} setDeals={setDeals} setClients={setClients} pedidos={pedidos}
            extra={clientExtra[openClientObj.id] || { notes: [], activities: [] }}
            onUpdateExtra={(updated) => setClientExtra((prev) => ({ ...prev, [openClientObj.id]: updated }))}
            onClose={() => setOpenClientId(null)}
            initialTab={openClientTab}
            onOpenPedido={(id) => { setOpenClientId(null); openPedidoSeen(id); }} />
        ) : (
        <>
        {page === "dashboard" && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18, flexWrap: "wrap", gap: 10 }}>
              <div style={{ fontFamily: "Manrope, sans-serif", fontWeight: 700, fontSize: 20, color: C.text }}>Dashboard</div>
              <div style={{ display: "flex", gap: 4, background: C.surface, borderRadius: 8, padding: 4 }}>
                {PERIODS.map((p) => (
                  <button key={p.key} onClick={() => setPeriod(p.key)}
                    style={{ border: "none", background: period === p.key ? C.accent : "transparent", color: period === p.key ? "#fff" : C.muted, fontSize: 12, fontWeight: 600, padding: "6px 10px", borderRadius: 6, cursor: "pointer" }}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ fontSize: 12, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>📈 Comercial</div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
              <MetricCard label="Leads" value={metrics.leads} icon="🧲" />
              <MetricCard label="R1" value={metrics.r1} icon="☎️" />
              <MetricCard label="R2" value={metrics.r2} icon="🤝" />
              <MetricCard label="Closed" value={metrics.closed} color={C.green} icon="✅" />
              <MetricCard label="MRR" value={fmtEUR(metrics.mrr)} color={C.accent} sub="clientes ativos" icon="💰" />
              <MetricCard label="ARR" value={fmtEUR(metrics.arr)} color={C.accent} icon="📆" />
              <MetricCard label="Faturação" value={fmtEUR(metrics.faturacao)} color={C.amber} sub="deals fechados no período" icon="🧾" />
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 30 }}>
              <MetricCard label="Clientes Ativos" value={metrics.clientesAtivos} sub="onboard + entrega serviço" icon="👥" />
              <MetricCard label="Taxa de Conversão" value={`${metrics.conversao}%`} sub="lead → cliente" icon="🎯" />
              <MetricCard label="Ticket Médio" value={fmtEUR(metrics.ticketMedio)} sub="por cliente fechado" icon="🏷️" />
              <MetricCard label="Nº Pedidos" value={metrics.pedidosVolume} color={C.amber} sub="volume operacional no período" icon="📦" />
            </div>

            <div style={{ fontSize: 12, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>🗂️ Operacional</div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
              <MetricCard label="Total de Pedidos" value={opStats.total} icon="📋" />
              <MetricCard label="Em Atraso" value={opStats.emAtraso} color={opStats.emAtraso > 0 ? C.red : C.green} icon="⏰" />
              <MetricCard label="Concluídos" value={opStats.concluidos} color={C.green} icon="✅" />
              <MetricCard label="No Prazo" value={`${opStats.noPrazo}%`} sub="dos pedidos concluídos" icon="🎯" />
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
              <MetricCard label="Tempo Médio de Conclusão" value={opStats.avgCycleDays !== null ? `${opStats.avgCycleDays}d` : "—"} sub="da criação à conclusão" icon="⏱️" />
              <MetricCard label="A Risco (48h)" value={opStats.aRisco} color={opStats.aRisco > 0 ? C.amber : C.green} sub="prazo nas próximas 48h" icon="⚠️" />
              <MetricCard label="Novos esta Semana" value={opStats.newThisWeek} color={C.accent} icon="🆕" />
            </div>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <div className="op-card-hover" style={{ flex: "1 1 260px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.muted, marginBottom: 10 }}>📊 Pedidos por Tipo</div>
                {opStats.topTypes.map(([type, count]) => (
                  <div key={type} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <span style={{ fontSize: 12, color: C.text }}>{type}</span>
                    <span style={{ fontSize: 12, color: C.accent, fontWeight: 700 }}>{count}</span>
                  </div>
                ))}
              </div>
              <div className="op-card-hover" style={{ flex: "1 1 200px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.muted, marginBottom: 10 }}>🧑‍💼 Pedidos por Responsável</div>
                {Object.entries(opStats.byOwner).map(([owner, count]) => (
                  <div key={owner} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <span style={{ fontSize: 12, color: C.text }}>{owner}</span>
                    <span style={{ fontSize: 12, color: C.accent, fontWeight: 700 }}>{count}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {page === "crm" && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18, flexWrap: "wrap", gap: 10 }}>
              <div style={{ fontFamily: "Manrope, sans-serif", fontWeight: 700, fontSize: 20, color: C.text }}>CRM Comercial</div>
              <button onClick={() => setAddingDeal(true)}
                style={{ background: C.accent, border: "none", borderRadius: 8, padding: "9px 16px", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                + Novo Cliente
              </button>
            </div>

            {addingDeal && (
              <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, marginBottom: 20, maxWidth: 480 }}>
                <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Nome do cliente / lead</div>
                <input value={newDeal.name} onChange={(e) => setNewDeal({ ...newDeal, name: e.target.value })} placeholder="ex. Nova Imobiliária Lda"
                  style={{ width: "100%", background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13, marginBottom: 12, boxSizing: "border-box" }} />

                <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Valor mensal estimado (€)</div>
                    <input type="number" value={newDeal.value} onChange={(e) => setNewDeal({ ...newDeal, value: e.target.value })} placeholder="500"
                      style={{ width: "100%", background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13, boxSizing: "border-box" }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Responsável</div>
                    <select value={newDeal.owner} onChange={(e) => setNewDeal({ ...newDeal, owner: e.target.value })}
                      style={{ width: "100%", background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13 }}>
                      <option value="Fábio">Fábio</option>
                      <option value="Nicole">Nicole</option>
                    </select>
                  </div>
                </div>

                <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Contacto (opcional)</div>
                <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
                  <input value={newDeal.contact} onChange={(e) => setNewDeal({ ...newDeal, contact: e.target.value })} placeholder="Nome do contacto"
                    style={{ flex: 1, background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13, boxSizing: "border-box" }} />
                  <input value={newDeal.email} onChange={(e) => setNewDeal({ ...newDeal, email: e.target.value })} placeholder="Email"
                    style={{ flex: 1, background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13, boxSizing: "border-box" }} />
                </div>
                <input value={newDeal.phone} onChange={(e) => setNewDeal({ ...newDeal, phone: e.target.value })} placeholder="Telefone"
                  style={{ width: "100%", background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13, marginBottom: 14, boxSizing: "border-box" }} />

                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={submitNewDeal} style={{ background: C.accent, border: "none", borderRadius: 6, padding: "8px 14px", color: "#fff", fontSize: 13, cursor: "pointer" }}>Adicionar</button>
                  <button onClick={() => setAddingDeal(false)} style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 14px", color: C.muted, fontSize: 13, cursor: "pointer" }}>Cancelar</button>
                </div>
              </div>
            )}

            <div className="op-scroll" style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 12, WebkitOverflowScrolling: "touch", touchAction: "pan-x" }}>
              {STAGE_COLUMNS.map((stage) => {
                const stageDeals = deals.filter((d) => d.stage === stage);
                const total = stageDeals.reduce((sum, d) => sum + d.value, 0);
                return (
                  <div key={stage} onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDropDeal(e, stage)}
                    style={{ minWidth: 210, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 10, flexShrink: 0 }}>
                    <div style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: stage === LOST_STAGE ? C.red : C.text }}>{stage}</div>
                      <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{fmtEUR(total)} · {stageDeals.length} negócio{stageDeals.length !== 1 ? "s" : ""}</div>
                    </div>
                    {stageDeals.map((d) => (
                      <DealCard key={d.id} deal={d} onDragStart={onDragStart} onOpen={openClientByDeal} onAdvance={onAdvanceDeal} isLast={stage === "Entrega de Serviço"} />
                    ))}
                    {stageDeals.length === 0 && (
                      <div style={{ fontSize: 11, color: C.muted, textAlign: "center", padding: "18px 4px", opacity: 0.6 }}>Sem negócios aqui</div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {page === "operacional" && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18, flexWrap: "wrap", gap: 10 }}>
              <div style={{ fontFamily: "Manrope, sans-serif", fontWeight: 700, fontSize: 20, color: C.text }}>Pedidos dos Clientes</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input value={propertySearch} onChange={(e) => setPropertySearch(e.target.value)} placeholder="🔍 ID do imóvel..."
                  style={{ background: C.surface, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", fontSize: 13, width: 160 }} />
                <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}
                  style={{ background: C.surface, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", fontSize: 13 }}>
                  <option value="Todos">Todos os tipos</option>
                  {[...new Set(pedidos.map((p) => pedidoTitle(p)))].map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <select value={clientFilter} onChange={(e) => setClientFilter(e.target.value)}
                  style={{ background: C.surface, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", fontSize: 13 }}>
                  <option value="Todos">Todos os clientes</option>
                  {[...new Set(pedidos.map((p) => p.client))].map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <button onClick={() => setAddingPedido(true)}
                  style={{ background: C.accent, border: "none", borderRadius: 8, padding: "9px 16px", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                  + Novo Pedido
                </button>
              </div>
            </div>

            {addingPedido && (
              <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, marginBottom: 20, maxWidth: 480 }}>
                <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Cliente</div>
                <select value={newPedido.clientId} onChange={(e) => setNewPedido({ ...newPedido, clientId: e.target.value })}
                  style={{ width: "100%", background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13, marginBottom: 12 }}>
                  <option value="">Escolher cliente…</option>
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>

                <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Tipo de pedido</div>
                    <select value={newPedido.type} onChange={(e) => setNewPedido({ ...newPedido, type: e.target.value })}
                      style={{ width: "100%", background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13 }}>
                      {[...PRESET_TYPES, "Pedido Aberto"].map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Responsável</div>
                    <select value={newPedido.owner} onChange={(e) => setNewPedido({ ...newPedido, owner: e.target.value })}
                      style={{ width: "100%", background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13 }}>
                      <option value="Fábio">Fábio</option>
                      <option value="Nicole">Nicole</option>
                    </select>
                  </div>
                </div>

                {newPedido.type === "Pedido Aberto" && (
                  <>
                    <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Título do pedido</div>
                    <input value={newPedido.customTitle} onChange={(e) => setNewPedido({ ...newPedido, customTitle: e.target.value })} placeholder="ex. Apoio para dossier de investidor"
                      style={{ width: "100%", background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13, marginBottom: 12, boxSizing: "border-box" }} />
                  </>
                )}

                <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Descrição</div>
                <textarea value={newPedido.description} onChange={(e) => setNewPedido({ ...newPedido, description: e.target.value })} rows={3} placeholder="Descreva o pedido..."
                  style={{ width: "100%", background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13, marginBottom: 12, resize: "vertical", boxSizing: "border-box" }} />

                <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>ID do imóvel (opcional)</div>
                <input value={newPedido.propertyId} onChange={(e) => setNewPedido({ ...newPedido, propertyId: e.target.value })} placeholder="ex. LX-231"
                  style={{ width: "100%", background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13, marginBottom: 12, boxSizing: "border-box" }} />

                <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Prazo</div>
                <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                  <input type="date" value={newPedido.dueDate} onChange={(e) => setNewPedido({ ...newPedido, dueDate: e.target.value })}
                    style={{ flex: 1, background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13 }} />
                  <input type="time" value={newPedido.dueTime} onChange={(e) => setNewPedido({ ...newPedido, dueTime: e.target.value })}
                    style={{ width: 110, background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13 }} />
                </div>

                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={submitNewPedido} style={{ background: C.accent, border: "none", borderRadius: 6, padding: "8px 14px", color: "#fff", fontSize: 13, cursor: "pointer" }}>Criar pedido</button>
                  <button onClick={() => setAddingPedido(false)} style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 14px", color: C.muted, fontSize: 13, cursor: "pointer" }}>Cancelar</button>
                </div>
              </div>
            )}

            <div className="op-scroll" style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 12, WebkitOverflowScrolling: "touch", touchAction: "pan-x" }}>
              {OP_STAGES.map((stage) => {
                const stagePedidos = filteredPedidos.filter((p) => p.stage === stage);
                return (
                  <div key={stage} onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDropPedido(e, stage)}
                    style={{ minWidth: 210, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 10, flexShrink: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: STAGE_META[stage].color, marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span>{STAGE_META[stage].icon} {stage}</span><span style={{ color: C.muted, fontWeight: 600 }}>{stagePedidos.length}</span>
                    </div>
                    {stagePedidos.map((p) => <PedidoCard key={p.id} pedido={p} onDragStart={onDragStart} onOpen={openPedidoSeen} />)}
                    {stagePedidos.length === 0 && (
                      <div style={{ fontSize: 11, color: C.muted, textAlign: "center", padding: "18px 4px", opacity: 0.6 }}>Sem pedidos aqui</div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {page === "clientes" && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18, flexWrap: "wrap", gap: 10 }}>
              <div style={{ fontFamily: "Manrope, sans-serif", fontWeight: 700, fontSize: 20, color: C.text }}>Clientes</div>
              <button onClick={() => setAddingClient(true)}
                style={{ background: C.accent, border: "none", borderRadius: 8, padding: "9px 16px", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                + Novo Cliente
              </button>
            </div>

            {addingClient && (
              <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, marginBottom: 20, maxWidth: 440 }}>
                <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Nome do cliente</div>
                <input value={newClient.name} onChange={(e) => setNewClient({ ...newClient, name: e.target.value })} placeholder="ex. Nova Imobiliária Lda"
                  style={{ width: "100%", background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13, marginBottom: 12, boxSizing: "border-box" }} />

                <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Contacto (opcional)</div>
                <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                  <input value={newClient.contact} onChange={(e) => setNewClient({ ...newClient, contact: e.target.value })} placeholder="Nome do contacto"
                    style={{ flex: 1, background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13, boxSizing: "border-box" }} />
                  <input value={newClient.email} onChange={(e) => setNewClient({ ...newClient, email: e.target.value })} placeholder="Email"
                    style={{ flex: 1, background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13, boxSizing: "border-box" }} />
                </div>
                <input value={newClient.phone} onChange={(e) => setNewClient({ ...newClient, phone: e.target.value })} placeholder="Telefone"
                  style={{ width: "100%", background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13, marginBottom: 14, boxSizing: "border-box" }} />

                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={submitNewClient} style={{ background: C.accent, border: "none", borderRadius: 6, padding: "8px 14px", color: "#fff", fontSize: 13, cursor: "pointer" }}>Adicionar</button>
                  <button onClick={() => setAddingClient(false)} style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 14px", color: C.muted, fontSize: 13, cursor: "pointer" }}>Cancelar</button>
                </div>
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {clients.map((c) => {
                const activeDeal = deals.find((d) => d.name === c.name && ACTIVE_STAGES.includes(d.stage));
                const clientDeal = deals.find((d) => d.name === c.name);
                const nPedidos = pedidos.filter((p) => p.client === c.name).length;
                return (
                  <div key={c.id} onClick={() => openClient(c.id)} className="op-card-hover"
                    style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 18px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div style={{ width: 36, height: 36, borderRadius: "50%", background: stripeFor(c.id), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 800, color: "#0A0F1E", flexShrink: 0 }}>
                        {c.name.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: C.text, fontFamily: "Manrope, sans-serif" }}>{c.name}</div>
                        <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{c.contact} · {nPedidos} pedido{nPedidos !== 1 ? "s" : ""}</div>
                      </div>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: activeDeal ? C.green : clientDeal && clientDeal.stage === LOST_STAGE ? C.red : C.amber }}>
                      {activeDeal ? fmtEUR(activeDeal.value) + "/mês" : clientDeal ? clientDeal.stage : "Prospect"}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {page === "financeiro" && !financeiroClientId && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, flexWrap: "wrap", gap: 10 }}>
              <div style={{ fontFamily: "Manrope, sans-serif", fontWeight: 700, fontSize: 20, color: C.text }}>Financeiro</div>
            </div>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 18 }}>Escolhe um cliente para ver o P&L, lançamentos e reconciliação bancária dele.</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {clients.map((c) => (
                <div key={c.id} onClick={() => setFinanceiroClientId(c.id)} className="op-card-hover"
                  style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 18px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ width: 36, height: 36, borderRadius: "50%", background: stripeFor(c.id), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 800, color: "#0A0F1E", flexShrink: 0 }}>
                      {c.name.charAt(0).toUpperCase()}
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: C.text, fontFamily: "Manrope, sans-serif" }}>{c.name}</div>
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 700, color: C.accent }}>Ver financeiro →</span>
                </div>
              ))}
              {clients.length === 0 && <div style={{ fontSize: 13, color: C.muted }}>Ainda não há clientes.</div>}
            </div>
          </>
        )}

        {page === "financeiro" && financeiroClientId && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
              <span onClick={() => setFinanceiroClientId(null)} style={{ cursor: "pointer", color: C.accent, fontSize: 13, fontWeight: 600 }}>← Clientes</span>
              <span style={{ color: C.border }}>/</span>
              <span style={{ fontSize: 18, fontWeight: 800, color: C.text, fontFamily: "Manrope, sans-serif" }}>
                {(clients.find((c) => c.id === financeiroClientId) || {}).name}
              </span>
            </div>
            <FinanceiroPanel clientId={financeiroClientId} clientName={(clients.find((c) => c.id === financeiroClientId) || {}).name} isEquipa={true} />
          </>
        )}
        </>
        )}
      </div>
    </div>
  );
}

// ================= CLIENT PORTAL =================
function ClientPortal({ profile }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [clientName, setClientName] = useState("");
  const [section, setSection] = useState("pedidos");
  const [pedidos, setPedidos] = useState([]);
  const [openPedidoId, setOpenPedidoId] = useState(null);
  const [step, setStep] = useState("idle");
  const [creatingType, setCreatingType] = useState(null);
  const [customTitle, setCustomTitle] = useState("");
  const [description, setDescription] = useState("");
  const [propertyId, setPropertyId] = useState("");
  const [files, setFiles] = useState([]);
  const [dueDate, setDueDate] = useState("");
  const [dueTime, setDueTime] = useState("");
  const [formError, setFormError] = useState("");
  const [filter, setFilter] = useState("todos");
  const [tipoFilter, setTipoFilter] = useState("todos");
  const [sortBy, setSortBy] = useState("recente");
  const [searchQuery, setSearchQuery] = useState("");
  const [justSubmitted, setJustSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const reloadPedidos = async () => setPedidos(await db.listPedidosForClient(profile.client_id));

  useEffect(() => {
    if (!profile.client_id) { setLoading(false); return; }
    Promise.all([
      db.getClient(profile.client_id).then((c) => setClientName(c.name)),
      reloadPedidos(),
    ]).catch((e) => setLoadError(e.message)).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!profile.client_id) return;
    const channel = sb.channel("cliente-realtime-" + profile.client_id)
      .on("postgres_changes", { event: "*", schema: "public", table: "pedidos", filter: `client_id=eq.${profile.client_id}` }, () => reloadPedidos())
      .on("postgres_changes", { event: "*", schema: "public", table: "pedido_mensagens" }, () => reloadPedidos())
      .subscribe();
    return () => sb.removeChannel(channel);
  }, [profile.client_id]);

  if (!profile.client_id) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 40, textAlign: "center" }}>
        <div style={{ maxWidth: 420, color: C.muted, fontSize: 14 }}>
          A sua conta ainda não está associada a nenhum cliente OPERA. Contacte a equipa OPERA para ativarmos o seu acesso ao portal.
        </div>
      </div>
    );
  }
  if (loading) return <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 13 }}>A carregar…</div>;
  if (loadError) return <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: C.red, fontSize: 13, padding: 24, textAlign: "center" }}>Erro ao carregar dados: {loadError}</div>;

  const lastActivity = (p) => {
    const times = [p.createdAt.getTime()];
    if (p.completedAt) times.push(p.completedAt.getTime());
    p.messages.forEach((m) => times.push(m.date.getTime()));
    return Math.max(...times);
  };
  const allMyPedidos = pedidos.slice().sort((a, b) => {
    if (sortBy === "data") return b.createdAt - a.createdAt;
    if (sortBy === "prazo") return a.due - b.due;
    if (sortBy === "estado") return OP_STAGES.indexOf(a.stage) - OP_STAGES.indexOf(b.stage);
    return lastActivity(b) - lastActivity(a);
  });
  const myPedidos = allMyPedidos.filter((p) => {
    if (filter === "curso" && p.stage === "Concluído") return false;
    if (filter === "concluidos" && p.stage !== "Concluído") return false;
    if (tipoFilter !== "todos" && p.type !== tipoFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      const haystack = `${pedidoTitle(p)} ${p.description || ""} ${p.propertyId || ""}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
  const openPedido = pedidos.find((p) => p.id === openPedidoId);

  const openPedidoSeen = (id) => {
    setPedidos((prev) => prev.map((p) => (p.id === id ? { ...p, clientSeen: true } : p)));
    db.markPedidoClientSeen(id).catch(() => {});
    setOpenPedidoId(id);
  };

  const resetForm = () => { setStep("idle"); setCreatingType(null); setCustomTitle(""); setDescription(""); setPropertyId(""); setFiles([]); setDueDate(""); setDueTime(""); setFormError(""); };
  const pickType = (type) => { setCreatingType(type); setCustomTitle(""); setStep("form"); };

  const handleFiles = (e) => {
    const chosen = Array.from(e.target.files || []).map((f) => ({ id: `${f.name}-${f.size}-${f.lastModified}-${Date.now()}`, file: f, name: f.name }));
    setFiles((prev) => [...prev, ...chosen]);
    e.target.value = "";
  };
  const removeFile = (id) => setFiles((prev) => prev.filter((f) => f.id !== id));

  const submitPedido = async () => {
    if (creatingType === "Pedido Aberto" && !customTitle.trim()) { setFormError("Dê um título ao seu pedido."); return; }
    if (!description.trim()) { setFormError("Por favor descreva o pedido."); return; }
    if (!dueDate) { setFormError("Por favor indique a data em que precisa do pedido."); return; }
    const due = new Date(`${dueDate}T${dueTime || "18:00"}:00`);
    setSubmitting(true);
    try {
      const created = await db.createPedido({
        client_id: profile.client_id,
        type: creatingType,
        custom_title: creatingType === "Pedido Aberto" ? customTitle.trim() : null,
        description: description.trim(),
        property_id: propertyId.trim() || null,
        stage: "Recebido",
        owner: "Equipa OPERA",
        due: due.toISOString(),
        seen: false,
      });
      for (const f of files) {
        await db.uploadAttachment(created.id, f.file, "cliente");
      }
      await reloadPedidos();
      resetForm();
      setJustSubmitted(true);
      setTimeout(() => setJustSubmitted(false), 4000);
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const FILTERS = [
    { key: "todos", label: "Todos" },
    { key: "curso", label: "Em Curso" },
    { key: "concluidos", label: "Concluídos" },
  ];

  return (
    <div style={{ flex: 1, padding: "24px 28px", overflowY: "auto" }}>
      {openPedido ? (
        <PedidoDetailClient pedido={openPedido} onClose={() => setOpenPedidoId(null)} onReload={reloadPedidos} />
      ) : (
      <>
      <div style={{ fontFamily: "Manrope, sans-serif", fontWeight: 800, fontSize: 22, color: C.text, marginBottom: 4 }}>Olá, {clientName} 👋</div>
      <div style={{ fontSize: 13, color: C.muted, marginBottom: 20 }}>Acompanhe aqui os seus pedidos e fale diretamente com a equipa OPERA.</div>

      <div style={{ display: "flex", gap: 4, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 4, width: "fit-content", marginBottom: 24 }}>
        {[{ key: "pedidos", label: "Pedidos", icon: "📋" }, { key: "financeiro", label: "Financeiro", icon: "📊" }].map((s) => (
          <span key={s.key} onClick={() => setSection(s.key)}
            style={{ padding: "8px 16px", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: "pointer", color: section === s.key ? "#fff" : C.muted, background: section === s.key ? C.accent : "transparent", display: "flex", alignItems: "center", gap: 6 }}>
            <span>{s.icon}</span>{s.label}
          </span>
        ))}
      </div>

      {section === "financeiro" && <FinanceiroPanel clientId={profile.client_id} clientName={clientName} isEquipa={false} />}

      {section === "pedidos" && <>
      {justSubmitted && (
        <div className="op-fade-in" style={{ background: "rgba(46,216,167,0.12)", border: `1px solid ${C.green}`, borderRadius: 8, padding: "12px 14px", marginBottom: 20, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 18 }}>✅</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.green }}>Pedido enviado com sucesso!</div>
            <div style={{ fontSize: 11, color: C.muted }}>A equipa OPERA foi notificada e vai começar a tratar disto em breve.</div>
          </div>
        </div>
      )}

      {step === "idle" && (
        <button onClick={() => setStep("picking")}
          style={{ background: C.accent, border: "none", borderRadius: 8, padding: "13px 22px", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer", marginBottom: 30, display: "flex", alignItems: "center", gap: 8, boxShadow: "0 4px 14px rgba(61,107,255,0.35)" }}>
          <span style={{ fontSize: 16 }}>＋</span> Novo Pedido
        </button>
      )}

      {step === "picking" && (
        <div className="op-fade-in" style={{ marginBottom: 30 }}>
          <SectionTitle>Que tipo de pedido é?</SectionTitle>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
            {[...PRESET_TYPES, "Pedido Aberto"].map((type) => (
              <button key={type} onClick={() => pickType(type)} className="op-type-btn"
                style={{
                  background: C.surface, color: C.text, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 16px", fontSize: 12.5, fontWeight: 600, cursor: "pointer",
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 6, width: 108, textAlign: "center",
                }}>
                <span style={{ fontSize: 22 }}>{TYPE_ICONS[type]}</span>
                {type}
              </button>
            ))}
          </div>
          <button onClick={resetForm} style={{ background: "transparent", border: "none", color: C.muted, fontSize: 12, cursor: "pointer" }}>Cancelar</button>
        </div>
      )}

      {step === "form" && (
        <div className="op-fade-in" style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, marginBottom: 30, maxWidth: 480 }}>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Tipo de pedido</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
            <span style={{ fontSize: 18 }}>{TYPE_ICONS[creatingType]}</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{creatingType}</span>
            <span onClick={() => setStep("picking")} style={{ fontSize: 11, color: C.accent, cursor: "pointer", marginLeft: "auto" }}>mudar tipo</span>
          </div>

          {creatingType === "Pedido Aberto" && (
            <>
              <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Título do pedido</div>
              <input value={customTitle} onChange={(e) => setCustomTitle(e.target.value)} placeholder="ex. Apoio para dossier de investidor"
                style={{ width: "100%", background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13, marginBottom: 14, boxSizing: "border-box" }} />
            </>
          )}

          <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Descreva o pedido</div>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Explique o que precisa..."
            style={{ width: "100%", background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13, marginBottom: 14, resize: "vertical", boxSizing: "border-box" }} />

          <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>ID do imóvel (opcional)</div>
          <input value={propertyId} onChange={(e) => setPropertyId(e.target.value)} placeholder="ex. LX-231"
            style={{ width: "100%", background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13, marginBottom: 14, boxSizing: "border-box" }} />

          <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Anexar fotos ou documentos</div>
          <label className="op-type-btn" style={{
            display: "flex", flexDirection: "column", alignItems: "center", gap: 4, border: `1.5px dashed ${C.border}`, borderRadius: 8,
            padding: "16px 10px", cursor: "pointer", marginBottom: 10, color: C.muted, fontSize: 12,
          }}>
            <span style={{ fontSize: 20 }}>📎</span>
            Clique para escolher ficheiros
            <input type="file" multiple onChange={handleFiles} style={{ display: "none" }} />
          </label>
          {files.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 14 }}>
              {files.map((f) => (
                <div key={f.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: C.text, background: C.surfaceRaised, borderRadius: 6, padding: "5px 8px" }}>
                  <span>📎 {f.name}</span>
                  <span onClick={() => removeFile(f.id)} style={{ cursor: "pointer", color: C.muted }}>×</span>
                </div>
              ))}
            </div>
          )}
          {files.length === 0 && <div style={{ marginBottom: 4 }} />}

          <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Para quando precisa? (data e hora)</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)}
              style={{ flex: 1, background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13 }} />
            <input type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)}
              style={{ width: 110, background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13 }} />
          </div>

          {formError && <div style={{ fontSize: 12, color: C.red, marginBottom: 10 }}>{formError}</div>}

          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={submitPedido} disabled={submitting} style={{ background: C.accent, border: "none", borderRadius: 6, padding: "8px 14px", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", opacity: submitting ? 0.7 : 1 }}>
              {submitting ? "A enviar..." : "Enviar pedido"}
            </button>
            <button onClick={resetForm} style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 14px", color: C.muted, fontSize: 13, cursor: "pointer" }}>Cancelar</button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 10 }}>
        <SectionTitle>Os meus pedidos</SectionTitle>
        <div style={{ display: "flex", gap: 4, background: C.surface, borderRadius: 8, padding: 4 }}>
          {FILTERS.map((f) => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              style={{ border: "none", background: filter === f.key ? C.accent : "transparent", color: filter === f.key ? "#fff" : C.muted, fontSize: 12, fontWeight: 600, padding: "6px 12px", borderRadius: 6, cursor: "pointer" }}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="🔍 Pesquisar por título, descrição ou ID do imóvel..."
          style={{ flex: "1 1 240px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "9px 12px", color: C.text, fontSize: 13, boxSizing: "border-box" }} />
        <select value={tipoFilter} onChange={(e) => setTipoFilter(e.target.value)}
          style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "9px 12px", color: C.text, fontSize: 13 }}>
          <option value="todos">Todos os tipos</option>
          {[...PRESET_TYPES, "Pedido Aberto"].map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}
          style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "9px 12px", color: C.text, fontSize: 13 }}>
          <option value="recente">Ordenar: Mais recente</option>
          <option value="data">Ordenar: Data de criação</option>
          <option value="prazo">Ordenar: Prazo mais próximo</option>
          <option value="estado">Ordenar: Estado do processo</option>
        </select>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {myPedidos.map((p) => {
          const meta = STAGE_META[p.stage];
          const stageIdx = OP_STAGES.indexOf(p.stage);
          return (
            <div key={p.id} onClick={() => openPedidoSeen(p.id)}
              className={`op-card-hover${!p.clientSeen ? " op-new-pulse" : ""}`}
              style={{
                background: C.surface, borderLeft: `4px solid ${meta.color}`, borderRadius: 10, padding: "14px 16px", cursor: "pointer", position: "relative",
                border: !p.clientSeen ? `1.5px solid ${C.amber}` : `1px solid ${C.border}`, borderLeftWidth: 4, borderLeftColor: meta.color,
              }}>
              {!p.clientSeen && (
                <span style={{ position: "absolute", top: -8, right: 8, background: C.amber, color: "#1a1400", fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 4, letterSpacing: 0.5 }}>
                  NOVO
                </span>
              )}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
                <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                  <div style={{ width: 34, height: 34, borderRadius: 8, background: `${meta.color}22`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>
                    {TYPE_ICONS[p.type] || "📄"}
                  </div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{pedidoTitle(p)}</div>
                    <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>Prazo: {fmtDateTime(p.due)}{p.propertyId ? ` · 🏠 ${p.propertyId}` : ""}</div>
                  </div>
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, color: meta.color, background: `${meta.color}22`, padding: "5px 10px", borderRadius: 6, whiteSpace: "nowrap" }}>
                  {meta.icon} {p.stage}
                </span>
              </div>
              <div style={{ display: "flex", gap: 4, marginTop: 12 }}>
                {OP_STAGES.map((s, i) => (
                  <div key={s} style={{ flex: 1, height: 4, borderRadius: 2, background: i <= stageIdx ? meta.color : C.border, transition: "background 0.3s" }} />
                ))}
              </div>
            </div>
          );
        })}
        {myPedidos.length === 0 && (
          <div style={{ fontSize: 13, color: C.muted, textAlign: "center", padding: "30px 0" }}>
            {allMyPedidos.length === 0 ? "Ainda não fez nenhum pedido — comece por criar um acima 👆" : "Sem pedidos nesta categoria."}
          </div>
        )}
      </div>

      </>}
      </>
      )}
    </div>
  );
}

// ================= AUTH / LOGIN =================
function useSession() {
  const [session, setSession] = useState(undefined);
  useEffect(() => {
    sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = sb.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  return session;
}

function LoginScreen() {
  const [mode, setMode] = useState("magic"); // magic | password
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submitMagic = async () => {
    if (!email.trim()) return;
    setBusy(true); setError("");
    try {
      const { error } = await sb.auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: window.location.origin + window.location.pathname },
      });
      if (error) throw error;
      setSent(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = async () => {
    if (!email.trim() || !password) return;
    setBusy(true); setError("");
    try {
      const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
    } catch (e) {
      setError("Email ou password incorretos.");
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (m) => { setMode(m); setError(""); setSent(false); };

  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 360, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 28 }}>
        <div style={{ fontFamily: "Manrope, sans-serif", fontWeight: 800, fontSize: 20, color: C.text, marginBottom: 6 }}>Entrar na OPERA CRM</div>

        <div style={{ display: "flex", gap: 4, background: C.surfaceRaised, borderRadius: 8, padding: 4, marginBottom: 18 }}>
          <button onClick={() => switchMode("magic")}
            style={{ flex: 1, border: "none", background: mode === "magic" ? C.accent : "transparent", color: mode === "magic" ? "#fff" : C.muted, fontSize: 12, fontWeight: 600, padding: "8px 0", borderRadius: 6, cursor: "pointer" }}>
            Link por email
          </button>
          <button onClick={() => switchMode("password")}
            style={{ flex: 1, border: "none", background: mode === "password" ? C.accent : "transparent", color: mode === "password" ? "#fff" : C.muted, fontSize: 12, fontWeight: 600, padding: "8px 0", borderRadius: 6, cursor: "pointer" }}>
            Password
          </button>
        </div>

        {mode === "magic" ? (
          sent ? (
            <div style={{ background: "rgba(46,216,167,0.12)", border: `1px solid ${C.green}`, borderRadius: 8, padding: "12px 14px", fontSize: 13, color: C.green }}>
              ✅ Link enviado para {email}. Verifique o seu email.
            </div>
          ) : (
            <>
              <div style={{ fontSize: 13, color: C.muted, marginBottom: 14 }}>Indique o seu email para receber um link de acesso.</div>
              <input value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitMagic()} type="email" placeholder="oseu@email.pt"
                style={{ width: "100%", background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "10px 12px", color: C.text, fontSize: 13, marginBottom: 14, boxSizing: "border-box" }} />
              {error && <div style={{ fontSize: 12, color: C.red, marginBottom: 12 }}>{error}</div>}
              <button onClick={submitMagic} disabled={busy} style={{ width: "100%", background: C.accent, border: "none", borderRadius: 6, padding: "10px 0", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", opacity: busy ? 0.7 : 1 }}>
                {busy ? "A enviar..." : "Enviar link de acesso"}
              </button>
            </>
          )
        ) : (
          <>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 14 }}>Entre com o seu email e password. Se ainda não definiu uma, use o "Link por email" e depois defina uma nas definições.</div>
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="oseu@email.pt"
              style={{ width: "100%", background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "10px 12px", color: C.text, fontSize: 13, marginBottom: 10, boxSizing: "border-box" }} />
            <input value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitPassword()} type="password" placeholder="Password"
              style={{ width: "100%", background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "10px 12px", color: C.text, fontSize: 13, marginBottom: 14, boxSizing: "border-box" }} />
            {error && <div style={{ fontSize: 12, color: C.red, marginBottom: 12 }}>{error}</div>}
            <button onClick={submitPassword} disabled={busy} style={{ width: "100%", background: C.accent, border: "none", borderRadius: 6, padding: "10px 0", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", opacity: busy ? 0.7 : 1 }}>
              {busy ? "A entrar..." : "Entrar"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function CenteredMessage({ children }) {
  return <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 13 }}>{children}</div>;
}

// ================= APP ROOT =================
function SetPasswordButton() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const save = async () => {
    setMsg("");
    if (password.length < 6) { setMsg("A password precisa de pelo menos 6 caracteres."); return; }
    if (password !== confirm) { setMsg("As passwords não coincidem."); return; }
    setBusy(true);
    try {
      const { error } = await sb.auth.updateUser({ password });
      if (error) throw error;
      setMsg("Password definida com sucesso!");
      setPassword(""); setConfirm("");
      setTimeout(() => { setOpen(false); setMsg(""); }, 1500);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <span onClick={() => setOpen(true)} style={{ cursor: "pointer", fontSize: 12, color: C.muted, textDecoration: "underline" }}>
        Definir password
      </span>
    );
  }

  return (
    <div style={{ position: "absolute", top: 50, right: 20, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, zIndex: 1100, width: 260, boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 10 }}>Definir password</div>
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Nova password"
        style={{ width: "100%", background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13, marginBottom: 8, boxSizing: "border-box" }} />
      <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Confirmar password"
        style={{ width: "100%", background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.text, fontSize: 13, marginBottom: 10, boxSizing: "border-box" }} />
      {msg && <div style={{ fontSize: 12, color: msg.includes("sucesso") ? C.green : C.red, marginBottom: 10 }}>{msg}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={save} disabled={busy} style={{ flex: 1, background: C.accent, border: "none", borderRadius: 6, padding: "8px 0", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Guardar</button>
        <button onClick={() => { setOpen(false); setMsg(""); }} style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 12px", color: C.muted, fontSize: 12, cursor: "pointer" }}>Cancelar</button>
      </div>
    </div>
  );
}

function OperaCRM() {
  const session = useSession();
  const [profile, setProfile] = useState(undefined);
  const [profileError, setProfileError] = useState("");

  useEffect(() => {
    if (session) {
      db.getProfile(session.user.id).then(setProfile).catch((e) => setProfileError(e.message));
    } else if (session === null) {
      setProfile(undefined);
      setProfileError("");
    }
  }, [session]);

  const signOut = () => sb.auth.signOut();

  let body;
  if (session === undefined) body = <CenteredMessage>A carregar…</CenteredMessage>;
  else if (session === null) body = <LoginScreen />;
  else if (profileError) body = <CenteredMessage>Erro ao carregar perfil: {profileError}</CenteredMessage>;
  else if (!profile) body = <CenteredMessage>A carregar…</CenteredMessage>;
  else if (profile.role === "equipa") body = <EquipaApp profile={profile} />;
  else body = <ClientPortal profile={profile} />;

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh", width: "100%", background: C.bg, fontFamily: "Inter, sans-serif" }}>
      <style>{FONT_IMPORT}</style>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: `1px solid ${C.border}`, background: C.surface, flexWrap: "wrap", gap: 10, flexShrink: 0, position: "relative" }}>
        <div style={{ fontFamily: "Manrope, sans-serif", fontWeight: 800, fontSize: 16, color: C.text }}>OPERA <span style={{ color: C.accent }}>CRM</span></div>
        {session && profile && (
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <span style={{ fontSize: 12, color: C.muted }}>{profile.full_name || session.user.email}</span>
            <SetPasswordButton />
            <button onClick={signOut} style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 12px", color: C.muted, fontSize: 12, cursor: "pointer" }}>Sair</button>
          </div>
        )}
      </div>
      <div style={{ display: "flex", flex: 1, position: "relative", minHeight: 0, minWidth: 0, overflow: "hidden" }}>
        {body}
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<OperaCRM />);
