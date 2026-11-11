// Festa quando a OPERA fecha um negócio: confetis no ecrã e som de caixa registadora ("cha-ching").
// Sem bibliotecas: um canvas por cima de tudo durante uns segundos e uma gravação curta.

const CORES = ["#2B63E8", "#15803D", "#F59E0B", "#E11D48", "#7C3AED", "#06B6D4", "#FACC15"];

export function confetti(ms = 4000) {
  if (typeof document === "undefined") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const c = document.createElement("canvas");
  c.setAttribute("aria-hidden", "true");
  c.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:200";
  document.body.appendChild(c);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth, h = window.innerHeight;
  c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext("2d");
  g.scale(dpr, dpr);
  // Duas rajadas, dos cantos de baixo para o meio, e uma chuva por cima.
  const ps = [];
  const rajada = (x, dir) => {
    for (let i = 0; i < 90; i++) {
      const a = (-Math.PI / 2) + dir * (Math.random() * 0.6 + 0.15);
      const v = 11 + Math.random() * 9;
      ps.push({ x, y: h + 10, vx: Math.cos(a) * v, vy: Math.sin(a) * v, ...forma() });
    }
  };
  const forma = () => ({ cor: CORES[(Math.random() * CORES.length) | 0], s: 6 + Math.random() * 6, r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.3, t: Math.random() < 0.3 ? "c" : "q" });
  rajada(0, 1); rajada(w, -1);
  for (let i = 0; i < 80; i++) ps.push({ x: Math.random() * w, y: -20 - Math.random() * h * 0.5, vx: (Math.random() - 0.5) * 2, vy: 2 + Math.random() * 3, ...forma() });
  const t0 = performance.now();
  const passo = (t) => {
    const fim = t - t0 > ms;
    g.clearRect(0, 0, w, h);
    g.globalAlpha = fim ? 1 : Math.min(1, (ms - (t - t0)) / 600 + 0.15);
    for (const p of ps) {
      p.vy += 0.25; p.vx *= 0.99; p.vy *= 0.99;
      p.x += p.vx; p.y += p.vy; p.r += p.vr;
      g.save(); g.translate(p.x, p.y); g.rotate(p.r); g.fillStyle = p.cor;
      if (p.t === "c") { g.beginPath(); g.arc(0, 0, p.s / 2.4, 0, 6.28); g.fill(); }
      else g.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2 * (0.4 + Math.abs(Math.sin(p.r))));
      g.restore();
    }
    if (!fim) requestAnimationFrame(passo); else c.remove();
  };
  requestAnimationFrame(passo);
}

// "Cha-ching" quando se fecha um negócio: gravação "Cha ching - new purchase" de cartoon_music (Pixabay, licença
// Pixabay Content License: uso livre, sem créditos obrigatórios), em public/sons/.
let audio = null;
export function somDinheiro() {
  try {
    if (!audio) { audio = new Audio(`${import.meta.env.BASE_URL}sons/negocio-fechado.mp3`); audio.preload = "auto"; audio.volume = 0.8; }
    audio.currentTime = 0;
    audio.play()?.catch(() => { /* o browser não deixou tocar sem um clique antes */ });
  } catch { /* sem som */ }
}
