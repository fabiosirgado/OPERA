// CloudTalk: o botão Ligar (sem chaves da CloudTalk, liga pelo telefone) e o webhook de fim de chamada.
// O webhook é chamado com a chave de teste das entradas automáticas, em vez da assinatura da CloudTalk.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadEnv, USERS, signIn, signInWithMfa } from "./helpers.js";

const env = loadEnv();
const suite = env?.LEADS_INBOUND_TEST_KEY ? describe : describe.skip;
const RUN = Date.now().toString(36);
const fn = () => `${env.VITE_SUPABASE_URL}/functions/v1/leads-cloudtalk`;
const phone = () => `93${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

async function hook(type, data, key = env.LEADS_INBOUND_TEST_KEY, eventId = `${RUN}-${Math.random().toString(36).slice(2)}`) {
  const res = await fetch(fn(), {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "x-opera-secret": key } : {}) },
    body: JSON.stringify({ event_id: eventId, type, version: "v1", data }),
  });
  return { status: res.status, body: await res.json(), eventId };
}

suite("CloudTalk", () => {
  let admin, gestor, aAdmin, c1, c2, stages;

  async function client(name) {
    let { data: c } = await admin.from("clients").select("id,leads_status").eq("name", name).maybeSingle();
    if (!c) ({ data: c } = await admin.from("clients").insert({ name, leads_enabled: true }).select("id,leads_status").single());
    if (c.leads_status === "inativo") await admin.rpc("leads_reactivate_client", { p_client_id: c.id });
    await admin.from("leads").delete().eq("client_id", c.id);
    return c.id;
  }
  const lead = async (clientId, row) => {
    const { data, error } = await gestor.from("leads")
      .insert({ client_id: clientId, entry_stage: "meta", stage_id: stages.meta, source: "Meta", ...row }).select("id").single();
    if (error) throw error;
    return data.id;
  };
  const get = (id) => gestor.from("leads").select("attempts,first_call_at,stage_id").eq("id", id).single().then((r) => r.data);
  const calls = (id) => gestor.from("lead_events").select("title,meta,created_at").eq("lead_id", id).eq("type", "call").then((r) => r.data);

  beforeAll(async () => {
    admin = await signInWithMfa(env, USERS.admin, "TOTP_ADMIN");
    gestor = await signInWithMfa(env, USERS.gestor, "TOTP_GESTOR");
    aAdmin = await signIn(env, USERS.aAdmin);
    const { data: st } = await admin.from("lead_stages").select("id,key").not("key", "is", null);
    stages = Object.fromEntries(st.map((s) => [s.key, s.id]));
    c1 = await client("Cliente CloudTalk");
    c2 = await client("Cliente CloudTalk 2");
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.from("leads").delete().in("client_id", [c1, c2].filter(Boolean));
  });

  it("o botão Ligar nunca liga pelo utilizador de teste; os clientes não ligam", async () => {
    // O utilizador de teste não tem agente na CloudTalk: com as chaves configuradas, o pedido é recusado antes de
    // ligar; sem chaves, a aplicação liga pelo telefone. Nunca sai uma chamada real a partir dos testes.
    expect((await admin.from("profiles").update({ cloudtalk_agent_id: null }).eq("email", USERS.gestor)).error).toBeNull();
    const id = await lead(c1, { name: "Ligar", phone: "930000000" });
    const call = async (sb) => {
      const { data: s } = await sb.auth.getSession();
      const res = await fetch(fn(), {
        method: "POST",
        headers: { "content-type": "application/json", apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${s.session.access_token}` },
        body: JSON.stringify({ action: "call", lead_id: id }),
      });
      return { status: res.status, body: await res.json() };
    };
    const r = await call(gestor);
    expect(r.body.configured === false || /agente da CloudTalk/.test(r.body.error ?? "")).toBe(true);
    expect((await call(aAdmin)).status).toBe(403);
  });

  it("o fim de chamada junta a duração e o resultado à chamada pedida pelo botão Ligar", async () => {
    const p = phone();
    const id = await lead(c1, { name: "Pedida", phone: `+351 ${p}`, created_at: ago(20) });
    expect((await gestor.rpc("leads_register_call", { p_lead_id: id, p_meta: { via: "cloudtalk" } })).error).toBeNull();
    const r = await hook("call.ended", {
      call_id: `c-${RUN}-1`, direction: "outgoing", external_number: `+351${p}`, started_at: new Date().toISOString(),
      talking_time: 95, duration: 110, recorded: false, user: { id: 1, email: USERS.gestor },
    });
    expect(r.body).toMatchObject({ ok: true, status: "processado", lead_id: id });
    const cs = await calls(id);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ title: "Chamada CloudTalk, atendida" });
    expect(cs[0].meta).toMatchObject({ via: "cloudtalk", call_id: `c-${RUN}-1`, answered: true, duration_s: 95 });
    expect((await get(id)).attempts).toBe(1);

    const again = await hook("call.ended", { call_id: `c-${RUN}-1`, direction: "outgoing", external_number: `+351${p}` }, undefined, r.eventId);
    expect(again.body.repetido).toBe(true);
    expect(await calls(id)).toHaveLength(1);
  });

  it("uma chamada feita diretamente na CloudTalk fica registada na lead com esse telefone", async () => {
    const p = phone();
    const id = await lead(c1, { name: "Direta", phone: p, created_at: ago(60) });
    const started = ago(30);
    const r = await hook("call.ended", {
      call_id: `c-${RUN}-2`, direction: "outgoing", external_number: `+351${p}`, started_at: started, talking_time: 0, duration: 25,
    });
    expect(r.body).toMatchObject({ status: "processado", lead_id: id });
    const l = await get(id);
    expect(l.attempts).toBe(1);
    expect(new Date(l.first_call_at).getTime()).toBe(new Date(started).getTime());
    expect(l.stage_id).toBe(stages.followup);
    expect((await calls(id))[0]).toMatchObject({ title: "Chamada CloudTalk, não atendida" });
  });

  it("o mesmo telefone em dois clientes: usa a lead com atividade mais recente e pede confirmação", async () => {
    const p = phone();
    await lead(c2, { name: "Antiga", phone: p, created_at: ago(600) });
    const recent = await lead(c1, { name: "Recente", phone: p, created_at: ago(5) });
    const r = await hook("call.ended", { call_id: `c-${RUN}-3`, direction: "outgoing", external_number: `+351${p}`, talking_time: 30 });
    expect(r.body).toMatchObject({ status: "processado", lead_id: recent, outros_clientes: true });
    const { data: notes } = await gestor.from("lead_events").select("title,body,pinned").eq("lead_id", recent).eq("type", "note");
    expect(notes[0]).toMatchObject({ title: "Confirmar a chamada", pinned: true });
    expect(notes[0].body).toContain("Cliente CloudTalk 2");
  });

  it("ignora chamadas recebidas e números sem lead", async () => {
    expect((await hook("call.ended", { call_id: `c-${RUN}-4`, direction: "incoming", external_number: "+351930000000" })).body.status).toBe("ignorado");
    expect((await hook("call.ended", { call_id: `c-${RUN}-5`, direction: "outgoing", external_number: "+351939999998" })).body.status).toBe("sem_lead");
    expect((await hook("call.started", { call_id: `c-${RUN}-6` })).body.status).toBe("ignorado");
  });

  it("a gravação fica marcada e só a equipa OPERA a pode ouvir", async () => {
    const p = phone();
    const id = await lead(c1, { name: "Gravada", phone: p });
    await hook("call.ended", { call_id: `c-${RUN}-7`, direction: "outgoing", external_number: `+351${p}`, talking_time: 12 });
    expect((await hook("call.recording_ready", { call_id: `c-${RUN}-7` })).body).toMatchObject({ status: "processado", lead_id: id });
    expect((await calls(id))[0].meta.recorded).toBe(true);
    expect((await gestor.rpc("leads_can_hear_recording", { p_call_id: `c-${RUN}-7` })).data).toBe(id);
    expect((await aAdmin.rpc("leads_can_hear_recording", { p_call_id: `c-${RUN}-7` })).error).toBeTruthy();
  });

  it("a análise da CloudTalk de uma chamada sem análise não grava nada; os clientes não a gravam", async () => {
    const p = phone();
    const id = await lead(c1, { name: "Analisada", phone: p });
    await hook("call.ended", { call_id: `c-${RUN}-8`, direction: "outgoing", external_number: `+351${p}`, talking_time: 30 });
    for (const type of ["transcript.ready", "cidata.ready"]) {
      const r = await hook(type, { call_id: `c-${RUN}-8`, complete: true });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe("ignorado");
    }
    expect((await calls(id))[0].meta.ci).toBeUndefined();
    expect((await aAdmin.rpc("leads_cloudtalk_ci", { p_call_id: `c-${RUN}-8`, p: { summary: "x" } })).error).toBeTruthy();
    expect((await gestor.rpc("leads_cloudtalk_ci", { p_call_id: `c-${RUN}-8`, p: { summary: "x" } })).error).toBeTruthy();
  });

  it("o resumo do cidata.ready fica numa nota da lead, e sai ao apagar os dados pessoais", async () => {
    const p = phone();
    const id = await lead(c1, { name: "Resumida", phone: p });
    await hook("call.ended", { call_id: `c-${RUN}-9`, direction: "outgoing", external_number: `+351${p}`, talking_time: 40 });
    const r = await hook("cidata.ready", {
      call_id: `c-${RUN}-9`, complete: true,
      summary: { summary: "Quer visitar o T2 no sábado.", ai_call_type: "qualification", smart_notes: { action_items: ["Marcar visita"] } },
      sentiment: { overall_sentiment: "positive" }, topics: [{ name: "Visita" }],
    });
    expect(r.body).toMatchObject({ status: "processado", lead_id: id });
    const ci = (await calls(id))[0].meta.ci;
    expect(ci).toMatchObject({ summary: "Quer visitar o T2 no sábado.", sentiment: "positive", topics: ["Visita"] });
    expect(ci.notes).toEqual(["Próximos passos: Marcar visita"]);
    // No histórico fica uma nota normal, como no Pipedrive.
    const notes = () => gestor.from("lead_events").select("title,body,edited_at").eq("lead_id", id).eq("type", "note").then((x) => x.data);
    expect(await notes()).toEqual([{ title: "Resumo da chamada (CloudTalk)", edited_at: null,
      body: "Quer visitar o T2 no sábado.\n\n• Próximos passos: Marcar visita\n\nSentimento positivo · Temas: Visita" }]);
    // Uma segunda análise da mesma chamada atualiza a mesma nota.
    await hook("cidata.ready", { call_id: `c-${RUN}-9`, summary: { summary: "Visita marcada para sábado." } });
    expect((await notes()).map((n) => n.body.split("\n")[0])).toEqual(["Visita marcada para sábado."]);
    // Um transcript.ready sem transcrição disponível não apaga o resumo.
    expect((await hook("transcript.ready", { call_id: `c-${RUN}-9` })).status).toBe(200);
    expect((await calls(id))[0].meta.ci.summary).toBe("Visita marcada para sábado.");
    expect((await gestor.rpc("leads_erase_subject", { p_lead_id: id, p_confirm: "APAGAR" })).error).toBeNull();
    expect((await calls(id))[0].meta.ci).toBeUndefined();
    expect(await notes()).toEqual([]);
  });

  it("recusa webhooks sem assinatura nem chave, e os clientes não chamam as funções do webhook", async () => {
    expect((await hook("call.ended", {}, "x".repeat(64))).status).toBe(401);
    const res = await fetch(fn(), { method: "POST", headers: { "content-type": "application/json", "svix-id": "msg_1", "svix-timestamp": "1", "svix-signature": "v1,abc" }, body: "{}" });
    expect(res.status).toBe(401);
    expect((await aAdmin.rpc("leads_cloudtalk_call_ended", { p: {} })).error).toBeTruthy();
    expect((await gestor.from("cloudtalk_events").select("event_id").limit(1)).error).toBeNull();
    expect((await aAdmin.from("cloudtalk_events").select("event_id")).data).toHaveLength(0);
  });
});
