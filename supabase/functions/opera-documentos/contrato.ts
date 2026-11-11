// Gera o PDF do contrato de prestação de serviços OPERA SA (gestão de leads) a partir do contrato, da ficha de fecho
// e dos pagamentos. Texto base: contrato da Joana Vicente (nov 2026), adaptado ao OPERA Leads.
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

type Ficha = {
  tipo?: "empresa" | "particular"; nome: string; nif: string; morada: string; codigo_postal?: string; localidade?: string;
  rep_nome?: string; rep_qualidade?: string; rep_cc?: string; rep_cc_validade?: string; rep_nif?: string;
  cc?: string; cc_validade?: string; email: string; telefone?: string; ami?: string;
};
type Pag = { numero: number; valor: number; data_prevista: string; estado: string };
type Contrato = { servico: string | null; duracao_meses: number | null; data_inicio: string; valor_total: number | null; ficha: Ficha };

// ---------- Números e datas por extenso
const UN = ["zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze", "treze", "catorze", "quinze", "dezasseis", "dezassete", "dezoito", "dezanove"];
const DZ = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
const CT = ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"];
function ate999(n: number): string {
  if (n < 20) return UN[n];
  if (n < 100) return DZ[Math.floor(n / 10)] + (n % 10 ? " e " + UN[n % 10] : "");
  if (n === 100) return "cem";
  return CT[Math.floor(n / 100)] + (n % 100 ? " e " + ate999(n % 100) : "");
}
function inteiro(n: number): string {
  if (n < 1000) return ate999(n);
  if (n < 1_000_000) {
    const m = Math.floor(n / 1000), r = n % 1000;
    const mil = m === 1 ? "mil" : ate999(m) + " mil";
    if (!r) return mil;
    return mil + (r < 100 || r % 100 === 0 ? " e " : " ") + ate999(r);
  }
  const mi = Math.floor(n / 1_000_000), r = n % 1_000_000;
  const s = mi === 1 ? "um milhão" : inteiro(mi) + " milhões";
  return r ? s + (r < 100 || (r < 1000 && r % 100 === 0) ? " e " : " ") + inteiro(r) : s;
}
export function euroExtenso(v: number): string {
  const c = Math.round(v * 100), e = Math.floor(c / 100), cent = c % 100;
  const pe = e ? `${inteiro(e)} ${e === 1 ? "euro" : (e % 1_000_000 === 0 ? "de euros" : "euros")}` : "";
  const pc = cent ? `${inteiro(cent)} ${cent === 1 ? "cêntimo" : "cêntimos"}` : "";
  return [pe, pc].filter(Boolean).join(" e ") || "zero euros";
}
const euroMil = (v: number) => { // formato 3.300,00 € (o Intl pt-PT não agrupa abaixo de 10 000)
  const [i, d] = v.toFixed(2).split(".");
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "," + d + " €";
};
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const dataLonga = (s: string) => `${+s.slice(8, 10)} de ${MESES[+s.slice(5, 7) - 1]} de ${s.slice(0, 4)}`;
const dataPT = (s?: string) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : "");
const NUM = ["zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze"];
const nExt = (n: number) => `${n} (${NUM[n] ?? n})`;
const nExtF = (n: number) => `${n} (${(NUM[n] ?? String(n)).replace(/^um$/, "uma").replace(/^dois$/, "duas")})`;

// ---------- Motor de paginação simples (A4, margens 2 cm, Helvetica com WinAnsi)
const A4: [number, number] = [595.28, 841.89];
const M = 56.7, W = A4[0] - 2 * M;
const DARK = rgb(0.1, 0.1, 0.18), GREY = rgb(0.4, 0.4, 0.4), LINE = rgb(0.8, 0.8, 0.8), HEAD = rgb(0.933, 0.933, 0.953);

export async function gerarContrato(c: Contrato, pagamentos: Pag[], opts: { rodape?: string } = {}): Promise<Uint8Array> {
  if (c.servico !== "SA") throw new Error("Por agora só existe o modelo de contrato do OPERA SA. O BO e o bundle ainda não têm modelo.");
  const f = c.ficha;
  const pags = pagamentos.filter((p) => p.estado !== "cancelado").sort((a, b) => a.numero - b.numero);
  if (!pags.length) throw new Error("O contrato não tem pagamentos definidos.");
  const meses = c.duracao_meses || 3;
  const total = Math.round(pags.reduce((s, p) => s + Number(p.valor), 0) * 100) / 100;
  const empresa = f.tipo !== "particular";

  const doc = await PDFDocument.create();
  doc.setTitle(`Contrato OPERA SA · ${f.nome}`); doc.setAuthor("OPERA"); doc.setLanguage("pt-PT");
  const R = await doc.embedFont(StandardFonts.Helvetica);
  const B = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage(A4);
  let y = A4[1] - M;
  const bottom = M + 14;
  const novaPagina = () => { page = doc.addPage(A4); y = A4[1] - M; };
  const garante = (h: number) => { if (y - h < bottom) novaPagina(); };

  // Texto com **negrito** em linha, quebra de linhas e justificação
  type Tok = { t: string; b: boolean };
  const tokens = (s: string): Tok[] => {
    const out: Tok[] = []; let bold = false;
    s.split("**").forEach((part, i) => { if (i > 0) bold = !bold; part.split(/(\s+)/).forEach((w) => { if (w) out.push({ t: w, b: bold }); }); });
    return out;
  };
  const larg = (t: Tok, size: number) => (t.b ? B : R).widthOfTextAtSize(t.t, size);
  function linhas(s: string, size: number, w: number) {
    const ls: Tok[][] = []; let cur: Tok[] = []; let cw = 0;
    for (const t of tokens(s)) {
      const isSp = /^\s+$/.test(t.t);
      const tw = larg(isSp ? { t: " ", b: t.b } : t, size);
      if (!isSp && cw + tw > w && cur.length) { while (cur.length && /^\s+$/.test(cur[cur.length - 1].t)) cur.pop(); ls.push(cur); cur = []; cw = 0; }
      if (isSp && !cur.length) continue;
      cur.push(isSp ? { t: " ", b: t.b } : t); cw += tw;
    }
    while (cur.length && /^\s+$/.test(cur[cur.length - 1].t)) cur.pop();
    if (cur.length) ls.push(cur);
    return ls;
  }
  function desenha(l: Tok[], x: number, yy: number, size: number, w: number, just: boolean, color = DARK) {
    const gaps = l.filter((t) => t.t === " ").length;
    const used = l.reduce((s, t) => s + larg(t, size), 0);
    const extra = just && gaps ? Math.min((w - used) / gaps, size) : 0;
    let cx = x;
    for (const t of l) {
      if (t.t === " ") { cx += larg(t, size) + extra; continue; }
      page.drawText(t.t, { x: cx, y: yy, size, font: t.b ? B : R, color });
      cx += larg(t, size);
    }
  }

  function P(s: string, o: { size?: number; lead?: number; after?: number; indent?: number; bullet?: boolean; center?: boolean; color?: any; bold?: boolean; before?: number } = {}) {
    const size = o.size ?? 9.5, lead = o.lead ?? size * 1.47, ind = o.indent ?? (o.bullet ? 14 : 0);
    const w = W - ind;
    if (o.before) y -= o.before;
    const ls = linhas(o.bold ? `**${s}**` : s, size, w);
    ls.forEach((l, i) => {
      garante(lead);
      const base = y - size;
      if (o.bullet && i === 0) page.drawText("•", { x: M + 4, y: base, size, font: R, color: DARK });
      if (o.center) {
        const lw = l.reduce((s2, t) => s2 + larg(t, size), 0);
        desenha(l, M + (W - lw) / 2, base, size, w, false, o.color);
      } else desenha(l, M + ind, base, size, w, i < ls.length - 1, o.color);
      y -= lead;
    });
    y -= o.after ?? (o.bullet ? 3 : 5);
  }
  const H = (s: string) => { garante(40); P(s, { size: 11.5, lead: 16, bold: true, before: 10, after: 5 }); };
  const H3 = (s: string) => { garante(30); P(s, { size: 10, lead: 14, bold: true, before: 4, after: 3 }); };
  const BL = (s: string) => P(s, { bullet: true });

  function tabela(rows: [string, string][], w1 = 170) {
    const size = 9, lead = 12, pad = 5, w2 = W - w1;
    rows.forEach(([a, b], i) => {
      const la = linhas(`**${a}**`, size, w1 - 2 * pad), lb = linhas(i === 0 ? `**${b}**` : b, size, w2 - 2 * pad);
      const h = Math.max(la.length, lb.length, 1) * lead + 2 * pad;
      garante(h);
      if (i === 0) page.drawRectangle({ x: M, y: y - h, width: W, height: h, color: HEAD });
      page.drawRectangle({ x: M, y: y - h, width: w1, height: h, borderColor: LINE, borderWidth: 0.5 });
      page.drawRectangle({ x: M + w1, y: y - h, width: w2, height: h, borderColor: LINE, borderWidth: 0.5 });
      la.forEach((l, k) => desenha(l, M + pad, y - pad - size - k * lead + 2, size, w1, false));
      lb.forEach((l, k) => desenha(l, M + w1 + pad, y - pad - size - k * lead + 2, size, w2, false));
      y -= h;
    });
    y -= 10;
  }

  // ---------- Conteúdo
  const moradaCompleta = [f.morada, [f.codigo_postal, f.localidade].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const contactos = [f.email, f.telefone].filter(Boolean).join(" · ");
  const varios = pags.length > 1;
  const iguais = varios && pags.every((p) => Math.abs(Number(p.valor) - Number(pags[0].valor)) < 0.005);
  const listaPags = pags.map((p) => `${euroMil(Number(p.valor))} a ${dataPT(p.data_prevista)}`).join("; ");

  P("CONTRATO DE PRESTAÇÃO DE SERVIÇOS", { size: 17, lead: 22, bold: true, center: true, after: 4 });
  P("Gestão de Leads · OPERA SA", { size: 10, lead: 14, center: true, color: GREY, after: 2 });
  P("OPERA · You sell. We operate.", { size: 10, lead: 14, center: true, color: GREY, after: 12 });

  H("Identificação das Partes");
  P('**PRIMEIRO OUTORGANTE ("OPERA" ou "Prestador")**');
  P("Denominação social: GRABBINGSTARS, LDA., com sede na Rua Alexandre O'Neill, n.º 68, São Domingos de Rana");
  P("NIPC: 516486900");
  P("Representada por: Fábio de Jesus de Castro Sirgado, na qualidade de sócio gerente");
  P("Contactos: fabio.sirgado@opera-os.com · 915 444 075");
  P('(doravante designada por "OPERA" ou "Prestador de Serviços")', { after: 11 });
  P('**SEGUNDO OUTORGANTE ("Cliente")**');
  if (empresa) {
    P(`Denominação social: ${f.nome.toUpperCase()}`);
    P(`NIPC: ${f.nif}`);
    P(`Sede: ${moradaCompleta}`);
    const cc = f.rep_cc ? `, portador(a) do Cartão de Cidadão n.º ${f.rep_cc}${f.rep_cc_validade ? `, válido até ${dataPT(f.rep_cc_validade)}` : ""}` : "";
    P(`Representada por: ${f.rep_nome}${cc}${f.rep_nif ? `, NIF ${f.rep_nif}` : ""}, na qualidade de ${f.rep_qualidade || "gerente"}`);
  } else {
    P(`Nome: ${f.nome}`);
    P(`NIF: ${f.nif}${f.cc ? ` · Cartão de Cidadão n.º ${f.cc}${f.cc_validade ? `, válido até ${dataPT(f.cc_validade)}` : ""}` : ""}`);
    P(`Morada: ${moradaCompleta}`);
  }
  P(`Contactos: ${contactos}`);
  P(`(doravante designad${empresa ? "a" : "o(a)"} por "Cliente" e, em conjunto com a OPERA, as "Partes")`);

  H("Considerandos");
  P('(a) A OPERA é uma empresa especializada na prestação de serviços de suporte a profissionais e empresas do setor imobiliário, incluindo a gestão das leads que lhes chegam, sob o modelo "Real Estate Operations as a Service";');
  P("(b) O Cliente exerce atividade no setor imobiliário e pretende contratar a OPERA para assumir a gestão das leads que lhe chegam, para que se possa concentrar na angariação, negociação e relação com clientes;");
  P("(c) As Partes pretendem regular os termos e condições em que os referidos serviços serão prestados;");
  P('É livremente celebrado o presente Contrato de Prestação de Serviços ("Contrato"), que se rege pelas cláusulas seguintes.');

  H("Cláusula 1.ª · Objeto");
  P('1.1. O presente Contrato tem por objeto a prestação, pela OPERA ao Cliente, de serviços de gestão de leads ("Serviços"), nos termos descritos na Cláusula 2.ª e no Anexo I (Ficha de Cliente e Condições do Serviço).');
  P("1.2. Os Serviços têm por finalidade apoiar o Cliente no atendimento, qualificação e acompanhamento das leads que lhe chegam, sem que a OPERA assuma a qualidade de mediadora, angariadora ou parte nas transações imobiliárias, mantendo o Cliente total responsabilidade pela atividade de mediação imobiliária, nos termos da legislação aplicável, designadamente a Lei n.º 15/2013, de 8 de fevereiro.");

  H("Cláusula 2.ª · Descrição dos Serviços");
  P("2.1. No âmbito da gestão de leads, a OPERA prestará ao Cliente os seguintes serviços:");
  BL("Receção das leads que chegam ao Cliente por qualquer canal inbound, com registo na plataforma de gestão de leads da OPERA (OPERA Leads);");
  BL("Contacto telefónico às leads, em nome do Cliente, dentro do horário definido no Anexo I;");
  BL("Qualificação das leads, designadamente tipo de imóvel (a comprar ou vender), zona, orçamento, prazo e capacidade financeira declarada;");
  BL("Agendamento de visitas e reuniões diretamente na agenda do Cliente, desde que esta esteja partilhada com a OPERA e atualizada;");
  BL("Follow ups às leads ainda não convertidas;");
  BL("Registo dos contactos realizados, das qualificações e das respetivas notas no OPERA Leads.");
  P("2.2. O serviço incide exclusivamente sobre as leads geradas pelo Cliente ou para o Cliente, não incluindo prospeção a frio, geração de leads nem gestão de campanhas publicitárias.", { before: 2 });
  P("2.3. A OPERA não negoceia, não apresenta propostas nem presta informação vinculativa sobre imóveis, preços ou condições de negócio. A informação comercial transmitida às leads é fornecida e validada pelo Cliente.");
  P("2.4. A OPERA assume uma obrigação de meios, não garantindo um número mínimo de leads qualificadas, visitas agendadas ou negócios concretizados, os quais dependem do volume e da qualidade das leads recebidas.");
  P("2.5. A gestão das leads é feita no OPERA Leads, plataforma da titularidade da OPERA. Durante a vigência do Contrato, o Cliente tem acesso, com utilizador próprio, às suas leads, ao histórico de contactos e às qualificações, podendo acompanhá-las em tempo real.");
  P("2.6. Não estão incluídos no presente Contrato serviços de gestão processual, documental ou de suporte jurídico, os quais, se solicitados pelo Cliente, poderão ser contratados à parte, nos termos da Cláusula 5.3.");

  H("Cláusula 3.ª · Modelo de Funcionamento");
  P("3.1. A gestão de leads decorre de forma contínua, sem necessidade de pedido individual, a partir da entrada de cada lead inbound, seja qual for o canal de origem.");
  P("3.2. A OPERA disponibiliza ao Cliente um ponto de contacto para o acompanhamento do serviço, alinhamento da informação comercial a transmitir às leads e resolução de qualquer questão relacionada com a prestação dos Serviços.");
  P("3.3. A OPERA atuará como equipa externa de gestão de leads do Cliente, sem prejuízo da autonomia técnica e organizativa de cada uma das Partes, não se estabelecendo entre elas qualquer relação de subordinação jurídica, societária ou laboral.");

  H("Cláusula 4.ª · Duração e Renovação");
  P(`4.1. O presente Contrato entra em vigor na data indicada no Anexo I ("Data de Início") e vigora por um período de ${nExt(meses)} ${meses === 1 ? "mês" : "meses"}.`);
  P(`4.2. O Contrato renova automaticamente por períodos sucessivos de ${nExt(meses)} ${meses === 1 ? "mês" : "meses"}, salvo se qualquer das Partes comunicar à outra, por escrito, a sua intenção de não renovação, com uma antecedência mínima de 15 (quinze) dias em relação ao termo do período em curso.`);

  const periodo = `${nExt(meses)} ${meses === 1 ? "mês" : "meses"}`;
  H("Cláusula 5.ª · Preço e Condições de Pagamento");
  P(`5.1. Como contrapartida pelos Serviços prestados em cada período de ${periodo}, o Cliente pagará à OPERA o seguinte preço ("Preço"):`);
  BL(`Valor: ${euroMil(total)} (${euroExtenso(total)}), acrescido de IVA à taxa legal em vigor, por cada período de ${periodo};`);
  if (!varios) BL("Pagamento: integral, na Data de Início e, em caso de renovação, até ao primeiro dia de cada novo período;");
  else if (iguais) BL(`Pagamento: em ${nExtF(pags.length)} prestações, iguais e sucessivas, de ${euroMil(Number(pags[0].valor))} (${euroExtenso(Number(pags[0].valor))}) cada, acrescidas de IVA à taxa legal em vigor, com vencimento em ${pags.map((p) => dataPT(p.data_prevista)).join(", ").replace(/, ([^,]*)$/, " e $1")};`);
  else BL(`Pagamento: em ${nExtF(pags.length)} pagamentos, acrescidos de IVA à taxa legal em vigor, nos seguintes valores e datas: ${listaPags};`);
  BL("Meio de pagamento: transferência bancária para o IBAN PT50 0033 0000 4568 8726 8920 5.");
  P("5.2. O âmbito dos serviços incluídos no Preço está detalhado no Anexo I.", { before: 2 });
  P("5.3. Serviços não incluídos no âmbito definido no Anexo I, se solicitados pelo Cliente, poderão ser prestados mediante orçamento e acordo prévio e escrito entre as Partes.");
  P(`5.4. Em caso de atraso no pagamento${varios ? " de qualquer prestação" : ""} superior a 10 (dez) dias úteis após a data de vencimento, a OPERA poderá: (i) cobrar juros de mora à taxa legal em vigor para transações comerciais; e/ou (ii) suspender a prestação dos Serviços, mediante notificação prévia ao Cliente com 5 (cinco) dias úteis de antecedência.`);
  P("5.5. O Preço pode ser atualizado pela OPERA para os períodos de renovação, mediante comunicação ao Cliente com uma antecedência mínima de 30 (trinta) dias em relação ao termo do período em curso, podendo o Cliente, nesse caso, comunicar a sua oposição à renovação.");
  P(varios
    ? `5.6. O Preço de cada período de ${periodo} é devido na totalidade, ainda que pago em prestações, e não é reembolsável em caso de cessação antecipada por iniciativa do Cliente, salvo resolução por incumprimento imputável à OPERA. Nesse caso, vencem-se de imediato as prestações em falta relativas ao período em curso.`
    : "5.6. O Preço de cada período é devido na totalidade e não é reembolsável em caso de cessação antecipada por iniciativa do Cliente, salvo resolução por incumprimento imputável à OPERA.");

  H("Cláusula 6.ª · Obrigações da OPERA");
  P("A OPERA fica obrigada a:");
  BL("Prestar os Serviços com diligência, competência técnica e profissionalismo, de acordo com as boas práticas do setor;");
  BL("Contactar as leads com cortesia e de acordo com a informação comercial fornecida pelo Cliente;");
  BL("Registar no OPERA Leads os contactos realizados, as qualificações e os agendamentos efetuados, mantendo-os acessíveis ao Cliente;");
  BL("Assegurar a confidencialidade da informação e dos dados pessoais tratados no âmbito da prestação dos Serviços, nos termos da Cláusula 8.ª;");
  BL("Manter um ponto de contacto responsável pelo acompanhamento da relação com o Cliente;");
  BL("Comunicar ao Cliente, de forma tempestiva, qualquer situação relevante para a boa condução do serviço.");

  H("Cláusula 7.ª · Obrigações do Cliente");
  P("O Cliente fica obrigado a:");
  BL("Fornecer, de forma tempestiva, verdadeira e completa, toda a informação necessária à prestação dos Serviços;");
  BL("Manter a sua licença ou registo profissional (AMI, quando aplicável, ou vínculo válido a mediadora licenciada) em vigor durante toda a duração do Contrato;");
  BL("Proceder ao pagamento pontual do Preço e demais valores devidos nos termos deste Contrato;");
  BL("Garantir que as leads foram recolhidas licitamente e informadas de que podem ser contactadas por telefone, em seu nome, por prestadores de serviços;");
  BL("Fornecer à OPERA a informação comercial necessária sobre os imóveis e serviços a apresentar às leads;");
  BL("Assegurar que as suas leads inbound chegam à OPERA, pelos meios técnicos acordados entre as Partes;");
  BL("Manter a sua agenda partilhada com a OPERA e atualizada, no caso de agendamento de visitas e reuniões;");
  BL("Assumir integral responsabilidade legal, deontológica e fiscal pela atividade de mediação e consultoria imobiliária por si exercida, incluindo perante clientes, entidades reguladoras e terceiros, não sendo tal responsabilidade transferida para a OPERA.");

  H("Cláusula 8.ª · Confidencialidade e Proteção de Dados");
  P("8.1. As Partes ficam obrigadas a manter confidencial toda a informação de natureza confidencial a que tenham acesso no âmbito da execução do presente Contrato, não a divulgando a terceiros nem a utilizando para fins distintos dos previstos neste Contrato, salvo consentimento prévio e escrito da outra Parte ou obrigação legal de divulgação.");
  P("8.2. No âmbito da gestão de leads, a OPERA trata dados pessoais de leads e potenciais clientes do Cliente, atuando como subcontratante nos termos do artigo 28.º do Regulamento (UE) 2016/679 (RGPD), conforme o Acordo de Tratamento de Dados constante do Anexo II, que faz parte integrante do presente Contrato.");
  P("8.3. As Partes assumem o compromisso de cumprir a legislação aplicável em matéria de proteção de dados pessoais, incluindo o RGPD e a Lei n.º 58/2019, de 8 de agosto, adotando as medidas técnicas e organizativas adequadas à proteção dos dados tratados.");
  P("8.4. As obrigações de confidencialidade previstas nesta cláusula permanecem em vigor durante a vigência do Contrato e por um período de 3 (três) anos após a sua cessação, seja qual for o motivo desta.");

  H("Cláusula 9.ª · Suspensão, Resolução e Cessação");
  P("9.1. Qualquer das Partes pode resolver o presente Contrato, com efeitos imediatos, mediante comunicação escrita à outra Parte, em caso de incumprimento grave ou reiterado das obrigações previstas neste Contrato, quando tal incumprimento não seja sanado no prazo de 15 (quinze) dias após interpelação escrita para o efeito.");
  P(`9.2. O Cliente pode fazer cessar o Contrato antes do termo do período em curso, mediante comunicação escrita à OPERA com uma antecedência mínima de 30 (trinta) dias, sem direito a reembolso do Preço já pago${varios ? " e mantendo-se devidas as prestações relativas ao período em curso" : " ou vencido"}, nos termos da Cláusula 5.6.`);
  P("9.3. A OPERA pode suspender a prestação dos Serviços em caso de incumprimento no pagamento do Preço, nos termos da Cláusula 5.4, sem que tal suspensão constitua incumprimento do presente Contrato.");
  P("9.4. Com a cessação do Contrato, seja qual for o motivo, as Partes cooperam com lealdade para assegurar uma passagem ordenada das leads em acompanhamento, salvo em caso de resolução por incumprimento imputável ao Cliente.");
  P("9.5. Com a cessação do Contrato, cessa o acesso do Cliente ao OPERA Leads. A pedido do Cliente, a OPERA disponibiliza-lhe a exportação das suas leads e respetivo histórico num formato de uso corrente. Os dados das leads do Cliente são conservados durante 6 (seis) meses após a cessação, para esse efeito, e eliminados findo esse prazo, salvo obrigação legal de conservação.");

  H("Cláusula 10.ª · Responsabilidade");
  P("10.1. A OPERA responde pelos danos diretos causados ao Cliente em consequência de incumprimento culposo das obrigações previstas neste Contrato, nos termos gerais de direito.");
  P("10.2. A OPERA não é responsável por danos indiretos ou lucros cessantes, nem pela veracidade e exatidão da informação fornecida pelo Cliente, pelas leads ou por terceiros.");
  P("10.3. A OPERA não assume, em caso algum, a posição de mediadora imobiliária, angariadora ou parte nas transações imobiliárias em que o Cliente intervenha, nem qualquer responsabilidade que, por lei ou por contrato, seja exclusiva do Cliente enquanto profissional do setor.");

  H("Cláusula 11.ª · Propriedade Intelectual e Titularidade dos Dados");
  P('11.1. A marca "OPERA", a plataforma OPERA Leads, os processos, metodologias, guiões, modelos e demais materiais desenvolvidos ou utilizados pela OPERA na prestação dos Serviços são e permanecem propriedade exclusiva da OPERA ou dos seus licenciantes, não conferindo o presente Contrato ao Cliente qualquer direito sobre os mesmos.');
  P("11.2. Os dados das leads do Cliente, incluindo contactos e histórico, pertencem ao Cliente, enquanto responsável pelo tratamento, independentemente de estarem alojados no OPERA Leads.");

  H("Cláusula 12.ª · Natureza da Relação e Não Exclusividade");
  P("12.1. A relação entre as Partes é de prestação de serviços, não constituindo, em caso algum, contrato de trabalho, contrato de agência, mandato com representação, associação em participação ou qualquer outra forma de relação societária ou laboral.");
  P("12.2. Salvo acordo em contrário constante do Anexo I, o presente Contrato não tem natureza de exclusividade, podendo cada uma das Partes prestar serviços ou colaborar com terceiros.");

  H("Cláusula 13.ª · Comunicações");
  P("13.1. Todas as comunicações entre as Partes no âmbito deste Contrato deverão ser efetuadas por escrito, para os endereços de email indicados na identificação das Partes, sendo consideradas eficazes na data do respetivo envio, salvo prova de não entrega.");
  P("13.2. Qualquer alteração aos dados de contacto de qualquer das Partes deverá ser comunicada à outra Parte no prazo de 10 (dez) dias a contar da respetiva alteração.");

  H("Cláusula 14.ª · Disposições Finais");
  P("14.1. O presente Contrato, incluindo os seus Anexos, constitui a totalidade do acordo entre as Partes relativamente ao seu objeto, substituindo quaisquer entendimentos, propostas ou acordos anteriores, escritos ou verbais.");
  P("14.2. Qualquer alteração ao presente Contrato só será válida se reduzida a escrito e assinada por ambas as Partes.");
  P("14.3. A eventual invalidade ou ineficácia de qualquer cláusula deste Contrato não afeta a validade das restantes, devendo as Partes substituir a cláusula inválida por outra que mais se aproxime do efeito pretendido.");
  P("14.4. A tolerância de qualquer das Partes quanto ao incumprimento, pela outra, de qualquer obrigação prevista neste Contrato não constitui renúncia ao direito de exigir o seu cumprimento.");

  H("Cláusula 15.ª · Lei Aplicável e Resolução de Litígios");
  P("15.1. O presente Contrato é regido pela lei portuguesa.");
  P("15.2. As Partes procurarão resolver amigavelmente qualquer litígio emergente do presente Contrato. Não sendo possível a resolução amigável no prazo de 30 (trinta) dias, é competente o foro da comarca de Lisboa, com expressa renúncia a qualquer outro.");

  // Assinaturas (bloco inteiro na mesma página)
  garante(190);
  y -= 10;
  P("O presente Contrato é celebrado em formato eletrónico e assinado digitalmente pelas Partes, considerando-se celebrado na data da última assinatura digital aposta. Cada uma das Partes fica com um exemplar do documento assinado.", { after: 18 });
  const col2 = M + W / 2;
  const assin = (x: number, linhasTxt: string[]) => { let yy = y; linhasTxt.forEach((t, i) => { if (i === 2) yy -= 48; page.drawText(t, { x, y: yy - 9, size: 9, font: i === 0 ? B : R, color: DARK }); yy -= 16; }); return yy; };
  const qual = empresa ? `Qualidade: ${(f.rep_qualidade || "gerente").replace(/^./, (m) => m.toUpperCase())} da ${f.nome}` : "Qualidade: Cliente";
  const quebra = (s: string) => { const ls = linhas(s, 9, W / 2 - 10); return ls.map((l) => l.map((t) => t.t).join("")); };
  const y1 = assin(M, ["Pela OPERA", "Assinatura digital:", "Nome: Fábio de Jesus de Castro Sirgado", "Qualidade: Sócio gerente"]);
  const y2 = assin(col2, ["Pelo Cliente", "Assinatura digital:", `Nome: ${empresa ? f.rep_nome : f.nome}`, ...quebra(qual)]);
  y = Math.min(y1, y2) - 10;

  // Anexo I
  novaPagina();
  P("Anexo I · Ficha de Cliente e Condições do Serviço", { size: 11.5, lead: 16, bold: true, after: 6 });
  H3("1. Identificação do Cliente");
  tabela([
    ["Campo", "Preenchimento"],
    [empresa ? "Denominação" : "Nome", f.nome],
    [empresa ? "NIPC" : "NIF", f.nif],
    [empresa ? "Sede" : "Morada", moradaCompleta],
    ["Tipo de Cliente", empresa ? "Empresa" : "Particular"],
    ["Licença AMI", f.ami ? `AMI n.º ${f.ami}` : "Não aplicável"],
  ]);
  H3("2. Serviço incluído no Preço");
  tabela([["Área", "Âmbito"], ["Gestão de leads (OPERA SA)", "Conforme Cláusula 2.ª"]]);
  H3("3. Condições da Gestão de Leads");
  tabela([
    ["Campo", "Preenchimento"],
    ["Plataforma de gestão de leads", "OPERA Leads, com acesso do Cliente por utilizador próprio"],
    ["Horário de contacto às leads", "Dias úteis, das 9h30 às 18h30"],
  ]);
  H3("4. Condições Comerciais");
  tabela([
    ["Campo", "Preenchimento"],
    ["Preço", `${euroMil(total)} + IVA por cada período de ${meses} ${meses === 1 ? "mês" : "meses"}`],
    ["Modalidade de pagamento", !varios ? `Pagamento integral na Data de Início (${dataPT(pags[0].data_prevista)})`
      : iguais ? `${pags.length} prestações de ${euroMil(Number(pags[0].valor))} + IVA, com vencimento em ${pags.map((p) => dataPT(p.data_prevista)).join(", ")}`
      : `${pags.length} pagamentos + IVA: ${listaPags}`],
    ["Data de início", dataLonga(c.data_inicio)],
    ["Prazo inicial", `${meses} ${meses === 1 ? "mês" : "meses"}`],
  ]);

  // Anexo II
  novaPagina();
  P("Anexo II · Acordo de Tratamento de Dados (RGPD)", { size: 11.5, lead: 16, bold: true, after: 6 });
  P("Nos termos do artigo 28.º do Regulamento (UE) 2016/679 (RGPD), as Partes acordam que, na medida em que a OPERA trate dados pessoais por conta do Cliente no âmbito da prestação dos Serviços, são aplicáveis os seguintes termos:");
  BL("A OPERA trata os dados pessoais exclusivamente de acordo com as instruções documentadas do Cliente e para os fins previstos neste Contrato;");
  BL("A OPERA assegura que as pessoas autorizadas a tratar os dados pessoais assumiram um compromisso de confidencialidade;");
  BL("A OPERA adota as medidas técnicas e organizativas adequadas para garantir um nível de segurança adequado ao risco;");
  BL("A OPERA não subcontrata o tratamento de dados a terceiros sem autorização prévia do Cliente, ficando desde já concedida autorização geral para os fornecedores de alojamento e infraestrutura do OPERA Leads, com dados alojados na União Europeia, e para os fornecedores de serviços de telefonia necessários ao contacto com as leads, sendo o Cliente informado de qualquer alteração;");
  BL("A OPERA apoia o Cliente no cumprimento das obrigações relativas ao exercício dos direitos dos titulares dos dados e às obrigações previstas nos artigos 32.º a 36.º do RGPD;");
  BL("No termo da prestação dos Serviços, a OPERA disponibiliza ao Cliente, a seu pedido, a exportação dos dados pessoais e apaga-os no prazo de 6 (seis) meses após a cessação, salvo obrigação legal de conservação;");
  BL("A OPERA disponibiliza ao Cliente toda a informação necessária para demonstrar o cumprimento das obrigações previstas no artigo 28.º do RGPD, permitindo e contribuindo para auditorias, incluindo inspeções, realizadas pelo Cliente ou por outro auditor por este mandatado.");
  H3("Categorias de titulares e dados tratados");
  tabela([
    ["Elemento", "Descrição"],
    ["Titulares", "Leads e potenciais clientes do Cliente"],
    ["Dados", "Identificação, contacto, preferências imobiliárias e capacidade financeira declarada"],
    ["Finalidades", "Atendimento, qualificação, agendamento e acompanhamento de leads por conta do Cliente"],
    ["Prazo de conservação", "Duração do Contrato e 6 (seis) meses após a sua cessação, sem prejuízo de obrigações legais de conservação"],
  ], 128);

  // Rodapé em todas as páginas
  const pages = doc.getPages();
  const rod = opts.rodape ?? `OPERA · Contrato de Prestação de Serviços · Gestão de Leads · ${f.nome}`;
  pages.forEach((pg, i) => {
    pg.drawText(rod, { x: M, y: 34, size: 7.5, font: R, color: GREY });
    const t = `Página ${i + 1} de ${pages.length}`;
    pg.drawText(t, { x: A4[0] - M - R.widthOfTextAtSize(t, 7.5), y: 34, size: 7.5, font: R, color: GREY });
  });
  return await doc.save();
}
