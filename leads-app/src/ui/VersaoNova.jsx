import { useEffect, useState } from "react";

// Versão nova publicada: um separador aberto continua com a versão antiga até ser recarregado (e uma versão antiga
// com um erro pode pesar na base de dados para toda a gente, como aconteceu com a Fila a 2026-11-20).
// A cada 5 minutos, e ao voltar à janela, compara o ficheiro principal da página publicada com o desta página:
// se mudou, recarrega sozinho quando o separador está escondido; com o separador à vista, mostra um aviso.
const SCRIPT = /src="([^"]*\/assets\/index-[^"]+\.js)"/;

export default function VersaoNova() {
  const [nova, setNova] = useState(false);
  useEffect(() => {
    const atual = document.querySelector('script[type="module"][src*="/assets/index-"]')?.getAttribute("src");
    if (!atual) return undefined; // em desenvolvimento não há ficheiro com nome fixo
    let mudou = false;
    const ver = async () => {
      if (mudou) { if (document.visibilityState === "hidden") window.location.reload(); return; }
      try {
        const html = await (await fetch(`/leads/?versao=${Date.now()}`, { cache: "no-store" })).text();
        const publicada = html.match(SCRIPT)?.[1];
        if (!publicada || publicada === atual) return;
        mudou = true;
        if (document.visibilityState === "hidden") window.location.reload();
        else setNova(true);
      } catch { /* sem rede: tenta outra vez mais tarde */ }
    };
    const t = setInterval(ver, 5 * 60 * 1000);
    document.addEventListener("visibilitychange", ver);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", ver); };
  }, []);
  if (!nova) return null;
  return (
    <div role="status" style={{ position: "fixed", left: "50%", bottom: 16, transform: "translateX(-50%)", zIndex: 1000,
      display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", maxWidth: "calc(100vw - 32px)",
      background: "#0B1B3A", color: "#fff", borderRadius: 12, padding: "12px 16px", boxShadow: "0 8px 24px rgba(11,27,58,.25)", fontSize: 14 }}>
      <span>Há uma versão nova do Leads.</span>
      <button type="button" className="btn sm" onClick={() => window.location.reload()}>Atualizar</button>
    </div>
  );
}
