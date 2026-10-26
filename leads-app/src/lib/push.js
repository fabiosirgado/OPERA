import { sb } from "../supabase.js";

// App instalável e notificações no telemóvel (web push). O service worker está em public/sw.js.
const SW_URL = "/leads/sw.js";

export const pushSupported = () =>
  typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

// iPhone e iPad (o iPad recente apresenta-se como Mac com ecrã tátil).
export const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

// Aberta a partir do ícone no ecrã principal, sem a barra do browser.
export const isStandalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;

// Android e computador: o browser oferece instalar; guardamos o pedido para o botão "Instalar a app".
let installPrompt = null;
export const canInstall = () => Boolean(installPrompt) && !isStandalone();
export async function install() {
  if (!installPrompt) return false;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  window.dispatchEvent(new Event("opera-instalar"));
  return outcome === "accepted";
}

export function registerServiceWorker() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e;
    window.dispatchEvent(new Event("opera-instalar"));
  });
  if (!("serviceWorker" in navigator) || import.meta.env.DEV) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(SW_URL, { scope: "/leads/" }).catch(() => { /* sem app instalável neste browser */ });
  });
}

const fromBase64Url = (s) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

async function registration() {
  return (await navigator.serviceWorker.getRegistration("/leads/")) || navigator.serviceWorker.register(SW_URL, { scope: "/leads/" });
}

async function save(sub) {
  const j = sub.toJSON();
  const { error } = await sb.rpc("leads_push_subscribe", {
    p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_user_agent: navigator.userAgent,
  });
  if (error) throw new Error("Não foi possível ativar as notificações. Tente de novo.");
}

// Estado neste dispositivo: "sem_suporte", "instalar" (iPhone fora da app), "bloqueadas", "ativas" ou "desligadas".
export async function pushState() {
  if (!pushSupported()) return isIOS() && !isStandalone() ? "instalar" : "sem_suporte";
  if (Notification.permission === "denied") return "bloqueadas";
  const reg = await navigator.serviceWorker.getRegistration("/leads/");
  const sub = await reg?.pushManager.getSubscription();
  if (sub && Notification.permission === "granted") {
    // Volta a ligar este dispositivo à pessoa com sessão (outra pessoa pode ter usado o mesmo browser).
    await save(sub).catch(() => {});
    return "ativas";
  }
  return "desligadas";
}

export async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "bloqueadas" : "desligadas";
  const { data: key, error } = await sb.rpc("leads_push_public_key");
  if (error || !key) throw new Error("As notificações ainda não estão prontas no servidor. Tente daqui a uns minutos.");
  const reg = await registration();
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(key) });
  await save(sub);
  return "ativas";
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration("/leads/");
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return "desligadas";
  await sb.rpc("leads_push_unsubscribe", { p_endpoint: sub.endpoint });
  await sub.unsubscribe().catch(() => {});
  return "desligadas";
}

// Ao terminar sessão: este dispositivo deixa de receber os avisos desta pessoa (a autorização do browser fica).
export async function forgetDevice() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration("/leads/");
    const sub = await reg?.pushManager.getSubscription();
    if (sub) await sb.rpc("leads_push_unsubscribe", { p_endpoint: sub.endpoint });
  } catch { /* sem notificações neste dispositivo */ }
}
