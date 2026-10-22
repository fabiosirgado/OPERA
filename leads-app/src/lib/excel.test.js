import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { buildRows, exportRows, guessField, matchClient, matchStage, readWorkbook } from "./excel.js";

const stages = [
  { id: "s-meta", key: "meta", name: "Nova Lead Meta", client_id: null },
  { id: "s-imo", key: "imoveis", name: "Nova lead imóveis", client_id: null },
  { id: "s-bd", key: "bd", name: "Nova Lead BD", client_id: null },
  { id: "s-fu", key: "followup", name: "Follow Up OPERA", client_id: null },
  { id: "s-q", key: "qualificada", name: "Lead Qualificada", client_id: null },
  { id: "s-d", key: "desq", name: "Lead desqualificada", client_id: null },
  { id: "s-a", key: null, name: "Proposta enviada", client_id: "c-a" },
];
const clients = [{ id: "c-a", name: "Teixeira & Felizardo" }, { id: "c-b", name: "Bruno Fernandes" }];

describe("reconhecimento de colunas", () => {
  it("reconhece os nomes habituais, com e sem acentos", () => {
    expect(guessField("Telemóvel")).toBe("phone");
    expect(guessField("E-mail")).toBe("email");
    expect(guessField("Orçamento")).toBe("budget");
    expect(guessField("Etiquetas")).toBe("labels");
    expect(guessField("Observações")).toBe("note");
    expect(guessField("Coluna X")).toBe("skip");
  });
});

describe("etapas e clientes", () => {
  it("usa primeiro o nome exato e depois termos parecidos", () => {
    expect(matchStage("Lead Qualificada", "c-a", stages)).toBe("s-q");
    expect(matchStage("proposta ENVIADA", "c-a", stages)).toBe("s-a");
    expect(matchStage("Proposta enviada", "c-b", stages)).toBeNull();
    expect(matchStage("Perdido", "c-a", stages)).toBe("s-d");
    expect(matchStage("Em contacto", "c-a", stages)).toBe("s-fu");
    expect(matchStage("Facebook", "c-a", stages)).toBe("s-meta");
  });
  it("reconhece o cliente pelo nome", () => {
    expect(matchClient("teixeira & felizardo", clients)).toBe("c-a");
    expect(matchClient("Bruno", clients)).toBe("c-b");
    expect(matchClient("Desconhecido", clients)).toBeNull();
  });
});

describe("preparação das linhas", () => {
  it("separa as linhas com problemas e indica a linha do Excel", () => {
    const imp = {
      rows: [
        { Nome: "Ana", Tel: "912 000 111", Etapa: "Lead Qualificada", Etiquetas: "Quente; Novo" },
        { Nome: "", Tel: "912 000 222" },
        { Nome: "Sem contacto", Tel: "" },
      ],
      map: { Nome: "name", Tel: "phone", Etapa: "stage", Etiquetas: "labels" },
      client: "c-a", stage: "__col",
    };
    const { valid, bad } = buildRows(imp, clients, stages);
    expect(valid).toHaveLength(1);
    expect(valid[0]).toMatchObject({ line: 2, stage_id: "s-q", labels: ["Quente", "Novo"], source: "Base de dados" });
    expect(bad.map((b) => [b.line, b.why])).toEqual([[3, "Sem nome"], [4, "Sem telemóvel nem email"]]);
  });
  it("sem coluna Etapa reconhecível, entra em Nova Lead BD", () => {
    const imp = { rows: [{ Nome: "A", Email: "a@x.pt", Etapa: "???" }], map: { Nome: "name", Email: "email", Etapa: "stage" }, client: "c-b", stage: "__col" };
    expect(buildRows(imp, clients, stages).valid[0].stage_id).toBe("s-bd");
  });
});

describe("ficheiros", () => {
  it("lê um Excel gerado e devolve as colunas e as linhas", () => {
    const ws = XLSX.utils.json_to_sheet([{ Nome: "Ana", "Telemóvel": "912000111" }, { Nome: "Rui", "Telemóvel": "933000222" }]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Leads");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    const { headers, rows } = readWorkbook(buf);
    expect(headers).toEqual(["Nome", "Telemóvel"]);
    expect(rows).toHaveLength(2);
  });
  it("exporta no formato normal e no formato Pipedrive", () => {
    const l = { cliente: "A", nome: "Ana", telemovel: "912", email: "a@x.pt", origem: "Meta", interesse: "T2", etapa: "Nova Lead Meta",
      entrada: "2026-10-22T10:00:00Z", tentativas: 1, qualificacao: { Budget: "300 000 €" }, notas_afixadas: "Ligar à tarde", historico: "linha 1" };
    const [normal] = exportRows([l], { history: true });
    expect(normal).toMatchObject({ Cliente: "A", Nome: "Ana", Budget: "300 000 €", "Histórico": "linha 1" });
    const [pipe] = exportRows([l], { history: true, pipedrive: true });
    expect(pipe).toEqual({ Nome: "Ana", Telefone: "912", Email: "a@x.pt", Titulo: "Ana · T2", Origem: "Meta", Nota: "Ligar à tarde\nlinha 1" });
  });
});
