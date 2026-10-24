export const ROLE_LABEL = {
  admin: "Admin OPERA",
  gestor: "Gestor de leads",
  cliente_admin: "Admin do cliente",
  cliente: "Utilizador do cliente",
};

export const OPERA_ROLES = ["admin", "gestor"];
export const MAX_CLIENTS_PER_MANAGER = 8;
export const RETENTION_MONTHS = 6;

// Cores para os clientes, iguais às do protótipo.
export const CLIENT_COLORS = ["#3B6FE0", "#E07B3B", "#2E9E5B", "#8B5CF6", "#DB2777", "#0EA5E9", "#CA8A04", "#475569"];

const dateFmt = new Intl.DateTimeFormat("pt-PT", { day: "numeric", month: "short", year: "numeric" });
const whenFmt = new Intl.DateTimeFormat("pt-PT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export const fmtDate = (d) => (d ? dateFmt.format(new Date(d)) : "");
export const fmtWhen = (d) => (d ? whenFmt.format(new Date(d)) : "");

export const initials = (name) =>
  (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");

export const errorText = (e) => (e && (e.message || e.error)) || "Ocorreu um erro. Tenta outra vez.";

// ---------- Fase 2: pipeline e ficha da lead
export const TASK_TYPES = { call: "Chamada", meeting: "Reunião", followup: "Follow up" };
export const SOURCES = ["Meta", "Idealista", "Imovirtual", "Casa Sapo", "Base de dados", "Referência", "Chamada recebida", "Evento", "Outra"];
export const QUAL_FIELDS = ["Objetivo", "Budget", "Prazo", "Financiamento", "Tem imóvel para vender", "Disponibilidade para visita"];
export const ENTRY_KEYS = ["meta", "imoveis", "bd"];
export const QUALIFIED_POSITION = 50;
export const PAGE = 50;

export const LABEL_COLORS = {
  vermelho: ["#FDE2E2", "#991B1B", "Vermelho"], laranja: ["#FDE4D2", "#9A3412", "Laranja"],
  amarelo: ["#FEF3C7", "#854D0E", "Amarelo"], verde: ["#DDF3E4", "#166534", "Verde"],
  azul: ["#DCE8FF", "#1E3A8A", "Azul"], roxo: ["#ECE3FB", "#5B21B6", "Roxo"],
  rosa: ["#FCE7F3", "#9D174D", "Rosa"], cinzento: ["#E5E7EB", "#374151", "Cinzento"],
};

// Cores suaves para as etiquetas de cliente, iguais às do protótipo.
const CLIENT_SOFT = {
  "#3B6FE0": ["#DCE8FF", "#1E3A8A"], "#E07B3B": ["#FDE4D2", "#9A3412"], "#2E9E5B": ["#DDF3E4", "#166534"],
  "#8B5CF6": ["#ECE3FB", "#5B21B6"], "#DB2777": ["#FCE7F3", "#9D174D"], "#0EA5E9": ["#E0F2FE", "#075985"],
  "#CA8A04": ["#FEF3C7", "#854D0E"], "#475569": ["#E5E7EB", "#374151"],
};
export const clientSoft = (color) => CLIENT_SOFT[color] || ["#E5E7EB", "#374151"];

const hhmm = (d) => d.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
// "Hoje 10:30", "Ontem 18:00", "Amanhã 09:00" ou "22/10 10:30", como no protótipo.
export function fmtRel(ts) {
  if (!ts) return "";
  const d = new Date(ts), n = new Date();
  const y = new Date(n); y.setDate(n.getDate() - 1);
  const t = new Date(n); t.setDate(n.getDate() + 1);
  if (d.toDateString() === n.toDateString()) return `Hoje ${hhmm(d)}`;
  if (d.toDateString() === y.toDateString()) return `Ontem ${hhmm(d)}`;
  if (d.toDateString() === t.toDateString()) return `Amanhã ${hhmm(d)}`;
  return `${d.toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit" })} ${hhmm(d)}`;
}

export function ago(ts) {
  const m = Math.round((Date.now() - new Date(ts)) / 60000);
  if (m < 60) return `há ${Math.max(m, 0)} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `há ${h} h`;
  return `há ${Math.round(h / 24)} dias`;
}

export function fmtDur(min) {
  if (min == null || Number.isNaN(min)) return "";
  if (min < 1) return "< 1 min";
  if (min < 60) return `${Math.round(min)} min`;
  if (min < 1440) return `${(min / 60).toFixed(1).replace(".", ",")} h`;
  return `${(min / 1440).toFixed(1).replace(".", ",")} dias`;
}

// Valor para <input type="datetime-local"> na hora local.
export function localInput(ts) {
  const d = new Date(ts);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export const digits = (p) => String(p || "").replace(/\D/g, "").replace(/^(00)?351(?=\d{9}$)/, "");
export const waLink = (phone) => { const d = digits(phone); return `https://wa.me/${d.length === 9 ? `351${d}` : d}`; };
