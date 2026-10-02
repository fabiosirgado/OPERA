// Calcula a poupança potencial da OPERA face a uma estrutura interna.
// Os valores da OPERA ficam apenas aqui, no servidor, e nunca chegam ao browser.
// Devolve sempre intervalos arredondados, nunca o valor exato.

const OPERA = { bo: 750, sa: 850, bundle: 1500 }; // €/mês, referência interna

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let body;
  try { body = await req.json(); } catch { return json({ error: "invalid" }, 400); }

  const needBO = !!body.needBO, needSA = !!body.needSA;
  const interno = Number(body.interno);
  if (!(needBO || needSA) || !Number.isFinite(interno) || interno < 500 || interno > 20000) {
    return json({ error: "invalid" }, 400);
  }

  const opera = needBO && needSA ? OPERA.bundle : needBO ? OPERA.bo : OPERA.sa;
  const diff = interno - opera;
  if (diff <= 0) return json({ pctMin: 0, pctMax: 0, anualMin: 0, anualMax: 0 });

  const pct = diff / interno * 100;
  const pctMin = Math.floor(pct / 5) * 5;
  const anual = diff * 12;
  const anualMin = Math.floor(anual / 1000) * 1000;

  return json({ pctMin, pctMax: pctMin + 5, anualMin, anualMax: anualMin + 1000 });
};

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
