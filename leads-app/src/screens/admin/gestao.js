// Separador "Pagamentos e contratos" do Dashboard Admin: confirmar pagamentos, completar e editar contratos,
// renovações, custos e saldo bancário. Lê e grava pelas tabelas opera_* (RLS: só nível total) e pelas funções opera_admin_*.
import { sb } from "../../supabase.js";

const PRECO = { SA: { 1: 3000, 2: 3000, 3: 3300 }, BO: { 1: 2550, 2: 2550, 3: 2850 }, BUNDLE: { 1: 4800, 2: 4800, 3: 5100 } };
const SERVICOS = ["SA", "BO", "BUNDLE", "OUTRO"];
const VEND = ["Ana", "Fábio", "André"];
const TIPOS = [["nova", "Venda nova"], ["cross_sell", "Cross sell (valor = só o acrescentado)"], ["renovacao", "Renovação normal"], ["recuperada", "Renovação recuperada pela Ana (5%)"]];
const CATS = { entrega: "Entrega", aquisicao: "Aquisição", outros: "Outros" };
const DATA = /^\d{4}-\d{2}-\d{2}$/;
const eur = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: 2 });
const hoje = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const dataPT = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : "");
const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); kids.forEach((k) => k != null && e.append(k)); return e; };
const dat = (v) => { if (!DATA.test(v || "")) throw new Error("Data inválida"); return v; };
const num = (v) => { const n = Number(v); if (v === "" || !Number.isFinite(n) || n < 0) throw new Error("Valor inválido"); return Math.round(n * 100) / 100; };
const txt = (v, campo = "o nome do cliente") => {
  const s = String(v || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120);
  if (!s) throw new Error("Falta " + campo);
  return s;
};
const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };

export function mountGestao(box, refreshDashboard) {
  box.innerHTML = "";
  const msg = el("div", { className: "msg" }); msg.hidden = true;
  const status = (m, kind) => { msg.textContent = m || ""; msg.hidden = !m; msg.className = "msg" + (kind ? " " + kind : ""); };
  const card = (titulo, nota, ...kids) => el("div", { className: "op-card", style: "margin-bottom:16px" }, el("h2", { textContent: titulo }), el("p", { className: "note", textContent: nota }), ...kids);
  const L = {};
  ["prest", "incompletos", "renov", "contratos", "novo", "custos", "custoNovo", "recentes"].forEach((k) => { L[k] = el("div", {}, el("div", { className: "vazio", textContent: "A carregar…" })); });
  const procura = el("input", { type: "search", placeholder: "Procurar cliente" }); procura.setAttribute("aria-label", "Procurar cliente");
  procura.style.cssText = "width:100%;max-width:320px;margin-bottom:6px";
  const saldoAtual = el("div", { className: "grow", textContent: "A carregar…" });
  const saldoValor = el("input", { type: "number", step: "0.01", placeholder: "Valor €" }); saldoValor.setAttribute("aria-label", "Saldo em euros");
  const saldoData = el("input", { type: "date", value: hoje() }); saldoData.setAttribute("aria-label", "Data do saldo");
  const saldoBtn = el("button", { className: "pri", textContent: "Registar saldo" });

  box.append(msg,
    card("Pagamentos por confirmar", "Pagamentos já vencidos e os que vencem nos próximos 31 dias. Um PIF aparece uma vez, com o valor total. A data de pagamento é hoje por defeito; muda se entrou noutro dia.", L.prest),
    card("Contratos por completar", "Escolhe o serviço e a forma de pagamento. PIF: um único pagamento na data de início. Pagamentos mensais iguais: o valor é dividido por 2, 3 ou 6 meses. Plano à medida: cada pagamento com o valor e a data combinados. O valor sugerido é o preço de tabela.", L.incompletos),
    card("Renovações a decidir", "Packs ativos que terminam nos próximos 60 dias (o painel já assume que renovam; aqui confirmas). \"Renovou\" cria um pack igual a começar no dia a seguir ao fim.", L.renov),
    card("Contratos", "Ativos, por completar e terminados nos últimos 90 dias. Em Editar mudas cliente, serviço, vendedor, forma de pagamento, valor, datas e cada pagamento por receber. Os já recebidos ficam como estão.", procura, L.contratos),
    card("Novo contrato manual", "Para um cliente que não passou pelo gestor de leads.", L.novo),
    card("Custos", "Mensais (salários, software) ou pontuais (campanhas, equipamento). Entrega: quem presta o serviço. Aquisição: comercial e marketing. Outros: tecnologia, contabilidade. As comissões da Ana já entram sozinhas: não as registes aqui. Para alguém que sai, põe a data de fim em vez de apagar. Os nomes começados por \"Gestor de Leads\" e \"Back office\" contam para a capacidade.", L.custos, el("h3", { textContent: "Novo custo", style: "font-size:14px;margin:12px 0 0" }), L.custoNovo),
    card("Saldo bancário", "Saldo da conta da Grabbingstars, para o painel calcular quantos meses de custos tens em caixa.", el("div", { className: "item" }, saldoAtual, el("div", { className: "actions" }, saldoValor, saldoData, saldoBtn))),
    card("Pagamentos recebidos", "Os últimos 30. A data de recebimento decide em que mês o dinheiro entra na caixa. Se confirmaste o pagamento errado, anula e confirma o certo.", L.recentes));

  const vazio = (node, t) => node.replaceChildren(el("div", { className: "vazio", textContent: t }));

  async function acao(btn, fn, okMsg) {
    btn.disabled = true;
    status("A gravar…");
    try {
      await fn();
      status(okMsg, "ok");
      await carregar();
      refreshDashboard?.();
      return true;
    } catch (e) {
      status(e?.message || "Algo falhou.", "err");
      btn.disabled = false;
      return false;
    }
  }
  const tenta = (fn) => { try { fn(); } catch (e) { status(e.message, "err"); } };
  // Botão em dois toques para ações que não se desfazem com facilidade
  function confirmar2(btn, label, fn) {
    let armado = false;
    btn.addEventListener("click", () => {
      if (!armado) { armado = true; btn.textContent = "Tens a certeza?"; setTimeout(() => { armado = false; btn.textContent = label; }, 4000); return; }
      fn();
    });
  }

  // Campos de um contrato (Editar, Completar e Novo)
  function campos(r) {
    const nome = el("input", { type: "text", value: r.cliente || "", placeholder: "Nome do cliente" }); nome.style.minWidth = "180px";
    const srv = el("select"); SERVICOS.forEach((s) => srv.append(el("option", { value: s, textContent: s === "BUNDLE" ? "Bundle SA + BO" : s === "OUTRO" ? "Outro" : "OPERA " + s })));
    srv.value = SERVICOS.includes(r.servico) ? r.servico : "SA";
    const pres = el("select"); [1, 2, 3, 6].forEach((n) => pres.append(el("option", { value: n, textContent: n === 1 ? "PIF: pagamento único" : n + " pagamentos mensais iguais" })));
    pres.append(el("option", { value: "p", textContent: "Plano à medida (valores e datas livres)" }));
    pres.value = r.plano_personalizado ? "p" : String([1, 2, 3, 6].includes(r.modalidade) ? r.modalidade : 1);
    const dur = el("select"); [1, 3, 6].forEach((n) => dur.append(el("option", { value: n, textContent: n === 1 ? "1 mês" : n + " meses" })));
    dur.value = String(r.duracao_meses || 3);
    const val = el("input", { type: "number", step: "0.01", value: r.valor_total != null ? r.valor_total : "" });
    const ini = el("input", { type: "date", value: r.data_inicio || hoje() });
    const unico = el("input", { type: "checkbox", checked: !!r.servico_unico });
    const vend = el("select"); vend.append(el("option", { value: "", textContent: "Sem vendedor" })); VEND.forEach((n) => vend.append(el("option", { value: n, textContent: n })));
    if (r.vendedor && !VEND.includes(r.vendedor)) vend.append(el("option", { value: r.vendedor, textContent: r.vendedor }));
    vend.value = r.vendedor || "";
    const tipo = el("select"); TIPOS.forEach(([v, t]) => tipo.append(el("option", { value: v, textContent: t })));
    tipo.value = r.tipo_venda || (r.origem === "renovacao" ? "renovacao" : "nova");
    dur.addEventListener("change", () => { if (dur.value === "1") unico.checked = true; });
    let mexeu = r.valor_total != null;
    val.addEventListener("input", () => { mexeu = true; });
    const sugere = () => { if (mexeu || pres.value === "p") return; const p = (PRECO[srv.value] || {})[Math.min(3, +pres.value)]; val.value = p != null ? p : ""; };
    const lab = (t, c) => el("label", {}, t, c);
    const labVal = lab("Valor total €", val);
    const ajusta = () => { labVal.hidden = pres.value === "p"; sugere(); };
    srv.addEventListener("change", sugere); pres.addEventListener("change", ajusta); ajusta();
    return {
      pres,
      nodes: [lab("Cliente", nome), lab("Serviço", srv), lab("Pagamento", pres), lab("Duração", dur), labVal, lab("Início (conta como data de fecho)", ini),
        lab("Vendedor", vend), lab("Tipo de venda", tipo), el("label", { style: "display:flex;align-items:center;gap:6px;font-size:13px;color:var(--color-fg)" }, unico, "Serviço único (não renova)")],
      valores() {
        if (!SERVICOS.includes(srv.value)) throw new Error("Serviço inválido");
        const m = +dur.value;
        if (![1, 3, 6].includes(m)) throw new Error("Duração inválida");
        const base = {
          cliente: txt(nome.value), servico: srv.value, duracao_meses: m, data_inicio: dat(ini.value), data_fecho: dat(ini.value),
          servico_unico: unico.checked, vendedor: vend.value || null, tipo_venda: TIPOS.some(([v]) => v === tipo.value) ? tipo.value : "nova",
        };
        if (pres.value === "p") return { medida: true, base };
        const n = +pres.value;
        if (![1, 2, 3, 6].includes(n)) throw new Error("Pagamento inválido");
        if (val.value === "") throw new Error("Falta o valor");
        return { medida: false, base: { ...base, modalidade: n, valor_total: num(val.value) } };
      },
    };
  }

  // Editor de plano à medida: pagamentos com valor e data livres
  function planoEditor(linhas, minData) {
    const corpo = el("tbody");
    const soma = el("b");
    const atualizaSoma = () => { soma.textContent = eur.format([...corpo.querySelectorAll("input[type=number]")].reduce((s, i) => s + (Number(i.value) || 0), 0)); };
    const addLinha = (valor, data) => {
      const v = el("input", { type: "number", step: "0.01", value: valor != null ? valor : "" });
      const d = el("input", { type: "date", value: data || minData || hoje() });
      const x = el("button", { className: "danger", textContent: "Remover" });
      const tr = el("tr", {}, el("td", {}, v), el("td", {}, d), el("td", {}, x));
      x.addEventListener("click", () => { tr.remove(); atualizaSoma(); });
      v.addEventListener("input", atualizaSoma);
      corpo.append(tr); atualizaSoma();
    };
    (linhas.length ? linhas : [{}]).forEach((l) => addLinha(l.valor, l.data_prevista));
    const add = el("button", { textContent: "Adicionar pagamento" });
    add.addEventListener("click", () => addLinha(null, null));
    return {
      node: el("div", {},
        el("table", { className: "prest" }, el("thead", {}, el("tr", {}, el("th", { textContent: "Valor €" }), el("th", { textContent: "Data" }), el("th"))), corpo),
        el("div", { className: "actions", style: "margin-top:8px" }, add, el("span", { className: "tag" }, "Soma por pagar: ", soma))),
      plano() {
        const out = [...corpo.querySelectorAll("tr")].map((tr) => {
          const [v, d] = tr.querySelectorAll("input");
          if (v.value === "") return null;
          return { valor: num(v.value), data: dat(d.value) };
        }).filter(Boolean);
        if (!out.length) throw new Error("Põe pelo menos um pagamento");
        return out;
      },
    };
  }

  const cancelarContrato = async (id) => {
    await must(sb.from("opera_contratos").update({ estado: "cancelado", updated_at: new Date().toISOString() }).eq("id", id));
    await must(sb.from("opera_pagamentos").update({ estado: "cancelado" }).eq("contrato_id", id).eq("estado", "pendente"));
  };
  const rpc = (f, args) => must(sb.rpc(f, args));

  function renderPrest(rows) {
    if (!rows.length) return vazio(L.prest, "Nada por confirmar.");
    L.prest.replaceChildren(...rows.map((r) => {
      const atrasada = r.data_prevista < hoje();
      const d = el("input", { type: "date", value: hoje() }); d.setAttribute("aria-label", "Data de pagamento");
      const ok = el("button", { className: "pri", textContent: "Confirmar pagamento" });
      ok.addEventListener("click", () => tenta(() => {
        const dia = dat(d.value);
        acao(ok, () => must(sb.from("opera_pagamentos").update({ estado: "pago", data_pagamento: dia, confirmado_em: new Date().toISOString() }).eq("id", r.id).eq("estado", "pendente")), `Pagamento de ${r.c.cliente} confirmado.`);
      }));
      const canc = el("button", { className: "danger", textContent: "Não vai ser pago" });
      confirmar2(canc, "Não vai ser pago", () => acao(canc, () => must(sb.from("opera_pagamentos").update({ estado: "cancelado" }).eq("id", r.id).eq("estado", "pendente")), `Pagamento de ${r.c.cliente} cancelado.`));
      return el("div", { className: "item" },
        el("div", { className: "grow" }, el("b", { textContent: r.c.cliente }),
          el("div", { className: "muted" + (atrasada ? " op-bad" : ""), textContent: `${r.c.servico || "?"} · ${r.c.modalidade === 1 ? "PIF, pagamento único" : "pagamento " + r.numero + " de " + r.c.modalidade} · ${atrasada ? "venceu" : "vence"} a ${dataPT(r.data_prevista)}` })),
        el("b", { className: atrasada ? "op-bad" : "", textContent: eur.format(r.valor) }),
        el("div", { className: "actions" }, d, ok, canc));
    }));
  }

  function renderIncompletos(rows) {
    if (!rows.length) return vazio(L.incompletos, "Todos os contratos estão completos.");
    L.incompletos.replaceChildren(...rows.map((r) => {
      const f = campos(r);
      const pe = planoEditor([], r.data_inicio || hoje());
      const zona = el("div", { className: "edit" }, el("b", { textContent: "Pagamentos acordados" }), pe.node);
      const mostra = () => { zona.hidden = f.pres.value !== "p"; };
      f.pres.addEventListener("change", mostra); mostra();
      const guardar = el("button", { className: "pri", textContent: "Guardar contrato" });
      guardar.addEventListener("click", () => tenta(() => {
        const v = f.valores();
        const plano = v.medida ? pe.plano() : null;
        acao(guardar, async () => {
          if (v.medida) {
            await must(sb.from("opera_contratos").update({ ...v.base, updated_at: new Date().toISOString() }).eq("id", r.id));
            await rpc("opera_admin_definir_plano", { p_contrato: r.id, p_plano: plano });
          } else {
            await must(sb.from("opera_contratos").update({ ...v.base, plano_personalizado: false, updated_at: new Date().toISOString() }).eq("id", r.id));
            await rpc("opera_admin_gerar_prestacoes", { p_contrato: r.id });
          }
        }, `Contrato de ${r.cliente} completo.`);
      }));
      const canc = el("button", { className: "danger", textContent: "Cancelar contrato" });
      confirmar2(canc, "Cancelar contrato", () => acao(canc, () => cancelarContrato(r.id), `Contrato de ${r.cliente} cancelado.`));
      return el("div", { className: "item" },
        el("div", { className: "grow" }, el("b", { textContent: r.cliente }), el("div", { className: "muted", textContent: r.notas || "" })),
        el("div", { className: "form" }, ...f.nodes, el("div", { className: "actions" }, guardar, canc)), zona);
    }));
  }

  const abertos = new Set();
  let cache = [];
  function renderContratos(rows) {
    cache = rows;
    const q = (procura.value || "").trim().toLowerCase();
    const lista = q ? rows.filter((r) => (r.cliente || "").toLowerCase().includes(q)) : rows;
    if (!lista.length) return vazio(L.contratos, q ? "Nenhum contrato com esse nome." : "Ainda não há contratos.");
    L.contratos.replaceChildren(...lista.map((r) => {
      const prest = [...(r.opera_pagamentos || [])].sort((a, b) => a.numero - b.numero);
      const pago = prest.filter((p) => p.estado === "pago").reduce((s, p) => s + Number(p.valor), 0);
      const tag = el("span", { className: "tag" + (r.estado === "incompleto" ? " warn" : ""), textContent: r.estado === "incompleto" ? "por completar" : r.estado });
      const resumo = `${r.servico || "?"} · ${r.modalidade === 1 ? "PIF" : r.modalidade ? r.modalidade + " pagamentos" : "pagamento ?"} · ${dataPT(r.data_inicio)} a ${dataPT(r.data_fim)} · pago ${eur.format(pago)}${r.vendedor ? " · vendedor " + r.vendedor : ""}`;
      const painel = el("div", { className: "edit" }); painel.hidden = !abertos.has(r.id);
      const editar = el("button", { textContent: painel.hidden ? "Editar" : "Fechar" });
      editar.addEventListener("click", () => {
        painel.hidden = !painel.hidden;
        if (painel.hidden) abertos.delete(r.id); else abertos.add(r.id);
        editar.textContent = painel.hidden ? "Editar" : "Fechar";
      });
      const f = campos(r);
      const pendentes = prest.filter((p) => p.estado === "pendente");
      const pe = planoEditor(pendentes, r.data_inicio);
      const guardar = el("button", { className: "pri", textContent: "Guardar contrato" });
      guardar.addEventListener("click", () => tenta(() => {
        const v = f.valores();
        let plano = null;
        if (v.medida) { try { plano = pe.plano(); } catch { plano = null; } }
        acao(guardar, async () => {
          if (v.medida) {
            await must(sb.from("opera_contratos").update({ ...v.base, updated_at: new Date().toISOString() }).eq("id", r.id));
            if (plano) await rpc("opera_admin_definir_plano", { p_contrato: r.id, p_plano: plano });
          } else {
            await must(sb.from("opera_contratos").update({ ...v.base, plano_personalizado: false, updated_at: new Date().toISOString() }).eq("id", r.id));
            await rpc("opera_admin_recalcular_prestacoes", { p_contrato: r.id });
          }
        }, `Contrato de ${r.cliente} atualizado.`);
      }));
      const canc = el("button", { className: "danger", textContent: "Cancelar contrato" });
      confirmar2(canc, "Cancelar contrato", () => acao(canc, () => cancelarContrato(r.id), `Contrato de ${r.cliente} cancelado.`));
      const guardarPlano = el("button", { className: "pri", textContent: "Guardar pagamentos" });
      guardarPlano.addEventListener("click", () => tenta(() => {
        const plano = pe.plano();
        acao(guardarPlano, () => rpc("opera_admin_definir_plano", { p_contrato: r.id, p_plano: plano }), `Pagamentos de ${r.cliente} atualizados.`);
      }));
      const fechadas = prest.filter((p) => p.estado !== "pendente");
      painel.append(
        el("b", { textContent: "Contrato" }),
        el("div", { className: "form" }, ...f.nodes, el("div", { className: "actions" }, guardar, canc)),
        el("b", { textContent: "Pagamentos por receber" }),
        el("div", { className: "muted", textContent: "Muda valores e datas, acrescenta ou remove pagamentos. Ao guardar, o contrato passa a plano à medida e o valor total fica igual ao já pago mais estes pagamentos." }),
        pe.node, el("div", { className: "actions", style: "margin-top:8px" }, guardarPlano));
      if (fechadas.length) painel.append(el("b", { textContent: "Pagas e canceladas" }), el("table", { className: "prest" },
        el("thead", {}, el("tr", {}, ...["Nº", "Valor", "Data", "Estado"].map((t) => el("th", { textContent: t })))),
        el("tbody", {}, ...fechadas.map((p) => el("tr", {}, el("td", { textContent: String(p.numero) }), el("td", { textContent: eur.format(p.valor) }), el("td", { textContent: dataPT(p.data_prevista) }),
          el("td", { textContent: p.estado === "pago" ? `paga a ${dataPT(p.data_pagamento)}` : "cancelada" }))))));
      return el("div", { className: "item" },
        el("div", { className: "grow" }, el("b", { textContent: r.cliente }), tag, el("div", { className: "muted", textContent: resumo })),
        el("b", { textContent: r.valor_total != null ? eur.format(r.valor_total) : "?" }),
        el("div", { className: "actions" }, editar), painel);
    }));
  }
  procura.addEventListener("input", () => renderContratos(cache));

  function renderNovo() {
    const f = campos({});
    const pe = planoEditor([], hoje());
    const zona = el("div", { className: "edit" }, el("b", { textContent: "Pagamentos acordados" }), pe.node);
    const mostra = () => { zona.hidden = f.pres.value !== "p"; };
    f.pres.addEventListener("change", mostra); mostra();
    const criar = el("button", { className: "pri", textContent: "Criar contrato" });
    criar.addEventListener("click", () => tenta(() => {
      const v = f.valores();
      const plano = v.medida ? pe.plano() : null;
      const id = crypto.randomUUID();
      acao(criar, async () => {
        await must(sb.from("opera_contratos").insert({ id, ...v.base, estado: "incompleto", origem: "manual" }));
        if (v.medida) await rpc("opera_admin_definir_plano", { p_contrato: id, p_plano: plano });
        else await rpc("opera_admin_gerar_prestacoes", { p_contrato: id });
      }, "Contrato criado.").then((ok) => { if (ok) renderNovo(); });
    }));
    L.novo.replaceChildren(el("div", { className: "form" }, ...f.nodes, el("div", { className: "actions" }, criar)), zona);
  }

  function camposCusto(r) {
    const desc = el("input", { type: "text", value: r.descricao || "", placeholder: "Ex.: Gestor de Leads: Hélio" }); desc.style.minWidth = "220px";
    const cat = el("select"); Object.entries(CATS).forEach(([k, t]) => cat.append(el("option", { value: k, textContent: t })));
    cat.value = r.categoria || "entrega";
    const tipo = el("select");
    tipo.append(el("option", { value: "mensal", textContent: "Mensal (todos os meses)" }), el("option", { value: "pontual", textContent: "Pontual (uma vez)" }));
    tipo.value = r.tipo || "mensal";
    const val = el("input", { type: "number", step: "0.01", value: r.valor_mensal != null ? r.valor_mensal : "" });
    const ini = el("input", { type: "date", value: r.inicio || hoje() });
    const fim = el("input", { type: "date", value: r.fim || "" });
    const lab = (t, c) => el("label", {}, t, c);
    const lVal = lab("Valor por mês €", val), lIni = lab("Desde", ini), lFim = lab("Até (opcional)", fim);
    const ajusta = () => {
      const p = tipo.value === "pontual";
      lVal.firstChild.textContent = p ? "Valor €" : "Valor por mês €";
      lIni.firstChild.textContent = p ? "Data" : "Desde";
      lFim.hidden = p;
    };
    tipo.addEventListener("change", ajusta); ajusta();
    return {
      nodes: [lab("Descrição", desc), lab("Tipo", tipo), lab("Categoria", cat), lVal, lIni, lFim],
      valores() {
        if (!CATS[cat.value]) throw new Error("Categoria inválida");
        if (!["mensal", "pontual"].includes(tipo.value)) throw new Error("Tipo inválido");
        if (val.value === "") throw new Error("Falta o valor");
        const p = tipo.value === "pontual";
        if (!p && fim.value && fim.value < ini.value) throw new Error("A data de fim é anterior ao início");
        return { descricao: txt(desc.value, "a descrição"), tipo: tipo.value, categoria: cat.value, valor_mensal: num(val.value), inicio: dat(ini.value), fim: p ? dat(ini.value) : (fim.value ? dat(fim.value) : null) };
      },
    };
  }

  function renderCustos(rows) {
    if (!rows.length) vazio(L.custos, "Ainda não há custos.");
    else L.custos.replaceChildren(...rows.map((r) => {
      const pontual = r.tipo === "pontual";
      const ativo = pontual || (r.inicio <= hoje() && (!r.fim || r.fim >= hoje()));
      const estado = pontual ? `pontual · ${dataPT(r.inicio)}` : !ativo && r.inicio > hoje() ? `a partir de ${dataPT(r.inicio)}` : !ativo ? `terminou a ${dataPT(r.fim)}` : r.fim ? `até ${dataPT(r.fim)}` : "ativo";
      const painel = el("div", { className: "edit" }); painel.hidden = true;
      const editar = el("button", { textContent: "Editar" });
      editar.addEventListener("click", () => { painel.hidden = !painel.hidden; editar.textContent = painel.hidden ? "Editar" : "Fechar"; });
      const f = camposCusto(r);
      const guardar = el("button", { className: "pri", textContent: "Guardar" });
      guardar.addEventListener("click", () => tenta(() => { const v = f.valores(); acao(guardar, () => must(sb.from("opera_custos").update(v).eq("id", r.id)), "Custo atualizado."); }));
      const apagar = el("button", { className: "danger", textContent: "Apagar" });
      confirmar2(apagar, "Apagar", () => acao(apagar, () => must(sb.from("opera_custos").delete().eq("id", r.id)), "Custo apagado."));
      painel.append(el("div", { className: "form" }, ...f.nodes, el("div", { className: "actions" }, guardar, apagar)));
      return el("div", { className: "item" },
        el("div", { className: "grow" }, el("b", { textContent: r.descricao }), el("span", { className: "tag" + (ativo ? "" : " warn"), textContent: CATS[r.categoria] || r.categoria }), el("div", { className: "muted", textContent: estado })),
        el("b", { textContent: eur.format(r.valor_mensal) + (pontual ? "" : "/mês") }),
        el("div", { className: "actions" }, editar), painel);
    }));
  }
  function renderCustoNovo() {
    const f = camposCusto({});
    const criar = el("button", { className: "pri", textContent: "Adicionar custo" });
    criar.addEventListener("click", () => tenta(() => {
      const v = f.valores();
      acao(criar, () => must(sb.from("opera_custos").insert(v)), "Custo adicionado.").then((ok) => { if (ok) renderCustoNovo(); });
    }));
    L.custoNovo.replaceChildren(el("div", { className: "form" }, ...f.nodes, el("div", { className: "actions" }, criar)));
  }

  function renderRenov(rows) {
    if (!rows.length) return vazio(L.renov, "Nenhum pack a terminar nos próximos 60 dias.");
    L.renov.replaceChildren(...rows.map((r) => {
      const sim = el("button", { className: "pri", textContent: "Renovou" });
      sim.addEventListener("click", () => acao(sim, () => rpc("opera_admin_renovar", { p_contrato: r.id }), `Renovação de ${r.cliente} registada.`));
      const nao = el("button", { className: "danger", textContent: "Não renovou" });
      confirmar2(nao, "Não renovou", () => acao(nao, () => must(sb.from("opera_contratos").update({ renovacao: "nao_renovou", updated_at: new Date().toISOString() }).eq("id", r.id).is("renovacao", null)), `${r.cliente}: não renovação registada.`));
      return el("div", { className: "item" },
        el("div", { className: "grow" }, el("b", { textContent: r.cliente }), el("div", { className: "muted", textContent: `${r.servico || "?"} · termina a ${dataPT(r.data_fim)}` })),
        el("b", { textContent: eur.format(r.valor_total || 0) }),
        el("div", { className: "actions" }, sim, nao));
    }));
  }

  function renderRecentes(rows) {
    if (!rows.length) return vazio(L.recentes, "Ainda não confirmaste nenhum pagamento.");
    L.recentes.replaceChildren(...rows.map((r) => {
      const an = el("button", { textContent: "Anular" });
      confirmar2(an, "Anular", () => acao(an, () => must(sb.from("opera_pagamentos").update({ estado: "pendente", data_pagamento: null, confirmado_em: null }).eq("id", r.id).eq("estado", "pago")), `Confirmação de ${r.c.cliente} anulada.`));
      const d = el("input", { type: "date", value: r.data_pagamento || hoje() }); d.setAttribute("aria-label", "Data em que foi recebido");
      const corr = el("button", { textContent: "Corrigir data" });
      corr.addEventListener("click", () => tenta(() => {
        const dia = dat(d.value);
        acao(corr, () => must(sb.from("opera_pagamentos").update({ data_pagamento: dia }).eq("id", r.id).eq("estado", "pago")), `Data do pagamento de ${r.c.cliente} corrigida.`);
      }));
      return el("div", { className: "item" },
        el("div", { className: "grow" }, el("b", { textContent: r.c.cliente }), el("div", { className: "muted", textContent: `Pagamento ${r.numero} · previsto a ${dataPT(r.data_prevista)} · recebido a ${dataPT(r.data_pagamento)}` })),
        el("b", { textContent: eur.format(r.valor) }),
        el("div", { className: "actions" }, d, corr, an));
    }));
  }

  saldoBtn.addEventListener("click", () => tenta(() => {
    if (saldoValor.value === "") throw new Error("Falta o valor do saldo");
    const v = Number(saldoValor.value);
    if (!Number.isFinite(v)) throw new Error("Valor inválido");
    const dia = dat(saldoData.value);
    acao(saldoBtn, () => must(sb.from("opera_saldo").insert({ data: dia, valor: Math.round(v * 100) / 100 })), "Saldo registado.").then((ok) => { if (ok) saldoValor.value = ""; });
  }));

  let vivo = true;
  async function carregar() {
    const limite = (d) => { const x = new Date(); x.setDate(x.getDate() + d); return new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
    const [saldo, pags, cts, custos] = await Promise.all([
      must(sb.from("opera_saldo").select("valor,data,created_at").order("data", { ascending: false }).order("created_at", { ascending: false }).limit(1)),
      must(sb.from("opera_pagamentos").select("id,numero,valor,data_prevista,data_pagamento,estado,c:opera_contratos!inner(cliente,servico,modalidade,estado)").neq("estado", "cancelado")),
      must(sb.from("opera_contratos").select("*, opera_pagamentos(id,numero,valor,data_prevista,estado,data_pagamento)").neq("estado", "cancelado")),
      must(sb.from("opera_custos").select("*")),
    ]);
    if (!vivo) return;
    const ok = pags.filter((p) => p.c.estado !== "cancelado").map((p) => ({ ...p, valor: Number(p.valor) }));
    renderPrest(ok.filter((p) => p.estado === "pendente" && p.data_prevista <= limite(31)).sort((a, b) => a.data_prevista.localeCompare(b.data_prevista) || a.c.cliente.localeCompare(b.c.cliente)));
    renderRecentes(ok.filter((p) => p.estado === "pago").sort((a, b) => (b.data_pagamento || "").localeCompare(a.data_pagamento || "") || a.c.cliente.localeCompare(b.c.cliente)).slice(0, 30));
    const contratos = cts.map((c) => ({ ...c, valor_total: c.valor_total == null ? null : Number(c.valor_total) }));
    renderIncompletos(contratos.filter((c) => c.estado === "incompleto").sort((a, b) => a.created_at.localeCompare(b.created_at)));
    renderRenov(contratos.filter((c) => c.estado === "ativo" && !c.renovacao && !c.servico_unico && c.data_fim <= limite(60)).sort((a, b) => a.data_fim.localeCompare(b.data_fim)));
    renderContratos(contratos.filter((c) => ["ativo", "incompleto"].includes(c.estado) || (c.estado === "terminado" && (c.terminado_em || c.data_fim) >= limite(-90)))
      .sort((a, b) => a.cliente.toLowerCase().localeCompare(b.cliente.toLowerCase()) || a.data_inicio.localeCompare(b.data_inicio)));
    const h = hoje();
    renderCustos(custos.map((c) => ({ ...c, valor_mensal: Number(c.valor_mensal) })).sort((a, b) =>
      a.tipo.localeCompare(b.tipo)
      || Number(a.tipo === "mensal" && a.fim && a.fim < h) - Number(b.tipo === "mensal" && b.fim && b.fim < h)
      || (a.tipo === "pontual" ? b.inicio.localeCompare(a.inicio) : 0)
      || a.categoria.localeCompare(b.categoria) || a.descricao.localeCompare(b.descricao)));
    const s = saldo[0];
    saldoAtual.replaceChildren(s ? el("span", {}, "Último registo: ", el("b", { textContent: eur.format(s.valor) }), ` a ${dataPT(s.data)}`) : el("span", { textContent: "Ainda sem saldo registado." }));
  }

  renderNovo();
  renderCustoNovo();
  carregar().catch((e) => status(e?.message || "Não foi possível carregar.", "err"));
  return () => { vivo = false; };
}

// Separador "Acessos": quem vê o Dashboard Admin (só para o nível total).
export function mountAcessos(box) {
  box.innerHTML = "";
  const msg = el("div", { className: "msg" }); msg.hidden = true;
  const lista = el("div", {}, el("div", { className: "vazio", textContent: "A carregar…" }));
  box.append(el("div", { className: "op-card" },
    el("h2", { textContent: "Quem vê o Dashboard Admin" }),
    el("p", { className: "note", textContent: "Só a equipa OPERA aparece aqui. Total: vê tudo e mexe no financeiro. Comercial: vê só o separador do seu controlo comercial (objetivos, comissões, escalões e bónus). O vendedor é o nome que aparece nos contratos (Ana para a Ana). O teu próprio acesso não se muda aqui." }),
    msg, lista));
  let vivo = true;
  async function carregar() {
    const rows = await must(sb.rpc("opera_admin_acessos_lista"));
    if (!vivo) return;
    const { data: s } = await sb.auth.getSession();
    const eu = s.session?.user?.id;
    if (!rows.length) { lista.replaceChildren(el("div", { className: "vazio", textContent: "Ninguém na equipa." })); return; }
    lista.replaceChildren(...rows.map((r) => {
      const nivel = el("select");
      [["", "Sem acesso"], ["comercial", "Comercial"], ["total", "Total"]].forEach(([v, t]) => nivel.append(el("option", { value: v, textContent: t })));
      nivel.value = r.nivel || "";
      const vend = el("input", { type: "text", value: r.vendedor || "", placeholder: "Vendedor (ex.: Ana)" });
      const guardar = el("button", { className: "pri", textContent: "Guardar" });
      const mine = r.user_id === eu;
      if (mine) { nivel.disabled = true; vend.disabled = true; guardar.disabled = true; }
      guardar.addEventListener("click", async () => {
        guardar.disabled = true;
        try {
          if (nivel.value === "comercial" && !vend.value.trim()) throw new Error("Para o nível comercial, indica o nome de vendedor.");
          await must(sb.rpc("opera_admin_definir_acesso", { p_user: r.user_id, p_nivel: nivel.value || null, p_vendedor: vend.value }));
          msg.textContent = `Acesso de ${r.nome || r.email} guardado.`; msg.className = "msg ok"; msg.hidden = false;
          await carregar();
        } catch (e) {
          msg.textContent = e?.message || "Algo falhou."; msg.className = "msg err"; msg.hidden = false;
          guardar.disabled = false;
        }
      });
      return el("div", { className: "item" },
        el("div", { className: "grow" }, el("b", { textContent: r.nome || r.email }), el("div", { className: "muted", textContent: `${r.email || ""} · ${r.papel === "admin" ? "Admin OPERA" : "Gestor de leads"}${mine ? " · és tu" : ""}` })),
        el("div", { className: "actions" }, nivel, vend, guardar));
    }));
  }
  carregar().catch((e) => { lista.replaceChildren(el("div", { className: "vazio", textContent: e?.message || "Não foi possível carregar." })); });
  return () => { vivo = false; };
}
