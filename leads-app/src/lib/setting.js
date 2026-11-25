// Setting B2B (docs/setting/especificacao_setting.md). Cada cliente tem um tipo de serviço: imobiliário (todos os
// clientes de sempre, sem nenhuma mudança) ou setting. Num cliente de setting as etapas base mantêm as chaves e
// mostram outro nome (lead_stages.name_setting), a etapa "imoveis" fica escondida, os campos de qualificação são os
// do cliente e há quatro etapas do cliente com o resultado da reunião (lead_stages.outcome).
import { QUAL_FIELDS } from "./format.js";

export const OUTCOMES = [["compareceu", "Compareceu"], ["nao_compareceu", "Não compareceu"], ["fechado", "Fechado"], ["perdido", "Perdido"]];
const HIDDEN_KEYS = new Set(["imoveis"]);
// Campos de imobiliário de sempre, no formato dos campos por cliente.
const IMOB_FIELDS = QUAL_FIELDS.map((key) => ({ key, type: "texto" }));

// cfg: lista de { id, service_type, qual_fields, desq_reasons } (uma linha por cliente).
export function makeSetting(stages, cfg, clients = []) {
  const byClient = new Map((cfg || []).map((c) => [c.id, c]));
  const idByName = new Map(clients.map((c) => [c.name, c.id]));
  const isSetting = (cid) => byClient.get(cid)?.service_type === "setting";
  const stageName = (s, cid) => (s && s.name_setting && isSetting(cid) ? s.name_setting : s?.name ?? "");
  // Nomes que vêm já escritos do servidor (stage_name): troca o nome base pelo de setting quando o cliente é de setting.
  const baseToSetting = new Map(stages.filter((s) => s.name_setting && !s.client_id).map((s) => [s.name, s.name_setting]));
  const label = (name, cid) => (isSetting(cid) && baseToSetting.has(name) ? baseToSetting.get(name) : name);
  // O mesmo quando a linha só traz o nome do cliente (pesquisa, Hoje).
  const labelByClientName = (name, clientName) => label(name, idByName.get(clientName));
  // Etapas que um cliente vê (as de todos e as dele), já com o nome certo. Sem cliente: as de todos, como antes.
  const stagesFor = (cid) => stages
    .filter((s) => s.client_id === null || s.client_id === cid)
    .filter((s) => !(isSetting(cid) && HIDDEN_KEYS.has(s.key)))
    .map((s) => (isSetting(cid) && s.name_setting ? { ...s, name: s.name_setting } : s));
  const qualFields = (cid) => {
    const c = byClient.get(cid);
    if (isSetting(cid)) return Array.isArray(c?.qual_fields) ? c.qual_fields : [];
    return Array.isArray(c?.qual_fields) && c.qual_fields.length ? c.qual_fields : IMOB_FIELDS;
  };
  const desqReasons = (cid) => byClient.get(cid)?.desq_reasons || [];
  const hosts = (cid) => byClient.get(cid)?.meeting_hosts || [];
  const bookingUrl = (cid) => byClient.get(cid)?.booking_url || null;
  const outcomeStage = (cid, outcome) => stages.find((s) => s.client_id === cid && s.outcome === outcome);
  const settingClients = (clients) => clients.filter((c) => isSetting(c.id));
  return { isSetting, stageName, label, labelByClientName, stagesFor, qualFields, desqReasons, hosts, bookingUrl, outcomeStage, settingClients };
}

// Data e hora locais de um timestamp, para os campos <input type="date"> e <input type="time">.
export const meetingParts = (iso) => {
  if (!iso) return { date: "", time: "" };
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}` };
};
export const meetingIso = (date, time) => (date && time ? new Date(`${date}T${time}`).toISOString() : null);
export const fmtMeeting = (iso) => (iso
  ? new Intl.DateTimeFormat("pt-PT", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso))
  : "");

// Link da agenda de marcações do cliente, com o nome e o email da lead já preenchidos onde a agenda o aceita
// (Calendly e Cal.com). Noutras agendas o link segue tal como está.
export function bookingLink(url, lead) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (/(^|\.)calendly\.com$/i.test(u.hostname) || /(^|\.)cal\.com$/i.test(u.hostname)) {
      if (lead?.name) u.searchParams.set("name", lead.name);
      if (lead?.email) u.searchParams.set("email", lead.email);
      if (/calendly\.com$/i.test(u.hostname)) { u.searchParams.set("embed_type", "Inline"); u.searchParams.set("embed_domain", window.location.hostname); }
    }
    return u.toString();
  } catch { return null; }
}
