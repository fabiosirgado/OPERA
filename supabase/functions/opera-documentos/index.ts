// OPERA · Documentos: envia o contrato ao cliente, pede as faturas à contabilidade e reencaminha-as ao cliente.
//
// Envio por Resend (domínio opera-os.com), a partir de financeiro@opera-os.com (alias da caixa do Fábio), com cópia
// oculta para a caixa dele, para as respostas e o histórico ficarem no Gmail. A 1.ª fatura de cada contrato segue
// no mesmo email que o contrato; todos os emails ao cliente levam o IBAN no texto. As faturas da contabilidade chegam por um mailhook do
// Make (filtro no Gmail que reencaminha os emails da contabilidade), que chama a ação "fatura_recebida".
//
// Segredos (Supabase → Edge Functions → Secrets):
//   RESEND_API_KEY            a mesma do OPERA Leads
//   OPERA_DOCS_FROM           opcional, "OPERA Financeiro <financeiro@opera-os.com>"
//   OPERA_DOCS_REPLY_TO       opcional, "financeiro@opera-os.com"
//   OPERA_CONTABILIDADE_EMAIL opcional, "geral@m-g.com.pt"
//
// Ações (POST com JSON):
//   pedir_faturas                       pagamentos que vencem até daqui a 2 dias e ainda sem fatura (cron diário ou nível total)
//   pedir_fatura { pagamento_id }       pede já a fatura de um pagamento (nível total)
//   reenviar_pedido { fatura_id }       volta a mandar o pedido (nível total)
//   gerar_contrato { contrato_id }      gera o PDF a partir da ficha e dos pagamentos e guarda-o (nível total)
//   enviar_contrato { contrato_id }     manda o PDF guardado ao email da ficha (nível total)
//   fatura_recebida { subject, from, filename, data_base64 }   chamado pelo Make (x-opera-secret)
//   enviar_fatura { fatura_id }         manda a fatura validada ao cliente (nível total)
//   marcar_fatura { fatura_id, estado } tratada_fora | cancelada (nível total)
// Em qualquer envio, { teste_para: "email" } manda só para esse endereço (para testar sem incomodar ninguém).
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { gerarContrato } from "./contrato.ts";

const SECRET_KEY = (() => {
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  return keys ? JSON.parse(keys).default : Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
})();
const db = createClient(Deno.env.get("SUPABASE_URL")!, SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
const FROM = Deno.env.get("OPERA_DOCS_FROM") ?? "OPERA Financeiro <financeiro@opera-os.com>";
const REPLY_TO = Deno.env.get("OPERA_DOCS_REPLY_TO") ?? "financeiro@opera-os.com";
const FABIO = "fabio.sirgado@opera-os.com";
const CONTABILIDADE = Deno.env.get("OPERA_CONTABILIDADE_EMAIL") ?? "geral@m-g.com.pt";
const DOMINIO_CONTABILIDADE = CONTABILIDADE.split("@")[1]?.toLowerCase() ?? "";
const FATURAS_DESDE = "2026-11-11"; // pagamentos anteriores ao arranque não geram pedido automático
const DIAS_ANTES = 2; // o pedido à contabilidade sai 2 dias antes do vencimento
const IVA = 0.23;
const IBAN = "PT50 0033 0000 4568 8726 8920 5";
const BUCKET = "opera-documentos";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-opera-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

// ---------- Quem chama (igual ao opera-banco)
async function nivelDe(req: Request): Promise<"total" | "sistema" | null> {
  const secret = req.headers.get("x-opera-secret");
  if (secret) {
    const { data } = await db.rpc("leads_inbound_verify", { p_secret: secret });
    return data === true ? "sistema" : null;
  }
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth, error } = await db.auth.getUser(token);
  if (error || !auth.user) return null;
  const aal = (() => { try { return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).aal; } catch { return null; } })();
  if (aal !== "aal2") return null;
  const { data: a } = await db.from("opera_admin_acessos").select("nivel").eq("user_id", auth.user.id).maybeSingle();
  const { data: p } = await db.from("profiles").select("leads_status").eq("id", auth.user.id).maybeSingle();
  return a?.nivel === "total" && p?.leads_status === "ativo" ? "total" : null;
}

// ---------- Utilitários
const eur = (n: number) => new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(n);
const dataPT = (s?: string | null) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : "");
const hoje = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Lisbon" });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const SERVICO: Record<string, string> = {
  SA: "OPERA SA (gestão de leads)", BO: "OPERA BO (back office)", BUNDLE: "OPERA SA + OPERA BO", OUTRO: "serviços OPERA",
};
const addDias = (iso: string, d: number) => { const x = new Date(iso + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
const addMeses = (iso: string, m: number) => { const x = new Date(iso + "T12:00:00Z"); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); };
const fimPack = (c: any) => c.data_fim || addDias(addMeses(c.data_inicio, c.duracao_meses || 3), -1);
const b64 = (bytes: Uint8Array) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const emailOk = (e: unknown) => typeof e === "string" && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(e.trim());

const MOLDE = (corpo: string) => `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a1a2e;max-width:620px">${corpo}
<p style="margin-top:24px">Com os melhores cumprimentos,<br><b>Equipa Financeira OPERA</b><br>Grabbingstars, Lda. · NIPC 516486900<br>financeiro@opera-os.com · opera-os.com</p></div>`;
const BLOCO_IBAN = `<p style="background:#F4F6FB;border-radius:8px;padding:10px 14px"><b>Dados para pagamento</b><br>Transferência bancária para Grabbingstars, Lda.<br>IBAN: <b>${IBAN}</b></p>`;

async function enviar(m: { to: string[]; subject: string; html: string; attachments?: { filename: string; content: string }[]; teste_para?: string }) {
  if (!RESEND_KEY) throw new HttpError(500, "Falta o segredo RESEND_API_KEY no Supabase.");
  const teste = m.teste_para && emailOk(m.teste_para) ? m.teste_para.trim() : null;
  const to = teste ? [teste] : m.to;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM, to, reply_to: REPLY_TO,
      ...(teste || to.includes(FABIO) ? {} : { bcc: [FABIO] }),
      subject: teste ? `[TESTE para ${m.to.join(", ")}] ${m.subject}` : m.subject,
      html: m.html, attachments: m.attachments ?? [],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `Resend ${res.status}: ${String(body?.message ?? "erro").slice(0, 200)}`);
  return { teste: !!teste };
}

async function pdfBase64(path: string) {
  const { data, error } = await db.storage.from(BUCKET).download(path);
  if (error || !data) throw new HttpError(404, "Não encontrei o PDF guardado.");
  return b64(new Uint8Array(await data.arrayBuffer()));
}

function fichaValida(f: any) {
  if (!f || !f.nome || !f.nif || !f.morada || !emailOk(f.email)) throw new HttpError(400, "A ficha de fecho está incompleta (nome, NIF, morada e email).");
  return f;
}

// ---------- Contrato
async function gerar(contratoId: string) {
  const { data: c } = await db.from("opera_contratos").select("*, opera_pagamentos(numero,valor,data_prevista,estado)").eq("id", contratoId).maybeSingle();
  if (!c) throw new HttpError(404, "Contrato não encontrado.");
  const f = fichaValida(c.ficha);
  if (f.tipo !== "particular" && !f.rep_nome) throw new HttpError(400, "Falta o nome do representante da empresa na ficha.");
  let bytes: Uint8Array;
  try { bytes = await gerarContrato({ ...c, ficha: f }, (c.opera_pagamentos ?? []).map((p: any) => ({ ...p, valor: Number(p.valor) }))); }
  catch (e) { throw new HttpError(400, e instanceof Error ? e.message : String(e)); }
  const path = `contratos/${c.id}/contrato-${Date.now()}.pdf`;
  const { error } = await db.storage.from(BUCKET).upload(path, bytes, { contentType: "application/pdf" });
  if (error) throw new Error(error.message);
  await db.from("opera_contratos").update({ contrato_pdf: path, contrato_gerado_em: new Date().toISOString() }).eq("id", c.id);
  const { data: s } = await db.storage.from(BUCKET).createSignedUrl(path, 600);
  return { ok: true, path, url: s?.signedUrl ?? null };
}

async function enviarContrato(contratoId: string, teste_para?: string) {
  const { data: c } = await db.from("opera_contratos").select("*").eq("id", contratoId).maybeSingle();
  if (!c) throw new HttpError(404, "Contrato não encontrado.");
  const f = fichaValida(c.ficha);
  if (!c.contrato_pdf) throw new HttpError(400, "Gera e guarda o contrato antes de o enviar.");
  const pessoa = (f.tipo === "empresa" ? f.rep_nome : f.nome) || f.nome;
  const primeiro = String(pessoa).trim().split(/\s+/)[0];
  const html = MOLDE(`<p>Olá ${esc(primeiro)},</p>
<p>Segue em anexo o contrato de prestação de serviços da OPERA (${esc(SERVICO[c.servico] ?? "OPERA")}), com início a ${esc(dataPT(c.data_inicio))}.</p>
<p><b>Como assinar:</b> pode assinar digitalmente com a Chave Móvel Digital, gratuitamente, em <a href="https://www.autenticacao.gov.pt/web/guest/cc-aplicacao">autenticacao.gov.pt</a> (opção "Assinar documento"). Depois basta responder a este email com o PDF assinado e nós devolvemos a versão final assinada pelas duas partes.</p>
${BLOCO_IBAN}
<p>Qualquer dúvida, estamos disponíveis.</p>`);
  const r = await enviar({
    to: [f.email.trim()], subject: `Contrato OPERA · ${f.nome}`, html, teste_para,
    attachments: [{ filename: `Contrato OPERA ${c.servico ?? ""} ${f.nome}.pdf`.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " "), content: await pdfBase64(c.contrato_pdf) }],
  });
  if (!r.teste) await db.from("opera_contratos").update({ contrato_enviado_em: new Date().toISOString(), contrato_enviado_para: f.email.trim() }).eq("id", c.id);
  return { ok: true, teste: r.teste };
}

// ---------- Pedido de fatura
function textoPedido(fat: any, c: any) {
  const f = fat.dados;
  const total = Number(fat.valor);
  const desc = `Prestação de serviços ${SERVICO[c.servico] ?? "OPERA"}, pack de ${c.duracao_meses || 3} ${c.duracao_meses === 1 ? "mês" : "meses"} de ${dataPT(c.data_inicio)} a ${dataPT(fimPack(c))}`
    + (fat.total_pagamentos > 1 ? `, pagamento ${fat.numero} de ${fat.total_pagamentos}` : ", pagamento integral");
  const linhas: [string, string][] = [
    ["Cliente", f.nome], ["NIF", f.nif], ["Morada", [f.morada, [f.codigo_postal, f.localidade].filter(Boolean).join(" ")].filter(Boolean).join(", ")],
    ["Email do cliente", f.email], ["Descrição", desc], ["Valor", `${eur(total)} + IVA (${Math.round(IVA * 100)}%) = ${eur(Math.round(total * (1 + IVA) * 100) / 100)}`],
    ["Data de vencimento", dataPT(fat.data_prevista)],
  ];
  const html = MOLDE(`<p>Olá,</p>
<p>Pedimos a emissão da seguinte fatura em nome da Grabbingstars, Lda. (NIPC 516486900):</p>
<table style="border-collapse:collapse;font-size:14px">${linhas.map(([k, v]) => `<tr><td style="padding:4px 14px 4px 0;color:#666;vertical-align:top">${esc(k)}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>`).join("")}</table>
<p><b>Por favor respondam a este email com a fatura em PDF</b>, mantendo a referência ${esc(fat.ref)} no assunto, para seguir automaticamente para o cliente.</p>
<p>Obrigado.</p>`);
  return { subject: `Pedido de fatura [OPERA ${fat.ref}] ${f.nome}`, html };
}

async function pedirUma(pag: any, c: any, teste_para?: string) {
  const f = fichaValida(c.ficha);
  const total = (c.opera_pagamentos ?? []).filter((p: any) => p.estado !== "cancelado").length || c.modalidade || 1;
  let { data: fat } = await db.from("opera_faturas").select("*").eq("pagamento_id", pag.id).neq("estado", "cancelada").maybeSingle();
  if (fat && !["a_pedir", "erro", "pedida"].includes(fat.estado)) throw new HttpError(400, `A fatura ${fat.ref} já está ${fat.estado}.`);
  const dados = {
    tipo: f.tipo ?? null, nome: f.nome, nif: f.nif, morada: f.morada, codigo_postal: f.codigo_postal ?? null, localidade: f.localidade ?? null,
    email: f.email.trim(),
  };
  if (!fat && teste_para) {
    // Teste: mostra o email do pedido sem criar nenhum registo
    const falso = { ref: "F-TESTE", dados, valor: Number(pag.valor), numero: pag.numero, total_pagamentos: total, data_prevista: pag.data_prevista };
    const r = await enviar({ to: [CONTABILIDADE], ...textoPedido(falso, c), teste_para });
    return { ref: falso.ref, cliente: c.cliente, teste: r.teste };
  }
  if (!fat) {
    const { data, error } = await db.from("opera_faturas").insert({
      contrato_id: c.id, pagamento_id: pag.id, cliente: c.cliente, numero: pag.numero, total_pagamentos: total,
      valor: Number(pag.valor), data_prevista: pag.data_prevista, dados, estado: "a_pedir",
    }).select("*").single();
    if (error) throw new Error(error.message);
    fat = data;
  } else {
    const { data } = await db.from("opera_faturas").update({ dados, valor: Number(pag.valor), total_pagamentos: total, data_prevista: pag.data_prevista }).eq("id", fat.id).select("*").single();
    fat = data;
  }
  try {
    const m = textoPedido(fat, c);
    const r = await enviar({ to: [CONTABILIDADE], ...m, teste_para });
    if (!r.teste) await db.from("opera_faturas").update({ estado: "pedida", pedida_em: new Date().toISOString(), erro: null }).eq("id", fat.id);
    return { ref: fat.ref, cliente: c.cliente, teste: r.teste };
  } catch (e) {
    await db.from("opera_faturas").update({ estado: "erro", erro: e instanceof Error ? e.message : String(e) }).eq("id", fat.id);
    throw e;
  }
}

const SELECT_PAG = "id,numero,valor,data_prevista,estado,contrato_id,c:opera_contratos!inner(id,cliente,servico,modalidade,duracao_meses,data_inicio,data_fim,estado,ficha,opera_pagamentos(id,estado))";

async function pedirFaturas() {
  const { data: pags, error } = await db.from("opera_pagamentos").select(SELECT_PAG)
    .in("estado", ["pendente", "pago"]).gte("data_prevista", FATURAS_DESDE).lte("data_prevista", addDias(hoje(), DIAS_ANTES));
  if (error) throw new Error(error.message);
  const { data: ja } = await db.from("opera_faturas").select("pagamento_id,estado").neq("estado", "cancelada");
  const tratados = new Set((ja ?? []).filter((f) => f.estado !== "a_pedir" && f.estado !== "erro").map((f) => f.pagamento_id));
  const feitos: unknown[] = [], falhas: unknown[] = [], semFicha: string[] = [];
  for (const p of pags ?? []) {
    const c = (p as any).c;
    if (c.estado !== "ativo" || tratados.has(p.id)) continue;
    if (!c.ficha) { semFicha.push(c.cliente); continue; }
    try { feitos.push(await pedirUma(p, c)); } catch (e) { falhas.push({ cliente: c.cliente, erro: e instanceof Error ? e.message : String(e) }); }
  }
  return { ok: true, pedidas: feitos, falhas, sem_ficha: [...new Set(semFicha)] };
}

async function pedirFatura(pagamentoId: string, teste_para?: string) {
  const { data: p } = await db.from("opera_pagamentos").select(SELECT_PAG).eq("id", pagamentoId).maybeSingle();
  if (!p) throw new HttpError(404, "Pagamento não encontrado.");
  if ((p as any).c.estado === "cancelado" || p.estado === "cancelado") throw new HttpError(400, "Pagamento cancelado.");
  return { ok: true, ...(await pedirUma(p, (p as any).c, teste_para)) };
}

async function reenviarPedido(faturaId: string, teste_para?: string) {
  const { data: f } = await db.from("opera_faturas").select("pagamento_id").eq("id", faturaId).maybeSingle();
  if (!f?.pagamento_id) throw new HttpError(404, "Fatura sem pagamento associado.");
  return await pedirFatura(f.pagamento_id, teste_para);
}

// ---------- Resposta da contabilidade (Make)
async function faturaRecebida(b: Record<string, unknown>) {
  const from = String(b.from ?? "").toLowerCase();
  const subject = String(b.subject ?? "");
  const filename = String(b.filename ?? "fatura.pdf").slice(0, 150);
  const data = String(b.data_base64 ?? "");
  if (DOMINIO_CONTABILIDADE && !from.includes("@" + DOMINIO_CONTABILIDADE) && !from.includes(FABIO)) return { ok: false, ignorado: "remetente" };
  if (!/\.pdf$/i.test(filename) && !String(b.content_type ?? "").includes("pdf")) return { ok: false, ignorado: "não é PDF" };
  const ref = (subject.match(/F-\d{4,}/) ?? String(b.text ?? "").match(/F-\d{4,}/) ?? filename.match(/F-\d{4,}/))?.[0];
  if (!ref) return { ok: false, ignorado: "sem referência" };
  const { data: fat } = await db.from("opera_faturas").select("*").eq("ref", ref).maybeSingle();
  if (!fat) return { ok: false, ignorado: "referência desconhecida" };
  if (!["pedida", "erro", "a_pedir", "recebida"].includes(fat.estado)) return { ok: false, ignorado: `fatura já ${fat.estado}` };
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(data.replace(/\s+/g, "")), (ch) => ch.charCodeAt(0)); } catch { throw new HttpError(400, "PDF inválido."); }
  if (bytes.length < 100 || String.fromCharCode(...bytes.subarray(0, 4)) !== "%PDF") throw new HttpError(400, "O anexo não é um PDF.");
  const path = `faturas/${ref}.pdf`;
  const { error } = await db.storage.from(BUCKET).upload(path, bytes, { contentType: "application/pdf", upsert: true });
  if (error) throw new Error(error.message);
  await db.from("opera_faturas").update({ estado: "recebida", recebida_em: new Date().toISOString(), pdf_path: path, pdf_nome: filename, erro: null }).eq("id", fat.id);
  return { ok: true, ref };
}

// ---------- Fatura ao cliente (a 1.ª fatura de um contrato ainda não enviado leva o contrato no mesmo email)
async function enviarFatura(faturaId: string, teste_para?: string) {
  const { data: fat } = await db.from("opera_faturas").select("*").eq("id", faturaId).maybeSingle();
  if (!fat) throw new HttpError(404, "Fatura não encontrada.");
  if (!fat.pdf_path) throw new HttpError(400, "Ainda não chegou o PDF desta fatura.");
  if (fat.estado === "enviada" && !teste_para) throw new HttpError(400, "Esta fatura já foi enviada.");
  const email = String(fat.dados?.email ?? "").trim();
  if (!emailOk(email)) throw new HttpError(400, "Falta o email do cliente na ficha.");
  const { data: c } = await db.from("opera_contratos").select("id,servico,ficha,data_inicio,contrato_pdf,contrato_enviado_em").eq("id", fat.contrato_id).maybeSingle();
  const comContrato = !!c && !c.contrato_enviado_em && fat.numero === 1;
  if (comContrato && !c.contrato_pdf) throw new HttpError(400, "Gera o contrato antes de enviar a primeira fatura: seguem os dois no mesmo email.");
  const pessoa = (c?.ficha?.tipo === "empresa" ? c?.ficha?.rep_nome : fat.dados?.nome) || fat.dados?.nome || "";
  const primeiro = String(pessoa).trim().split(/\s+/)[0];
  const valorIva = Math.round(Number(fat.valor) * (1 + IVA) * 100) / 100;
  const qual = fat.total_pagamentos > 1 ? `pagamento ${fat.numero} de ${fat.total_pagamentos}` : "pagamento integral";
  const servico = SERVICO[c?.servico] ?? "serviço OPERA";
  const corpo = comContrato
    ? `<p>Olá ${esc(primeiro)},</p>
<p>Bem-vindo(a) à OPERA. Seguem em anexo:</p>
<ul><li>o <b>contrato</b> de prestação de serviços (${esc(servico)}), com início a ${esc(dataPT(c.data_inicio))};</li>
<li>a <b>fatura</b> relativa ao ${esc(qual)}, no valor de <b>${esc(eur(valorIva))}</b> (IVA incluído), com vencimento a ${esc(dataPT(fat.data_prevista))}.</li></ul>
<p><b>Como assinar o contrato:</b> pode assinar digitalmente com a Chave Móvel Digital, gratuitamente, em <a href="https://www.autenticacao.gov.pt/web/guest/cc-aplicacao">autenticacao.gov.pt</a> (opção "Assinar documento"). Depois basta responder a este email com o PDF assinado.</p>
${BLOCO_IBAN}
<p>Qualquer dúvida, estamos disponíveis.</p>`
    : `<p>Olá ${esc(primeiro)},</p>
<p>Segue em anexo a fatura relativa ao ${esc(qual)} do ${esc(servico)}, no valor de <b>${esc(eur(valorIva))}</b> (IVA incluído), com vencimento a ${esc(dataPT(fat.data_prevista))}.</p>
${BLOCO_IBAN}
<p>Qualquer dúvida, estamos disponíveis.</p>`;
  const anexos = [{ filename: fat.pdf_nome && /\.pdf$/i.test(fat.pdf_nome) ? fat.pdf_nome : `Fatura ${fat.ref}.pdf`, content: await pdfBase64(fat.pdf_path) }];
  if (comContrato) anexos.unshift({ filename: `Contrato OPERA ${c.servico ?? ""} ${fat.dados?.nome ?? fat.cliente}.pdf`.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " "), content: await pdfBase64(c.contrato_pdf) });
  const r = await enviar({
    to: [email], html: MOLDE(corpo), teste_para, attachments: anexos,
    subject: comContrato ? `Contrato e fatura OPERA · ${fat.dados?.nome ?? fat.cliente}` : `Fatura OPERA · ${fat.dados?.nome ?? fat.cliente} · ${qual}`,
  });
  if (!r.teste) {
    const agora = new Date().toISOString();
    await db.from("opera_faturas").update({ estado: "enviada", enviada_em: agora, enviada_para: email }).eq("id", fat.id);
    if (comContrato) await db.from("opera_contratos").update({ contrato_enviado_em: agora, contrato_enviado_para: email }).eq("id", c.id);
  }
  return { ok: true, teste: r.teste, com_contrato: comContrato };
}

async function marcarFatura(faturaId: string, estado: string) {
  if (!["tratada_fora", "cancelada"].includes(estado)) throw new HttpError(400, "Estado inválido.");
  const { error } = await db.from("opera_faturas").update({ estado }).eq("id", faturaId).neq("estado", "enviada");
  if (error) throw new Error(error.message);
  return { ok: true };
}

// Marca um pagamento como "fatura já tratada fora do sistema" (ex.: faturas emitidas antes do arranque).
async function tratadaFora(pagamentoId: string) {
  const { data: p } = await db.from("opera_pagamentos").select(SELECT_PAG).eq("id", pagamentoId).maybeSingle();
  if (!p) throw new HttpError(404, "Pagamento não encontrado.");
  const c = (p as any).c;
  const { data: fat } = await db.from("opera_faturas").select("id,estado").eq("pagamento_id", pagamentoId).neq("estado", "cancelada").maybeSingle();
  if (fat) return await marcarFatura(fat.id, "tratada_fora");
  const { error } = await db.from("opera_faturas").insert({
    contrato_id: c.id, pagamento_id: p.id, cliente: c.cliente, numero: p.numero, total_pagamentos: c.modalidade, valor: Number(p.valor),
    data_prevista: p.data_prevista, estado: "tratada_fora", dados: c.ficha ?? {},
  });
  if (error) throw new Error(error.message);
  return { ok: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);
  try {
    const nivel = await nivelDe(req);
    if (!nivel) return json({ error: "Sem acesso." }, 403);
    let b: Record<string, any> = {};
    const ct = req.headers.get("content-type") ?? "";
    try { b = ct.includes("application/x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(await req.text())) : await req.json(); }
    catch { return json({ error: "Pedido inválido." }, 400); }
    const teste = typeof b.teste_para === "string" ? b.teste_para : undefined;
    if (b.action === "pedir_faturas") return json(await pedirFaturas());
    if (b.action === "fatura_recebida") return json(await faturaRecebida(b));
    if (nivel !== "total") return json({ error: "Sem acesso." }, 403);
    const id = String(b.pagamento_id ?? b.fatura_id ?? b.contrato_id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Falta o identificador." }, 400);
    if (b.action === "pedir_fatura") return json(await pedirFatura(id, teste));
    if (b.action === "reenviar_pedido") return json(await reenviarPedido(id, teste));
    if (b.action === "gerar_contrato") return json(await gerar(id));
    if (b.action === "enviar_contrato") return json(await enviarContrato(id, teste));
    if (b.action === "enviar_fatura") return json(await enviarFatura(id, teste));
    if (b.action === "marcar_fatura") return json(await marcarFatura(id, String(b.estado ?? "")));
    if (b.action === "tratada_fora") return json(await tratadaFora(id));
    return json({ error: "Ação desconhecida." }, 400);
  } catch (e) {
    console.error("opera-documentos:", e instanceof Error ? e.message : e);
    return json({ error: e instanceof Error ? e.message : "Erro no servidor." }, e instanceof HttpError ? e.status : 500);
  }
});
