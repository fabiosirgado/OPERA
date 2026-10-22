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
