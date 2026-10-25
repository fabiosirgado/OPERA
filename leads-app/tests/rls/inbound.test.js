// Entradas automáticas: a função leads-inbound (Meta e emails dos portais) e o ecrã Entradas automáticas.
// Corre contra o opera-testes com uma chave de teste (só a impressão digital está na base de dados).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadEnv, USERS, signIn, signInWithMfa } from "./helpers.js";

const env = loadEnv();
const suite = env?.LEADS_INBOUND_TEST_KEY ? describe : describe.skip;
const RUN = Date.now().toString(36);
const PAGE = `pg${RUN}`;
const INBOX = `entradas.${RUN}@example.com`;

async function send(body, key = env.LEADS_INBOUND_TEST_KEY) {
  const res = await fetch(`${env.VITE_SUPABASE_URL}/functions/v1/leads-inbound`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "x-opera-secret": key } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const meta = (leadId, name, phone, extra = {}) => ({
  type: "meta", page_id: PAGE, form_id: "f1", lead_id: `${RUN}-${leadId}`, created_time: "2026-10-23T09:00:00+0000",
  field_data: [
    { name: "full_name", values: [name] }, { name: "phone_number", values: [phone] },
    { name: "email", values: [`${leadId}.${RUN}@example.com`] },
    { name: "qual_o_seu_orcamento", values: ["300 000 €"] },
  ],
  ...extra,
});

suite("Entradas automáticas", () => {
  let admin, gestor, aAdmin, clientE, stages;

  beforeAll(async () => {
    admin = await signInWithMfa(env, USERS.admin, "TOTP_ADMIN");
    gestor = await signInWithMfa(env, USERS.gestor, "TOTP_GESTOR");
    aAdmin = await signIn(env, USERS.aAdmin);
    const { data: st } = await admin.from("lead_stages").select("id,key").not("key", "is", null);
    stages = Object.fromEntries(st.map((s) => [s.key, s.id]));

    let { data: c } = await admin.from("clients").select("id,leads_status").eq("name", "Cliente Entradas").maybeSingle();
    if (!c) ({ data: c } = await admin.from("clients").insert({ name: "Cliente Entradas", leads_enabled: true }).select("id,leads_status").single());
    if (c.leads_status === "inativo") await admin.rpc("leads_reactivate_client", { p_client_id: c.id });
    clientE = c.id;
    await admin.from("leads").delete().eq("client_id", clientE);
    await admin.from("lead_meta_forms").delete().eq("client_id", clientE);
    await admin.from("client_inbox_addresses").delete().eq("client_id", clientE);
    expect((await gestor.from("lead_meta_forms").insert({ client_id: clientE, page_id: PAGE, label: "Página de teste" })).error).toBeNull();
    expect((await gestor.from("client_inbox_addresses").insert({ client_id: clientE, address: INBOX })).error).toBeNull();
  });

  afterAll(async () => {
    if (!admin || !clientE) return;
    await admin.from("leads").delete().eq("client_id", clientE);
    await admin.from("lead_meta_forms").delete().eq("client_id", clientE);
    await admin.from("client_inbox_addresses").delete().eq("client_id", clientE);
  });

  it("recusa pedidos sem a chave", async () => {
    expect((await send({ type: "meta" }, null)).status).toBe(401);
    expect((await send({ type: "meta" }, "x".repeat(64))).status).toBe(401);
  });

  it("lead do Meta entra em Nova Lead Meta, com as respostas numa nota e sem tarefa", async () => {
    const r = await send(meta("m1", "Marta Entradas", "+351 912 000 001"));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, status: "processado", client_id: clientE });
    const { data: lead } = await gestor.from("leads")
      .select("name,phone_norm,source,stage_id,entry_stage,external_id,source_created_at,next_task_at").eq("id", r.body.lead_id).single();
    expect(lead).toMatchObject({ name: "Marta Entradas", phone_norm: "912000001", source: "Meta",
      stage_id: stages.meta, entry_stage: "meta", external_id: `meta:${RUN}-m1`, next_task_at: null });
    expect(lead.source_created_at).toBeTruthy();
    const { data: ev } = await gestor.from("lead_events").select("type,title,body").eq("lead_id", r.body.lead_id);
    expect(ev.find((e) => e.title === "Lead recebida do Meta")).toBeTruthy();
    expect(ev.find((e) => e.type === "note").body).toContain("qual o seu orcamento: 300 000 €");
    const { count } = await gestor.from("lead_tasks").select("id", { count: "exact", head: true }).eq("lead_id", r.body.lead_id);
    expect(count).toBe(0);
  });

  it("a lead que entra sozinha tem o sinal Nova até alguém lhe ligar; as criadas à mão nunca o têm", async () => {
    const r = await send(meta("n1", "Nina Entradas", "+351 912 000 011"));
    const novas = async () => Object.fromEntries(((await gestor.rpc("leads_pipeline", { p_client: clientE, p_limit: 200 })).data ?? [])
      .map((l) => [l.name, l.is_new]));
    const { data: manual } = await gestor.from("leads")
      .insert({ client_id: clientE, name: "Manual Entradas", phone: "912000012", stage_id: stages.meta, entry_stage: "meta" }).select("id").single();
    expect(await novas()).toMatchObject({ "Nina Entradas": true, "Manual Entradas": false });
    expect((await gestor.rpc("leads_register_call", { p_lead_id: r.body.lead_id, p_meta: { via: "telefone" } })).error).toBeNull();
    expect((await novas())["Nina Entradas"]).toBe(false);
    await admin.from("leads").delete().in("id", [r.body.lead_id, manual.id]);
  });

  it("o mesmo pedido repetido pelo Make não cria outra lead", async () => {
    const r = await send(meta("m1", "Marta Entradas", "+351 912 000 001"));
    expect(r.body.status).toBe("duplicado");
    const { count } = await gestor.from("leads").select("id", { count: "exact", head: true }).eq("client_id", clientE);
    expect(count).toBe(1);
  });

  it("lead repetida (mesmo telefone) recebe só o evento Novo contacto recebido", async () => {
    const first = await gestor.from("leads").select("id").eq("client_id", clientE).single();
    const r = await send(meta("m2", "Marta E.", "912000001"));
    expect(r.body).toMatchObject({ status: "duplicado", lead_id: first.data.id });
    const { data: ev } = await gestor.from("lead_events").select("title").eq("lead_id", first.data.id).eq("title", "Novo contacto recebido");
    expect(ev).toHaveLength(1);
    const { count } = await gestor.from("lead_tasks").select("id", { count: "exact", head: true }).eq("lead_id", first.data.id);
    expect(count).toBe(0);
  });

  it("o formulário sozinho identifica o cliente (o gatilho do Make não envia a página)", async () => {
    const form = `frm${RUN}`;
    expect((await gestor.from("lead_meta_forms").insert({ client_id: clientE, form_id: form })).error).toBeNull();
    const r = await send({ type: "meta", form_id: form, lead_id: `${RUN}-f1`, name: "Rui Formulário", phone: "914000004",
      message: "Maior desafio: vender mais depressa" });
    expect(r.body).toMatchObject({ status: "processado", client_id: clientE });
    const { data: ev } = await gestor.from("lead_events").select("body").eq("lead_id", r.body.lead_id).eq("type", "note");
    expect(ev[0].body).toContain("Maior desafio");
    expect((await gestor.from("lead_meta_forms").insert({ client_id: clientE })).error).toBeTruthy();
  });

  it("formulário desconhecido fica por atribuir e a equipa escolhe o cliente", async () => {
    const r = await send(meta("m3", "Rui Sem Cliente", "913000003", { page_id: `outra${RUN}` }));
    expect(r.body).toMatchObject({ status: "sem_cliente", alert: true });
    const { data: ov } = await gestor.rpc("leads_inbound_overview");
    expect(ov.unassigned.find((u) => u.id === r.body.log_id)).toMatchObject({ name: "Rui Sem Cliente", channel: "meta" });
    expect((await aAdmin.rpc("leads_inbound_assign", { p_log_id: r.body.log_id, p_client_id: clientE })).error).toBeTruthy();
    const { data: done, error } = await gestor.rpc("leads_inbound_assign", { p_log_id: r.body.log_id, p_client_id: clientE });
    expect(error).toBeNull();
    expect(done.status).toBe("processado");
    expect((await gestor.rpc("leads_inbound_assign", { p_log_id: r.body.log_id, p_client_id: clientE })).error).toBeTruthy();
  });

  it("email de portal reencaminhado pelo Gmail entra em Nova lead imóveis no cliente certo", async () => {
    const r = await send({
      type: "email",
      from: "Idealista <noreply@idealista.com>",
      to: "abc@hook.eu1.make.com",
      subject: "Novo contacto para o seu anúncio T2 em Alvalade",
      text: `Olá,\n\nRecebeu uma nova mensagem.\n\nNome: Joana Portal\nTelefone: 934 000 007\nEmail: joana.${RUN}@example.com\n` +
        "Mensagem: Gostava de visitar o apartamento no sábado.\nReferência: 123456\n",
      headers: [{ name: "X-Forwarded-For", value: `${INBOX} abc@hook.eu1.make.com` }],
    });
    expect(r.status).toBe(200);
    expect(["processado", "revisao"]).toContain(r.body.status);
    expect(r.body.client_id).toBe(clientE);
    const { data: lead } = await gestor.from("leads").select("phone_norm,source,stage_id,entry_stage").eq("id", r.body.lead_id).single();
    expect(lead).toMatchObject({ phone_norm: "934000007", source: "Idealista", stage_id: stages.imoveis, entry_stage: "imoveis" });
  });

  it("email sem telefone nem email entra na mesma, com nota afixada a pedir revisão", async () => {
    const r = await send({
      type: "email", from: "alertas@imovirtual.com", to: INBOX,
      subject: "Pedido de informação", text: "Alguém pediu informações sobre o anúncio, sem deixar contactos.",
    });
    expect(r.body.status).toBe("revisao");
    const { data: ev } = await gestor.from("lead_events").select("title,pinned").eq("lead_id", r.body.lead_id).eq("pinned", true);
    expect(ev[0].title).toBe("Precisa de revisão");
    const { data: raw } = await gestor.rpc("leads_inbound_original", { p_log_id: r.body.log_id });
    expect(raw.subject).toBe("Pedido de informação");
  });

  it("email com endereço desconhecido fica por atribuir", async () => {
    const r = await send({ type: "email", from: "noreply@idealista.com", to: `ninguem.${RUN}@example.com`,
      subject: "Contacto", text: "Telefone 935 000 009" });
    expect(r.body.status).toBe("sem_cliente");
  });

  it("guarda o código de confirmação do Gmail para a equipa enviar ao cliente", async () => {
    const r = await send({
      type: "email", from: "Gmail Team <forwarding-noreply@google.com>", to: "abc@hook.eu1.make.com",
      subject: `(#987654321) Gmail Forwarding Confirmation - Receive Mail from ${INBOX}`,
      text: `${INBOX} has requested to automatically forward mail to your email address.\nConfirmation code: 987654321\n` +
        "https://mail-settings.google.com/mail/vf-abc123",
    });
    expect(r.body.status).toBe("codigo_gmail");
    const { data: ov } = await gestor.rpc("leads_inbound_overview");
    const code = ov.codes.find((c) => c.id === r.body.log_id);
    expect(code).toMatchObject({ code: "987654321", address: INBOX, client: "Cliente Entradas" });
    expect(code.link).toContain("mail-settings.google.com");
    expect((await gestor.rpc("leads_inbound_code_done", { p_log_id: r.body.log_id })).error).toBeNull();
    const { data: ov2 } = await gestor.rpc("leads_inbound_overview");
    expect(ov2.codes.find((c) => c.id === r.body.log_id)).toBeUndefined();
  });

  it("o ecrã mostra os canais de cada cliente e as últimas entradas", async () => {
    const { data: ov } = await gestor.rpc("leads_inbound_overview");
    const c = ov.clients.find((x) => x.id === clientE);
    expect(c.addresses).toEqual([INBOX]);
    expect(c.forms[0]).toMatchObject({ page_id: PAGE, form_id: null });
    expect(c.meta_last).toBeTruthy();
    expect(c.email_last).toBeTruthy();
    expect(ov.recent.length).toBeGreaterThan(0);
  });

  it("os clientes não veem nem mexem nas entradas automáticas", async () => {
    expect((await aAdmin.rpc("leads_inbound_overview")).error).toBeTruthy();
    expect((await aAdmin.from("inbound_log").select("id")).data).toHaveLength(0);
    expect((await aAdmin.from("client_inbox_addresses").select("address")).data).toHaveLength(0);
    expect((await aAdmin.from("lead_meta_forms").insert({ client_id: clientE, page_id: "x1" })).error).toBeTruthy();
    expect((await aAdmin.rpc("leads_inbound_process", { p_log_id: 1 })).error).toBeTruthy();
    expect((await aAdmin.rpc("leads_inbound_original", { p_log_id: 1 })).error).toBeTruthy();
  });
});
