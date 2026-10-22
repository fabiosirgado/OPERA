// Regras de negócio do pipeline (secção 6 do documento), testadas pela API com utilizadores reais.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadEnv, USERS, signIn, signInWithMfa } from "./helpers.js";

const env = loadEnv();
const suite = env ? describe : describe.skip;

suite("Pipeline e regras de negócio", () => {
  let admin, gestor, aUser, aAdmin, bAdmin, clientA, clientB, stages, aUserId;
  const created = [];

  const create = async (sb, p) => {
    const { data, error } = await sb.rpc("leads_create", { p });
    if (error) throw error;
    created.push(data);
    return data;
  };
  const lead = async (id) => (await admin.from("leads").select("*").eq("id", id).single()).data;
  const openTasks = async (id) =>
    (await admin.from("lead_tasks").select("*").eq("lead_id", id).is("done_at", null).is("canceled_at", null)).data;

  beforeAll(async () => {
    admin = await signInWithMfa(env, USERS.admin, "TOTP_ADMIN");
    gestor = await signInWithMfa(env, USERS.gestor, "TOTP_GESTOR");
    aUser = await signIn(env, USERS.aUser);
    aAdmin = await signIn(env, USERS.aAdmin);
    bAdmin = await signIn(env, USERS.bAdmin);
    aUserId = (await aUser.auth.getUser()).data.user.id;
    const { data: cl } = await admin.from("clients").select("id,name").in("name", ["Cliente Teste A", "Cliente Teste B"]);
    clientA = cl.find((c) => c.name === "Cliente Teste A").id;
    clientB = cl.find((c) => c.name === "Cliente Teste B").id;
    const { data: st } = await admin.from("lead_stages").select("id,key").not("key", "is", null);
    stages = Object.fromEntries(st.map((s) => [s.key, s.id]));
  });

  afterAll(async () => {
    if (admin && created.length) await admin.from("leads").delete().in("id", created);
  });

  describe("entrada de leads", () => {
    it("a etapa inicial depende da origem e a lead nasce sem tarefa", async () => {
      const meta = await lead(await create(gestor, { client_id: clientA, name: "Origem Meta", phone: "911111111", source: "Meta" }));
      const port = await lead(await create(gestor, { client_id: clientA, name: "Origem Idealista", phone: "911111112", source: "Idealista" }));
      const bd = await lead(await create(gestor, { client_id: clientA, name: "Origem BD", phone: "911111113", source: "Referência" }));
      expect([meta.stage_id, meta.entry_stage]).toEqual([stages.meta, "meta"]);
      expect([port.stage_id, port.entry_stage]).toEqual([stages.imoveis, "imoveis"]);
      expect([bd.stage_id, bd.entry_stage]).toEqual([stages.bd, "bd"]);
      expect(await openTasks(meta.id)).toHaveLength(0);
      expect(meta.next_task_at).toBeNull();
    });
    it("deteta duplicados pelo telefone normalizado, no mesmo cliente", async () => {
      const id = await create(gestor, { client_id: clientA, name: "Dup Original", phone: "+351 922 333 444", source: "Meta" });
      const { data } = await gestor.rpc("leads_find_duplicate", { p_client_id: clientA, p_phone: "922333444", p_email: null });
      expect(data[0]?.id).toBe(id);
      const { data: other } = await gestor.rpc("leads_find_duplicate", { p_client_id: clientB, p_phone: "922333444", p_email: null });
      expect(other).toHaveLength(0);
    });
    it("o cliente escolhe entre a OPERA contactar ou ficar com a lead", async () => {
      const opera = await lead(await create(aUser, { client_id: clientA, name: "Do cliente para a OPERA", phone: "933000001", source: "Idealista", stage: "auto" }));
      expect(opera.stage_id).toBe(stages.imoveis);
      expect(await openTasks(opera.id)).toHaveLength(0);
      const own = await lead(await create(aUser, { client_id: clientA, name: "Fico eu", phone: "933000002", stage: "qualificada" }));
      expect(own.stage_id).toBe(stages.qualificada);
      expect(await openTasks(own.id)).toHaveLength(0);
      const { data: notif } = await gestor.from("lead_notifications").select("kind").eq("lead_id", opera.id);
      expect(notif.map((n) => n.kind)).toContain("nova_lead_do_cliente");
    });
    it("o cliente não cria leads noutras etapas nem noutros clientes", async () => {
      expect((await aUser.rpc("leads_create", { p: { client_id: clientA, name: "X", stage: "followup" } })).error).toBeTruthy();
      expect((await aUser.rpc("leads_create", { p: { client_id: clientB, name: "X" } })).error).toBeTruthy();
    });
  });

  describe("chamadas e etapas", () => {
    it("ligar soma tentativa, fecha a Chamada e passa para Follow Up OPERA", async () => {
      const id = await create(gestor, { client_id: clientA, name: "Para ligar", phone: "944000001", source: "Meta" });
      await gestor.from("lead_tasks").insert({ lead_id: id, type: "call", due_at: new Date().toISOString() });
      expect((await gestor.rpc("leads_register_call", { p_lead_id: id, p_meta: { answered: false } })).error).toBeNull();
      const l = await lead(id);
      expect(l.attempts).toBe(1);
      expect(l.first_call_at).toBeTruthy();
      expect(l.stage_id).toBe(stages.followup);
      expect(l.entry_stage).toBe("meta");
      expect(await openTasks(id)).toHaveLength(0);
      expect(l.next_task_at).toBeNull();
      const { data: ev } = await gestor.from("lead_events").select("type").eq("lead_id", id);
      expect(ev.map((e) => e.type)).toEqual(expect.arrayContaining(["call", "stage"]));
    });
    it("o cliente não regista chamadas", async () => {
      const id = await create(gestor, { client_id: clientA, name: "Sem chamada do cliente", phone: "944000002", stage: "qualificada" });
      expect((await aUser.rpc("leads_register_call", { p_lead_id: id })).error).toBeTruthy();
    });
    it("Lead Qualificada cancela tarefas, cria Follow up a 24 h e põe o aviso na fila", async () => {
      const id = await create(gestor, { client_id: clientA, name: "A qualificar", phone: "944000003", source: "Meta" });
      await gestor.from("lead_tasks").insert({ lead_id: id, type: "meeting", due_at: new Date(Date.now() + 864e5).toISOString() });
      await gestor.from("leads").update({ stage_id: stages.qualificada }).eq("id", id);
      const open = await openTasks(id);
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ type: "followup", note: "Confirmar com o cliente" });
      const hours = (new Date(open[0].due_at) - Date.now()) / 3600e3;
      expect(hours).toBeGreaterThan(23.5);
      const { data: notif } = await gestor.from("lead_notifications").select("kind,status").eq("lead_id", id);
      expect(notif).toEqual([{ kind: "qualificada", status: "pendente" }]);
    });
    it("Lead desqualificada cancela as tarefas em aberto", async () => {
      const id = await create(gestor, { client_id: clientA, name: "A desqualificar", phone: "944000004", source: "Meta" });
      await gestor.from("lead_tasks").insert({ lead_id: id, type: "call", due_at: new Date().toISOString() });
      await gestor.from("leads").update({ stage_id: stages.desq }).eq("id", id);
      expect(await openTasks(id)).toHaveLength(0);
      expect((await lead(id)).next_task_at).toBeNull();
    });
  });

  describe("notas", () => {
    it("ficam marcadas como editadas e o autor não muda", async () => {
      const id = await create(gestor, { client_id: clientA, name: "Com nota", stage: "qualificada" });
      const { data: n } = await aUser.from("lead_events")
        .insert({ lead_id: id, type: "note", title: "Nota", body: "Primeira", author_id: aUserId }).select().single();
      const { data: e } = await aUser.from("lead_events").update({ body: "Corrigida", pinned: true }).eq("id", n.id).select().single();
      expect(e.edited_at).toBeTruthy();
      expect(e.pinned).toBe(true);
      const { error } = await gestor.from("lead_events").update({ author_id: null }).eq("id", n.id);
      expect(error).toBeTruthy();
    });
  });

  describe("consultas no servidor", () => {
    it("o pipeline pagina e ordena no servidor e mostra a nota afixada", async () => {
      const { data } = await gestor.rpc("leads_pipeline", { p_client: clientA, p_sort: "name", p_limit: 2 });
      expect(data).toHaveLength(2);
      const { data: page2 } = await gestor.rpc("leads_pipeline", { p_client: clientA, p_sort: "name", p_offset: 2, p_limit: 2 });
      expect(page2[0].name.localeCompare(data[1].name)).toBeGreaterThanOrEqual(0);
      const names = data.map((r) => r.name);
      expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
      const { data: pinned } = await gestor.rpc("leads_pipeline", { p_client: clientA, p_q: "Com nota" });
      expect(pinned[0].pinned_note).toBe("Corrigida");
    });
    it("o cliente só vê as suas leads no pipeline, nos totais e na pesquisa", async () => {
      const { data } = await bAdmin.rpc("leads_pipeline", { p_limit: 200 });
      expect(data.every((r) => r.client_id === clientB)).toBe(true);
      const { data: counts } = await bAdmin.rpc("leads_pipeline_counts", {});
      const totalB = counts.reduce((n, c) => n + Number(c.n), 0);
      expect(totalB).toBe(data.length);
      const { data: s } = await bAdmin.rpc("leads_search", { p_q: "Origem" });
      expect(s).toHaveLength(0);
      const { data: sa } = await aAdmin.rpc("leads_search", { p_q: "Origem" });
      expect(sa.length).toBeGreaterThanOrEqual(3);
    });
    it("o filtro de texto trata % e _ como letras", async () => {
      const { data } = await gestor.rpc("leads_pipeline_counts", { p_client: clientA, p_q: "%" });
      expect(Object.values(data).length).toBe(0);
    });
    it("a pesquisa encontra pelo telefone e pelas notas", async () => {
      const { data: byPhone } = await gestor.rpc("leads_search", { p_q: "+351 944 000 001" });
      expect(byPhone.map((r) => r.name)).toContain("Para ligar");
      const { data: byNote } = await gestor.rpc("leads_search", { p_q: "Corrigida" });
      expect(byNote[0]).toMatchObject({ name: "Com nota", found_in: "notas" });
    });
    it("a lista Hoje mostra as tarefas em aberto até amanhã", async () => {
      const { data: l } = await gestor.from("leads").select("id").eq("name", "Origem Meta").single();
      await gestor.from("lead_tasks").insert({ lead_id: l.id, type: "call", due_at: new Date(Date.now() + 3600e3).toISOString() });
      const { data } = await gestor.rpc("leads_today", { p_client: clientA });
      expect(data.some((t) => t.lead_name === "Origem Meta" && t.task_type === "call")).toBe(true);
    });
    it("os indicadores do topo contam do lado do servidor", async () => {
      const { data } = await gestor.rpc("leads_pipeline_kpis", { p_client: clientA });
      expect(Number(data[0].entraram_hoje)).toBeGreaterThanOrEqual(5);
      expect(Number(data[0].por_contactar)).toBeGreaterThanOrEqual(3);
    });
  });
});
