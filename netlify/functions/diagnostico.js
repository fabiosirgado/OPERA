// Netlify Function: proxy seguro para a API da Anthropic.
//
// VERSÃO DE DIAGNÓSTICO: esta versão tem linhas extra de "console.log"
// para aparecerem nos Function logs do Netlify e ajudarem a perceber
// porque é que uma chamada pode estar a falhar. Podes remover estas
// linhas mais tarde, quando tudo estiver a funcionar bem.

exports.handler = async function (event) {
  console.log("diagnostico: pedido recebido, método =", event.httpMethod);

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  console.log("diagnostico: ANTHROPIC_API_KEY está definida?", !!apiKey, apiKey ? `(começa por ${apiKey.slice(0, 7)}...)` : "");

  if (!apiKey) {
    console.log("diagnostico: a terminar com erro 501 — chave em falta.");
    return {
      statusCode: 501,
      body: JSON.stringify({
        error: "ANTHROPIC_API_KEY não está configurada nas variáveis de ambiente do Netlify.",
      }),
    };
  }

  try {
    const { model, max_tokens, system, messages } = JSON.parse(event.body);
    console.log("diagnostico: a chamar a Anthropic com o modelo", model || "claude-sonnet-5");

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

    console.log("diagnostico: resposta da Anthropic, status =", response.status);

    const data = await response.json();

    if (!response.ok) {
      console.log("diagnostico: corpo do erro da Anthropic:", JSON.stringify(data));
    } else {
      console.log("diagnostico: chamada bem sucedida.");
    }

    return {
      statusCode: response.status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    };
  } catch (err) {
    console.log("diagnostico: excepção apanhada:", err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
