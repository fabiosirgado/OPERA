// Separador "Banco" do Dashboard Admin (só nível total): ligação ao Millennium via Enable Banking,
// entradas a ligar a prestações e saídas a registar como custos.
import { sb, SUPABASE_URL } from "../../supabase.js";

export const RETORNO_KEY = "opera-banco-retorno";
const eur = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: 2 });
const dataPT = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : "");
const quando = (s) => (s ? new Date(s).toLocaleString("pt-PT", { dateStyle: "short", timeStyle: "short" }) : "nunca");
const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); kids.forEach((k) => k != null && e.append(k)); return e; };
const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };
const CATS = { entrega: "Entrega", aquisicao: "Aquisição", outros: "Outros" };

async function chamar(payload) {
  const { data: s } = await sb.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/opera-banco`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${s.session?.access_token ?? ""}` },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "O servidor não respondeu.");
  return body;
}

export function mountBanco(box, refreshDashboard) {
  box.innerHTML = "";
  const msg = el("div", { className: "msg" }); msg.hidden = true;
  const status = (m, kind) => { msg.textContent = m || ""; msg.hidden = !m; msg.className = "msg" + (kind ? " " + kind : ""); };
  const card = (titulo, nota, ...kids) => el("div", { className: "op-card", style: "margin-bottom:16px" }, el("h2", { textContent: titulo }), el("p", { className: "note", textContent: nota }), ...kids);
  const estadoBox = el("div", {}, el("div", { className: "vazio", textContent: "A carregar…" }));
  const entradas = el("div");
  const saidas = el("div");
  const tratados = el("div");
  box.append(msg,
    card("Conta Millennium", "Ligação só de leitura (PSD2), através do Enable Banking: o painel lê o saldo e os movimentos uma vez por dia (às 7h40) ou quando carregas em Atualizar agora. Não faz pagamentos. O banco pede para renovar a autorização de tempos a tempos; o painel avisa.", estadoBox),
    card("Entradas por ligar", "Dinheiro que entrou na conta e ainda não está ligado a uma prestação. Quando o valor e a data batem com uma prestação por receber, aparece a sugestão: confirma e a prestação fica paga na data do banco.", entradas),
    card("Saídas por tratar", "Dinheiro que saiu da conta. Regista como custo pontual o que ainda não está nos custos (campanhas, equipamento, serviços); ignora salários e custos mensais que já estão registados, transferências internas e impostos.", saidas),
    card("Tratados recentemente", "Os últimos 30 movimentos ligados, registados ou ignorados. Desfazer volta a pôr o movimento por tratar (e a prestação por receber, ou apaga o custo criado).", tratados));

  let vivo = true;
  async function acao(btn, fn, ok) {
    btn.disabled = true; status("A gravar…");
    try { await fn(); status(ok, "ok"); await carregar(); refreshDashboard?.(); }
    catch (e) { status(e?.message || "Algo falhou.", "err"); btn.disabled = false; }
  }

  function renderEstado(lig) {
    const ligar = el("button", { className: "pri", textContent: lig?.estado === "ativa" ? "Renovar autorização" : "Ligar Millennium" });
    ligar.addEventListener("click", async () => {
      ligar.disabled = true; status("A abrir o Millennium…");
      try {
        const { url } = await chamar({ action: "ligar", redirect_url: `${window.location.origin}/leads/` });
        window.location.assign(url);
      } catch (e) { status(e.message, "err"); ligar.disabled = false; }
    });
    const atualizar = el("button", { textContent: "Atualizar agora" });
    atualizar.addEventListener("click", () => acao(atualizar, async () => {
      const r = await chamar({ action: "sync" });
      if (!r.ok) throw new Error(r.message || "Não foi possível atualizar.");
    }, "Saldo e movimentos atualizados."));
    if (!lig) {
      estadoBox.replaceChildren(el("div", { className: "item" },
        el("div", { className: "grow" }, el("b", { textContent: "Ainda sem conta ligada." }), el("div", { className: "muted", textContent: "Ao carregar em Ligar Millennium, vais para o banco autorizar o acesso com a app Millennium e voltas aqui." })),
        el("div", { className: "actions" }, ligar)));
      return;
    }
    const dias = lig.valido_ate ? Math.ceil((new Date(lig.valido_ate) - Date.now()) / 864e5) : null;
    const contas = (lig.contas || []).map((c) => c.iban ? `${c.nome || "Conta"} ${c.iban.replace(/^(.{4}).*(.{4})$/, "$1 … $2")}` : c.nome || c.uid).join(", ");
    const tag = lig.estado === "ativa" ? (dias != null && dias <= 15 ? el("span", { className: "tag warn", textContent: `expira em ${dias} dias` }) : el("span", { className: "tag", textContent: "ligada" }))
      : el("span", { className: "tag bad", textContent: lig.estado === "pendente" ? "à espera de autorização" : "expirada" });
    estadoBox.replaceChildren(el("div", { className: "item" },
      el("div", { className: "grow" }, el("b", { textContent: lig.aspsp }), tag,
        el("div", { className: "muted", textContent: `${contas || "sem contas"} · última atualização: ${quando(lig.ultima_sync)}${lig.valido_ate ? " · autorização até " + dataPT(lig.valido_ate.slice(0, 10)) : ""}` }),
        lig.ultimo_erro ? el("div", { className: "muted op-bad", textContent: "Último erro: " + lig.ultimo_erro }) : null),
      el("div", { className: "actions" }, ...(lig.estado === "ativa" ? [atualizar] : []), ligar)));
  }

  function renderEntradas(rows, pendentes) {
    if (!rows.length) { entradas.replaceChildren(el("div", { className: "vazio", textContent: "Nada por ligar." })); return; }
    entradas.replaceChildren(...rows.map((m) => {
      const sel = el("select");
      sel.append(el("option", { value: "", textContent: "Escolher prestação…" }));
      pendentes.forEach((p) => sel.append(el("option", { value: p.pagamento_id, textContent: `${p.cliente} · prestação ${p.numero} · ${eur.format(p.valor)} · ${dataPT(p.data_prevista)}` })));
      if (m.sugestao) sel.value = m.sugestao.pagamento_id;
      const ligar = el("button", { className: "pri", textContent: m.sugestao ? "Confirmar" : "Ligar" });
      ligar.addEventListener("click", () => {
        if (!sel.value) { status("Escolhe a prestação a que este dinheiro corresponde.", "err"); return; }
        acao(ligar, () => must(sb.rpc("opera_admin_banco_ligar", { p_mov: m.id, p_pag: sel.value })), "Pagamento confirmado com a data do banco.");
      });
      const ign = el("button", { textContent: "Não é de cliente" });
      ign.addEventListener("click", () => acao(ign, () => must(sb.rpc("opera_admin_banco_ignorar", { p_mov: m.id })), "Movimento ignorado."));
      const sug = m.sugestao
        ? el("div", { className: "muted op-good", textContent: `Sugestão: ${m.sugestao.cliente}, prestação ${m.sugestao.numero} prevista a ${dataPT(m.sugestao.data_prevista)}${m.sugestao.nome_bate ? " (o nome bate)" : " (só o valor bate: confirma)"}` })
        : el("div", { className: "muted", textContent: "Sem prestação com este valor: escolhe à mão ou marca como não sendo de cliente." });
      return el("div", { className: "item" },
        el("div", { className: "grow" }, el("b", { textContent: m.contraparte || "Entrada" }), el("div", { className: "muted", textContent: `${dataPT(m.data)} · ${m.descricao || ""}` }), sug),
        el("b", { className: "op-good", textContent: eur.format(m.valor) }),
        el("div", { className: "actions" }, sel, ligar, ign));
    }));
  }

  function renderSaidas(rows) {
    if (!rows.length) { saidas.replaceChildren(el("div", { className: "vazio", textContent: "Nada por tratar." })); return; }
    saidas.replaceChildren(...rows.map((m) => {
      const desc = el("input", { type: "text", value: m.contraparte || m.descricao || "", placeholder: "Descrição do custo" }); desc.style.minWidth = "180px";
      const cat = el("select"); Object.entries(CATS).forEach(([k, t]) => cat.append(el("option", { value: k, textContent: t })));
      cat.value = "outros";
      const reg = el("button", { className: "pri", textContent: "Registar como custo" });
      reg.addEventListener("click", () => acao(reg, () => must(sb.rpc("opera_admin_banco_custo", { p_mov: m.id, p_categoria: cat.value, p_descricao: desc.value })), "Custo pontual registado."));
      const ign = el("button", { textContent: "Já está nos custos" });
      ign.addEventListener("click", () => acao(ign, () => must(sb.rpc("opera_admin_banco_ignorar", { p_mov: m.id })), "Movimento ignorado."));
      return el("div", { className: "item" },
        el("div", { className: "grow" }, el("b", { textContent: m.contraparte || "Saída" }), el("div", { className: "muted", textContent: `${dataPT(m.data)} · ${m.descricao || ""}` })),
        el("b", { className: "op-bad", textContent: eur.format(m.valor) }),
        el("div", { className: "actions" }, desc, cat, reg, ign));
    }));
  }

  function renderTratados(rows) {
    if (!rows.length) { tratados.replaceChildren(el("div", { className: "vazio", textContent: "Ainda nada tratado." })); return; }
    const NOME = { ligado: "ligado a prestação", custo: "registado como custo", ignorado: "ignorado" };
    tratados.replaceChildren(...rows.map((m) => {
      const des = el("button", { textContent: "Desfazer" });
      des.addEventListener("click", () => acao(des, () => must(sb.rpc("opera_admin_banco_desfazer", { p_mov: m.id })), "Movimento por tratar outra vez."));
      return el("div", { className: "item" },
        el("div", { className: "grow" }, el("b", { textContent: m.contraparte || (m.valor > 0 ? "Entrada" : "Saída") }), el("span", { className: "tag", textContent: NOME[m.estado] }), el("div", { className: "muted", textContent: `${dataPT(m.data)} · ${m.descricao || ""}` })),
        el("b", { textContent: eur.format(m.valor) }),
        el("div", { className: "actions" }, des));
    }));
  }

  async function carregar() {
    const [lig, sug, pend, saiRows, tratRows] = await Promise.all([
      must(sb.from("opera_banco_ligacao").select("*").in("estado", ["ativa", "expirada", "pendente"]).order("criado_em", { ascending: false }).limit(1)),
      must(sb.rpc("opera_admin_banco_sugestoes")),
      must(sb.rpc("opera_admin_banco_pendentes")),
      must(sb.from("opera_banco_movimentos").select("id,data,valor,contraparte,descricao").eq("estado", "novo").lt("valor", 0).order("data", { ascending: false }).limit(200)),
      must(sb.from("opera_banco_movimentos").select("id,data,valor,contraparte,descricao,estado").neq("estado", "novo").order("data", { ascending: false }).limit(30)),
    ]);
    if (!vivo) return;
    renderEstado(lig[0] || null);
    renderEntradas(sug || [], pend || []);
    renderSaidas(saiRows.map((m) => ({ ...m, valor: Number(m.valor) })));
    renderTratados(tratRows.map((m) => ({ ...m, valor: Number(m.valor) })));
  }

  // Regresso do Millennium: o Leads guardou o código; aqui termina-se a ligação.
  (async () => {
    let ret = null;
    try { ret = JSON.parse(sessionStorage.getItem(RETORNO_KEY) || "null"); sessionStorage.removeItem(RETORNO_KEY); } catch { ret = null; }
    if (ret?.erro) status("A autorização no banco foi cancelada ou falhou. Tenta outra vez em Ligar Millennium.", "err");
    else if (ret?.code) {
      status("A concluir a ligação ao Millennium e a ler os movimentos…");
      try {
        const r = await chamar({ action: "concluir", code: ret.code, state: ret.state });
        status(r.ok ? `Conta ligada. ${r.novos} movimentos lidos.` : (r.message || "Conta ligada."), "ok");
        refreshDashboard?.();
      } catch (e) { status(e.message, "err"); }
    }
    await carregar();
  })().catch((e) => status(e?.message || "Não foi possível carregar.", "err"));

  return () => { vivo = false; };
}
