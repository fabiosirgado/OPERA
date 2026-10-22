// Pequenas peças visuais do protótipo: ícones, etiquetas de cliente, de etiqueta e de tarefa.
import { LABEL_COLORS, TASK_TYPES, clientSoft } from "../lib/format.js";

const svg = (size, children) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">{children}</svg>
);
export const Icon = {
  clock: () => svg(15, <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  phone: () => svg(16, <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" />),
  plus: () => svg(22, <path d="M12 5v14M5 12h14" />),
  search: () => svg(16, <><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></>),
  pin: () => svg(13, <path d="M12 17v5M8 3h8l-1 6 3 4H6l3-4z" />),
};

export function ClientTag({ name, color }) {
  const [bg, fg] = clientSoft(color);
  return <span className="tag" style={{ background: bg, color: fg }}>{name}</span>;
}

export function LabelTag({ label }) {
  if (!label) return null;
  const [bg, fg] = LABEL_COLORS[label.color] || LABEL_COLORS.cinzento;
  return <span className="tag" style={{ background: bg, color: fg }}>{label.name}</span>;
}

export function LabelTags({ ids, labels }) {
  const list = (ids || []).map((id) => labels.find((l) => l.id === id)).filter(Boolean);
  if (!list.length) return null;
  return <div className="tags">{list.map((l) => <LabelTag key={l.id} label={l} />)}</div>;
}

export const TaskTag = ({ type }) => <span className={`ttag tt-${type}`}>{TASK_TYPES[type]}</span>;
