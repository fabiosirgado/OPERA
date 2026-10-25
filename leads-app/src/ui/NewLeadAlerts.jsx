import { useEffect, useState } from "react";

// Avisos de lead nova, no canto do ecrã, até serem abertos ou fechados. Com som curto e, se o browser
// deixar, também um aviso do sistema (para quando o separador está em segundo plano).
const canNotify = () => typeof window !== "undefined" && "Notification" in window;

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine"; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.45);
    o.onended = () => ctx.close();
  } catch { /* sem som */ }
}

// alerts: [{ id, name, client, source }]
export default function NewLeadAlerts({ alerts, onOpen, onClose }) {
  const [perm, setPerm] = useState(() => (canNotify() ? Notification.permission : "denied"));
  const last = alerts[alerts.length - 1];

  useEffect(() => {
    if (!last) return;
    beep();
    if (perm === "granted" && document.visibilityState !== "visible") {
      try {
        const n = new Notification(`Nova lead · ${last.name}`, { body: [last.client, last.source].filter(Boolean).join(" · "), tag: last.id });
        n.onclick = () => { window.focus(); onOpen(last.id); n.close(); };
      } catch { /* o browser não deixou */ }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last?.id]);

  if (!alerts.length) return null;
  return (
    <div className="alerts" role="region" aria-label="Leads novas" aria-live="polite">
      {alerts.slice(-4).map((a) => (
        <div key={a.id} className="alert">
          <span className="nova">Nova</span>
          <div className="alert-txt">
            <b>{a.name}</b>
            <small>{[a.client, a.source].filter(Boolean).join(" · ")}</small>
          </div>
          <button type="button" className="btn xs primary" onClick={() => onOpen(a.id)}>Abrir</button>
          <button type="button" className="x" aria-label={`Fechar o aviso de ${a.name}`} onClick={() => onClose(a.id)}>×</button>
        </div>
      ))}
      {alerts.length > 1 && <button type="button" className="link" onClick={() => onClose("*")}>Fechar todos</button>}
      {perm === "default" && (
        <button type="button" className="link" onClick={() => Notification.requestPermission().then(setPerm)}>
          Avisar também quando a OPERA Leads está noutro separador
        </button>
      )}
    </div>
  );
}
