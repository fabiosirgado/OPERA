// Prova, pela API e com utilizadores reais, que as regras de acesso do OPERA Leads estão no RLS do Supabase.
// Corre contra o projeto de testes. Sem .env.test, os testes são saltados.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadEnv, USERS, anonClient, signIn, signInWithMfa } from "./helpers.js";

const env = loadEnv();
const suite = env ? describe : describe.skip;

suite("RLS do OPERA Leads", { timeout: 60_000 }, () => {
  let admin, gestor, gestorSemMfa, aAdmin, aUser, bAdmin, anon;
  let stages, clientA, clientB, aUserId;
  const leads = {};

  // Atualiza e devolve as linhas que o RLS deixou mudar (0 linhas = bloqueado).
  const tryUpdate = async (sb, table, patch, id) => {
    const { data, error } = await sb.from(table).update(patch).eq("id", id).select();
    return error ? [] : data;
  };

  beforeAll(async () => {
    anon = anonClient(env);
    admin = await signInWithMfa(env, USERS.admin, "TOTP_ADMIN");
    gestor = await signInWithMfa(env, USERS.gestor, "TOTP_GESTOR");
    gestorSemMfa = await signIn(env, USERS.gestor);
    aAdmin = await signIn(env, USERS.aAdmin);
    aUser = await signIn(env, USERS.aUser);
    bAdmin = await signIn(env, USERS.bAdmin);

    const { data: st } = await admin.from("lead_stages").select("id,key").not("key", "is", null);
    stages = Object.fromEntries(st.map((s) => [s.key, s.id]));
    const { data: cl } = await admin.from("clients").select("id,name").in("name", ["Cliente Teste A", "Cliente Teste B"]);
    clientA = cl.find((c) => c.name === "Cliente Teste A").id;
    clientB = cl.find((c) => c.name === "Cliente Teste B").id;
    aUserId = (await aUser.auth.getUser()).data.user.id;

    const make = async (key, client, stage) => {
      const { data, error } = await admin.from("leads")
        .insert({ client_id: client, name: `Teste ${key}`, phone: "+351 912 345 678", stage_id: stages[stage], entry_stage: "bd" })
        .select().single();
      if (error) throw error;
      leads[key] = data;
    };
    await make("aFollow", clientA, "followup");
    await make("aQual", clientA, "qualificada");
    await make("bQual", clientB, "qualificada");
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.rpc("leads_reactivate_client", { p_client_id: clientB }).then(() => {}, () => {});
    await admin.rpc("leads_set_user_status", { p_user_id: aUserId, p_status: "ativo" });
    await admin.from("leads").delete().in("id", Object.values(leads).map((l) => l.id));
  });

  describe("sem login", () => {
    it("não lê leads, etapas, etiquetas nem registos", async () => {
      for (const t of ["leads", "lead_stages", "lead_labels", "lead_events", "lead_tasks", "audit_log", "inbound_log"]) {
        const { data } = await anon.from(t).select("id").limit(1);
        expect(data ?? [], t).toHaveLength(0);
      }
    });
    it("não chama as ações de administração", async () => {
      const { error } = await anon.rpc("leads_deactivate_client", { p_client_id: clientA });
      expect(error).toBeTruthy();
    });
  });

  describe("equipa OPERA", () => {
    it("sem verificação em dois passos não vê nada", async () => {
      const { data } = await gestorSemMfa.from("leads").select("id");
      expect(data).toHaveLength(0);
    });
    it("o gestor vê as leads de todos os clientes", async () => {
      const { data } = await gestor.from("leads").select("id").in("id", Object.values(leads).map((l) => l.id));
      expect(data).toHaveLength(3);
    });
    it("normaliza o telefone (só dígitos, sem 351)", () => {
      expect(leads.aFollow.phone_norm).toBe("912345678");
    });
    it("cada mudança de etapa fica no histórico com o autor", async () => {
      await gestor.from("leads").update({ stage_id: stages.bd }).eq("id", leads.aFollow.id);
      await gestor.from("leads").update({ stage_id: stages.followup }).eq("id", leads.aFollow.id);
      const { data } = await gestor.from("lead_events").select("type,from_stage_id,to_stage_id,author_id")
        .eq("lead_id", leads.aFollow.id).eq("type", "stage");
      expect(data.length).toBeGreaterThanOrEqual(2);
      expect(data.every((e) => e.author_id)).toBe(true);
    });
    it("não cria etapas antes de Lead Qualificada", async () => {
      const { error } = await gestor.from("lead_stages").insert({ name: "Antes", position: 45 });
      expect(error).toBeTruthy();
    });
    it("o gestor não lê o registo de atividade nem desativa clientes", async () => {
      const { data } = await gestor.from("audit_log").select("id").limit(1);
      expect(data).toHaveLength(0);
      const { error } = await gestor.rpc("leads_deactivate_client", { p_client_id: clientA });
      expect(error).toBeTruthy();
    });
    it("o gestor não vê clientes que só existem no CRM", async () => {
      const { data } = await gestor.from("clients").select("name").eq("name", "Cliente só do CRM");
      expect(data).toHaveLength(0);
      const { data: ov } = await gestor.rpc("leads_clients_overview");
      expect(ov.map((c) => c.name)).toContain("Cliente Teste A");
      expect(ov.map((c) => c.name)).not.toContain("Cliente só do CRM");
    });
    it("um gestor não pode ter mais de 8 clientes", async () => {
      const gestorId = (await gestor.auth.getUser()).data.user.id;
      const extra = [];
      for (let i = 0; i < 7; i++) {
        const { data, error } = await admin.from("clients").insert({ name: `Capacidade ${Date.now()}-${i}`, leads_enabled: true }).select().single();
        if (error) throw error;
        extra.push(data.id);
      }
      const results = [];
      for (const id of extra) {
        const { error } = await admin.rpc("leads_assign_manager", { p_client_id: id, p_manager_id: gestorId });
        results.push(!error);
      }
      // Já tinha 2 (A e B): 6 cabem, o 7.º seria o 9.º cliente.
      expect(results.filter(Boolean)).toHaveLength(6);
      expect(results[6]).toBe(false);
      for (const id of extra) await admin.rpc("leads_deactivate_client", { p_client_id: id });
    });
  });

  describe("cliente", () => {
    it("só vê as leads do seu cliente", async () => {
      const { data } = await aUser.from("leads").select("id").in("id", Object.values(leads).map((l) => l.id));
      expect(data.map((l) => l.id).sort()).toEqual([leads.aFollow.id, leads.aQual.id].sort());
      const { data: b } = await bAdmin.from("leads").select("id").in("id", [leads.aFollow.id, leads.aQual.id]);
      expect(b).toHaveLength(0);
    });
    it("não lê o histórico nem as tarefas de outro cliente", async () => {
      const { data } = await bAdmin.from("lead_events").select("id").eq("lead_id", leads.aFollow.id);
      expect(data).toHaveLength(0);
    });
    it("não cria leads noutro cliente", async () => {
      const { error } = await aUser.from("leads")
        .insert({ client_id: clientB, name: "Intrusa", stage_id: stages.bd, entry_stage: "bd" });
      expect(error).toBeTruthy();
    });
    it("não mexe em leads antes de Lead Qualificada", async () => {
      expect(await tryUpdate(aUser, "leads", { name: "Mexida" }, leads.aFollow.id)).toHaveLength(0);
      expect(await tryUpdate(aUser, "leads", { stage_id: stages.qualificada }, leads.aFollow.id)).toHaveLength(0);
      const { error } = await aUser.from("lead_events").insert({ lead_id: leads.aFollow.id, type: "note", body: "x", author_id: aUserId });
      expect(error).toBeTruthy();
    });
    it("mexe em leads a partir de Lead Qualificada", async () => {
      expect(await tryUpdate(aUser, "leads", { interest: "T2 em Lisboa" }, leads.aQual.id)).toHaveLength(1);
      const { error } = await aUser.from("lead_events").insert({ lead_id: leads.aQual.id, type: "note", body: "Liguei", author_id: aUserId });
      expect(error).toBeNull();
    });
    it("não devolve uma lead qualificada à OPERA", async () => {
      expect(await tryUpdate(aUser, "leads", { stage_id: stages.followup }, leads.aQual.id)).toHaveLength(0);
    });
    it("não mexe em leads de outro cliente, mesmo qualificadas", async () => {
      expect(await tryUpdate(aUser, "leads", { name: "Mexida" }, leads.bQual.id)).toHaveLength(0);
    });
    it("só edita as suas próprias notas", async () => {
      const { data: note } = await aUser.from("lead_events")
        .insert({ lead_id: leads.aQual.id, type: "note", body: "Nota do Rui", author_id: aUserId }).select().single();
      expect(await tryUpdate(aAdmin, "lead_events", { body: "Alterada" }, note.id)).toHaveLength(0);
      expect(await tryUpdate(aUser, "lead_events", { body: "Corrigida" }, note.id)).toHaveLength(1);
    });
    it("não muda o próprio papel nem o gestor do cliente", async () => {
      const { error } = await aUser.from("profiles").update({ leads_role: "admin" }).eq("id", aUserId);
      const { data } = await aUser.from("profiles").select("leads_role").eq("id", aUserId).single();
      expect(error || data.leads_role === "cliente").toBeTruthy();
      expect(await tryUpdate(aAdmin, "clients", { manager_id: null }, clientA)).toHaveLength(0);
    });
    it("não lê o registo de atividade nem as entradas automáticas", async () => {
      for (const t of ["audit_log", "inbound_log"]) {
        const { data } = await aAdmin.from(t).select("id").limit(1);
        expect(data, t).toHaveLength(0);
      }
    });
  });

  describe("RGPD", () => {
    it("apagar a pedido do titular anonimiza e exige confirmação escrita", async () => {
      const { data: l } = await admin.from("leads")
        .insert({ client_id: clientA, name: "Titular", phone: "912000111", email: "t@example.com", stage_id: stages.followup, entry_stage: "meta" })
        .select().single();
      leads.titular = l;
      await admin.from("lead_events").insert({ lead_id: l.id, type: "note", body: "Dados pessoais", author_id: (await admin.auth.getUser()).data.user.id });
      expect((await aUser.rpc("leads_erase_subject", { p_lead_id: l.id, p_confirm: "APAGAR" })).error).toBeTruthy();
      expect((await gestor.rpc("leads_erase_subject", { p_lead_id: l.id, p_confirm: "sim" })).error).toBeTruthy();
      expect((await gestor.rpc("leads_erase_subject", { p_lead_id: l.id, p_confirm: "APAGAR" })).error).toBeNull();
      const { data: after } = await gestor.from("leads").select("name,phone,email,anonymized,entry_stage,created_at").eq("id", l.id).single();
      expect(after).toMatchObject({ name: "Titular apagado", phone: null, email: null, anonymized: true, entry_stage: "meta" });
      const { data: ev } = await gestor.from("lead_events").select("type,body").eq("lead_id", l.id);
      expect(ev.some((e) => e.body === "Dados pessoais")).toBe(false);
    });
    it("só o admin muda a regra de anonimização", async () => {
      expect(await tryUpdate(gestor, "leads_settings", { anonymize_after_months: 12 }, true)).toHaveLength(0);
      expect(await tryUpdate(admin, "leads_settings", { anonymize_after_months: 12 }, true)).toHaveLength(1);
      await admin.from("leads_settings").update({ anonymize_after_months: 0 }).eq("id", true);
    });
  });

  describe("utilizadores e clientes", () => {
    it("o admin do cliente desativa utilizadores do seu cliente, e só desses", async () => {
      const bId = (await bAdmin.auth.getUser()).data.user.id;
      const { error: errB } = await aAdmin.rpc("leads_set_user_status", { p_user_id: bId, p_status: "desativado" });
      expect(errB).toBeTruthy();
      const { error: errSelf } = await aUser.rpc("leads_set_user_status", { p_user_id: aUserId, p_status: "desativado" });
      expect(errSelf).toBeTruthy();
      const { error } = await aAdmin.rpc("leads_set_user_status", { p_user_id: aUserId, p_status: "desativado" });
      expect(error).toBeNull();
      const { data } = await aUser.from("leads").select("id");
      expect(data).toHaveLength(0);
      await admin.rpc("leads_set_user_status", { p_user_id: aUserId, p_status: "ativo" });
    });
    it("desativar um cliente bloqueia logo os acessos e tira as leads ao gestor", async () => {
      const { error } = await admin.rpc("leads_deactivate_client", { p_client_id: clientB });
      expect(error).toBeNull();
      expect((await bAdmin.from("leads").select("id")).data).toHaveLength(0);
      expect((await gestor.from("leads").select("id").eq("id", leads.bQual.id)).data).toHaveLength(0);
      expect((await admin.from("leads").select("id").eq("id", leads.bQual.id)).data).toHaveLength(1);
      const { data: c } = await admin.from("clients").select("leads_purge_at").eq("id", clientB).single();
      const meses = (new Date(c.leads_purge_at) - Date.now()) / (30 * 24 * 3600 * 1000);
      expect(meses).toBeGreaterThan(5.8);
      await admin.rpc("leads_reactivate_client", { p_client_id: clientB });
      expect((await bAdmin.from("leads").select("id").eq("id", leads.bQual.id)).data).toHaveLength(1);
    });
    it("apagar já exige escrever o nome do cliente", async () => {
      await admin.rpc("leads_deactivate_client", { p_client_id: clientB });
      const { error } = await admin.rpc("leads_purge_client_now", { p_client_id: clientB, p_confirm_name: "errado" });
      expect(error).toBeTruthy();
      await admin.rpc("leads_reactivate_client", { p_client_id: clientB });
    });
    it("as ações de administração ficam no registo de atividade, que só o admin lê", async () => {
      const { data } = await admin.from("audit_log").select("action").order("created_at", { ascending: false }).limit(20);
      const actions = data.map((a) => a.action);
      expect(actions).toContain("desativar_cliente");
      expect(actions).toContain("reativar_cliente");
      expect(actions).toContain("desativar_utilizador");
    });
  });
});
