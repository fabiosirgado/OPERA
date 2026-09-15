const { useState, useEffect, useMemo } = React;
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
.op-fade-in { animation: opFadeIn 0.3s ease; }`;

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
const PRESET_TYPES = ["Nova Angariação", "CPCV", "Preparação de Escritura", "Factura", "Alteração de Anúncio", "Campanha de Marketing", "Relatório Financeiro", "Suporte Técnico"];
const TYPE_ICONS = {
  "Nova Angariação": "🏠", "CPCV": "📝", "Preparação de Escritura": "⚖️", "Factura": "🧾",
  "Alteração de Anúncio": "📢", "Campanha de Marketing": "📣", "Relatório Financeiro": "📊",
  "Suporte Técnico": "🛠️", "Pedido Aberto": "💬",
};
const ACTIVE_STAGES = ["Em Onboarding", "Entrega de Serviço"];
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

// ================= DATA LAYER (Supabase) =================
const PEDIDO_SELECT = "*, clients(id,name), pedido_tasks(*), pedido_notes(*), pedido_attachments(*), pedido_mensagens(*)";

function mapDeal(row) {
  return {
    id: row.id, clientId: row.client_id, name: row.name, contact: row.contact,
    value: Number(row.value) || 0, stage: row.stage, owner: row.owner,
    date: new Date(row.created_at), stageEnteredAt: new Date(row.stage_entered_at),
  };
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
    attachments: attachments.map((a) => ({ id: a.id, name: a.name, storagePath: a.storage_path })),
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
  async uploadAttachment(pedidoId, file) {
    const path = `${pedidoId}/${Date.now()}_${file.name}`;
    const { error: upErr } = await sb.storage.from("attachments").upload(path, file);
    if (upErr) throw upErr;
    const { error } = await sb.from("pedido_attachments").insert({ pedido_id: pedidoId, name: file.name, storage_path: path });
    if (error) throw error;
  },
  async getAttachmentUrl(path) {
    const { data, error } = await sb.storage.from("attachments").createSignedUrl(path, 600);
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

  // -- portal access linking (profiles <-> clients) --
  async listProfilesByClient(clientId) {
    const { data, error } = await sb.from("profiles").select("*").eq("client_id", clientId);
    if (error) throw error;
    return data;
  },
  async listUnlinkedClienteProfiles() {
    const { data, error } = await sb.from("profiles").select("*").eq("role", "cliente").is("client_id", null);
    if (error) throw error;
    return data;
  },
  async linkProfileToClient(profileId, clientId) {
    const { error } = await sb.from("profiles").update({ client_id: clientId }).eq("id", profileId);
    if (error) throw error;
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

function ChatThread({ messages, onSend, senderRole }) {
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
            <div key={m.id} style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start", gap: 8, flexDirection: mine ? "row-reverse" : "row" }}>
              <div style={{ width: 24, height: 24, borderRadius: "50%", background: mine ? C.accent : C.surfaceRaised, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, flexShrink: 0 }}>{avatar}</div>
              <div style={{ maxWidth: "75%", background: mine ? C.accent : C.surfaceRaised, color: mine ? "#fff" : C.text, borderRadius: 10, padding: "8px 11px" }}>
                <div style={{ fontSize: 10, opacity: 0.75, marginBottom: 3 }}>{m.sender === "cliente" ? "Cliente" : "Equipa OPERA"}</div>
                <div style={{ fontSize: 13 }}>{m.text}</div>
                <div style={{ fontSize: 9, opacity: 0.6, marginTop: 3 }}>{fmtDateTime(m.date)}</div>
              </div>
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

  return (
    <SidePanel onClose={onClose} eyebrow={pedido.client}>
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

      {pedido.attachments.length > 0 && (
        <>
          <SectionTitle>Ficheiros do cliente</SectionTitle>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 18 }}>
            {pedido.attachments.map((a) => (
              <div key={a.id} onClick={() => openAttachment(a)} style={{ fontSize: 13, color: C.text, background: C.surfaceRaised, borderRadius: 8, padding: "8px 10px", cursor: "pointer" }}>📎 {a.name}</div>
            ))}
          </div>
        </>
      )}

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
      <ChatThread messages={pedido.messages} onSend={sendMessage} senderRole="equipa" />
    </SidePanel>
  );
}

// ---------- Client-facing pedido detail (stage tracker + chat only) ----------
function PedidoDetailClient({ pedido, onClose, onReload }) {
  const run = async (fn) => { try { await fn(); await onReload(); } catch (e) { alert(e.message); } };
  const sendMessage = (text) => run(() => db.sendMessage(pedido.id, "cliente", text));
  const openAttachment = (a) => db.getAttachmentUrl(a.storagePath).then((url) => window.open(url, "_blank")).catch((e) => alert(e.message));
  const currentIndex = OP_STAGES.indexOf(pedido.stage);

  return (
    <SidePanel onClose={onClose} eyebrow={pedido.client}>
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

      {pedido.attachments.length > 0 && (
        <>
          <SectionTitle>Ficheiros enviados</SectionTitle>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 18 }}>
            {pedido.attachments.map((a) => (
              <div key={a.id} onClick={() => openAttachment(a)} style={{ fontSize: 13, color: C.text, background: C.surfaceRaised, borderRadius: 8, padding: "8px 10px", cursor: "pointer" }}>📎 {a.name}</div>
            ))}
          </div>
        </>
      )}

      <SectionTitle>Conversa com a OPERA</SectionTitle>
      <ChatThread messages={pedido.messages} onSend={sendMessage} senderRole="cliente" />
    </SidePanel>
  );
}

// ---------- Client detail panel (ficha de cliente, estilo Pipedrive) ----------
function ClientDetail({ client, deals, setDeals, setClients, pedidos, extra, onUpdateExtra, onClose, onOpenPedido }) {
  const [tab, setTab] = useState("geral");
  const [newNote, setNewNote] = useState("");
  const [newActType, setNewActType] = useState("Tarefa");
  const [newActText, setNewActText] = useState("");
  const [newActDue, setNewActDue] = useState("");
  const [editingContact, setEditingContact] = useState(false);
  const [contactDraft, setContactDraft] = useState({ contact: client.contact, email: client.email, phone: client.phone });
  const [linkedProfiles, setLinkedProfiles] = useState([]);
  const [unlinkedProfiles, setUnlinkedProfiles] = useState([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");

  useEffect(() => {
    db.listProfilesByClient(client.id).then(setLinkedProfiles).catch(() => {});
    db.listUnlinkedClienteProfiles().then(setUnlinkedProfiles).catch(() => {});
  }, [client.id]);

  const linkProfile = async () => {
    if (!selectedProfileId) return;
    try {
      await db.linkProfileToClient(selectedProfileId, client.id);
      const linked = unlinkedProfiles.find((p) => p.id === selectedProfileId);
      setLinkedProfiles((prev) => [...prev, linked]);
      setUnlinkedProfiles((prev) => prev.filter((p) => p.id !== selectedProfileId));
      setSelectedProfileId("");
    } catch (e) { alert(e.message); }
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
  const dealIsTerminal = pipelineDeal && (pipelineDeal.stage === "Closed" || pipelineDeal.stage === LOST_STAGE);
  const markDealStage = async (stage) => {
    setDeals((prev) => prev.map((d) => (d.id === pipelineDeal.id ? { ...d, stage, stageEnteredAt: new Date() } : d)));
    try { await db.updateDeal(pipelineDeal.id, { stage, stage_entered_at: new Date().toISOString() }); } catch (e) { alert(e.message); }
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
    { key: "alertas", label: `Alertas${alerts.length ? ` (${alerts.length})` : ""}` },
  ];

  return (
    <SidePanel onClose={onClose} eyebrow="Ficha de Cliente" width={460}>
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
        <MetricCard label="Estado" value={activeDeal ? "Ativo" : "Prospect"} color={activeDeal ? C.green : C.amber} />
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
                {!dealIsTerminal && (
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => markDealStage("Closed")} style={{ flex: 1, background: C.green, border: "none", borderRadius: 6, padding: "8px 0", color: "#06281c", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Ganho</button>
                    <button onClick={() => markDealStage(LOST_STAGE)} style={{ flex: 1, background: "transparent", border: `1px solid ${C.red}`, borderRadius: 6, padding: "8px 0", color: C.red, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Perdido</button>
                  </div>
                )}
              </div>
            </>
          )}

          <SectionTitle>Acesso ao portal</SectionTitle>
          <div style={{ background: C.surfaceRaised, borderRadius: 8, padding: 12, marginBottom: 18 }}>
            {linkedProfiles.length === 0 && <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>Ainda ninguém tem acesso ao portal para este cliente.</div>}
            {linkedProfiles.map((p) => (
              <div key={p.id} style={{ fontSize: 13, color: C.text, marginBottom: 6 }}>👤 {p.full_name || p.email || p.id}</div>
            ))}
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <select value={selectedProfileId} onChange={(e) => setSelectedProfileId(e.target.value)}
                style={{ flex: 1, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 8px", color: C.text, fontSize: 12 }}>
                <option value="">Associar conta registada…</option>
                {unlinkedProfiles.map((p) => <option key={p.id} value={p.id}>{p.email || p.full_name || p.id}</option>)}
              </select>
              <button onClick={linkProfile} disabled={!selectedProfileId} style={{ background: C.accent, border: "none", borderRadius: 6, padding: "6px 12px", color: "#fff", fontSize: 12, cursor: "pointer", opacity: selectedProfileId ? 1 : 0.5 }}>Associar</button>
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
    </SidePanel>
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
  const [addingDeal, setAddingDeal] = useState(false);
  const [newDeal, setNewDeal] = useState({ name: "", value: "", owner: "Fábio", contact: "", email: "", phone: "" });
  const [addingClient, setAddingClient] = useState(false);
  const [newClient, setNewClient] = useState({ name: "", contact: "", email: "", phone: "" });

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

  const openClient = (id) => { setOpenClientId(id); reloadClientExtra(id); };

  const periodDays = PERIODS.find((p) => p.key === period).days;

  const metrics = useMemo(() => {
    const inPeriod = (d) => withinPeriod(d.date, periodDays);
    const countStage = (stage) => deals.filter((d) => d.stage === stage && inPeriod(d)).length;
    const activeClients = deals.filter((d) => ACTIVE_STAGES.includes(d.stage));
    const mrr = activeClients.reduce((sum, d) => sum + d.value, 0);
    const arr = mrr * 12;
    const closedInPeriod = deals.filter((d) => d.stage === "Closed" && inPeriod(d));
    const faturacao = closedInPeriod.reduce((sum, d) => sum + d.value, 0);
    const totalLeadsAllTime = deals.length;
    const totalClosedAllTime = deals.filter((d) => ["Closed", "Em Onboarding", "Entrega de Serviço"].includes(d.stage)).length;
    const conversao = totalLeadsAllTime > 0 ? Math.round((totalClosedAllTime / totalLeadsAllTime) * 100) : 0;
    const closedAllValues = deals.filter((d) => ["Closed", "Em Onboarding", "Entrega de Serviço"].includes(d.stage));
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
    setDeals((prev) => prev.map((d) => (d.id === id ? { ...d, stage, stageEnteredAt: new Date() } : d)));
    db.updateDeal(id, { stage, stage_entered_at: new Date().toISOString() }).catch((e) => { alert(e.message); reloadDeals(); });
  };
  const onAdvanceDeal = (id) => {
    const deal = deals.find((d) => d.id === id);
    if (!deal) return;
    const idx = STAGE_ORDER.indexOf(deal.stage);
    const next = idx >= 0 && idx < STAGE_ORDER.length - 1 ? STAGE_ORDER[idx + 1] : deal.stage;
    setDeals((prev) => prev.map((d) => (d.id === id ? { ...d, stage: next, stageEnteredAt: new Date() } : d)));
    db.updateDeal(id, { stage: next, stage_entered_at: new Date().toISOString() }).catch((e) => { alert(e.message); reloadDeals(); });
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

      <div key={page} className="op-fade-in" style={{ flex: 1, padding: "24px 28px", overflowX: "hidden", minWidth: 0, overflowY: "auto" }}>
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
              </div>
            </div>
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
                    <div style={{ fontSize: 13, fontWeight: 700, color: activeDeal ? C.green : C.amber }}>{activeDeal ? fmtEUR(activeDeal.value) + "/mês" : "Prospect"}</div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {openPedido && <PedidoDetailInternal pedido={openPedido} onClose={() => setOpenPedidoId(null)} onReload={reloadPedidos} />}
      {openClientObj && (
        <ClientDetail client={openClientObj} deals={deals} setDeals={setDeals} setClients={setClients} pedidos={pedidos}
          extra={clientExtra[openClientObj.id] || { notes: [], activities: [] }}
          onUpdateExtra={(updated) => setClientExtra((prev) => ({ ...prev, [openClientObj.id]: updated }))}
          onClose={() => setOpenClientId(null)}
          onOpenPedido={(id) => { setOpenClientId(null); openPedidoSeen(id); }} />
      )}
    </div>
  );
}

// ================= CLIENT PORTAL =================
function ClientPortal({ profile }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [clientName, setClientName] = useState("");
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

  const allMyPedidos = pedidos.slice().sort((a, b) => b.createdAt - a.createdAt);
  const myPedidos = allMyPedidos.filter((p) => {
    if (filter === "curso") return p.stage !== "Concluído";
    if (filter === "concluidos") return p.stage === "Concluído";
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
        await db.uploadAttachment(created.id, f.file);
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
      <div style={{ fontFamily: "Manrope, sans-serif", fontWeight: 800, fontSize: 22, color: C.text, marginBottom: 4 }}>Olá, {clientName} 👋</div>
      <div style={{ fontSize: 13, color: C.muted, marginBottom: 24 }}>Acompanhe aqui os seus pedidos e fale diretamente com a equipa OPERA.</div>

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

      {openPedido && <PedidoDetailClient pedido={openPedido} onClose={() => setOpenPedidoId(null)} onReload={reloadPedidos} />}
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
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
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

  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ width: "100%", maxWidth: 360, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 28 }}>
        <div style={{ fontFamily: "Manrope, sans-serif", fontWeight: 800, fontSize: 20, color: C.text, marginBottom: 6 }}>Entrar na OPERA CRM</div>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 20 }}>Indique o seu email para receber um link de acesso.</div>
        {sent ? (
          <div style={{ background: "rgba(46,216,167,0.12)", border: `1px solid ${C.green}`, borderRadius: 8, padding: "12px 14px", fontSize: 13, color: C.green }}>
            ✅ Link enviado para {email}. Verifique o seu email.
          </div>
        ) : (
          <>
            <input value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} type="email" placeholder="oseu@email.pt"
              style={{ width: "100%", background: C.surfaceRaised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "10px 12px", color: C.text, fontSize: 13, marginBottom: 14, boxSizing: "border-box" }} />
            {error && <div style={{ fontSize: 12, color: C.red, marginBottom: 12 }}>{error}</div>}
            <button onClick={submit} disabled={busy} style={{ width: "100%", background: C.accent, border: "none", borderRadius: 6, padding: "10px 0", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", opacity: busy ? 0.7 : 1 }}>
              {busy ? "A enviar..." : "Enviar link de acesso"}
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
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: `1px solid ${C.border}`, background: C.surface, flexWrap: "wrap", gap: 10, flexShrink: 0 }}>
        <div style={{ fontFamily: "Manrope, sans-serif", fontWeight: 800, fontSize: 16, color: C.text }}>OPERA <span style={{ color: C.accent }}>CRM</span></div>
        {session && profile && (
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <span style={{ fontSize: 12, color: C.muted }}>{profile.full_name || session.user.email}</span>
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
