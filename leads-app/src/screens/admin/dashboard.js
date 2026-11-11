// Dashboard Admin: desenha os números e gráficos dentro do template, a partir do resultado de opera_admin_dados.
// Código em DOM simples (vindo do protótipo), montado e desmontado pelo ecrã React AdminDashboard.jsx.
import * as d3 from "d3";
import { TEMPLATE } from "./template.js";

const PAL = ["#3B82FF", "#38D6FF", "#9B8CFF", "#FFB547"];
const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const MESES_L = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const TAB_KEY = "opera-admin-separador";

const eur = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const eurK = (v) => (Math.abs(v) >= 1000 ? (v / 1000).toLocaleString("pt-PT", { maximumFractionDigits: 1 }) + " mil €" : eur.format(v));
const pctF = new Intl.NumberFormat("pt-PT", { style: "percent", maximumFractionDigits: 0 });
const fmtMes = (m) => MESES[+m.slice(5, 7) - 1] + " " + m.slice(2, 4);
const fmtDia = (d) => `${+d.slice(8, 10)} ${MESES[+d.slice(5, 7) - 1]}`;
const fmtMin = (v) => (v < 60 ? Math.round(v) + " min"
  : v < 1440 ? (v / 60).toLocaleString("pt-PT", { maximumFractionDigits: 1 }) + " h"
    : (v / 1440).toLocaleString("pt-PT", { maximumFractionDigits: 1 }) + " dias");
const F = {
  eur: (v) => eur.format(v), pct: (v) => pctF.format(v), int: (v) => Math.round(v).toLocaleString("pt-PT"),
  dec: (v) => v.toLocaleString("pt-PT", { maximumFractionDigits: 1 }), min: fmtMin,
  date: (v) => `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}`, txt: (v) => String(v),
  ratio: (v) => v.toLocaleString("pt-PT", { maximumFractionDigits: 1 }) + " : 1",
  pct1: (v) => v.toLocaleString("pt-PT", { style: "percent", maximumFractionDigits: 1 }),
};
export const fmt = (kind, v) => ((v == null || v === "" || Number.isNaN(v)) ? "—" : F[kind](v));

const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
export function intervalo(k) {
  const t = new Date(), y = t.getFullYear(), m = t.getMonth();
  const atras = (n) => iso(new Date(t.getTime() - n * 864e5));
  switch (k) {
    case "mes_hoje": return [iso(new Date(y, m, 1)), iso(t)];
    case "mes_ant": return [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))];
    case "d30": return [atras(29), iso(t)];
    case "d90": return [atras(89), iso(t)];
    case "tri": return [iso(new Date(y, m - (m % 3), 1)), iso(t)];
    case "ano": return [iso(new Date(y, 0, 1)), iso(t)];
    default: return [iso(new Date(y, m, 1)), iso(new Date(y, m + 1, 0))];
  }
}

// Cálculos feitos no ecrã a partir dos dados do servidor.
function regraMargens(pnl) {
  const p = pnl[0] || {};
  const r = Number(p.receita) || 0, rp = Number(p.receita_pipeline) || 0;
  const linhas = [
    ["entrega", "Custos de entrega", "custos_entrega", "custos_entrega", 0.2, "max"],
    ["aquisicao", "Aquisição (comercial e marketing)", "custos_aquisicao", "custos_aquisicao", 0.2, "max"],
    ["outros", "Outros custos", "custos_outros", "custos_outros", 0.2, "max"],
    ["resultado", "Margem final", "resultado", "resultado_pipeline", 0.4, "min"],
  ];
  return linhas.map(([id, nome, k, kp, alvo, tipo]) => {
    const v = Number(p[k]) || 0, vp = Number(p[kp]) || 0;
    const pct = r ? v / r : null, pctp = rp ? vp / rp : null;
    const cumpre = (x) => (x == null ? null : (tipo === "max" ? x <= alvo : x >= alvo));
    return {
      id, nome, alvo, tipo, meta: (tipo === "max" ? "até " : "mínimo ") + Math.round(alvo * 100) + "%",
      pct, folga: tipo === "max" ? r * alvo - v : v - r * alvo,
      pct_pipeline: pctp, folga_pipeline: tipo === "max" ? rp * alvo - vp : vp - rp * alvo,
      cumpre: cumpre(pct), cumpre_pipeline: cumpre(pctp),
    };
  });
}
function pipelineResumo(cpp, resumo) {
  const r = resumo[0] || {};
  const soma = (k) => cpp.reduce((s, c) => s + (Number(c[k]) || 0), 0);
  const mrr = soma("mensal");
  const total = (Number(r.receita_mensal) || 0) + mrr;
  return [{
    clientes: cpp.length, por_completar: cpp.filter((c) => c.estado === "incompleto").length,
    valor: soma("valor_total"), recebido: soma("recebido"), mrr_pipeline: mrr, mrr_com_pipeline: total,
    margem_com_pipeline: total ? (total - (Number(r.custos_mes) || 0)) / total : null,
  }];
}

/**
 * Monta o dashboard em `el`.
 * load(inicio, fim) → Promise com o objeto de opera_admin_dados.
 * pages: { gestao(el, refresh), acessos(el) } → montados na primeira vez que se abre o separador; devolvem uma função de limpeza.
 */
export function mountDashboard(el, { load, nivel, onOpenLead, pages = {} }) {
  el.innerHTML = TEMPLATE;
  const root = el.querySelector(".op");
  const comercial = nivel === "comercial";
  let gradN = 0;
  let state = { status: "loading", data: {} };
  let params = {};
  let pedido = 0;
  let destroyed = false;
  const limpezas = [];

  const dataOf = (id) => {
    if (state.status !== "ok") return { status: state.status, data: [] };
    const d = state.data[id];
    return Array.isArray(d) ? { status: "ok", data: d } : { status: "empty", data: [] };
  };
  const one = (id) => { const d = dataOf(id); return d.status === "ok" && d.data.length ? d.data[0] : null; };

  async function reload() {
    const n = ++pedido;
    root.classList.add("op-loading");
    try {
      const raw = await load(params.inicio || null, params.fim || null);
      if (destroyed || n !== pedido) return;
      const data = { ...raw };
      if (data.pnl_periodo) data.regra_margens = regraMargens(data.pnl_periodo);
      if (data.contratos_pipeline) data.pipeline_resumo = pipelineResumo(data.contratos_pipeline, data.resumo || []);
      state = { status: "ok", data };
    } catch (e) {
      if (destroyed || n !== pedido) return;
      state = { status: "error", data: {}, error: e };
    }
    root.classList.remove("op-loading");
    draw();
  }

  // Gradiente para dar volume às barras
  function grad(svg, color, horizontal) {
    let defs = svg.select("defs");
    if (defs.empty()) defs = svg.insert("defs", ":first-child");
    const id = "opg" + (++gradN);
    const c = d3.color(color);
    const lg = defs.append("linearGradient").attr("id", id).attr("x1", 0).attr("y1", 0).attr("x2", horizontal ? 1 : 0).attr("y2", horizontal ? 0 : 1);
    lg.append("stop").attr("offset", "0%").attr("stop-color", horizontal ? c.darker(0.5).formatHex() : c.brighter(0.8).formatHex());
    lg.append("stop").attr("offset", "100%").attr("stop-color", horizontal ? c.brighter(0.6).formatHex() : c.darker(0.7).formatHex());
    return `url(#${id})`;
  }

  // Separadores
  const tabs = [...root.querySelectorAll(".op-tab")];
  const montadas = {};
  const show = (id) => {
    tabs.forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === id)));
    root.querySelectorAll(".op-page").forEach((p) => { p.hidden = p.id !== id; });
    try { localStorage.setItem(TAB_KEY, id); } catch { /* sem armazenamento */ }
    if (pages[id] && !montadas[id]) {
      montadas[id] = true;
      const fim = pages[id](root.querySelector("#" + id), reload);
      if (typeof fim === "function") limpezas.push(fim);
    }
    draw();
  };
  tabs.forEach((t) => t.addEventListener("click", () => show(t.dataset.tab)));
  if (comercial) {
    tabs.forEach((t) => { t.hidden = t.dataset.tab !== "ana"; });
    root.querySelector("#periodo-bar").hidden = true;
    root.querySelector("#op-takeaway").hidden = true;
    root.querySelector(".op-head h1").textContent = "O meu controlo comercial";
  }

  const rowOf = (node, data) => {
    if (node.dataset.where) {
      const i = node.dataset.where.indexOf("=");
      const k = node.dataset.where.slice(0, i), v = decodeURIComponent(node.dataset.where.slice(i + 1));
      return data.find((r) => String(r[k]) === v);
    }
    return data[+(node.dataset.row || 0)];
  };

  function fillValues() {
    root.querySelectorAll("[data-fmt]").forEach((node) => {
      const d = dataOf(node.dataset.source);
      node.classList.remove("op-good", "op-bad");
      if (d.status !== "ok") { node.textContent = "—"; return; }
      const r = rowOf(node, d.data);
      const v = r ? r[node.dataset.field] : null;
      node.textContent = fmt(node.dataset.fmt, v);
      if (v == null) return;
      if (node.dataset.min != null) node.classList.add(v >= +node.dataset.min ? "op-good" : "op-bad");
      if (node.dataset.max != null) node.classList.add(v <= +node.dataset.max ? "op-good" : "op-bad");
    });
  }

  function alerts() {
    const r = one("resumo");
    const set = (id, on) => { root.querySelector("#" + id).hidden = !on; };
    const ids = ["al-incompletos", "al-atraso", "al-renov", "al-margem", "al-saldo", "al-ok"];
    if (!r) { ids.forEach((id) => set(id, false)); return; }
    const on = {
      "al-incompletos": r.contratos_incompletos > 0, "al-atraso": r.n_em_atraso > 0, "al-renov": r.renovacoes_60d > 0,
      "al-margem": r.margem_pct != null && r.margem_pct < 0.4, "al-saldo": r.saldo == null,
    };
    Object.entries(on).forEach(([id, v]) => set(id, v));
    set("al-ok", !Object.values(on).some(Boolean));
  }

  function progress(id, v, color) {
    const f = root.querySelector(`#${id} .fill`);
    f.style.width = Math.max(0, Math.min(100, (v || 0) * 100)) + "%";
    f.style.background = color;
  }
  function metas() {
    const r = one("resumo");
    if (!r) return;
    progress("bar-clientes", r.clientes_ativos / 15, PAL[0]);
    progress("bar-2027", r.receita_2027_contratada / 500000, PAL[1]);
    progress("bar-ritmo", r.receita_anual_ritmo / 500000, PAL[2]);
    progress("bar-renov", r.taxa_renovacao, r.taxa_renovacao != null && r.taxa_renovacao < 0.8 ? "var(--color-bad)" : PAL[0]);
  }

  function failed(box, d) {
    box.innerHTML = "";
    if (d.status === "error") {
      const m = document.createElement("div");
      m.style.cssText = "display:flex;align-items:center;justify-content:center;height:220px;font-size:12px;color:var(--color-fg-muted)";
      m.textContent = "Não foi possível carregar";
      box.appendChild(m);
    }
  }
  function legend(id, items) {
    const node = root.querySelector("#" + id); node.innerHTML = "";
    items.forEach(([name, color]) => {
      const s = document.createElement("span"); const i = document.createElement("i");
      i.style.background = color; s.append(i, document.createTextNode(name)); node.appendChild(s);
    });
  }
  function tip(box) {
    let t = box.querySelector(".op-tip");
    if (!t) { t = document.createElement("div"); t.className = "op-tip"; box.appendChild(t); }
    return {
      show(ev, title, lines) {
        t.innerHTML = "";
        const h = document.createElement("div"); h.className = "t"; h.textContent = title; t.appendChild(h);
        lines.forEach(([c, n, v]) => {
          const l = document.createElement("div");
          if (c) { const i = document.createElement("span"); i.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;background:${c}`; l.appendChild(i); }
          l.appendChild(document.createTextNode(`${n}: ${v}`)); t.appendChild(l);
        });
        t.style.display = "block";
        const [x, y] = d3.pointer(ev, box), w = t.offsetWidth;
        t.style.left = Math.max(0, Math.min(box.clientWidth - w, x + 12)) + "px";
        t.style.top = Math.max(0, y - t.offsetHeight - 8) + "px";
      },
      hide() { t.style.display = "none"; },
    };
  }
  function axisStyle(g) {
    g.attr("font-size", null).attr("font-family", null);
    g.selectAll("text").style("fill", "var(--color-fg-muted)").style("font-size", "12px");
    g.select(".domain").remove();
    g.selectAll("line").style("stroke", "var(--cds-chart-grid)");
  }

  // Barras agrupadas por mês ou semana
  function bars(box, rows, xKey, xFmt, series, extra) {
    box.innerHTML = "";
    const W = box.clientWidth || 320, H = 220;
    const svg = d3.select(box).append("svg").attr("width", "100%").attr("viewBox", `0 0 ${W} ${H}`);
    const kind = series[0].fmt;
    const yMax = kind === "pct" ? 1 : (d3.max(rows, (r) => d3.max(series, (s) => r[s.key] || 0)) || 0);
    const y = d3.scaleLinear([0, (kind === "pct" ? 1 : yMax * 1.1) || 1], [H - 24, 8]).nice();
    const tf = kind === "pct" ? d3.format(".0%") : kind === "int" ? d3.format("d") : eurK;
    const yAx = svg.append("g").call(d3.axisLeft(y).ticks(4).tickFormat(tf));
    const left = (d3.max(yAx.selectAll("text").nodes(), (n) => n.getComputedTextLength()) || 20) + 10;
    yAx.attr("transform", `translate(${left},0)`).call(d3.axisLeft(y).ticks(4).tickSize(-(W - left)).tickFormat(tf)).call(axisStyle);
    const x = d3.scaleBand(rows.map((r) => r[xKey]), [left + 4, W]).padding(0.25);
    const step = Math.ceil(rows.length / Math.max(1, Math.floor((W - left) / 56)));
    svg.append("g").attr("transform", `translate(0,${H - 24})`)
      .call(d3.axisBottom(x).tickSize(0).tickPadding(8).tickValues(x.domain().filter((_, i) => i % step === 0)).tickFormat(xFmt)).call(axisStyle);
    const xi = d3.scaleBand(series.map((s) => s.key), [0, x.bandwidth()]).padding(0.1);
    const tt = tip(box);
    const fills = Object.fromEntries(series.map((s) => [s.key, grad(svg, s.color)]));
    const g = svg.append("g").selectAll("g").data(rows).join("g").attr("transform", (r) => `translate(${x(r[xKey])},0)`);
    g.selectAll("rect").data((r) => series.map((s) => ({ s, v: r[s.key] || 0 }))).join("rect").attr("class", "bar")
      .attr("x", (d) => xi(d.s.key) + Math.max(0, (xi.bandwidth() - 32) / 2)).attr("width", Math.min(32, xi.bandwidth()))
      .attr("y", (d) => y(d.v)).attr("height", (d) => Math.max(0, y(0) - y(d.v))).attr("rx", 5).attr("fill", (d) => fills[d.s.key]);
    g.append("rect").attr("width", x.bandwidth()).attr("height", H - 32).attr("y", 8).attr("fill", "transparent")
      .on("mousemove", (ev, r) => tt.show(ev, xFmt(r[xKey]), series.map((s) => [series.length > 1 ? s.color : null, s.name, fmt(s.fmt, r[s.key])]).concat(extra ? extra(r) : [])))
      .on("mouseleave", () => tt.hide());
  }

  function pipeChart(box, rows) {
    box.innerHTML = "";
    const W = box.clientWidth || 320, rh = 30, H = rows.length * rh + 4;
    const svg = d3.select(box).append("svg").attr("width", "100%").attr("viewBox", `0 0 ${W} ${H}`);
    const labW = 128, valW = 130;
    const x = d3.scaleLinear([0, d3.max(rows, (r) => r.leads_agora) || 1], [0, Math.max(40, W - labW - valW)]);
    const g = svg.selectAll("g").data(rows).join("g").attr("transform", (_, i) => `translate(0,${i * rh})`);
    g.append("text").attr("y", rh / 2).attr("dy", "0.35em").text((r) => r.fase).style("fill", "var(--color-fg)").style("font-size", "12px");
    const fA = grad(svg, PAL[0], true), fB = grad(svg, PAL[1], true);
    g.append("rect").attr("class", "bar").attr("x", labW).attr("y", 7).attr("height", rh - 14).attr("rx", 6).attr("width", (r) => Math.max(2, x(r.leads_agora)))
      .attr("fill", (r) => (["Closed", "Em Onboarding", "Entrega de serviço"].includes(r.fase) ? fB : fA));
    g.append("text").attr("x", (r) => labW + Math.max(2, x(r.leads_agora)) + 6).attr("y", rh / 2).attr("dy", "0.35em")
      .text((r) => `${r.leads_agora} · +${r.entradas_30d} em 30 dias`).style("fill", "var(--color-fg-muted)").style("font-size", "12px");
  }

  // Tabela simples: cols = [campo, formato, (opcional) função de classe]
  function table(id, rows, cols, rowFn) {
    const tb = root.querySelector(`#${id} tbody`); tb.innerHTML = "";
    rows.forEach((r) => {
      const tr = document.createElement("tr");
      if (rowFn) rowFn(tr, r);
      cols.forEach(([k, kind, cls, txt]) => {
        const td = document.createElement("td");
        if (!["txt", "date", "mes"].includes(kind)) td.className = "n";
        td.textContent = txt ? txt(r) : kind === "mes" ? fmtMes(r[k]) : fmt(kind, r[k]);
        const c = cls && cls(r[k], r);
        if (c) td.classList.add(c);
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
  }
  const sinal = (v) => (v == null ? null : v >= 0 ? "op-good" : "op-bad");

  // Período
  const selP = root.querySelector("#p-preset"), inI = root.querySelector("#p-inicio"), inF = root.querySelector("#p-fim");
  const setParams = (p) => { params = { ...params, ...p }; reload(); };
  selP.addEventListener("change", () => {
    if (selP.value === "custom") { inI.focus(); return; }
    const [i, f] = intervalo(selP.value);
    setParams({ inicio: i, fim: f });
  });
  const aplicar = () => {
    if (!inI.value || !inF.value || !inI.validity.valid || !inF.validity.valid || inI.value > inF.value) return;
    selP.value = "custom";
    setParams({ inicio: inI.value, fim: inF.value });
  };
  inI.addEventListener("change", aplicar); inF.addEventListener("change", aplicar);
  function showPeriod() {
    const i = params.inicio, f = params.fim;
    if (document.activeElement !== inI) inI.value = i;
    if (document.activeElement !== inF) inF.value = f;
    if (document.activeElement !== selP && selP.value !== "custom") {
      const k = ["mes", "mes_hoje", "mes_ant", "d30", "d90", "tri", "ano"].find((x) => { const [a, b] = intervalo(x); return a === i && b === f; });
      selP.value = k || "custom";
    }
  }
  inI.addEventListener("blur", showPeriod); inF.addEventListener("blur", showPeriod);

  // Lista de clientes ao clicar num cartão (clicar no nome abre a ficha da lead). A lista abre logo abaixo da fila do cartão.
  const PER = "no período escolhido", HOJE = "hoje", ANA = "no período de comissão atual";
  const LISTAS = {
    R1: ["Clientes que entraram em R1", PER, "clientes", "Fase atual"],
    R2: ["Clientes que entraram em R2", PER, "clientes", "Fase atual"],
    Fecho: ["Clientes fechados", PER, "clientes", "Fase atual"],
    novos: ["Contratos novos", PER, "contratos", "Pagamento"],
    novos_pif: ["Contratos novos pagos de uma vez (PIF)", PER, "contratos", "Pagamento"],
    novos_bundle: ["Contratos novos em bundle SA + BO", PER, "contratos", "Pagamento"],
    mrr_novo: ["MRR dos contratos novos", PER, "contratos", "Detalhe", "Por mês"],
    renovacoes: ["Renovações", PER, "contratos", "Detalhe"],
    ativos_inicio: ["Clientes ativos no início do período", PER, "contratos", "Detalhe", "Por mês"],
    ativos_fim: ["Clientes ativos no fim do período", PER, "contratos", "Detalhe", "Por mês"],
    perdidos: ["Clientes que terminaram", PER, "contratos", "Detalhe", "Por mês"],
    fat: ["Faturação", PER, "prestações", "Prestação"],
    fat_pif: ["Faturação PIF", PER, "prestações", "Prestação"],
    fat_mensal: ["Faturação mensal", PER, "prestações", "Prestação"],
    por_receber: ["Faturado e ainda por receber", PER, "prestações", "Prestação"],
    caixa: ["Recebido", PER, "prestações", "Prestação"],
    caixa_pif: ["Recebido PIF", PER, "prestações", "Prestação"],
    caixa_mensal: ["Recebido mensal", PER, "prestações", "Prestação"],
    ativos_hoje: ["Clientes ativos hoje", HOJE, "contratos", "Detalhe", "Por mês"],
    em_atraso: ["Pagamentos vencidos por confirmar", HOJE, "prestações", "Prestação"],
    ana_fechos: ["Fechos da Ana", ANA, "contratos", "Pagamento", "Valor integral"],
    ana_r1: ["R1 marcadas pela Ana", ANA, "clientes", "Detalhe"],
  };
  const FUNIL = ["R1", "R2", "Fecho"];
  const UM = { clientes: "cliente", contratos: "contrato", "prestações": "prestação" };
  let aberto = null; // botão do cartão aberto
  const cardLista = document.createElement("div");
  cardLista.className = "op-card op-lista"; cardLista.hidden = true;
  cardLista.innerHTML = `<div class="op-lista-top"><h2></h2><button type="button" class="op-x" aria-label="Fechar lista">Fechar ✕</button></div>
    <p class="note"></p><div class="op-table-wrap"><table class="op-table"><thead><tr><th>Cliente</th><th>Data</th><th>Serviço</th><th></th><th class="n"></th></tr></thead><tbody></tbody></table></div>`;
  function linhasDe(k) {
    if (FUNIL.includes(k)) {
      const d = dataOf("funil_lista");
      return { ...d, data: d.data.filter((r) => r.etapa === k).map((r) => ({ lead_id: r.lead_id, cliente: r.cliente, dia: r.dia, servico: r.servico, valor: r.valor_total, detalhe: r.fase_atual })) };
    }
    const d = dataOf(k.startsWith("ana_") ? "ana_lista" : "cartoes_lista");
    return { ...d, data: d.data.filter((r) => r.lista === k) };
  }
  function desenhaLista() {
    root.querySelectorAll(".op-click").forEach((b) => b.setAttribute("aria-expanded", String(b === aberto)));
    cardLista.hidden = !aberto;
    if (!aberto) return;
    const k = aberto.dataset.lista;
    const [titulo, quando, unidade, det, val = "Valor"] = LISTAS[k];
    cardLista.querySelector("h2").textContent = titulo;
    const ths = cardLista.querySelectorAll("th");
    ths[3].textContent = det; ths[4].textContent = val;
    const tb = cardLista.querySelector("tbody"); tb.innerHTML = "";
    const nota = cardLista.querySelector(".note");
    const d = linhasDe(k);
    if (d.status !== "ok") { nota.textContent = d.status === "loading" ? "A carregar…" : "Não foi possível carregar a lista."; return; }
    const rows = d.data;
    const total = rows.reduce((s, r) => s + (Number(r.valor) || 0), 0);
    nota.textContent = rows.length
      ? `${rows.length} ${rows.length === 1 ? UM[unidade] : unidade} ${quando}${total ? `, ${eur.format(total)} no total` : ""}. Clica no nome para abrir a lead.`
      : `Sem ${unidade} ${quando}.`;
    rows.forEach((r) => {
      const tr = document.createElement("tr");
      const tdN = document.createElement("td");
      if (r.lead_id && onOpenLead) {
        const a = document.createElement("a"); a.textContent = r.cliente; a.style.fontWeight = "600"; a.href = "#";
        a.addEventListener("click", (e) => { e.preventDefault(); onOpenLead(r.lead_id); });
        tdN.appendChild(a);
      } else tdN.textContent = r.cliente;
      tr.appendChild(tdN);
      [["dia", "date"], ["servico", "txt"], ["detalhe", "txt"], ["valor", "eur"]].forEach(([c, kind]) => {
        const td = document.createElement("td");
        if (kind === "eur") td.className = "n";
        td.textContent = fmt(kind, r[c]);
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
  }
  root.querySelectorAll(".op-click").forEach((b) => b.addEventListener("click", () => {
    aberto = aberto === b ? null : b;
    if (aberto) b.closest(".op-tiles").after(cardLista);
    desenhaLista();
    if (aberto) cardLista.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }));
  cardLista.querySelector(".op-x").addEventListener("click", () => { aberto = null; desenhaLista(); });

  const visible = (id) => !root.querySelector("#" + id).closest(".op-page").hidden;

  function draw() {
    if (destroyed) return;
    fillValues(); alerts(); metas();
    const C = PAL;

    const pipe = dataOf("pipeline");
    if (visible("ch-pipe")) {
      const box = root.querySelector("#ch-pipe");
      if (pipe.status === "ok") pipeChart(box, pipe.data.filter((r) => !["Nova Lead BD", "Lead desqualificada"].includes(r.fase))); else failed(box, pipe);
    }
    legend("lg-vendas", [["Novos", C[0]], ["Renovações", C[1]]]);
    const vm = dataOf("vendas_mensais");
    if (visible("ch-vendas")) {
      const box = root.querySelector("#ch-vendas");
      if (vm.status === "ok") bars(box, vm.data, "mes", fmtMes,
        [{ key: "valor_novos", name: "Novos", color: C[0], fmt: "eur" }, { key: "valor_renovacoes", name: "Renovações", color: C[1], fmt: "eur" }],
        (r) => [[null, "Contratos novos", fmt("int", r.novos)], [null, "Renovações", fmt("int", r.renovacoes)]]);
      else failed(box, vm);
    }
    legend("lg-fluxo", [["Faturação", C[0]], ["Caixa recebida", C[1]], ["Custos", C[3]]]);
    const fl = dataOf("fluxo");
    if (visible("ch-fluxo")) {
      const box = root.querySelector("#ch-fluxo");
      if (fl.status === "ok") bars(box, fl.data, "mes", fmtMes,
        [{ key: "a_receber", name: "Faturação", color: C[0], fmt: "eur" }, { key: "recebido", name: "Caixa recebida", color: C[1], fmt: "eur" }, { key: "custos", name: "Custos", color: C[3], fmt: "eur" }]);
      else failed(box, fl);
    }

    const ct = dataOf("contratos");
    if (ct.status === "ok") table("tb-contratos", ct.data,
      [["cliente", "txt"], ["fase", "txt"], ["servico", "txt"], ["vendedor", "txt"], ["valor_total", "eur"], ["modalidade", "int"], ["data_inicio", "date"], ["data_fim", "date"],
        ["pago", "eur"], ["pendente", "eur"], ["em_atraso", "eur", (v) => (v > 0 ? "op-bad" : null)], ["estado", "txt", (v) => (v === "incompleto" ? "op-warn" : null)]],
      (tr, r) => { if (!r.conta) tr.style.color = "var(--color-fg-muted)"; });

    const cpp = dataOf("contratos_pipeline");
    if (cpp.status === "ok") table("tb-pipe", cpp.data,
      [["cliente", "txt"], ["fase", "txt"], ["servico", "txt"], ["valor_total", "eur"], ["mensal", "eur"],
        ["data_fecho", "date", (v) => (!v ? "op-warn" : null), (r) => (r.data_fecho ? fmt("date", r.data_fecho) : "sem data")],
        ["data_inicio", "date"], ["recebido", "eur"],
        ["estado", "txt", (v) => (v === "incompleto" ? "op-warn" : null), (r) => (r.estado === "incompleto" ? "por completar" : "completo")]]);

    // Regra de margens
    const rg = dataOf("regra_margens");
    const rbox = root.querySelector("#regra-barras");
    if (rg.status === "ok" && rg.data.length) {
      const rows = rg.data;
      const vals = rows.flatMap((r) => [r.pct, r.pct_pipeline, r.alvo]).filter((v) => v != null && Number.isFinite(v));
      const maxS = Math.min(1.5, Math.max(0.6, ...vals) * 1.1);
      const pos = (v) => Math.max(0, Math.min(100, (v / maxS) * 100));
      rbox.innerHTML = "";
      const lg = document.createElement("div"); lg.className = "rg-legend";
      [["linear-gradient(90deg,#3B82FF,#38D6FF)", "Real, dentro da regra"], ["linear-gradient(90deg,#FF8A5B,#E0384B)", "Real, fora da regra"], ["#9B8CFF", "Com pipeline"]].forEach(([bg, tx]) => {
        const s = document.createElement("span"); const i = document.createElement("i"); i.style.background = bg; s.append(i, document.createTextNode(tx)); lg.appendChild(s);
      });
      rbox.appendChild(lg);
      rows.forEach((r) => {
        const row = document.createElement("div"); row.className = "rg-row";
        const nome = document.createElement("div"); nome.className = "rg-nome"; nome.textContent = r.nome;
        const sm = document.createElement("small"); sm.textContent = "Regra: " + r.meta; nome.appendChild(sm);
        const track = document.createElement("div"); track.className = "rg-track";
        const fill = document.createElement("div"); fill.className = "rg-fill";
        fill.style.width = (r.pct == null ? 0 : pos(r.pct)) + "%";
        fill.style.background = r.cumpre ? "linear-gradient(90deg,#3B82FF,#38D6FF)" : "linear-gradient(90deg,#FF8A5B,#E0384B)";
        const meta = document.createElement("div"); meta.className = "rg-meta"; meta.style.left = pos(r.alvo) + "%";
        const ml = document.createElement("span"); ml.textContent = Math.round(r.alvo * 100) + "%"; meta.appendChild(ml);
        track.append(fill, meta);
        if (r.pct_pipeline != null) { const pp = document.createElement("div"); pp.className = "rg-pipe"; pp.style.left = "calc(" + pos(r.pct_pipeline) + "% - 1px)"; pp.title = "Com pipeline: " + fmt("pct", r.pct_pipeline); track.appendChild(pp); }
        const val = document.createElement("div"); val.className = "rg-val";
        const b = document.createElement("b"); b.textContent = fmt("pct", r.pct); b.className = r.cumpre == null ? "" : (r.cumpre ? "rg-ok" : "rg-ko");
        const s2 = document.createElement("small");
        s2.textContent = (r.id === "entrega" && r.pct != null ? "margem de entrega " + fmt("pct", 1 - r.pct) + " · " : "") + "com pipeline " + fmt("pct", r.pct_pipeline);
        val.append(b, s2);
        row.append(nome, track, val);
        rbox.appendChild(row);
      });
      table("tb-regra", rows, [["nome", "txt"], ["meta", "txt"],
        ["pct", "pct", (v, r) => (r.cumpre == null ? null : r.cumpre ? "op-good" : "op-bad")], ["folga", "eur", sinal],
        ["pct_pipeline", "pct", (v, r) => (r.cumpre_pipeline == null ? null : r.cumpre_pipeline ? "op-good" : "op-bad")], ["folga_pipeline", "eur", sinal]]);
    } else if (rg.status !== "loading") rbox.innerHTML = "";

    const pm = dataOf("pnl_mensal");
    if (pm.status === "ok") table("tb-pnl", pm.data,
      [["mes", "mes"], ["receita", "eur"], ["custos_entrega", "eur"], ["margem_bruta", "eur"], ["margem_bruta_pct", "pct"], ["custos_aquisicao", "eur"],
        ["custos_outros", "eur"], ["resultado", "eur", sinal], ["resultado_pct", "pct"], ["receita_pipeline", "eur"], ["resultado_pipeline", "eur", sinal], ["resultado_pipeline_pct", "pct"], ["faturacao", "eur"], ["caixa", "eur"]],
      (tr, r) => { if (r.futuro) tr.style.fontStyle = "italic"; });

    const tl = dataOf("ttl_semanal");
    if (visible("ch-ttl")) {
      const box = root.querySelector("#ch-ttl");
      if (tl.status === "ok") bars(box, tl.data, "semana", (d) => "sem. " + fmtDia(d),
        [{ key: "pct_ttl_15", name: "Em 15 min", color: C[0], fmt: "pct" }],
        (r) => [[null, "Mediana", fmt("min", r.ttl_mediano_min)], [null, "Leads novas", fmt("int", r.leads_novas)]]);
      else failed(box, tl);
    }
    const op = dataOf("operacao");
    if (op.status === "ok") table("tb-op", op.data,
      [["cliente", "txt"], ["leads_novas_30d", "int"], ["ttl_mediano_min", "min", (v) => (v == null ? null : v <= 15 ? "op-good" : "op-bad")], ["pct_ttl_15", "pct"], ["chamadas_30d", "int"], ["taxa_atendimento", "pct"],
        ["recuperadas_30d", "int"], ["tarefas_atrasadas", "int"], ["leads_trabalhadas_dia", "dec"], ["carga_slots", "dec"]]);

    legend("lg-funil", [["R1", C[0]], ["R2", C[1]], ["Fechos", C[2]]]);
    const fs = dataOf("funil_semanal");
    if (visible("ch-funil")) {
      const box = root.querySelector("#ch-funil");
      if (fs.status === "ok") bars(box, fs.data, "semana", (d) => "sem. " + fmtDia(d),
        [{ key: "r1", name: "R1", color: C[0], fmt: "int" }, { key: "r2", name: "R2", color: C[1], fmt: "int" }, { key: "fechos", name: "Fechos", color: C[2], fmt: "int" }]);
      else failed(box, fs);
    }
    const cp = dataOf("comercial_pessoas");
    if (cp.status === "ok") table("tb-pessoas", cp.data, [["pessoa", "txt"], ["r1", "int"], ["r2", "int"], ["fechos", "int"]]);

    const us = dataOf("unit_servico");
    if (us.status === "ok") table("tb-unit", us.data,
      [["nome", "txt"], ["clientes", "int"], ["receita_cliente", "eur"], ["custo_lugar", "eur"], ["margem_cliente", "eur"], ["vida_meses", "dec"], ["ltv", "eur"],
        ["novos", "int"], ["comissoes", "eur"], ["cac", "eur"], ["ltv_cac", "ratio", (v) => (v == null ? null : v >= 3 ? "op-good" : "op-bad")],
        ["payback_meses", "dec", null, (r) => (r.payback_meses == null ? "—" : fmt("dec", r.payback_meses) + " meses")]],
      (tr, r) => { if (r.k === "GLOBAL") tr.className = "tot"; });

    desenhaAna();

    // Objetivo de fechos do mês (empresa): 4 em novembro, 5 em dezembro, 6 a partir de janeiro de 2027
    const om = root.querySelector("#obj-mes-fechos");
    let objMes = null;
    if (params.inicio && params.fim && params.inicio.slice(0, 7) === params.fim.slice(0, 7)) {
      const ym = params.fim.slice(0, 7);
      objMes = ym === "2026-11" ? 4 : ym === "2026-12" ? 5 : ym >= "2027-01" ? 6 : null;
    }
    om.textContent = objMes ? `Objetivo do mês: ${objMes}` : "";
    om.hidden = !objMes;

    const ue = one("periodo");
    if (!comercial) showPeriod();
    desenhaLista();
    root.querySelector("#ue-aviso").hidden = !(ue && !ue.taxa_real);
  }

  function desenhaAna() {
    const ac = dataOf("ana_controlo");
    if (ac.status === "ok") {
      const par = (real, obj, kind) => `${fmt(kind, real)} / ${fmt(kind, obj)}`;
      const tb = root.querySelector("#tb-ana tbody"); tb.innerHTML = "";
      ac.data.forEach((r) => {
        const tr = document.createElement("tr");
        if (r.atual) tr.style.fontWeight = "600";
        if (!r.atual && !r.fechado) tr.style.color = "var(--color-fg-muted)";
        const cells = [
          [`${fmtDia(r.inicio)} a ${fmtDia(r.fim)}${r.atual ? " (atual)" : ""}`, null, false],
          [par(r.reunioes, r.obj_reunioes, "int"), r.reunioes >= r.obj_reunioes, true],
          [par(r.fechos, r.obj_fechos, "int"), r.fechos >= r.obj_fechos, true],
          [par(r.conversao, r.obj_conversao, "pct"), r.conversao == null ? null : r.conversao >= r.obj_conversao, true],
          [par(r.vendas, r.obj_vendas, "eur"), r.vendas >= r.obj_vendas, true],
          [par(r.pct_pif, r.obj_pif, "pct"), r.pct_pif == null ? null : r.pct_pif >= r.obj_pif, true],
          [fmt("eur", r.base_prevista), null, true],
          [r.escalao, null, false],
          [fmt("eur", r.falta_proximo), null, true],
          [fmt("eur", r.comissao_garantida), null, true],
          [fmt("eur", r.comissao_prevista), null, true],
          [`salário de ${MESES_L[+r.fim.slice(5, 7) - 1]}`, null, false],
        ];
        cells.forEach(([txt, ok, num]) => {
          const td = document.createElement("td");
          if (num) td.className = "n";
          td.textContent = txt;
          if (ok != null && (r.fechado || r.atual)) td.classList.add(ok ? "op-good" : (r.fechado ? "op-bad" : "op-warn"));
          tr.appendChild(td);
        });
        tb.appendChild(tr);
      });
      const a = ac.data.find((r) => r.atual);
      const box = root.querySelector("#ana-barras"); box.innerHTML = "";
      if (a) {
        [["Reuniões", a.reunioes, a.obj_reunioes, "int"], ["Fechos", a.fechos, a.obj_fechos, "int"], ["Vendas novas", a.vendas, a.obj_vendas, "eur"],
          ["Base da comissão (recebida + prevista)", a.base_prevista, 15000, "eur"], ["Pagamentos integrais", a.pct_pif, a.obj_pif, "pct"]].forEach(([nome, v, o, kind], i) => {
          const d = document.createElement("div"); d.className = "op-bar";
          const row = document.createElement("div"); row.className = "row";
          const s1 = document.createElement("span"); s1.textContent = nome;
          const s2 = document.createElement("span"); s2.className = "b"; s2.textContent = `${fmt(kind, v)} de ${fmt(kind, o)}`;
          row.append(s1, s2);
          const track = document.createElement("div"); track.className = "track";
          const f = document.createElement("div"); f.className = "fill";
          const p = o ? (v || 0) / o : 0;
          f.style.width = Math.max(0, Math.min(100, p * 100)) + "%";
          f.style.background = p >= 1 ? "var(--color-ok)" : PAL[i % PAL.length];
          track.appendChild(f); d.append(row, track);
          if (nome.startsWith("Base")) {
            const h = document.createElement("div"); h.className = "hint";
            h.textContent = `Escalão ${a.escalao}. ${a.falta_proximo != null ? "Faltam " + fmt("eur", a.falta_proximo) + " para o escalão seguinte." : "Já no escalão máximo."}`;
            d.appendChild(h);
          }
          box.appendChild(d);
        });
      }
    }
    const ab = dataOf("ana_bonus");
    if (ab.status === "ok") table("tb-ana-bonus", ab.data,
      [["trimestre", "txt", null, (r) => r.trimestre + (r.atual ? " (atual)" : "")], ["packs_a_terminar", "int"], ["renovados", "int"], ["nao_renovados", "int"], ["por_decidir", "int"],
        ["taxa_renovacao", "pct", (v) => (v == null ? null : v >= 0.8 ? "op-good" : "op-bad")], ["satisfacao", "dec", (v) => (v == null ? null : v >= 8 ? "op-good" : "op-bad")], ["respostas", "int"],
        ["bonus", "eur", null, (r) => (r.bonus == null ? "sem decisões" : fmt("eur", r.bonus))]],
      (tr, r) => { if (r.atual) tr.style.fontWeight = "600"; });
    const acm = dataOf("ana_comissoes");
    if (acm.status === "ok") {
      const TIPO = { nova: "Venda nova", cross_sell: "Cross sell", recuperada: "Renovação recuperada" };
      table("tb-ana-com", acm.data,
        [["cliente", "txt"], ["servico", "txt"], ["tipo_venda", "txt", null, (r) => TIPO[r.tipo_venda] || r.tipo_venda], ["numero", "int"], ["valor", "eur"], ["base", "eur"], ["dia", "date"],
          ["estado", "txt", null, (r) => (r.estado === "pago" ? "recebido" : "por receber")], ["periodo_fim", "date"], ["taxa", "pct1"], ["comissao", "eur"]],
        (tr, r) => { if (r.estado !== "pago") tr.style.color = "var(--color-fg-muted)"; });
      if (!acm.data.length) {
        const tb = root.querySelector("#tb-ana-com tbody");
        const tr = document.createElement("tr"); const td = document.createElement("td"); td.colSpan = 11;
        td.style.color = "var(--color-fg-muted)"; td.textContent = "Ainda não há contratos com vendedor Ana.";
        tr.appendChild(td); tb.appendChild(tr);
      }
    }
  }

  // Arranque: mês atual completo; separador guardado (ou o da Ana para o nível comercial)
  const [i0, f0] = intervalo("mes");
  params = { inicio: i0, fim: f0 };
  let inicial = "resumo";
  try { inicial = localStorage.getItem(TAB_KEY) || "resumo"; } catch { /* sem armazenamento */ }
  if (comercial || !tabs.some((t) => t.dataset.tab === inicial)) inicial = comercial ? "ana" : "resumo";
  if (!pages[inicial] && ["gestao", "banco", "acessos"].includes(inicial)) inicial = comercial ? "ana" : "resumo";
  show(inicial);
  reload();

  const onResize = () => { clearTimeout(onResize.t); onResize.t = setTimeout(draw, 200); };
  window.addEventListener("resize", onResize);

  return {
    reload,
    destroy() {
      destroyed = true;
      window.removeEventListener("resize", onResize);
      limpezas.forEach((f) => { try { f(); } catch { /* nada */ } });
      el.innerHTML = "";
    },
  };
}
