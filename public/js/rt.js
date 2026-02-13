export async function requireMe() {
  const r = await fetch("/api/me", { credentials: "same-origin" });
  if (!r.ok) { location.href = "/login.html"; throw new Error("not authed"); }
  const j = await r.json();
  return j.user;
}
export function setupRealtime({ scope, onStatus, onPlayers, onChat, onWallet, onGame, onRTC }){
  const socket = window.io({ withCredentials: true });
  socket.on("connect", () => socket.emit("presence", { scope }));
  socket.on("status", (s) => onStatus?.(s));
  socket.on("players:update", (p) => onPlayers?.(p));
  socket.on("chat:msg", (m) => onChat?.(m));
  socket.on("wallet:update", (w) => onWallet?.(w));
  socket.on("game:event", (e) => onGame?.(e));
  socket.on("rtc:signal", (p) => onRTC?.(p));
  function setScope(nextScope){ socket.emit("presence", { scope: nextScope }); }
  function sendChat(text, chatScope){ socket.emit("chat:send", { scope: chatScope || scope, text }); }
  function emit(event, payload){ socket.emit(event, payload); }
  return { socket, setScope, sendChat, emit };
}
