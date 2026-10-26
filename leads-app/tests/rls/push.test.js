// Notificações no telemóvel: cada pessoa só vê e apaga os seus dispositivos; as chaves e a fila ficam no servidor.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadEnv, USERS, signIn } from "./helpers.js";

const env = loadEnv();
const suite = env ? describe : describe.skip;
const ENDPOINT = `https://fcm.googleapis.com/fcm/send/teste-rls-${Date.now()}`;
const KEYS = { p_p256dh: "BGwNolkQ3VtqrF2FcbVIeO0Eve7FNcl_MtTVnkOKAB2uG_NmpeIDHtKjMxrsD9h1PBhfpEAfpCOsyk7579E3WhE", p_auth: "kA7_N4FxZ92IrspkiiRFHQ" };

suite("Notificações no telemóvel", () => {
  let aAdmin, bAdmin;

  beforeAll(async () => {
    aAdmin = await signIn(env, USERS.aAdmin);
    bAdmin = await signIn(env, USERS.bAdmin);
  });

  afterAll(async () => {
    await aAdmin?.rpc("leads_push_unsubscribe", { p_endpoint: ENDPOINT });
    await bAdmin?.rpc("leads_push_unsubscribe", { p_endpoint: ENDPOINT });
  });

  it("ativa neste dispositivo e só a própria pessoa o vê", async () => {
    expect((await aAdmin.rpc("leads_push_subscribe", { p_endpoint: ENDPOINT, ...KEYS })).error).toBeNull();
    const mine = (await aAdmin.from("push_subscriptions").select("endpoint")).data.map((s) => s.endpoint);
    expect(mine).toContain(ENDPOINT);
    const other = (await bAdmin.from("push_subscriptions").select("endpoint")).data.map((s) => s.endpoint);
    expect(other).not.toContain(ENDPOINT);
  });

  it("outra pessoa no mesmo browser fica com o dispositivo", async () => {
    expect((await bAdmin.rpc("leads_push_subscribe", { p_endpoint: ENDPOINT, ...KEYS })).error).toBeNull();
    expect((await aAdmin.from("push_subscriptions").select("endpoint")).data.map((s) => s.endpoint)).not.toContain(ENDPOINT);
    expect((await bAdmin.from("push_subscriptions").select("endpoint")).data.map((s) => s.endpoint)).toContain(ENDPOINT);
  });

  it("só aceita endereços https", async () => {
    expect((await aAdmin.rpc("leads_push_subscribe", { p_endpoint: "http://exemplo.pt/x", ...KEYS })).error).not.toBeNull();
  });

  it("a chave pública está disponível; a privada, a fila e o envio não", async () => {
    expect((await aAdmin.rpc("leads_push_public_key")).error).toBeNull();
    expect((await aAdmin.rpc("leads_push_keys")).error).not.toBeNull();
    expect((await aAdmin.rpc("leads_push_claim")).error).not.toBeNull();
    expect((await aAdmin.rpc("leads_push_done", { p_ok: [], p_gone: [], p_failed: [] })).error).not.toBeNull();
    expect((await aAdmin.from("lead_push_queue").select("id")).data).toEqual([]);
  });
});
