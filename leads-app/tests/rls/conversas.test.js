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

  it("lead qualificada: entra sozinha uma mensagem da OPERA na conversa, com a lead junta", async () => {
    const id = await lead(clientA, { name: `${TAG} Sara`, phone: "912340009",
      qualification: { Objetivo: "Comprador", Budget: "300 000 €", Financiamento: "crédito pré aprovado" } });
    expect((await gestor.from("leads").update({ stage_id: stages.qualificada }).eq("id", id)).error).toBeNull();
    const m = (await thread(aUser, clientA)).find((x) => x.lead_id === id && x.auto === "qualificada");
    expect(m).toBeTruthy();
    expect(m.side).toBe("opera");
    expect(m.body).toContain(`Lead qualificada: ${TAG} Sara`);
    expect(m.body).toContain("Comprador · Budget 300 000 € · Financiamento: crédito pré aprovado");
    expect(m.lead_open).toBe(true);
    // Só uma mensagem por qualificação.
    expect((await thread(aUser, clientA)).filter((x) => x.lead_id === id && x.auto).length).toBe(1);
  });

  it("mensagem vazia ou longa demais não entra", async () => {
    expect((await send(aUser, clientA, "   ")).error).not.toBeNull();
    expect((await send(aUser, clientA, "x".repeat(4001))).error).not.toBeNull();
  });

  it("junta-se qualquer lead do mesmo cliente, em qualquer etapa", async () => {
    const early = await lead(clientA, { name: `${TAG} Inês`, phone: "912340001" });
    const qualified = await lead(clientA, { name: `${TAG} Pedro`, phone: "912340002", qualification: { Objetivo: "Comprador" } });
    await gestor.from("leads").update({ stage_id: stages.qualificada }).eq("id", qualified);
    const otherClient = await lead(clientB, { name: `${TAG} Rita`, phone: "912340003" });

    expect((await send(gestor, clientA, `${TAG} outro cliente`, otherClient)).error).not.toBeNull();
    expect((await send(aUser, clientA, `${TAG} intruso`, otherClient)).error).not.toBeNull();
    const { data: earlyMsg, error: e1 } = await send(gestor, clientA, `${TAG} esta ainda é nossa`, early);
    expect(e1).toBeNull();
    const { data: id, error } = await send(gestor, clientA, `${TAG} vê esta`, qualified);
    expect(error).toBeNull();

    const seen = await thread(aUser, clientA);
    for (const [msg, name] of [[id, `${TAG} Pedro`], [earlyMsg, `${TAG} Inês`]]) {
      const m = seen.find((x) => x.id === msg);
      expect(m.lead_name).toBe(name);
      expect(m.lead_open).toBe(true);
    }
    // Lead de outro cliente nunca aparece, nem para quem a juntasse por engano.
    expect((await thread(bAdmin, clientB)).some((x) => x.lead_name?.startsWith(TAG))).toBe(false);
    expect((await send(aUser, clientA, `${TAG} e esta?`, early)).error).toBeNull();
  });

  it("exportar a conversa é só para a equipa OPERA", async () => {
    expect((await aAdmin.rpc("leads_messages_export", { p_client_id: clientA })).error).not.toBeNull();
    const { data, error } = await admin.rpc("leads_messages_export", { p_client_id: clientA });
    expect(error).toBeNull();
    expect(data.some((m) => m.body === `${TAG} Olá OPERA`)).toBe(true);
    expect(data.some((m) => m.deleted)).toBe(true);
  });

  it("mensagens de voz: só quem está na conversa grava e ouve; apagada, o ficheiro sai", async () => {
    const audio = () => new Blob([new Uint8Array(2048).fill(7)], { type: "audio/webm" });
    const path = `${clientA}/${crypto.randomUUID()}.webm`;
    expect((await aUser.storage.from("conversas").upload(path, audio(), { contentType: "audio/webm" })).error).toBeNull();
    // Outro cliente não grava na pasta deste nem ouve; ficheiro com outro formato não entra.
    expect((await bAdmin.storage.from("conversas").upload(`${clientA}/${crypto.randomUUID()}.webm`, audio(), { contentType: "audio/webm" })).error).not.toBeNull();
    expect((await bAdmin.storage.from("conversas").createSignedUrl(path, 60)).error).not.toBeNull();
    expect((await aUser.storage.from("conversas").upload(`${clientA}/${crypto.randomUUID()}.webm`, new Blob(["x"], { type: "text/html" }), { contentType: "text/html" })).error).not.toBeNull();

    // Só envia quem gravou o ficheiro, e com a duração certa.
    expect((await gestor.rpc("leads_message_send", { p_client_id: clientA, p_body: null, p_audio_path: path, p_audio_seconds: 12 })).error).not.toBeNull();
    expect((await aUser.rpc("leads_message_send", { p_client_id: clientA, p_body: null, p_audio_path: path, p_audio_seconds: 301 })).error).not.toBeNull();
    const { data: id, error } = await aUser.rpc("leads_message_send", { p_client_id: clientA, p_body: `${TAG} ouve isto`, p_audio_path: path, p_audio_seconds: 42 });
    expect(error).toBeNull();
    expect((await aUser.rpc("leads_message_send", { p_client_id: clientA, p_body: null, p_audio_path: path, p_audio_seconds: 42 })).error).not.toBeNull();

    const m = (await thread(gestor, clientA)).find((x) => x.id === id);
    expect(m.audio_path).toBe(path);
    expect(m.audio_seconds).toBe(42);
    const { data: signed } = await gestor.storage.from("conversas").createSignedUrl(path, 60);
    expect((await fetch(signed.signedUrl)).status).toBe(200);
    const last = (await gestor.rpc("leads_conversations")).data.find((c) => c.client_id === clientA);
    expect(last.last_body).toBe(`Mensagem de voz (0:42)\n${TAG} ouve isto`);

    // A legenda pode sair; a voz fica.
    expect((await aUser.rpc("leads_message_edit", { p_id: id, p_body: "" })).error).toBeNull();
    expect((await thread(gestor, clientA)).find((x) => x.id === id).body).toBeNull();

    // Apagada: some da conversa e o ficheiro é apagado na volta seguinte da função leads-notify.
    expect((await aUser.rpc("leads_message_delete", { p_id: id })).error).toBeNull();
    expect((await thread(gestor, clientA)).find((x) => x.id === id).audio_path).toBeNull();
    if (env.LEADS_INBOUND_TEST_KEY) {
      const res = await fetch(`${env.VITE_SUPABASE_URL}/functions/v1/leads-notify`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-opera-secret": env.LEADS_INBOUND_TEST_KEY },
        body: JSON.stringify({ action: "process" }),
      });
      expect((await res.json()).files).toBeGreaterThanOrEqual(1);
      expect((await gestor.storage.from("conversas").createSignedUrl(path, 60)).error).not.toBeNull();
    }
  });

  it("a fila dos avisos por email não está aberta a utilizadores", async () => {
    expect((await gestor.rpc("leads_message_notifications_claim", { p_limit: 1 })).error).not.toBeNull();
    expect((await aAdmin.rpc("leads_message_notification_preview", { p_id: 1 })).error).not.toBeNull();
    expect((await aAdmin.from("client_message_notifications").select("id")).data).toEqual([]);
  });
});
