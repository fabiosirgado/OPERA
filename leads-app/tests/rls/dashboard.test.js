// Dashboard: os números calculados no servidor, verificados com um cenário conhecido num cliente próprio.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadEnv, USERS, anonClient, signIn, signInWithMfa } from "./helpers.js";

const env = loadEnv();
const suite = env ? describe : describe.skip;
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
// O Time to Lead conta só o horário de trabalho (segunda a sexta, 9:30 às 19:00): as leads com chamada ficam num dia
// útil recente às 11:00 UTC (11:00 ou 12:00 em Lisboa), para o resultado não depender da hora a que o teste corre.
const FIXED_HOLIDAYS = ["01-01", "04-25", "05-01", "06-10", "08-15", "10-05", "11-01", "12-01", "12-08", "12-25"];
const workday = (() => {
  for (let back = 1; back < 7; back++) {
    const d = new Date(Date.now() - back * 86400000);
    if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5 && !FIXED_HOLIDAYS.includes(d.toISOString().slice(5, 10))) {
      return d.toISOString().slice(0, 10);
    }
  }
  throw new Error("Sem dia útil nos últimos 6 dias.");
})();
const at = (hhmm) => `${workday}T${hhmm}:00Z`;

suite("Dashboard", () => {
  let admin, gestor, aAdmin, clientD, stages, me;

  beforeAll(async () => {
    admin = await signInWithMfa(env, USERS.admin, "TOTP_ADMIN");
    gestor = await signInWithMfa(env, USERS.gestor, "TOTP_GESTOR");
    aAdmin = await signIn(env, USERS.aAdmin);
    me = (await gestor.auth.getUser()).data.user.id;
    const { data: st } = await admin.from("lead_stages").select("id,key").not("key", "is", null);
    stages = Object.fromEntries(st.map((s) => [s.key, s.id]));

    // Cliente só para este teste, sempre o mesmo.
    let { data: c } = await admin.from("clients").select("id,leads_status").eq("name", "Cliente Dashboard").maybeSingle();
    if (!c) ({ data: c } = await admin.from("clients").insert({ name: "Cliente Dashboard", leads_enabled: true }).select("id,leads_status").single());
    if (c.leads_status === "inativo") await admin.rpc("leads_reactivate_client", { p_client_id: c.id });
    clientD = c.id;
    await admin.from("leads").delete().eq("client_id", clientD);

    const lead = async (row) => {
      const { data, error } = await gestor.from("leads").insert({ client_id: clientD, ...row }).select("id").single();
      if (error) throw error;
      return data.id;
    };
    const event = (lead_id, row) => gestor.from("lead_events").insert({ lead_id, author_id: me, ...row });

    // 1 e 2: Time to Lead de 10 e 40 minutos (Meta e portal).
    const l1 = await lead({ name: "D1", source: "Meta", entry_stage: "meta", stage_id: stages.followup, created_at: at("11:00"), first_call_at: at("11:10") });
    const l2 = await lead({ name: "D2", source: "Idealista", entry_stage: "imoveis", stage_id: stages.followup, created_at: at("10:20"), first_call_at: at("11:00") });
    // 3: Meta por contactar.
    await lead({ name: "D3", source: "Meta", entry_stage: "meta", stage_id: stages.meta, created_at: ago(60) });
    // 4: BD trabalhada e recuperada (passou a qualificada).
    const l4 = await lead({ name: "D4", source: "Base de dados", entry_stage: "bd", stage_id: stages.qualificada, created_at: ago(2 * 1440),
      qualification: { Objetivo: "Comprador, Crédito" } });
    // 5: Meta desqualificada sem chamada (não conta como por contactar).
    const l5 = await lead({ name: "D5", source: "Meta", entry_stage: "meta", stage_id: stages.desq, created_at: ago(30) });

    await event(l1, { type: "call", title: "Chamada", meta: { answered: true }, created_at: at("11:10") });
    await event(l2, { type: "call", title: "Chamada", meta: { answered: false }, created_at: at("11:00") });
    await event(l4, { type: "call", title: "Chamada", meta: { answered: true }, created_at: ago(100) });
    await event(l4, { type: "stage", from_stage_id: stages.followup, to_stage_id: stages.qualificada, created_at: ago(90) });
    await event(l5, { type: "stage", from_stage_id: stages.meta, to_stage_id: stages.desq, created_at: ago(20) });
    // 6: lead importada (histórico de outro sistema) com uma chamada antiga importada: não conta em nada.
    const l6 = await lead({ name: "D6", source: "Remax", entry_stage: "bd", stage_id: stages.followup, created_at: ago(60), imported: true });
    await event(l6, { type: "call", title: "Chamada (Pipedrive)", meta: { imported: true, answered: true }, created_at: ago(50) });

    await gestor.from("lead_tasks").insert([
      { lead_id: l1, type: "call", due_at: ago(200), done_at: ago(110) },
      { lead_id: l2, type: "meeting", due_at: ago(60), done_at: ago(50) },
      { lead_id: l2, type: "followup", due_at: ago(1440) },
    ]);
  });

  afterAll(async () => {
    if (admin && clientD) await admin.from("leads").delete().eq("client_id", clientD);
  });

  it("calcula o Time to Lead só com leads Meta e de portais", async () => {
    const { data: d, error } = await gestor.rpc("leads_dashboard", { p_client: clientD, p_period: "7" });
    expect(error).toBeNull();
    expect(d.ttl_n).toBe(2);
    expect(d.ttl_median).toBeCloseTo(25, 0);
    expect(d.ttl_avg).toBeCloseTo(25, 0);
    expect(d.ttl_in_target).toBe(1);
    expect(d.ttl_in_60).toBe(2);
    expect(d.pending).toBe(1);
    expect(d.ttl_buckets).toEqual([1, 0, 1, 0, 0, 1]);
  });

  it("o Time to Lead conta só o horário de trabalho, sem fins de semana nem feriados", async () => {
    const cases = [
      ["2026-10-26T10:00:00+00:00", "2026-10-26T10:12:00+00:00", 12], // segunda, dentro do horário
      ["2026-10-24T15:00:00+01:00", "2026-10-26T09:40:00+00:00", 10], // sábado, ligada segunda às 9:40
      ["2026-10-24T15:00:00+01:00", "2026-10-26T09:15:00+00:00", 0],  // ligada antes de abrir
      ["2026-10-23T18:50:00+01:00", "2026-10-26T09:40:00+00:00", 20], // sexta 18:50, segunda 9:40
      ["2026-10-27T20:30:00+00:00", "2026-10-28T09:45:00+00:00", 15], // depois das 19:00
      ["2026-12-31T18:00:00+00:00", "2027-01-04T09:40:00+00:00", 70], // 1 de janeiro é feriado
      ["2027-03-26T10:00:00+00:00", "2027-03-29T09:40:01+01:00", 10], // Sexta Feira Santa
    ];
    for (const [from, to, minutes] of cases) {
      const { data, error } = await gestor.rpc("leads_business_minutes", { p_from: from, p_to: to });
      expect(error).toBeNull();
      expect(Number(data)).toBeCloseTo(minutes, 0);
    }
  });

  it("conta entradas, chamadas, atividades, qualificação e recuperadas", async () => {
    const { data: d } = await gestor.rpc("leads_dashboard", { p_client: clientD, p_period: "7" });
    expect(d.leads_in).toBe(5);
    expect([d.calls, d.answered]).toEqual([3, 2]);
    expect(d.acts).toEqual({ call: 1, meeting: 1, followup: 0 });
    expect([d.qual, d.desq]).toEqual([1, 1]);
    expect([d.recovered, d.bd_worked]).toEqual([1, 1]);
    expect(d.overdue).toBe(1);
    expect(d.by_source.find((s) => s.l === "Meta").v).toBe(3);
    expect(d.per_day).toHaveLength(7);
    expect(d.per_day.reduce((n, x) => n + x.v, 0)).toBe(5);
    const row = d.per_client.find((c) => c.id === clientD);
    expect(row).toMatchObject({ leads_in: 5, calls: 3, qual: 1, desq: 1, recovered: 1, overdue: 1, ttl_in_target: 1 });
    // Qualificadas por tipo: uma lead pode contar em mais de um.
    expect(d.qual_types).toEqual({ comprador: 1, proprietario: 0, credito: 1, sem_tipo: 0 });
  });

  it("um cliente interno não conta no dashboard geral, só quando é escolhido", async () => {
    const kpis = async (c) => (await gestor.rpc("leads_pipeline_kpis", { p_client: c })).data[0];
    const antes = await kpis(null);
    expect((await aAdmin.rpc("leads_set_client_internal", { p_client_id: clientD, p_internal: true })).error).toBeTruthy();
    expect((await admin.rpc("leads_set_client_internal", { p_client_id: clientD, p_internal: true })).error).toBeNull();
    try {
      const { data: geral } = await gestor.rpc("leads_dashboard", { p_period: "7" });
      expect(geral.per_client.map((c) => c.id)).not.toContain(clientD);
      const { data: so } = await gestor.rpc("leads_dashboard", { p_client: clientD, p_period: "7" });
      expect(so.leads_in).toBe(5);
      // Os números do Pipeline geral também deixam o cliente interno de fora.
      const [depois, soD] = [await kpis(null), await kpis(clientD)];
      expect(soD.entraram_hoje).toBeGreaterThan(0);
      for (const k of ["entraram_hoje", "por_contactar", "tarefas_atrasadas", "qualificadas"])
        expect(depois[k]).toBe(antes[k] - soD[k]);
    } finally {
      await admin.rpc("leads_set_client_internal", { p_client_id: clientD, p_internal: false });
    }
  });

  it("os períodos mudam o que conta", async () => {
    const { data: all } = await gestor.rpc("leads_dashboard", { p_client: clientD, p_period: "0" });
    const { data: w } = await gestor.rpc("leads_dashboard", { p_client: clientD, p_period: "7" });
    expect(all.leads_in).toBeGreaterThanOrEqual(w.leads_in);
    expect(all.per_day).toHaveLength(30);
  });

  it("cada cliente vê só o seu dashboard; a ocupação dos gestores é só da equipa OPERA", async () => {
    // Mesmo pedindo outro cliente, o servidor devolve só os números do cliente de quem pede.
    const { data: mine, error } = await aAdmin.rpc("leads_dashboard", { p_client: clientD, p_period: "7" });
    expect(error).toBeNull();
    expect(mine.per_client).toHaveLength(1);
    expect(mine.per_client[0].id).not.toBe(clientD);
    expect((await anonClient(env).rpc("leads_dashboard", { p_period: "7" })).error).toBeTruthy();
    const { data: none } = await aAdmin.rpc("leads_managers_load");
    expect(none ?? []).toHaveLength(0);
    const { data: load } = await gestor.rpc("leads_managers_load");
    const g = load.find((m) => m.id === me);
    expect(g.clients.length).toBeLessThanOrEqual(8);
  });

  it("só o admin muda o objetivo do Time to Lead", async () => {
    expect((await gestor.rpc("leads_set_ttl_target", { p_minutes: 20 })).error).toBeTruthy();
    expect((await admin.rpc("leads_set_ttl_target", { p_minutes: 20 })).error).toBeNull();
    const { data: d } = await gestor.rpc("leads_dashboard", { p_client: clientD, p_period: "7" });
    expect(d.ttl_target).toBe(20);
    expect(d.ttl_in_target).toBe(1);
    await admin.rpc("leads_set_ttl_target", { p_minutes: 15 });
  });
});
