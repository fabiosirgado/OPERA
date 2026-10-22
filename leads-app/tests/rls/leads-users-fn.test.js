// Prova que a Edge Function de convites só deixa cada papel convidar quem deve.
// Corre contra o projeto de testes. Sem .env.test, os testes são saltados.
import { describe, it, expect, beforeAll } from "vitest";
import { loadEnv, USERS, anonClient, signIn, signInWithMfa } from "./helpers.js";

const env = loadEnv();
const suite = env ? describe : describe.skip;
const REDIRECT = "http://localhost:5173/leads/";

suite("Edge Function de convites", () => {
  let admin, gestor, gestorSemMfa, aAdmin, aUser, clientA, clientB;

  // Devolve { status, body } sem lançar erro, para ver também as recusas.
  const call = async (sb, payload) => {
    const { data: s } = await sb.auth.getSession();
    const res = await fetch(`${env.VITE_SUPABASE_URL}/functions/v1/leads-users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY,
        ...(s.session ? { Authorization: `Bearer ${s.session.access_token}` } : {}),
      },
      body: JSON.stringify({ redirect_to: REDIRECT, ...payload }),
    });
    return { status: res.status, body: await res.json() };
  };
  const invite = (sb, extra) => call(sb, { action: "invite", name: "Pessoa Teste", email: `nova-${Date.now()}@example.com`, ...extra });

  beforeAll(async () => {
    admin = await signInWithMfa(env, USERS.admin, "TOTP_ADMIN");
    gestor = await signInWithMfa(env, USERS.gestor, "TOTP_GESTOR");
    gestorSemMfa = await signIn(env, USERS.gestor);
    aAdmin = await signIn(env, USERS.aAdmin);
    aUser = await signIn(env, USERS.aUser);
    const { data } = await admin.from("clients").select("id,name").in("name", ["Cliente Teste A", "Cliente Teste B"]);
    clientA = data.find((c) => c.name === "Cliente Teste A").id;
    clientB = data.find((c) => c.name === "Cliente Teste B").id;
  });

  it("recusa pedidos sem sessão", async () => {
    expect((await call(anonClient(env), { action: "invite" })).status).toBe(401);
  });
  it("um utilizador do cliente não convida ninguém", async () => {
    expect((await invite(aUser, { role: "cliente", client_id: clientA })).status).toBe(403);
  });
  it("o admin do cliente só convida para o seu cliente, e nunca gestores", async () => {
    expect((await invite(aAdmin, { role: "cliente", client_id: clientB })).status).toBe(403);
    expect((await invite(aAdmin, { role: "gestor" })).status).toBe(403);
  });
  it("a equipa OPERA sem dois passos não convida", async () => {
    expect((await invite(gestorSemMfa, { role: "cliente", client_id: clientA })).status).toBe(403);
  });
  it("só o admin convida gestores", async () => {
    expect((await invite(gestor, { role: "gestor" })).status).toBe(403);
  });
  it("recusa links de regresso para outros sites", async () => {
    const r = await call(admin, { action: "invite", name: "X", email: "x@example.com", role: "cliente", client_id: clientA, redirect_to: "https://exemplo-mau.com/leads/" });
    expect(r.status).toBe(400);
  });
  it("dá acesso a quem já tem conta no CRM, sem criar outra", async () => {
    const r = await invite(admin, { email: "teste.crm@example.com", role: "cliente", client_id: clientA });
    if (r.status === 200) expect(r.body.status).toBe("ativo");
    else expect(r.body.error).toMatch(/já tem acesso/);
    const { data } = await admin.from("profiles").select("leads_role,client_id").eq("email", "teste.crm@example.com").single();
    expect(data).toMatchObject({ leads_role: "cliente", client_id: clientA });
  });
});
