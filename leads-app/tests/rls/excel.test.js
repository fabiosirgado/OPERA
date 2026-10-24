// Importar e exportar Excel: regras no servidor, testadas pela API com utilizadores reais.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadEnv, USERS, signIn, signInWithMfa } from "./helpers.js";

const env = loadEnv();
const suite = env ? describe : describe.skip;
const TAG = `Imp${Date.now() % 100000}`;

suite("Importar e exportar", () => {
  let admin, gestor, aAdmin, bAdmin, clientA, clientB, stages;

  const row = (line, extra) => ({ line, client_id: clientA, stage_id: stages.bd, name: `${TAG} ${line}`, phone: `96${String(1000000 + line)}`, source: "Base de dados", labels: [], ...extra });
  const batch = async (sb, rows, dup = "ignore") => {
    const { data, error } = await sb.rpc("leads_import_batch", { p_rows: rows, p_dup: dup, p_file: "teste.xlsx" });
    if (error) throw error;
    return data;
  };
  const byName = async (name) => (await admin.from("leads").select("*, lead_tasks(*), lead_events(*), links:lead_label_links(label_id)").eq("name", name).single()).data;

  beforeAll(async () => {
    admin = await signInWithMfa(env, USERS.admin, "TOTP_ADMIN");
    gestor = await signInWithMfa(env, USERS.gestor, "TOTP_GESTOR");
    aAdmin = await signIn(env, USERS.aAdmin);
    bAdmin = await signIn(env, USERS.bAdmin);
    const { data: cl } = await admin.from("clients").select("id,name").in("name", ["Cliente Teste A", "Cliente Teste B"]);
    clientA = cl.find((c) => c.name === "Cliente Teste A").id;
    clientB = cl.find((c) => c.name === "Cliente Teste B").id;
    const { data: st } = await admin.from("lead_stages").select("id,key").not("key", "is", null);
    stages = Object.fromEntries(st.map((s) => [s.key, s.id]));
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.from("leads").delete().like("name", `${TAG}%`);
    await admin.from("lead_labels").delete().like("name", `${TAG}%`);
  });

  it("os clientes não importam", async () => {
    expect((await aAdmin.rpc("leads_import_batch", { p_rows: [row(2)], p_dup: "ignore", p_file: "x" })).error).toBeTruthy();
    expect((await aAdmin.rpc("leads_import_check", { p_rows: [] })).error).toBeTruthy();
  });

  it("cria leads novas como BD, sem tarefa, com nota e etiquetas (as novas a cinzento)", async () => {
    const r = await batch(gestor, [row(2, { source: "Meta", note: "Veio de uma feira", labels: ["Quente", `${TAG} Nova`] })]);
    expect(r).toMatchObject({ created: 1, updated: 0, ignored: 0, errors: [] });
    const l = await byName(`${TAG} 2`);
    expect(l.entry_stage).toBe("bd");
    expect(l.imported).toBe(true); // histórico: não conta como lead que entrou no dashboard
    expect(l.lead_tasks).toHaveLength(0);
    expect(l.next_task_at).toBeNull();
    expect(l.lead_events.map((e) => e.title)).toEqual(expect.arrayContaining(["Lead importada de Excel", "Nota"]));
    expect(l.links).toHaveLength(2);
    const { data: lab } = await gestor.from("lead_labels").select("color").eq("name", `${TAG} Nova`).single();
    expect(lab.color).toBe("cinzento");
  });

  it("deteta duplicados antes de importar", async () => {
    const { data } = await gestor.rpc("leads_import_check", { p_rows: [
      { i: 0, client_id: clientA, phone: "+351 961 000 002", email: null },
      { i: 1, client_id: clientB, phone: "961000002", email: null },
      { i: 2, client_id: clientA, phone: "960000000", email: null },
    ] });
    expect(data.map((d) => d.i)).toEqual([0]);
  });

  it("duplicados: ignorar, atualizar dados em falta ou criar na mesma", async () => {
    expect(await batch(gestor, [row(2)], "ignore")).toMatchObject({ created: 0, ignored: 1 });
    expect(await batch(gestor, [row(2, { email: "novo@exemplo.pt", budget: "200 000 €", interest: "T3" })], "fill")).toMatchObject({ updated: 1 });
    const l = await byName(`${TAG} 2`);
    expect(l).toMatchObject({ email: "novo@exemplo.pt", interest: "T3" });
    expect(l.qualification.Budget).toBe("200 000 €");
    const r = await batch(gestor, [row(2, { name: `${TAG} 2 cópia` })], "create");
    expect(r.created).toBe(1);
  });

  it("devolve os erros com a linha do Excel", async () => {
    const r = await batch(gestor, [
      row(5, { client_id: "00000000-0000-0000-0000-000000000000" }),
      row(6, { phone: "", email: "" }),
      row(7, { name: "" }),
      row(8),
    ]);
    expect(r.created).toBe(1);
    expect(r.errors.map((e) => [e.line, e.reason])).toEqual([
      [5, "Cliente não reconhecido"], [6, "Sem telemóvel nem email"], [7, "Sem nome"],
    ]);
  });

  it("cada cliente exporta só as suas leads; a equipa OPERA exporta por cliente", async () => {
    const { data: b } = await bAdmin.rpc("leads_export", { p_client: clientA });
    expect(b.total).toBe(0);
    const { data: own } = await aAdmin.rpc("leads_export", {});
    expect(own.rows.every((r) => r.cliente === "Cliente Teste A")).toBe(true);
    const { data: g } = await gestor.rpc("leads_export", { p_client: clientA, p_history: true });
    const mine = g.rows.find((r) => r.nome === `${TAG} 2`);
    expect(mine.historico).toMatch(/Lead importada de Excel/);
    expect(mine.etiquetas).toMatch(/Quente/);
  });

  it("a exportação filtra por etapas e pagina de 1000 em 1000", async () => {
    const { data } = await gestor.rpc("leads_export", { p_client: clientA, p_stages: [stages.qualificada] });
    expect(data.rows.every((r) => r.etapa === "Lead Qualificada")).toBe(true);
    const { data: p2 } = await gestor.rpc("leads_export", { p_client: clientA, p_offset: 1000 });
    expect(p2.rows).toHaveLength(Math.max(0, p2.total - 1000));
  });

  it("importações e exportações ficam no registo de atividade", async () => {
    await gestor.rpc("leads_log_import", { p_file: "teste.xlsx", p_created: 3, p_updated: 1, p_ignored: 1, p_errors: 3 });
    const { data } = await admin.from("audit_log").select("action,detail").order("created_at", { ascending: false }).limit(20);
    expect(data.map((a) => a.action)).toEqual(expect.arrayContaining(["importacao", "exportacao"]));
  });
});
