// Separador "Contratos e faturas" do Dashboard Admin (só nível total).
// Ficha de fecho → contrato em PDF (gerado no servidor) → envio ao cliente.
// Pedidos de fatura à contabilidade (automáticos na data prevista) → fatura recebida → validação → envio ao cliente.
// Tudo o que envia emails ou gera documentos passa pela Edge Function opera-documentos.
import { sb, SUPABASE_URL } from "../../supabase.js";

const EU = "fabio.sirgado@opera-os.com";
const DESDE = "2026-11-11"; // igual a FATURAS_DESDE na Edge Function
const eur = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: 2 });
const dataPT = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : "");
const quando = (s) => (s ? new Date(s).toLocaleString("pt-PT", { dateStyle: "short", timeStyle: "short" }) : "");
const hoje = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const emDias = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); kids.forEach((k) => k != null && e.append(k)); return e; };
const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };
const SRV = { SA: "OPERA SA", BO: "OPERA BO", BUNDLE: "Bundle SA + BO", OUTRO: "Outro" };
const ESTADO_FAT = { a_pedir: "por pedir", pedida: "pedida", recebida: "por validar", enviada: "enviada", tratada_fora: "tratada fora", cancelada: "cancelada", erro: "erro" };

// NIF/NIPC português: 9 dígitos com dígito de controlo
export function nifValido(v) {
  const s = String(v || "").replace(/\s+/g, "");
  if (!/^\d{9}$/.test(s)) return false;
  const soma = [...s.slice(0, 8)].reduce((t, d, i) => t + Number(d) * (9 - i), 0);
  const ctl = 11 - (soma % 11);
  return Number(s[8]) === (ctl >= 10 ? 0 : ctl);
}
const emailValido = (v) => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(String(v || "").trim());
const limpa = (v, max = 160) => String(v || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

async function chamar(payload) {
  const { data: s } = await sb.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/opera-documentos`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${s.session?.access_token ?? ""}` },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "O servidor não respondeu.");
  return body;
}

// Abre um PDF do bucket privado num separador novo (o separador abre-se antes do pedido, para o browser não o bloquear)
async function abrirPdf(path) {
  const w = window.open("", "_blank");
  try {
    const { data, error } = await sb.storage.from("opera-documentos").createSignedUrl(path, 300);
    if (error) throw error;
    if (w) w.location.href = data.signedUrl; else window.location.href = data.signedUrl;
  } catch (e) { w?.close(); throw e; }
}

// Formulário da ficha de fecho
export function fichaForm(f = {}, clienteNome = "") {
  const tipo = el("select");
  tipo.append(el("option", { value: "empresa", textContent: "Empresa" }), el("option", { value: "particular", textContent: "Particular" }));
  tipo.value = f.tipo === "particular" ? "particular" : "empresa";
  const inp = (v, ph = "", w = "200px", type = "text") => { const i = el("input", { type, value: v || "", placeholder: ph }); i.style.minWidth = w; return i; };
  const I = {
    nome: inp(f.nome || clienteNome, "", "260px"), nif: inp(f.nif, "9 dígitos", "120px"),
    morada: inp(f.morada, "Rua, n.º, andar", "280px"), codigo_postal: inp(f.codigo_postal, "0000-000", "100px"), localidade: inp(f.localidade, "", "140px"),
    rep_nome: inp(f.rep_nome, "Nome completo", "240px"), rep_qualidade: inp(f.rep_qualidade || "gerente", "", "120px"),
    rep_cc: inp(f.rep_cc, "N.º do documento", "150px"), rep_cc_validade: inp(f.rep_cc_validade, "", "140px", "date"), rep_nif: inp(f.rep_nif, "", "120px"),
    cc: inp(f.cc, "N.º do documento", "150px"), cc_validade: inp(f.cc_validade, "", "140px", "date"),
    email: inp(f.email, "", "240px", "email"), telefone: inp(f.telefone, "+351 …", "150px"), ami: inp(f.ami, "Se aplicável", "100px"),
  };
  const lab = (t, c) => el("label", {}, t, c);
  const lNome = lab("Denominação social", I.nome), lNif = lab("NIPC", I.nif), lMorada = lab("Sede", I.morada);
  const emp = el("div", { className: "form" }, lab("Representante", I.rep_nome), lab("Qualidade", I.rep_qualidade), lab("CC do representante", I.rep_cc), lab("Validade do CC", I.rep_cc_validade), lab("NIF do representante", I.rep_nif));
  const par = el("div", { className: "form" }, lab("Cartão de Cidadão", I.cc), lab("Validade do CC", I.cc_validade));
  const ajusta = () => {
    const e = tipo.value === "empresa";
    lNome.firstChild.textContent = e ? "Denominação social" : "Nome completo";
    lNif.firstChild.textContent = e ? "NIPC" : "NIF";
    lMorada.firstChild.textContent = e ? "Sede" : "Morada";
    emp.hidden = !e; par.hidden = e;
  };
  tipo.addEventListener("change", ajusta); ajusta();
  const node = el("div", {},
    el("div", { className: "form" }, lab("Tipo", tipo), lNome, lNif),
    el("div", { className: "form" }, lMorada, lab("Código postal", I.codigo_postal), lab("Localidade", I.localidade)),
    emp, par,
    el("div", { className: "form" }, lab("Email do cliente", I.email), lab("Telefone", I.telefone), lab("Licença AMI", I.ami)));
  return {
    node,
    valores() {
      const e = tipo.value === "empresa";
      const v = Object.fromEntries(Object.entries(I).map(([k, i]) => [k, limpa(i.value)]));
      if (!v.nome) throw new Error(e ? "Falta a denominação social." : "Falta o nome.");
      if (!nifValido(v.nif)) throw new Error(e ? "O NIPC não é válido." : "O NIF não é válido.");
      if (!v.morada) throw new Error("Falta a morada.");
      if (v.codigo_postal && !/^\d{4}-\d{3}$/.test(v.codigo_postal)) throw new Error("O código postal deve ter o formato 0000-000.");
      if (!emailValido(v.email)) throw new Error("O email do cliente não é válido.");
      if (e && !v.rep_nome) throw new Error("Falta o nome do representante.");
      if (e && v.rep_nif && !nifValido(v.rep_nif)) throw new Error("O NIF do representante não é válido.");
      const out = { tipo: tipo.value, nome: v.nome, nif: v.nif.replace(/\s+/g, ""), morada: v.morada, codigo_postal: v.codigo_postal || null, localidade: v.localidade || null,
        email: v.email.toLowerCase(), telefone: v.telefone || null, ami: v.ami.replace(/^AMI\s*(n\.?º?\s*)?/i, "") || null };
      if (e) Object.assign(out, { rep_nome: v.rep_nome, rep_qualidade: v.rep_qualidade || "gerente", rep_cc: v.rep_cc || null, rep_cc_validade: v.rep_cc_validade || null, rep_nif: v.rep_nif || null });
      else Object.assign(out, { cc: v.cc || null, cc_validade: v.cc_validade || null });
      return out;
    },
  };
}

export function mountDocumentos(box) {
  box.innerHTML = "";
  const msg = el("div", { className: "msg" }); msg.hidden = true;
  const status = (m, kind) => { msg.textContent = m || ""; msg.hidden = !m; msg.className = "msg" + (kind ? " " + kind : ""); if (m) msg.scrollIntoView({ block: "nearest" }); };
  const card = (titulo, nota, ...kids) => el("div", { className: "op-card", style: "margin-bottom:16px" }, el("h2", { textContent: titulo }), el("p", { className: "note", textContent: nota }), ...kids);
  const L = {};
  ["fichas", "contratos", "validar", "pedidos", "proximos", "enviadas"].forEach((k) => { L[k] = el("div", {}, el("div", { className: "vazio", textContent: "A carregar…" })); });
  box.append(msg,
    card("Fichas de fecho por preencher", "Clientes fechados sem dados de identificação. Sem ficha não há contrato nem pedido de fatura. Tu ou a Ana preenchem uma vez; as renovações herdam a ficha.", L.fichas),
    card("Contratos", "Gera o contrato a partir da ficha e dos pagamentos (o modelo escolhe sozinho as cláusulas de pagamento integral ou em prestações), vê o PDF e envia ao cliente. Para já só existe modelo para o OPERA SA. \"Enviar teste\" manda só para ti.", L.contratos),
    card("Faturas por validar", "Faturas que a contabilidade já mandou. Abre o PDF, confirma e envia ao cliente.", L.validar),
    card("Pedidos de fatura em curso", "Pedidos enviados à contabilidade (geral@m-g.com.pt) à espera da resposta com o PDF, e os que falharam.", L.pedidos),
    card("Próximos pedidos de fatura", "Todos os dias às 8h10 o sistema pede à contabilidade as faturas dos pagamentos que vencem nesse dia (só de clientes com ficha e a partir de 11/11/2026). Aqui vês os próximos 31 dias e os vencidos sem pedido. Podes pedir já, ou marcar como tratada fora se a fatura já foi passada por outra via.", L.proximos),
    card("Faturas enviadas", "As últimas 20 faturas enviadas aos clientes.", L.enviadas));

  const vazio = (node, t) => node.replaceChildren(el("div", { className: "vazio", textContent: t }));
  async function acao(btn, fn, okMsg) {
    btn.disabled = true; status("A tratar…");
    try { const r = await fn(); status(typeof okMsg === "function" ? okMsg(r) : okMsg, "ok"); await carregar(); return r; }
    catch (e) { status(e?.message || "Algo falhou.", "err"); btn.disabled = false; return null; }
  }
  function confirmar2(btn, label, fn) {
    let armado = false;
    btn.addEventListener("click", () => {
      if (!armado) { armado = true; btn.textContent = "Confirma: enviar?"; setTimeout(() => { armado = false; btn.textContent = label; }, 4000); return; }
      armado = false; fn();
    });
  }
  const botao = (t, cls = "") => el("button", { textContent: t, className: cls });
  const verPdf = (path) => { const b = botao("Ver PDF"); b.addEventListener("click", () => abrirPdf(path).catch((e) => status(e.message, "err"))); return b; };

  function editorFicha(c, depois) {
    const f = fichaForm(c.ficha || {}, c.cliente);
    const guardar = botao("Guardar ficha", "pri");
    guardar.addEventListener("click", () => {
      let v; try { v = f.valores(); } catch (e) { status(e.message, "err"); return; }
      acao(guardar, () => must(sb.from("opera_contratos").update({ ficha: v, ficha_em: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", c.id)),
        `Ficha de ${v.nome} guardada.`).then(depois);
    });
    return el("div", { className: "edit" }, f.node, el("div", { className: "actions" }, guardar));
  }

  const abertos = new Set();
  function renderFichas(rows) {
    if (!rows.length) return vazio(L.fichas, "Todos os clientes ativos têm ficha.");
    L.fichas.replaceChildren(...rows.map((c) => {
      const painel = el("div"); painel.hidden = !abertos.has("f" + c.id);
      const abrir = botao(painel.hidden ? "Preencher ficha" : "Fechar", "pri");
      abrir.addEventListener("click", () => {
        if (painel.hidden && !painel.firstChild) painel.append(editorFicha(c, () => abertos.delete("f" + c.id)));
        painel.hidden = !painel.hidden; abrir.textContent = painel.hidden ? "Preencher ficha" : "Fechar";
        if (painel.hidden) abertos.delete("f" + c.id); else abertos.add("f" + c.id);
      });
      if (!painel.hidden) painel.append(editorFicha(c, () => abertos.delete("f" + c.id)));
      return el("div", { className: "item" },
        el("div", { className: "grow" }, el("b", { textContent: c.cliente }), el("div", { className: "muted", textContent: `${SRV[c.servico] || "serviço por definir"} · início a ${dataPT(c.data_inicio)}${c.estado === "incompleto" ? " · contrato por completar" : ""}` })),
        el("div", { className: "actions" }, abrir), painel);
    }));
  }

  function renderContratos(rows) {
    if (!rows.length) return vazio(L.contratos, "Ainda não há contratos com ficha.");
    L.contratos.replaceChildren(...rows.map((c) => {
      const f = c.ficha;
      const passos = [
        c.contrato_gerado_em ? `gerado a ${quando(c.contrato_gerado_em)}` : "contrato por gerar",
        c.contrato_enviado_em ? `enviado a ${quando(c.contrato_enviado_em)} para ${c.contrato_enviado_para}` : null,
        c.contrato_assinado_em ? `assinado a ${dataPT(c.contrato_assinado_em.slice(0, 10))}` : null,
      ].filter(Boolean).join(" · ");
      const tag = el("span", { className: "tag" + (c.contrato_assinado_em ? "" : c.contrato_enviado_em ? "" : " warn"), textContent: c.contrato_assinado_em ? "assinado" : c.contrato_enviado_em ? "à espera de assinatura" : c.contrato_pdf ? "por enviar" : "por gerar" });
      const gerar = botao(c.contrato_pdf ? "Gerar de novo" : "Gerar contrato", c.contrato_pdf ? "" : "pri");
      gerar.disabled = c.servico !== "SA" || c.estado === "incompleto";
      gerar.title = c.servico !== "SA" ? "Ainda não há modelo para este serviço" : c.estado === "incompleto" ? "Completa primeiro o contrato em Pagamentos e contratos" : "";
      gerar.addEventListener("click", () => {
        const w = window.open("", "_blank");
        acao(gerar, () => chamar({ action: "gerar_contrato", contrato_id: c.id }), "Contrato gerado. Confirma o PDF antes de enviar.")
          .then((r) => { if (r?.url && w) w.location.href = r.url; else w?.close(); });
      });
      const acoes = [gerar];
      if (c.contrato_pdf) {
        acoes.push(verPdf(c.contrato_pdf));
        const teste = botao("Enviar teste");
        teste.addEventListener("click", () => acao(teste, () => chamar({ action: "enviar_contrato", contrato_id: c.id, teste_para: EU }), `Teste enviado para ${EU}.`));
        const env = botao(c.contrato_enviado_em ? "Enviar outra vez" : "Enviar ao cliente", c.contrato_enviado_em ? "" : "pri");
        confirmar2(env, env.textContent, () => acao(env, () => chamar({ action: "enviar_contrato", contrato_id: c.id }), `Contrato enviado para ${f.email}.`));
        acoes.push(teste, env);
      }
      if (c.contrato_enviado_em && !c.contrato_assinado_em) {
        const ass = botao("Marcar assinado");
        ass.addEventListener("click", () => acao(ass, () => must(sb.from("opera_contratos").update({ contrato_assinado_em: new Date().toISOString() }).eq("id", c.id)), `Contrato de ${c.cliente} marcado como assinado.`));
        acoes.push(ass);
      }
      const painel = el("div"); painel.hidden = !abertos.has("c" + c.id);
      const editar = botao(painel.hidden ? "Editar ficha" : "Fechar");
      editar.addEventListener("click", () => {
        if (painel.hidden && !painel.firstChild) painel.append(editorFicha(c, () => abertos.delete("c" + c.id)));
        painel.hidden = !painel.hidden; editar.textContent = painel.hidden ? "Editar ficha" : "Fechar";
        if (painel.hidden) abertos.delete("c" + c.id); else abertos.add("c" + c.id);
      });
      if (!painel.hidden) painel.append(editorFicha(c, () => abertos.delete("c" + c.id)));
      acoes.push(editar);
      const fichaMudou = c.contrato_gerado_em && c.ficha_em && c.ficha_em > c.contrato_gerado_em;
      return el("div", { className: "item" },
        el("div", { className: "grow" }, el("b", { textContent: f.nome }), tag,
          el("div", { className: "muted", textContent: `${SRV[c.servico] || "?"} · início a ${dataPT(c.data_inicio)} · ${f.email} · ${passos}` }),
          fichaMudou ? el("div", { className: "muted op-bad", textContent: "A ficha mudou depois de o contrato ser gerado: gera de novo antes de enviar." }) : null),
        el("div", { className: "actions" }, ...acoes), painel);
    }));
  }

  function linhaFatura(fa, ...acoes) {
    const qual = fa.total_pagamentos > 1 ? `pagamento ${fa.numero} de ${fa.total_pagamentos}` : "pagamento integral";
    return el("div", { className: "item" },
      el("div", { className: "grow" }, el("b", { textContent: fa.dados?.nome || fa.cliente }), el("span", { className: "tag" + (fa.estado === "erro" ? " bad" : fa.estado === "recebida" ? " warn" : ""), textContent: `${fa.ref} · ${ESTADO_FAT[fa.estado] || fa.estado}` }),
        el("div", { className: "muted", textContent: [qual, `vence a ${dataPT(fa.data_prevista)}`, fa.pedida_em ? `pedida a ${quando(fa.pedida_em)}` : null, fa.recebida_em ? `recebida a ${quando(fa.recebida_em)}` : null, fa.enviada_em ? `enviada a ${quando(fa.enviada_em)} para ${fa.enviada_para}` : null].filter(Boolean).join(" · ") }),
        fa.erro ? el("div", { className: "muted op-bad", textContent: fa.erro }) : null),
      el("b", { textContent: `${eur.format(fa.valor)} + IVA` }),
      el("div", { className: "actions" }, ...acoes));
  }

  function renderFaturas(fats) {
    const validar = fats.filter((f) => f.estado === "recebida");
    if (!validar.length) vazio(L.validar, "Nenhuma fatura à espera de validação.");
    else L.validar.replaceChildren(...validar.map((fa) => {
      const teste = botao("Enviar teste");
      teste.addEventListener("click", () => acao(teste, () => chamar({ action: "enviar_fatura", fatura_id: fa.id, teste_para: EU }), `Teste enviado para ${EU}.`));
      const env = botao("Validar e enviar", "pri");
      confirmar2(env, "Validar e enviar", () => acao(env, () => chamar({ action: "enviar_fatura", fatura_id: fa.id }), `Fatura ${fa.ref} enviada para ${fa.dados?.email}.`));
      return linhaFatura(fa, verPdf(fa.pdf_path), teste, env);
    }));

    const pedidos = fats.filter((f) => ["a_pedir", "pedida", "erro"].includes(f.estado));
    if (!pedidos.length) vazio(L.pedidos, "Nenhum pedido em curso.");
    else L.pedidos.replaceChildren(...pedidos.map((fa) => {
      const re = botao("Reenviar pedido");
      re.addEventListener("click", () => acao(re, () => chamar({ action: "reenviar_pedido", fatura_id: fa.id }), `Pedido ${fa.ref} reenviado à contabilidade.`));
      const fora = botao("Tratada fora");
      fora.addEventListener("click", () => acao(fora, () => chamar({ action: "marcar_fatura", fatura_id: fa.id, estado: "tratada_fora" }), `${fa.ref} marcada como tratada fora.`));
      const canc = botao("Cancelar", "danger");
      canc.addEventListener("click", () => acao(canc, () => chamar({ action: "marcar_fatura", fatura_id: fa.id, estado: "cancelada" }), `Pedido ${fa.ref} cancelado.`));
      return linhaFatura(fa, re, fora, canc);
    }));

    const env = fats.filter((f) => f.estado === "enviada").sort((a, b) => b.enviada_em.localeCompare(a.enviada_em)).slice(0, 20);
    if (!env.length) vazio(L.enviadas, "Ainda não foi enviada nenhuma fatura.");
    else L.enviadas.replaceChildren(...env.map((fa) => linhaFatura(fa, verPdf(fa.pdf_path))));
  }

  function renderProximos(contratos, fats) {
    const comFatura = new Set(fats.filter((f) => f.estado !== "cancelada").map((f) => f.pagamento_id));
    const lim = emDias(31);
    const rows = contratos.filter((c) => c.ficha && c.estado === "ativo").flatMap((c) => (c.opera_pagamentos || [])
      .filter((p) => p.estado !== "cancelado" && !comFatura.has(p.id) && p.data_prevista >= DESDE && p.data_prevista <= lim)
      .map((p) => ({ ...p, c, total: (c.opera_pagamentos || []).filter((x) => x.estado !== "cancelado").length })))
      .sort((a, b) => a.data_prevista.localeCompare(b.data_prevista));
    if (!rows.length) return vazio(L.proximos, "Nada a pedir nos próximos 31 dias.");
    L.proximos.replaceChildren(...rows.map((p) => {
      const atras = p.data_prevista < hoje();
      const ja = botao("Pedir já");
      ja.addEventListener("click", () => acao(ja, () => chamar({ action: "pedir_fatura", pagamento_id: p.id }), (r) => `Pedido ${r.ref} enviado à contabilidade.`));
      const teste = botao("Ver pedido (teste)");
      teste.title = `Manda o email do pedido só para ${EU}, sem registar nada`;
      teste.addEventListener("click", () => acao(teste, () => chamar({ action: "pedir_fatura", pagamento_id: p.id, teste_para: EU }), `Pedido de teste enviado para ${EU}.`));
      const fora = botao("Tratada fora");
      fora.addEventListener("click", () => acao(fora, () => chamar({ action: "tratada_fora", pagamento_id: p.id }), "Marcada como tratada fora."));
      return el("div", { className: "item" },
        el("div", { className: "grow" }, el("b", { textContent: p.c.ficha.nome }),
          el("div", { className: "muted" + (atras ? " op-bad" : ""), textContent: `${p.total > 1 ? `pagamento ${p.numero} de ${p.total}` : "pagamento integral"} · ${atras ? "venceu" : p.data_prevista === hoje() ? "vence hoje" : "vence"} a ${dataPT(p.data_prevista)}${p.data_prevista > hoje() ? ` · pedido automático a ${dataPT(p.data_prevista)}` : ""}` })),
        el("b", { textContent: `${eur.format(p.valor)} + IVA` }),
        el("div", { className: "actions" }, ja, teste, fora));
    }));
  }

  let vivo = true;
  async function carregar() {
    const [cts, fats] = await Promise.all([
      must(sb.from("opera_contratos").select("id,cliente,servico,modalidade,estado,data_inicio,data_fim,ficha,ficha_em,contrato_pdf,contrato_gerado_em,contrato_enviado_em,contrato_enviado_para,contrato_assinado_em,created_at,opera_pagamentos(id,numero,valor,data_prevista,estado)")
        .in("estado", ["ativo", "incompleto"]).order("data_inicio", { ascending: false })),
      must(sb.from("opera_faturas").select("*").neq("estado", "cancelada").order("criada_em", { ascending: false })),
    ]);
    if (!vivo) return;
    const contratos = cts.map((c) => ({ ...c, opera_pagamentos: (c.opera_pagamentos || []).map((p) => ({ ...p, valor: Number(p.valor) })) }));
    const faturas = fats.map((f) => ({ ...f, valor: Number(f.valor) }));
    renderFichas(contratos.filter((c) => !c.ficha));
    renderContratos(contratos.filter((c) => c.ficha));
    renderFaturas(faturas);
    renderProximos(contratos, faturas);
  }
  carregar().catch((e) => status(e?.message || "Não foi possível carregar.", "err"));
  return () => { vivo = false; };
}
