// Marcação do Dashboard Admin. Os números entram pelos atributos data-source / data-field / data-fmt (ver dashboard.js).
const t = (source, field, fmt, extra = "") => `<span class="b" data-source="${source}" data-field="${field}" data-row="0" data-fmt="${fmt}"${extra}>—</span>`;
const tile = (lbl, source, field, fmt, sub, extra = "") =>
  `<div class="op-tile"><div class="lbl">${lbl}</div><div class="val" data-source="${source}" data-field="${field}" data-row="0" data-fmt="${fmt}"${extra}>—</div><div class="sub">${sub}</div></div>`;
const aw = (field, fmt, extra = "") => `<span data-source="ana_controlo" data-field="${field}" data-where="atual=true" data-fmt="${fmt}"${extra}>—</span>`;
const atile = (lbl, field, fmt, sub, extra = "") =>
  `<div class="op-tile"><div class="lbl">${lbl}</div><div class="val" data-source="ana_controlo" data-field="${field}" data-where="atual=true" data-fmt="${fmt}"${extra}>—</div><div class="sub">${sub}</div></div>`;
const th = (cols) => `<thead><tr>${cols.map(([l, n]) => `<th${n ? ' class="n"' : ""}>${l}</th>`).join("")}</tr></thead><tbody></tbody>`;

export const TEMPLATE = `
<div class="op">
  <header class="op-head">
    <div class="op-brand"><span class="op-logo">OPERA</span><span class="op-tagline">You sell. We operate.</span></div>
    <h1>Dashboard Admin</h1>
    <p id="op-takeaway">${t("resumo", "clientes_ativos", "int")} clientes ativos de 15 · MRR de ${t("resumo", "receita_mensal", "eur")} · margem de ${t("resumo", "margem_pct", "pct", ' data-min="0.4"')} para uma meta de 40%.</p>
    <span class="op-live">Dados em direto do OPERA OS</span>
  </header>

  <div class="op-periodo" id="periodo-bar">
    <label>Período<select id="p-preset" aria-label="Período">
      <option value="mes">Este mês (completo)</option><option value="mes_hoje">Este mês até hoje</option><option value="mes_ant">Mês passado</option><option value="d30">Últimos 30 dias</option><option value="d90">Últimos 90 dias</option><option value="tri">Este trimestre</option><option value="ano">Este ano</option><option value="custom">Personalizado</option>
    </select></label>
    <label>De<input type="date" id="p-inicio" min="2020-01-01" max="2099-12-31" aria-label="Data de início"></label>
    <label>Até<input type="date" id="p-fim" min="2020-01-01" max="2099-12-31" aria-label="Data de fim"></label>
    <span class="pnote">A mostrar de ${t("periodo", "inicio", "date")} a ${t("periodo", "fim", "date")}. Aplica-se a Comercial, Financeiro e Operação; o Resumo mostra o dia de hoje.</span>
  </div>

  <nav class="op-tabs" role="tablist">
    <button class="op-tab" role="tab" data-tab="resumo" aria-selected="true">Resumo</button>
    <button class="op-tab" role="tab" data-tab="comercial" aria-selected="false">Comercial</button>
    <button class="op-tab" role="tab" data-tab="ana" aria-selected="false">Ana · comercial</button>
    <button class="op-tab" role="tab" data-tab="financeiro" aria-selected="false">Financeiro</button>
    <button class="op-tab" role="tab" data-tab="gestao" aria-selected="false">Pagamentos e contratos</button>
    <button class="op-tab" role="tab" data-tab="operacao" aria-selected="false">Operação</button>
    <button class="op-tab" role="tab" data-tab="definicoes" aria-selected="false">Definições</button>
    <button class="op-tab" role="tab" data-tab="acessos" aria-selected="false">Acessos</button>
  </nav>

  <!-- RESUMO -->
  <section class="op-page" id="resumo">
    <div class="op-tiles">
      ${tile("Clientes ativos hoje", "resumo", "clientes_ativos", "int", "Meta: 15 até 31/12/2026")}
      ${tile("MRR hoje", "resumo", "receita_mensal", "eur", `Ritmo anual ${t("resumo", "receita_anual_ritmo", "eur")}`)}
      ${tile("Margem mensal", "resumo", "margem_pct", "pct", `${t("resumo", "margem_mes", "eur")}/mês sobre o MRR · meta 40%`, ' data-min="0.4"')}
      ${tile("Pagamentos vencidos", "resumo", "em_atraso", "eur", `${t("resumo", "n_em_atraso", "int")} prestações por confirmar`, ' data-max="0"')}
      ${tile("Ocupação OPERA SA", "capacidade", "ocupacao_sa", "pct", `${t("capacidade", "slots_usados", "dec")} de ${t("capacidade", "slots_disponiveis", "int")} slots`, ' data-max="0.85"')}
      <div class="op-tile"><div class="lbl">Time to Lead · semana atual</div><div class="val" data-source="ttl_semanal" data-field="ttl_mediano_min" data-row="7" data-fmt="min" data-max="15">—</div><div class="sub"><span data-source="ttl_semanal" data-field="pct_ttl_15" data-row="7" data-fmt="pct">—</span> contactadas em 15 min</div></div>
    </div>
    <div class="op-grid">
      <div class="op-card">
        <h2>Para tratar</h2>
        <p class="note">Só aparece o que precisa de ação hoje.</p>
        <ul class="op-alerts">
          <li id="al-incompletos" hidden>Faltam dados em ${t("resumo", "contratos_incompletos", "int")} contratos (serviço, modalidade ou valor). Sem isso não há prestações nem receita contada.</li>
          <li id="al-atraso" class="bad" hidden>${t("resumo", "n_em_atraso", "int")} prestações vencidas por confirmar, no total de ${t("resumo", "em_atraso", "eur")}. Confirma as que já entraram no banco.</li>
          <li id="al-renov" hidden>${t("resumo", "renovacoes_60d", "int")} contratos terminam nos próximos 60 dias sem decisão de renovação.</li>
          <li id="al-margem" class="bad" hidden>Margem mensal de ${t("resumo", "margem_pct", "pct")}, abaixo dos 40%.</li>
          <li id="al-saldo" hidden>Saldo bancário ainda não registado: sem ele não dá para saber quantos meses de custos tens em caixa.</li>
          <li id="al-ok" hidden>Nada pendente.</li>
        </ul>
      </div>
      <div class="op-card">
        <h2>Metas</h2>
        <p class="note">Clientes ativos até ao fim de 2026 e faturação de 2027.</p>
        <div class="op-bar" id="bar-clientes"><div class="row"><span>Clientes ativos: ${t("resumo", "clientes_ativos", "int")} de 15</span></div><div class="track"><div class="fill"></div></div></div>
        <div class="op-bar" id="bar-2027"><div class="row"><span>2027 já contratado: ${t("resumo", "receita_2027_contratada", "eur")} de 500.000 €</span></div><div class="track"><div class="fill"></div></div><div class="hint">Faturação com data em 2027 de contratos já fechados.</div></div>
        <div class="op-bar" id="bar-ritmo"><div class="row"><span>Ritmo anual de hoje: ${t("resumo", "receita_anual_ritmo", "eur")} de 500.000 €</span></div><div class="track"><div class="fill"></div></div><div class="hint">MRR × 12, se tudo renovar.</div></div>
        <div class="op-bar" id="bar-renov"><div class="row"><span>Taxa de renovação: ${t("resumo", "taxa_renovacao", "pct", ' data-min="0.8"')} · meta 80%</span></div><div class="track"><div class="fill"></div></div><div class="hint">Sobre ${t("resumo", "contratos_terminados", "int")} packs já terminados ou decididos.</div></div>
      </div>
    </div>
  </section>

  <!-- COMERCIAL -->
  <section class="op-page" id="comercial" hidden>
    <h3 class="op-sec">Funil <small>· período escolhido</small></h3>
    <div class="op-tiles">
      <button type="button" class="op-tile op-click" data-lista="R1" aria-expanded="false"><div class="lbl">R1 marcadas</div><div class="val" data-source="periodo" data-field="r1" data-row="0" data-fmt="int">—</div><div class="sub">Ver clientes ›</div></button>
      <button type="button" class="op-tile op-click" data-lista="R2" aria-expanded="false"><div class="lbl">R2</div><div class="val" data-source="periodo" data-field="r2" data-row="0" data-fmt="int">—</div><div class="sub">${t("periodo", "em_decisao", "int")} passaram a Em decisão · ver ›</div></button>
      <button type="button" class="op-tile op-click" data-lista="Fecho" aria-expanded="false"><div class="lbl">Fechos</div><div class="val" data-source="periodo" data-field="fechos" data-row="0" data-fmt="int">—</div><div class="sub"><span id="obj-mes-fechos"></span>Ver clientes ›</div></button>
      ${tile("Conversão R1 → fecho", "periodo", "conv_r1_fecho", "pct", "Meta da Ana: 10%", ' data-min="0.1"')}
      ${tile("Conversão R1 → R2", "periodo", "conv_r1_r2", "pct", `R2 → fecho: ${t("periodo", "conv_r2_fecho", "pct")}`)}
      <div class="op-tile"><div class="lbl">Em decisão agora</div><div class="val" data-source="pipeline" data-field="leads_agora" data-where="fase=Em%20decis%C3%A3o" data-fmt="int">—</div><div class="sub"><span data-source="pipeline" data-field="leads_agora" data-where="fase=R1" data-fmt="int">—</span> em R1 e <span data-source="pipeline" data-field="leads_agora" data-where="fase=R2" data-fmt="int">—</span> em R2</div></div>
    </div>
    <div class="op-card" id="card-lista" hidden style="margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
        <h2 id="lista-titulo">Clientes</h2>
        <button type="button" class="op-x" id="lista-fechar" aria-label="Fechar lista">Fechar ✕</button>
      </div>
      <p class="note" id="lista-nota">No período escolhido.</p>
      <div class="op-table-wrap"><table class="op-table" id="tb-lista">${th([["Cliente"], ["Data"], ["Fase atual"], ["Serviço"], ["Valor", 1]])}</table></div>
    </div>
    <h3 class="op-sec">Vendas <small>· contratos fechados no período</small></h3>
    <div class="op-tiles">
      ${tile("Vendas novas", "periodo", "vendas_novas", "eur", `${t("periodo", "contratos_novos", "int")} contratos novos`)}
      ${tile("Ticket médio", "periodo", "ticket_medio", "eur", "Valor do pack")}
      ${tile("Vendas em PIF", "periodo", "pct_pif_vendas", "pct", "Meta da Ana: 50% ou mais", ' data-min="0.5"')}
      ${tile("Bundle SA + BO", "periodo", "pct_bundle", "pct", "Dos contratos novos")}
      ${tile("Renovações", "periodo", "renovacoes", "int", "Packs renovados com início no período")}
    </div>
    <h3 class="op-sec">Pipeline <small>· clientes fechados no período que ainda não estão em entrega</small></h3>
    <div class="op-card" style="margin-bottom:16px">
      <p class="note" style="margin-top:0">Leads da OPERA hoje em Closed e Em Onboarding, com data de início (data de fecho) no período escolhido. Ainda não contam para clientes ativos, MRR nem receita; passam a contar quando entrarem em Entrega de serviço.</p>
      <div class="op-tiles">
        ${tile("Clientes em pipeline", "pipeline_resumo", "clientes", "int", `${t("pipeline_resumo", "por_completar", "int")} com contrato por completar`)}
        ${tile("Valor contratado", "pipeline_resumo", "valor", "eur", `${t("pipeline_resumo", "recebido", "eur")} já recebido`)}
        ${tile("MRR a entrar", "pipeline_resumo", "mrr_pipeline", "eur", "Quando todos estiverem em entrega")}
        ${tile("MRR com pipeline", "pipeline_resumo", "mrr_com_pipeline", "eur", `Margem mensal seria ${t("pipeline_resumo", "margem_com_pipeline", "pct", ' data-min="0.4"')}`)}
      </div>
      <div class="op-table-wrap"><table class="op-table" id="tb-pipe">${th([["Cliente"], ["Fase"], ["Serviço"], ["Valor", 1], ["Por mês", 1], ["Fecho"], ["Início"], ["Recebido", 1], ["Estado"]])}</table></div>
    </div>
    <h3 class="op-sec">Economia do cliente</h3>
    <div class="op-tiles">
      ${tile("CAC", "periodo", "cac", "eur", `${t("periodo", "clientes_novos_cac", "int")} clientes novos fechados no gestor de leads`)}
      ${tile("LTV", "periodo", "ltv", "eur", `${t("periodo", "margem_cliente", "eur")}/mês de margem por cliente × ${t("periodo", "vida_media_meses", "dec")} meses`)}
      ${tile("LTV : CAC", "periodo", "ltv_cac", "ratio", "Saudável a partir de 3 : 1", ' data-min="3"')}
      ${tile("Recuperação do CAC", "periodo", "payback_meses", "dec", "Meses de margem para pagar o CAC", ' data-max="3"')}
      ${tile("Churn mensal", "periodo", "churn_mensal", "pct1", `${t("periodo", "clientes_perdidos", "int")} clientes terminados · churn de MRR ${t("periodo", "churn_mrr", "pct")}`, ' data-max="0.067"')}
    </div>
    <p class="op-caveat" id="ue-aviso" hidden>O LTV usa a taxa de renovação de referência (80%): só há ${t("periodo", "decisoes_renovacao", "int")} decisões de renovação registadas. Passa a usar a real a partir de 5.</p>
    <div class="op-card" style="margin-bottom:16px">
      <h2>LTV, CAC e rácio por serviço</h2>
      <p class="note">Período escolhido. CAC de cada serviço = comissões das vendas desse serviço mais a parte dos outros custos de aquisição (repartidos pelo número de contratos novos), a dividir pelos contratos novos desse serviço. Sem vendas de um serviço no período, o CAC desse serviço fica em branco. A taxa de renovação é a mesma para todos até haver histórico.</p>
      <div class="op-table-wrap"><table class="op-table" id="tb-unit">${th([["Serviço"], ["Clientes", 1], ["Receita/mês", 1], ["Custo do lugar", 1], ["Margem/mês", 1], ["Vida (meses)", 1], ["LTV", 1], ["Novos", 1], ["Comissões", 1], ["CAC", 1], ["LTV : CAC", 1], ["Recuperação", 1]])}</table></div>
    </div>
    <div class="op-grid">
      <div class="op-card"><h2>R1, R2 e fechos por semana</h2><p class="note">Últimas 8 semanas, contados quando a lead entra na fase.</p><div class="op-legend" id="lg-funil"></div><div class="op-chart" id="ch-funil"></div></div>
      <div class="op-card"><h2>Por pessoa</h2><p class="note">No período, por quem mudou a lead de fase no gestor de leads.</p><div class="op-table-wrap"><table class="op-table" id="tb-pessoas">${th([["Pessoa"], ["R1", 1], ["R2", 1], ["Fechos", 1]])}</table></div></div>
    </div>
    <div class="op-grid">
      <div class="op-card"><h2>Pipeline da OPERA por fase</h2><p class="note">Leads em cada fase hoje e quantas entraram nela nos últimos 30 dias. A BD e as desqualificadas ficam de fora.</p><div class="op-chart" id="ch-pipe"></div></div>
      <div class="op-card"><h2>Vendas por mês</h2><p class="note">Últimos 6 meses, pelo mês de início do serviço.</p><div class="op-legend" id="lg-vendas"></div><div class="op-chart" id="ch-vendas"></div></div>
    </div>
  </section>

  <!-- ANA -->
  <section class="op-page" id="ana" hidden>
    <h3 class="op-sec">Período de comissão atual <small>· de ${aw("inicio", "date")} a ${aw("fim", "date")}, pago no salário deste mês · não depende do período escolhido em cima</small></h3>
    <div class="op-tiles">
      ${atile("Fechos", "fechos", "int", `Objetivo ${aw("obj_fechos", "int")}`)}
      ${atile("Vendas novas", "vendas", "eur", "Objetivo 15.000 € · ao preço integral")}
      ${atile("Reuniões (R1)", "reunioes", "int", `Objetivo ${aw("obj_reunioes", "int")} (15 por semana)`)}
      ${atile("Conversão", "conversao", "pct", "Fechos ÷ reuniões · objetivo 10%", ' data-min="0.1"')}
      ${atile("Pagamentos integrais", "pct_pif", "pct", "Objetivo 50% ou mais", ' data-min="0.5"')}
      ${atile("Comissão a pagar", "comissao_garantida", "eur", `Já recebido · prevista ${aw("comissao_prevista", "eur")}`)}
      ${atile("Escalão", "escalao", "txt", `Faltam ${aw("falta_proximo", "eur")} para o seguinte`)}
      <div class="op-tile"><div class="lbl">Bónus trimestral</div><div class="val" data-source="ana_bonus" data-field="bonus" data-where="atual=true" data-fmt="eur">—</div><div class="sub">Renovação da carteira <span data-source="ana_bonus" data-field="taxa_renovacao" data-where="atual=true" data-fmt="pct">—</span> · satisfação <span data-source="ana_bonus" data-field="satisfacao" data-where="atual=true" data-fmt="dec">—</span></div></div>
    </div>
    <div class="op-card" style="margin-bottom:16px"><h2>Objetivo vs realidade</h2><p class="note">Barra = realidade em % do objetivo do período atual.</p><div id="ana-barras"></div></div>
    <div class="op-card" style="margin-bottom:16px">
      <h2>Por período de comissão</h2>
      <p class="note">Períodos de 26 a 25 (o primeiro começa a 9/11, entrada da Ana). Rampa de fechos da Ana: 2 no primeiro período (9 a 25 de novembro), 5 no de dezembro, 6 a partir de janeiro. Em cada célula: realidade / objetivo. Comissão garantida = sobre dinheiro já recebido; prevista = junta as prestações por receber com data nesse período.</p>
      <div class="op-table-wrap"><table class="op-table" id="tb-ana">${th([["Período"], ["Reuniões", 1], ["Fechos", 1], ["Conversão", 1], ["Vendas novas", 1], ["Integrais", 1], ["Base da comissão", 1], ["Escalão"], ["Falta p/ seguinte", 1], ["Garantida", 1], ["Prevista", 1], ["Paga em"]])}</table></div>
    </div>
    <div class="op-card" style="margin-bottom:16px">
      <h2>Escalões</h2>
      <p class="note">Rappel sobre o valor de vendas novas e cross sell recebido no período, ao preço integral (a diferença do fracionado não conta). A taxa aplica-se a todo o valor do período.</p>
      <table class="op-table">
        <thead><tr><th>Escalão</th><th>Valor recebido no período</th><th class="n">Taxa</th><th class="n">Exemplo</th></tr></thead>
        <tbody>
          <tr><td>1</td><td>Até 15.000 €</td><td class="n">10%</td><td class="n">12.000 € → 1.200 €</td></tr>
          <tr><td>2</td><td>De 15.000,01 € a 24.000 €</td><td class="n">11%</td><td class="n">20.000 € → 2.200 €</td></tr>
          <tr><td>3</td><td>Acima de 24.000 €</td><td class="n">12,5%</td><td class="n">30.000 € → 3.750 €</td></tr>
          <tr><td>Renovação recuperada</td><td>Só com decisão escrita do Fábio</td><td class="n">5%</td><td class="n">Não conta para o escalão</td></tr>
          <tr><td>Renovação normal</td><td></td><td class="n">0%</td><td class="n"></td></tr>
        </tbody>
      </table>
    </div>
    <div class="op-card" style="margin-bottom:16px">
      <h2>Bónus trimestral de renovação</h2>
      <p class="note">Carteira = clientes vendidos pela Ana. 250 € se 80% ou mais dos packs que terminam no trimestre renovarem; 500 € se, além disso, a satisfação média dos clientes dela for 8 ou mais. A satisfação vem do inquérito mensal, ligada pelo nome do cliente.</p>
      <div class="op-table-wrap"><table class="op-table" id="tb-ana-bonus">${th([["Trimestre"], ["Packs a terminar", 1], ["Renovaram", 1], ["Não renovaram", 1], ["Por decidir", 1], ["Renovação", 1], ["Satisfação", 1], ["Respostas", 1], ["Bónus", 1]])}</table></div>
    </div>
    <div class="op-card">
      <h2>Comissões por prestação</h2>
      <p class="note">Cada prestação dos contratos vendidos pela Ana, do período anterior até 3 meses à frente. A cinzento: ainda por receber (só é paga quando o dinheiro entrar).</p>
      <div class="op-table-wrap"><table class="op-table" id="tb-ana-com">${th([["Cliente"], ["Serviço"], ["Tipo"], ["Prestação", 1], ["Valor", 1], ["Conta", 1], ["Data"], ["Estado"], ["Período até"], ["Taxa", 1], ["Comissão", 1]])}</table></div>
    </div>
  </section>

  <!-- FINANCEIRO -->
  <section class="op-page" id="financeiro" hidden>
    <h3 class="op-sec">MRR <small>· receita recorrente mensal, valor do pack a dividir pelos meses</small></h3>
    <div class="op-tiles">
      ${tile("MRR no fim do período", "periodo", "mrr_fim", "eur", `${t("periodo", "clientes_fim", "int")} clientes ativos`)}
      ${tile("MRR no início", "periodo", "mrr_inicio", "eur", `${t("periodo", "clientes_inicio", "int")} clientes ativos`)}
      ${tile("MRR novo", "periodo", "mrr_novo", "eur", "De contratos novos no período")}
      ${tile("MRR perdido", "periodo", "mrr_perdido", "eur", "Serviços terminados no período", ' data-max="0"')}
    </div>
    <h3 class="op-sec">Faturação <small>· o que se fatura no período: o PIF no arranque, o mensal a cada mês</small></h3>
    <div class="op-tiles">
      ${tile("Faturação", "periodo", "faturacao", "eur", "Total do período")}
      ${tile("Faturação PIF", "periodo", "faturacao_pif", "eur", "Packs pagos de uma vez")}
      ${tile("Faturação mensal", "periodo", "faturacao_mensal", "eur", "Prestações de packs fracionados")}
      ${tile("Faturado e ainda por receber", "periodo", "por_receber", "eur", "Do que foi faturado no período")}
    </div>
    <h3 class="op-sec">Caixa <small>· dinheiro que entrou no banco no período</small></h3>
    <div class="op-tiles">
      ${tile("Recebido", "periodo", "caixa", "eur", "Pagamentos confirmados")}
      ${tile("Recebido PIF", "periodo", "caixa_pif", "eur", "Packs pagos de uma vez")}
      ${tile("Recebido mensal", "periodo", "caixa_mensal", "eur", "Prestações")}
      ${tile("Saldo bancário hoje", "resumo", "saldo", "eur", `${t("resumo", "meses_de_caixa", "dec")} meses de custos`)}
    </div>
    <h3 class="op-sec">Regra de margens <small>· cada custo em % da receita do período</small></h3>
    <div class="op-card" style="margin-bottom:16px">
      <p class="note" style="margin-top:0">Entrega até 20% (margem de entrega de 80%), aquisição até 20%, outros até 20%, margem final de pelo menos 40%. A barra mostra o valor real; o traço marca o limite. Folga = quanto ainda cabe (ou falta) em euros no período.</p>
      <div id="regra-barras"></div>
      <div class="op-table-wrap" style="margin-top:16px"><table class="op-table" id="tb-regra">${th([["Linha"], ["Regra"], ["Real", 1], ["Folga real", 1], ["Com pipeline", 1], ["Folga c/ pipeline", 1]])}</table></div>
    </div>
    <div class="op-grid">
      <div class="op-card">
        <h2>P&amp;L do período</h2>
        <p class="note">Receita reconhecida: o valor de cada contrato espalhado pelos dias do serviço. Custos mensais proporcionais aos dias; custos pontuais e comissões na sua data. Metas: margem bruta 80%, resultado 40%.</p>
        <table class="op-table">
          <thead><tr><th></th><th class="n">Real</th><th class="n">%</th><th class="n">Com pipeline</th><th class="n">%</th></tr></thead>
          <tbody>
          <tr class="tot"><td>Receita</td><td class="n" data-source="pnl_periodo" data-field="receita" data-row="0" data-fmt="eur">—</td><td></td><td class="n" data-source="pnl_periodo" data-field="receita_pipeline" data-row="0" data-fmt="eur">—</td><td></td></tr>
          <tr><td>Custos de entrega</td><td class="n" data-source="pnl_periodo" data-field="custos_entrega" data-row="0" data-fmt="eur">—</td><td></td><td class="n" data-source="pnl_periodo" data-field="custos_entrega" data-row="0" data-fmt="eur">—</td><td></td></tr>
          <tr class="tot"><td>Margem bruta</td><td class="n" data-source="pnl_periodo" data-field="margem_bruta" data-row="0" data-fmt="eur">—</td><td class="n" data-source="pnl_periodo" data-field="margem_bruta_pct" data-row="0" data-fmt="pct" data-min="0.8">—</td><td class="n" data-source="pnl_periodo" data-field="margem_bruta_pipeline" data-row="0" data-fmt="eur">—</td><td class="n" data-source="pnl_periodo" data-field="margem_bruta_pipeline_pct" data-row="0" data-fmt="pct" data-min="0.8">—</td></tr>
          <tr><td>Custos de aquisição</td><td class="n" data-source="pnl_periodo" data-field="custos_aquisicao" data-row="0" data-fmt="eur">—</td><td></td><td class="n" data-source="pnl_periodo" data-field="custos_aquisicao" data-row="0" data-fmt="eur">—</td><td></td></tr>
          <tr><td>Outros custos</td><td class="n" data-source="pnl_periodo" data-field="custos_outros" data-row="0" data-fmt="eur">—</td><td></td><td class="n" data-source="pnl_periodo" data-field="custos_outros" data-row="0" data-fmt="eur">—</td><td></td></tr>
          <tr class="tot"><td>Resultado operacional</td><td class="n" data-source="pnl_periodo" data-field="resultado" data-row="0" data-fmt="eur" data-min="0">—</td><td class="n" data-source="pnl_periodo" data-field="resultado_pct" data-row="0" data-fmt="pct" data-min="0.4">—</td><td class="n" data-source="pnl_periodo" data-field="resultado_pipeline" data-row="0" data-fmt="eur" data-min="0">—</td><td class="n" data-source="pnl_periodo" data-field="resultado_pipeline_pct" data-row="0" data-fmt="pct" data-min="0.4">—</td></tr>
          <tr><td style="color:var(--color-fg-muted)">Faturação no período</td><td class="n" data-source="pnl_periodo" data-field="faturacao" data-row="0" data-fmt="eur">—</td><td></td><td></td><td></td></tr>
          <tr><td style="color:var(--color-fg-muted)">Caixa recebida no período</td><td class="n" data-source="pnl_periodo" data-field="caixa" data-row="0" data-fmt="eur">—</td><td></td><td></td><td></td></tr>
        </tbody></table>
        <p class="note" style="margin:8px 0 0">Real: só clientes em Entrega de serviço. Com pipeline: junta os clientes em Closed e Em Onboarding a partir da data de início. Custos iguais nas duas.</p>
      </div>
      <div class="op-card"><h2>Faturação, caixa e custos por mês</h2><p class="note">De 2 meses atrás a 5 à frente. O futuro não conta vendas novas nem renovações.</p><div class="op-legend" id="lg-fluxo"></div><div class="op-chart" id="ch-fluxo"></div></div>
    </div>
    <div class="op-card" style="margin-bottom:16px">
      <h2>P&amp;L por mês</h2>
      <p class="note">Últimos 6 meses e os 2 seguintes (em itálico: só contratos e custos já registados). Fixo, não depende do período escolhido.</p>
      <div class="op-table-wrap"><table class="op-table" id="tb-pnl">${th([["Mês"], ["Receita", 1], ["Entrega", 1], ["Margem bruta", 1], ["%", 1], ["Aquisição", 1], ["Outros", 1], ["Resultado", 1], ["%", 1], ["Receita c/ pipeline", 1], ["Resultado c/ pipeline", 1], ["%", 1], ["Faturação", 1], ["Caixa", 1]])}</table></div>
    </div>
    <div class="op-card">
      <h2>Contratos</h2>
      <p class="note">Ativos, por completar e terminados há menos de 30 dias. Prestações 1 = PIF. A cinzento: contratos de leads em Closed ou Em Onboarding, que ainda não contam para as métricas de clientes e receita.</p>
      <div class="op-table-wrap"><table class="op-table" id="tb-contratos">${th([["Cliente"], ["Fase"], ["Serviço"], ["Vendedor"], ["Valor", 1], ["Prestações", 1], ["Início"], ["Fim"], ["Pago", 1], ["Por pagar", 1], ["Vencido", 1], ["Estado"]])}</table></div>
    </div>
  </section>

  <!-- GESTÃO: pagamentos, contratos, custos, saldo -->
  <section class="op-page opg" id="gestao" hidden></section>

  <!-- OPERAÇÃO -->
  <section class="op-page" id="operacao" hidden>
    <div class="op-tiles">
      ${tile("Ocupação OPERA SA hoje", "capacidade", "ocupacao_sa", "pct", `${t("capacidade", "gestores", "int")} Gestor(es) de Leads · 8 slots cada`, ' data-max="0.85"')}
      ${tile("Ocupação OPERA BO hoje", "capacidade", "ocupacao_bo", "pct", `${t("capacidade", "clientes_bo", "int")} de ${t("capacidade", "capacidade_bo", "int")} clientes`, ' data-max="0.85"')}
      <div class="op-tile"><div class="lbl">Time to Lead · semana atual</div><div class="val" data-source="ttl_semanal" data-field="ttl_mediano_min" data-row="7" data-fmt="min" data-max="15">—</div><div class="sub">Mediana · objetivo 15 min</div></div>
      <div class="op-tile"><div class="lbl">Contactadas em 15 min</div><div class="val" data-source="ttl_semanal" data-field="pct_ttl_15" data-row="7" data-fmt="pct">—</div><div class="sub"><span data-source="ttl_semanal" data-field="leads_novas" data-row="7" data-fmt="int">—</span> leads novas esta semana</div></div>
    </div>
    <div class="op-card" style="margin-bottom:16px"><h2>Leads contactadas em 15 minutos, por semana</h2><p class="note">Últimas 8 semanas, leads novas de clientes (sem BD). Passa o rato para ver a mediana do Time to Lead.</p><div class="op-chart" id="ch-ttl"></div></div>
    <div class="op-card">
      <h2>Por cliente · período escolhido</h2>
      <p class="note">Carga em slots: o maior entre 1 e as leads trabalhadas por dia a dividir por 25. Tarefas atrasadas são as de hoje.</p>
      <div class="op-table-wrap"><table class="op-table" id="tb-op">${th([["Cliente"], ["Leads novas", 1], ["Time to Lead", 1], ["Em 15 min", 1], ["Chamadas", 1], ["Atendidas", 1], ["BD recuperadas", 1], ["Tarefas atrasadas", 1], ["Leads/dia", 1], ["Slots", 1]])}</table></div>
    </div>
  </section>

  <!-- DEFINIÇÕES -->
  <section class="op-page" id="definicoes" hidden>
    <div class="op-card">
      <h2>Como cada número é calculado</h2>
      <p class="note">Tudo vem do OPERA OS em direto e é calculado no servidor (função opera_admin_dados).</p>
      <dl class="op-defs">
        <dt>Contrato</dt><dd>Criado automaticamente quando uma lead do cliente OPERA passa para Closed, Em Onboarding ou Entrega de serviço. Lê os campos Serviço, Modalidade, Valor, Início e Plano da qualificação da lead. Sem Valor, usa o preço de tabela. Sem Serviço ou Modalidade, fica por completar. O vendedor é quem passou a lead para Closed (podes mudar em Pagamentos e contratos).</dd>
        <dt>Pipeline</dt><dd>Clientes já fechados (leads da OPERA em Closed ou Em Onboarding) que ainda não estão em Entrega de serviço. MRR a entrar = valor de cada contrato a dividir pelos meses. MRR com pipeline = MRR de hoje mais o MRR a entrar; a margem com pipeline usa os custos mensais de hoje.</dd>
        <dt>Renovação assumida</dt><dd>Todos os packs são tratados como se renovassem ao mesmo valor no fim. As exceções são os serviços únicos, os packs marcados como "não renovou" e os clientes que passaram a Serviço terminado. Os serviços únicos contam na receita do P&amp;L e como cliente ativo enquanto duram, mas não no MRR.</dd>
        <dt>PIF e mensal</dt><dd>PIF é o pack pago de uma vez (1 prestação no arranque). Mensal é o pack fracionado (várias prestações).</dd>
        <dt>MRR</dt><dd>Soma do valor de cada contrato ativo a dividir pelos meses do pack.</dd>
        <dt>Faturação</dt><dd>Prestações com data no período.</dd>
        <dt>Caixa</dt><dd>Pagamentos confirmados, pela data em que entraram no banco.</dd>
        <dt>Cliente ativo</dt><dd>Cliente com a lead em Entrega de serviço (ou contrato manual), com contrato cujo período inclui o dia em causa e que ainda não passou a Serviço terminado.</dd>
        <dt>Serviço terminado e churn</dt><dd>Quando uma lead do cliente OPERA passa a Serviço terminado, o contrato fecha nesse dia e conta como não renovação. Churn mensal = clientes terminados no período a dividir pelos clientes ativos no início, ajustado a 30 dias. Com 80% de renovação a cada 3 meses, o churn mensal de referência é cerca de 6,7%.</dd>
        <dt>R1, R2 e fechos</dt><dd>Leads do cliente OPERA que entraram na fase R1 ou R2 no período. Fecho é a primeira entrada em Closed, Em Onboarding ou Entrega de serviço.</dd>
        <dt>CAC</dt><dd>Custos de aquisição do período (mensais proporcionais aos dias, pontuais e comissões da Ana) a dividir pelos contratos novos com data de fecho (= data de início) no período.</dd>
        <dt>LTV</dt><dd>Margem mensal média de um cliente recorrente vezes a vida média. A margem é o valor mensal menos o custo de um lugar: Gestor de Leads a dividir por 8 no SA, back office a dividir por 15 no BO, os dois no bundle. Vida média = 3 meses a dividir por (1 menos taxa de renovação).</dd>
        <dt>P&amp;L</dt><dd>Receita reconhecida pelos dias de serviço. Margem bruta = receita menos custos de entrega. Resultado operacional = margem bruta menos aquisição e outros custos. Sem impostos nem amortizações.</dd>
        <dt>Regra de margens</dt><dd>Entrega até 20%, aquisição até 20%, outros até 20%, margem final de pelo menos 40%, na versão real e com pipeline.</dd>
        <dt>Comissões</dt><dd>Calculadas automaticamente para os contratos com vendedor Ana. Rappel por período de 26 a 25 sobre o valor recebido ao preço integral: 10% até 15.000 €, 11% até 24.000 €, 12,5% acima, aplicado a todo o valor; 5% nas renovações recuperadas; 0% nas renovações normais. Entram no P&amp;L e no CAC como custo de aquisição, sem TSU, na data em que o dinheiro entra (ou está previsto entrar). Não registes estas comissões à mão nos custos. Bónus trimestral: 250 € com 80% ou mais de renovação da carteira dela, 500 € se além disso a satisfação média for 8 ou mais (não entra automaticamente no P&amp;L).</dd>
        <dt>Time to Lead</dt><dd>Minutos entre a entrada da lead no sistema e a primeira chamada. Leads de BD não contam.</dd>
        <dt>Ocupação</dt><dd>SA: soma da carga dos clientes a dividir por 8 slots por Gestor de Leads. BO: clientes BO ou bundle ativos a dividir por 15 por pessoa de back office.</dd>
        <dt>Acessos</dt><dd>Só quem está na lista de Acessos vê o Dashboard Admin. Total: vê tudo e mexe no financeiro. Comercial: vê só o separador do seu controlo comercial.</dd>
      </dl>
    </div>
  </section>

  <!-- ACESSOS -->
  <section class="op-page opg" id="acessos" hidden></section>
</div>`;
