// Mudar a ordem, o nome e apagar etapas extra (depois de Lead Qualificada), com as regras de acesso do RLS.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadEnv, USERS, signIn, signInWithMfa } from "./helpers.js";

const env = loadEnv();
const suite = env ? describe : describe.skip;

suite("Gerir etapas", { timeout: 60_000 }, () => {
  let admin, gestor, aAdmin, bAdmin, clientA, stageOpera, stageCliente, leadId;
  const TAG = `Etapa ${Date.now() % 100000}`;
  const rows = (r) => r.data ?? [];

  beforeAll(async () => {
    admin = await signInWithMfa(env, USERS.admin, "TOTP_ADMIN");
    gestor = await signInWithMfa(env, USERS.gestor, "TOTP_GESTOR");
    aAdmin = await signIn(env, USERS.aAdmin);
    bAdmin = await signIn(env, USERS.bAdmin);
    clientA = (await admin.from("clients").select("id").eq("name", "Cliente Teste A").single()).data.id;
    stageOpera = (await gestor.from("lead_stages").insert({ name: `${TAG} OPERA`, position: 61.5, client_id: clientA, owner: "opera" })
      .select().single()).data;
    stageCliente = (await aAdmin.from("lead_stages").insert({ name: `${TAG} cliente`, position: 62.5, client_id: clientA, owner: "cliente" })
      .select().single()).data;
  });

  afterAll(async () => {
    if (!admin) return;
    if (leadId) await admin.from("leads").delete().eq("id", leadId);
    await admin.from("lead_stages").delete().like("name", `${TAG}%`);
  });

  it("a equipa OPERA muda a ordem e o nome de uma etapa extra", async () => {
    expect(rows(await gestor.from("lead_stages").update({ position: 63.5, name: `${TAG} OPERA 2` }).eq("id", stageOpera.id).select("id"))).toHaveLength(1);
  });

  it("o cliente muda as suas etapas, mas não as da OPERA nem as de outro cliente", async () => {
    expect(rows(await aAdmin.from("lead_stages").update({ name: `${TAG} cliente 2` }).eq("id", stageCliente.id).select("id"))).toHaveLength(1);
    expect(rows(await aAdmin.from("lead_stages").update({ name: "x" }).eq("id", stageOpera.id).select("id"))).toHaveLength(0);
    expect(rows(await bAdmin.from("lead_stages").update({ name: "x" }).eq("id", stageCliente.id).select("id"))).toHaveLength(0);
  });

  it("as etapas base não mudam de nome nem de ordem, e as extra não saem do intervalo", async () => {
    const { data: q } = await admin.from("lead_stages").select("id").eq("key", "qualificada").single();
    expect(rows(await admin.from("lead_stages").update({ name: "x" }).eq("id", q.id).select("id"))).toHaveLength(0);
    expect((await gestor.from("lead_stages").update({ position: 40 }).eq("id", stageOpera.id)).error).toBeTruthy();
  });

  it("uma etapa com leads não se apaga; sem leads apaga-se", async () => {
    const { data: l } = await gestor.from("leads")
      .insert({ client_id: clientA, name: `${TAG} lead`, phone: "912000999", stage_id: stageOpera.id, entry_stage: "bd" }).select("id").single();
    leadId = l.id;
    const { error } = await gestor.from("lead_stages").delete().eq("id", stageOpera.id);
    expect(error?.code).toBe("23503");
    await admin.from("leads").delete().eq("id", leadId);
    leadId = null;
    expect(rows(await gestor.from("lead_stages").delete().eq("id", stageOpera.id).select("id"))).toHaveLength(1);
    expect(rows(await bAdmin.from("lead_stages").delete().eq("id", stageCliente.id).select("id"))).toHaveLength(0);
  });
});

