// Importar e exportar Excel no browser (SheetJS). A gravação e os duplicados ficam no servidor.
import * as XLSX from "xlsx";
import { QUAL_FIELDS, TASK_TYPES } from "./format.js";

// Colunas reconhecidas pelo nome (sem acentos, minúsculas), como no protótipo.
export const FIELD_MAP = {
  name: ["nome", "name", "cliente final", "contacto nome"],
  phone: ["telemovel", "telefone", "contacto", "phone", "tel", "numero"],
  email: ["email", "mail", "e mail", "correio"],
  source: ["origem", "fonte", "source", "canal"],
  interest: ["interesse", "imovel", "procura"],
  budget: ["budget", "orcamento", "valor"],
  stage: ["etapa", "estado", "fase", "stage"],
  labels: ["etiqueta", "etiquetas", "label", "labels", "tags"],
  note: ["nota", "notas", "obs", "observacoes", "comentario"],
  client: ["cliente", "consultor", "conta"],
  date: ["data", "criado", "data de entrada"],
};
export const FIELD_LABEL = {
  name: "Nome", phone: "Telemóvel", email: "Email", source: "Origem", interest: "Interesse ou imóvel", budget: "Budget",
  stage: "Etapa", labels: "Etiquetas", note: "Nota", client: "Cliente", date: "Data de entrada", skip: "Não importar",
};

export const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();

export function guessField(header) {
  const n = norm(header);
  for (const [f, syn] of Object.entries(FIELD_MAP)) if (syn.some((s) => n === s || n.startsWith(s))) return f;
  return "skip";
}

// Etapa: primeiro o nome exato, depois termos parecidos. stages: etapas visíveis para o cliente.
export function matchStage(value, clientId, stages) {
  if (!value) return null;
  const n = norm(value);
  const fits = stages.filter((s) => s.client_id === null || s.client_id === clientId);
  const exact = fits.find((s) => norm(s.name) === n);
  if (exact) return exact.id;
  const byKey = (k) => stages.find((s) => s.key === k)?.id ?? null;
  if (/desq|perd|sem interesse/.test(n)) return byKey("desq");
  if (/qualif/.test(n)) return byKey("qualificada");
  if (/follow|tent|contact|convers/.test(n)) return byKey("followup");
  if (/meta|facebook|instagram/.test(n)) return byKey("meta");
  if (/imov|portal|idealista|casa sapo/.test(n)) return byKey("imoveis");
  if (/nov|bd|base/.test(n)) return byKey("bd");
  return null;
}

export function matchClient(value, clients) {
  if (!value) return null;
  const n = norm(value);
  const exact = clients.find((c) => norm(c.name) === n);
  if (exact) return exact.id;
  const c = clients.find((c) => norm(c.name).includes(n) || n.includes(norm(c.name).split(" ")[0]));
  return c ? c.id : null;
}

// Lê a primeira folha. Devolve { headers, rows } com as linhas como objetos { coluna: valor }.
export function readWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: "array", cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "", raw: true });
  const headers = rows.length ? Object.keys(rows[0]) : [];
  return { headers, rows };
}

const cell = (v) => (v instanceof Date ? v.toISOString() : String(v ?? "").trim());

// Prepara as linhas para o servidor e separa as que têm problemas.
// imp: { rows, map: {coluna: campo}, client: id | "__col", stage: id | "__col" }
export function buildRows(imp, clients, stages) {
  const col = (f) => Object.keys(imp.map).find((h) => imp.map[h] === f);
  const valid = [], bad = [];
  const bd = stages.find((s) => s.key === "bd")?.id;
  imp.rows.forEach((r, i) => {
    const g = (f) => { const h = col(f); return h ? cell(r[h]) : ""; };
    const clientId = imp.client === "__col" ? matchClient(g("client"), clients) : imp.client;
    const stageId = imp.stage === "__col" ? (matchStage(g("stage"), clientId, stages) || bd) : imp.stage;
    const o = {
      line: i + 2, client_id: clientId, stage_id: stageId, name: g("name"), phone: g("phone"), email: g("email"),
      source: g("source") || "Base de dados", interest: g("interest"), budget: g("budget"),
      labels: g("labels").split(/[,;|]/).map((x) => x.trim()).filter(Boolean), note: g("note"),
      source_date: /^\d{4}-\d{2}-\d{2}/.test(g("date")) ? g("date") : null,
    };
    const why = !clientId ? "Cliente não reconhecido" : !o.name ? "Sem nome" : !o.phone && !o.email ? "Sem telemóvel nem email" : null;
    if (why) bad.push({ ...o, why }); else valid.push(o);
  });
  return { valid, bad };
}

// Linhas para exportar. pipedrive: formato pronto para importar no Pipedrive.
export function exportRows(list, { history = false, pipedrive = false } = {}) {
  const when = (d) => (d ? new Date(d).toLocaleString("pt-PT") : "");
  return list.map((l) => {
    if (pipedrive) {
      return {
        Nome: l.nome, Telefone: l.telemovel || "", Email: l.email || "",
        Titulo: l.nome + (l.interesse ? ` · ${l.interesse}` : ""), Origem: l.origem || "",
        Nota: [l.notas_afixadas, history ? l.historico : ""].filter(Boolean).join("\n"),
      };
    }
    const r = {
      Cliente: l.cliente, Nome: l.nome, "Telemóvel": l.telemovel || "", Email: l.email || "", Origem: l.origem || "",
      Interesse: l.interesse || "", Etapa: l.etapa, Entrada: when(l.entrada),
      "Próxima tarefa": l.proxima_tarefa ? `${TASK_TYPES[l.proxima_tarefa]} ${when(l.proxima_tarefa_em)}` : "",
      Tentativas: l.tentativas, "Último contacto": when(l.ultimo_contacto), "Responsável": l.responsavel || "",
      Etiquetas: l.etiquetas || "", "Notas afixadas": l.notas_afixadas || "",
    };
    for (const q of QUAL_FIELDS) r[q] = (l.qualificacao || {})[q] || "";
    if (history) r["Histórico"] = l.historico || "";
    return r;
  });
}

export function downloadXlsx(rows, fileName) {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Leads");
  XLSX.writeFile(wb, fileName);
}

export const TEMPLATE_ROWS = [{
  Cliente: "Nome do cliente", Nome: "Exemplo Silva", "Telemóvel": "912345678", Email: "exemplo@email.pt", Origem: "Referência",
  Interesse: "T2 Lisboa", Budget: "300 000 €", Etapa: "Nova Lead BD", Etiquetas: "Quente, Comprador", Nota: "",
}];

export const fileSafe = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase();
