// Conversas entre a OPERA e cada cliente: quem lê, quem escreve, mudar e apagar, leads juntas, por ler e exportação.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadEnv, USERS, anonClient, signIn, signInWithMfa } from "./helpers.js";

const env = loadEnv();
const suite = env ? describe : describe.skip;
const TAG = `Conversa${Date.now() % 100000}`;

suite("Conversas", () => {
  let admin, gestor, aAdmin, aUser, bAdmin, clientA, clientB, stages;
  const createdLeads = [];

  const lead = async (client, row) => {
    const { data, error } = await gestor.from("leads")
      .insert({ client_id: client, entry_stage: "bd", stage_id: stages.followup, source: "Referência", ...row }).select("id").single();
    if (error) throw error;
    createdLeads.push(data.id);
    return data.id;
  };
  const send = (sb, client, body, leadId = null) =>
    sb.rpc("leads_message_send", { p_client_id: client, p_body: body, p_lead_id: leadId });
  const thread = async (sb, client) => (await sb.rpc("leads_conversation", { p_client_id: client })).data ?? [];
  const unreadOf = async (sb, client) => (await sb.rpc("leads_conversations")).data.find((c) => c.client_id === client)?.unread;

  beforeAll(async () => {
    admin = await signInWithMfa(env, USERS.admin, "TOTP_ADMIN");
    gestor = await signInWithMfa(env, USERS.gestor, "TOTP_GESTOR");
    aAdmin = await signIn(env, USERS.aAdmin);
    aUser = await signIn(env, USERS.aUser);
    bAdmin = await signIn(env, USERS.bAdmin);
    const { data: st } = await admin.from("lead_stages").select("id,key").not("key", "is", null);
    stages = Object.fromEntries(st.map((s) => [s.key, s.id]));
    clientA = (await admin.from("clients").select("id").eq("name", "Cliente Teste A").single()).data.id;
    clientB = (await admin.from("clients").select("id").eq("name", "Cliente Teste B").single()).data.id;
  });

  afterAll(async () => {
    if (admin && createdLeads.length) await admin.from("leads").delete().in("id", createdLeads);
  });

  it("o cliente escreve à OPERA; a OPERA lê; outro cliente não vê nada", async () => {
    const { data: id, error } = await send(aUser, clientA, `${TAG} Olá OPERA`);
    expect(error).toBeNull();
    expect((await thread(gestor, clientA)).some((m) => m.id === id && m.side === "cliente")).toBe(true);
    expect((await thread(aAdmin, clientA)).some((m) => m.id === id)).toBe(true);

    const other = await bAdmin.rpc("leads_conversation", { p_client_id: clientA });
    expect(other.error).not.toBeNull();
    expect((await bAdmin.from("client_messages").select("id").eq("id", id)).data).toEqual([]);
    expect((await send(bAdmin, clientA, `${TAG} intruso`)).error).not.toBeNull();
    expect((await bAdmin.rpc("leads_conversations")).data.map((c) => c.client_id)).toEqual([clientB]);
  });

  it("ninguém escreve diretamente na tabela, nem sem sessão", async () => {
    const direct = await aUser.from("client_messages").insert({ client_id: clientA, body: `${TAG} direto` });
    expect(direct.error).not.toBeNull();
    expect((await anonClient(env).rpc("leads_conversations")).error).not.toBeNull();
    expect((await anonClient(env).from("client_messages").select("id")).data ?? []).toEqual([]);
  });

  it("mensagem da OPERA conta como por ler no cliente até a abrir", async () => {
    await aUser.rpc("leads_conversation_mark_read", { p_client_id: clientA });
    expect(await unreadOf(aUser, clientA)).toBe(0);
    const { error } = await send(gestor, clientA, `${TAG} Resposta da OPERA`);
    expect(error).toBeNull();
    expect(await unreadOf(aUser, clientA)).toBe(1);
    expect(await unreadOf(gestor, clientA)).toBe(0);
    await aUser.rpc("leads_conversation_mark_read", { p_client_id: clientA });
    expect(await unreadOf(aUser, clientA)).toBe(0);
    // As leituras de cada pessoa são só suas.
    const me = (await aAdmin.auth.getUser()).data.user.id;
    expect((await aAdmin.from("client_message_reads").select("user_id")).data.every((r) => r.user_id === me)).toBe(true);
  });

  it("só quem escreveu muda ou apaga; apagada fica a indicação", async () => {
    const { data: id } = await send(aUser, clientA, `${TAG} com erro`);
    expect((await aAdmin.rpc("leads_message_edit", { p_id: id, p_body: "outra" })).error).not.toBeNull();
    expect((await gestor.rpc("leads_message_delete", { p_id: id })).error).not.toBeNull();
    expect((await aUser.rpc("leads_message_edit", { p_id: id, p_body: `${TAG} corrigida` })).error).toBeNull();
    let m = (await thread(gestor, clientA)).find((x) => x.id === id);
    expect(m.body).toBe(`${TAG} corrigida`);
    expect(m.edited_at).not.toBeNull();
    expect((await aUser.rpc("leads_message_delete", { p_id: id })).error).toBeNull();
    m = (await thread(gestor, clientA)).find((x) => x.id === id);
    expect(m.body).toBeNull();
    expect(m.deleted_at).not.toBeNull();
    expect((await aUser.rpc("leads_message_edit", { p_id: id, p_body: "de volta" })).error).not.toBeNull();
  });

  it("mensagem vazia ou longa demais não entra", async () => {
    expect((await send(aUser, clientA, "   ")).error).not.toBeNull();
    expect((await send(aUser, clientA, "x".repeat(4001))).error).not.toBeNull();
  });

  it("só se junta uma lead do mesmo cliente, a partir de Lead Qualificada", async () => {
    const early = await lead(clientA, { name: `${TAG} Inês`, phone: "912340001" });
    const qualified = await lead(clientA, { name: `${TAG} Pedro`, phone: "912340002", qualification: { Objetivo: "Comprador" } });
    await gestor.from("leads").update({ stage_id: stages.qualificada }).eq("id", qualified);
    const otherClient = await lead(clientB, { name: `${TAG} Rita`, phone: "912340003", qualification: { Objetivo: "Comprador" } });
    await gestor.from("leads").update({ stage_id: stages.qualificada }).eq("id", otherClient);

    expect((await send(gestor, clientA, `${TAG} cedo`, early)).error).not.toBeNull();
    expect((await send(gestor, clientA, `${TAG} outro cliente`, otherClient)).error).not.toBeNull();
    const { data: id, error } = await send(gestor, clientA, `${TAG} vê esta`, qualified);
    expect(error).toBeNull();
    const m = (await thread(aUser, clientA)).find((x) => x.id === id);
    expect(m.lead_id).toBe(qualified);
    expect(m.lead_name).toBe(`${TAG} Pedro`);
    // O cliente também junta as suas leads qualificadas.
    expect((await send(aUser, clientA, `${TAG} e esta?`, qualified)).error).toBeNull();
  });

  it("exportar a conversa é só para a equipa OPERA", async () => {
    expect((await aAdmin.rpc("leads_messages_export", { p_client_id: clientA })).error).not.toBeNull();
    const { data, error } = await admin.rpc("leads_messages_export", { p_client_id: clientA });
    expect(error).toBeNull();
    expect(data.some((m) => m.body === `${TAG} Olá OPERA`)).toBe(true);
    expect(data.some((m) => m.deleted)).toBe(true);
  });

  it("a fila dos avisos por email não está aberta a utilizadores", async () => {
    expect((await gestor.rpc("leads_message_notifications_claim", { p_limit: 1 })).error).not.toBeNull();
    expect((await aAdmin.rpc("leads_message_notification_preview", { p_id: 1 })).error).not.toBeNull();
    expect((await aAdmin.from("client_message_notifications").select("id")).data).toEqual([]);
  });
});
