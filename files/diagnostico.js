// Netlify Function: proxy seguro para a API da Anthropic.
//
// Porque isto existe: a ferramenta de diagnóstico (blueprint-flow.html)
// corre no browser do visitante. Chamar a API da Anthropic diretamente
// do browser exigiria expor a chave de API no código-fonte da página,
// visível a qualquer pessoa que abra as ferramentas de developer do
// browser — isso é um risco de segurança sério (a tua chave pode ser
// roubada e usada por terceiros, gerando custos na tua conta).
//
// Esta função corre do lado do servidor (na infraestrutura do Netlify),
// onde a chave fica escondida numa variável de ambiente, nunca exposta
// ao browser.
//
// --- Como ativar ---
// 1. Cria uma chave de API em https://console.anthropic.com/settings/keys
// 2. No painel do Netlify: Project configuration > Environment variables
//    > Add a variable
//    Nome:  ANTHROPIC_API_KEY
//    Valor: a tua chave (começa por "sk-ant-...")
// 3. Volta a publicar o site (novo deploy) para a variável ficar ativa.
// 4. A partir daí, o diagnóstico em blueprint-flow.html passa a usar
//    automaticamente a IA real em vez do gerador local de recurso.
//
// Nota: isto tem custos associados à tua conta Anthropic, cobrados por
// utilização (por diagnóstico gerado). Consulta os preços em
// https://www.anthropic.com/pricing antes de ativar em produção.

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 501,
      body: JSON.stringify({
        error: "ANTHROPIC_API_KEY não está configurada nas variáveis de ambiente do Netlify.",
      }),
    };
  }

  try {
    const { model, max_tokens, system, messages } = JSON.parse(event.body);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model || "claude-sonnet-5",
        max_tokens: max_tokens || 1000,
        system,
        messages,
      }),
    });

    const data = await response.json();

    return {
      statusCode: response.status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
