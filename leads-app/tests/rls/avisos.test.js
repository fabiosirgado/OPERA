// Avisos por email: quem recebe, o conteúdo, o que não gera aviso e quem pode mexer na fila.
// O envio real depende do Resend; aqui usa-se a pré-visualização da função leads-notify (não envia nada).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadEnv, USERS, signIn, signInWithMfa } from "./helpers.js";

const env = loadEnv();
const suite = env?.LEADS_INBOUND_TEST_KEY ? describe : describe.skip;
const TAG = `Aviso${Date.now() % 100000}`;

async function notify(body) {
  const res = await fetch(`${env.VITE_SUPABASE_URL}/functions/v1/leads-notify`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opera-secret": env.LEADS_INBOUND_TEST_KEY },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

suite("Avisos por email", () => {
  let admin, gestor, aAdmin, aUser, clientA, stages, me, aUserId;
  const created = [];

  const lead = async (row) => {
    const { data, error } = await gestor.from("leads")
      .insert({ client_id: clientA, entry_stage: "bd", stage_id: stages.followup, source: "Referência", ...row }).select("id").single();
    if (error) throw error;
    created.push(data.id);
    return data.id;
  };
  const notificationOf = async (leadId, kind) => (await admin.from("lead_notifications")
    .select("id,status,kind,attempts").eq("lead_id", leadId).eq("kind", kind).maybeSingle()).data;

  beforeAll(async () => {
    admin = await signInWithMfa(env, USERS.admin, "TOTP_ADMIN");
    gestor = await signInWithMfa(env, USERS.gestor, "TOTP_GESTOR");
    aAdmin = await signIn(env, USERS.aAdmin);
    aUser = await signIn(env, USERS.aUser);
    me = (await gestor.auth.getUser()).data.user.id;
    aUserId = (await aUser.auth.getUser()).data.user.id;
    const { data: st } = await admin.from("lead_stages").select("id,key").not("key", "is", null);
    stages = Object.fromEntries(st.map((s) => [s.key, s.id]));
    clientA = (await admin.from("clients").select("id").eq("name", "Cliente Teste A").single()).data.id;
    await admin.rpc("leads_assign_manager", { p_client_id: clientA, p_manager_id: me });
  });

  afterAll(async () => {
    if (admin && created.length) await admin.from("leads").delete().in("id", created);
  });

  it("qualificar uma lead põe o aviso na fila e o email leva o resumo e o link", async () => {
    const id = await lead({ name: `${TAG} Marta`, phone: "912345001", email: "marta@example.com", interest: "T2 Alvalade",
      qualification: { Budget: "300 000 €", Prazo: "3 meses" } });
    await gestor.from("lead_events").insert({ lead_id: id, type: "note", title: "Nota", body: "Só ao fim da tarde", pinned: true, author_id: me });
    expect((await gestor.from("leads").update({ stage_id: stages.qualificada }).eq("id", id)).error).toBeNull();
    const n = await notificationOf(id, "qualificada");
    expect(n.status).toBe("pendente");

    const { status, body: p } = await notify({ action: "preview", id: n.id });
    expect(status).toBe(200);
    expect(p.subject).toBe(`Lead qualificada: ${TAG} Marta`);
    expect(p.text).toContain("Telefone: 912345001");
    expect(p.text).toContain("Budget: 300 000 €");
    expect(p.text).toContain("Só ao fim da tarde");
    expect(p.link).toContain(`lead=${id}`);
    expect(p.html).toContain("Abrir a lead");
    expect(p.reply_to).toBe(USERS.gestor);
    // Sem responsável: todos os utilizadores ativos do cliente.
    expect(p.real_to).toEqual(expect.arrayContaining([USERS.aAdmin, USERS.aUser]));
    // No ambiente de testes, tudo vai para um só endereço.
    expect(p.to).toHaveLength(1);
    expect(p.real_to).not.toContain(p.to[0]);
  });

  it("com responsável no cliente, só o responsável recebe", async () => {
    const id = await lead({ name: `${TAG} Rui`, phone: "912345002", owner_user_id: aUserId });
    await gestor.from("leads").update({ stage_id: stages.qualificada }).eq("id", id);
    const { body: p } = await notify({ action: "preview", id: (await notificationOf(id, "qualificada")).id });
    expect(p.real_to).toEqual([USERS.aUser]);
  });

  it("uma lead criada pelo cliente para a OPERA contactar avisa o gestor do cliente", async () => {
    const { data: id, error } = await aAdmin.rpc("leads_create", { p: { client_id: clientA, name: `${TAG} Pedido`, phone: "912345003", source: "Meta" } });
    expect(error).toBeNull();
    created.push(id);
    const { body: p } = await notify({ action: "preview", id: (await notificationOf(id, "nova_lead_do_cliente")).id });
    expect(p.real_to).toEqual([USERS.gestor]);
    expect(p.subject).toContain("criou uma lead para a OPERA contactar");
  });

  it("leads importadas já qualificadas (por exemplo do Pipedrive) não avisam o cliente", async () => {
    const { data, error } = await gestor.rpc("leads_import_batch", {
      p_rows: [{ line: 2, client_id: clientA, stage_id: stages.qualificada, name: `${TAG} Importada`, phone: "912345004", source: "Pipedrive", labels: [] }],
      p_dup: "ignore", p_file: "pipedrive.xlsx",
    });
    expect(error).toBeNull();
    expect(data.created).toBe(1);
    const { data: l } = await admin.from("leads").select("id").eq("name", `${TAG} Importada`).single();
    created.push(l.id);
    expect(await notificationOf(l.id, "qualificada")).toBeNull();
  });

  it("sem a chave do Resend, os avisos ficam pendentes para sair mais tarde", async () => {
    const r = await notify({ action: "process" });
    expect(r.body).toEqual({ configured: false });
    const id = created[0];
    expect((await notificationOf(id, "qualificada")).status).toBe("pendente");
  });

  it("só o servidor mexe na fila; os clientes não veem os avisos", async () => {
    expect((await gestor.rpc("leads_notifications_claim", { p_limit: 1 })).error).toBeTruthy();
    expect((await gestor.rpc("leads_notification_done", { p_id: 1, p_ok: true })).error).toBeTruthy();
    expect((await aAdmin.rpc("leads_notification_preview", { p_id: 1 })).error).toBeTruthy();
    expect((await aAdmin.from("lead_notifications").select("id")).data).toHaveLength(0);
    const bad = await fetch(`${env.VITE_SUPABASE_URL}/functions/v1/leads-notify`, {
      method: "POST", headers: { "content-type": "application/json", "x-opera-secret": "x".repeat(64) }, body: "{}",
    });
    expect(bad.status).toBe(401);
  });
});
