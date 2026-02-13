import { requireMe, setupRealtime } from "/js/rt.js";
import { escapeHtml, commaTC } from "/js/util.js";

// CACHE BUSTER: This forces the browser to load fresh files every time you deploy
const v = Date.now(); 

const routes = {
  lobby:    { title:"Lobby", scope:"lobby", frame:`/games/lobby.html?v=${v}`, panel:"Lobby" },
  dice:     { title:"Color Dice", scope:"dice", frame:`/games/dice.html?v=${v}`, panel:"Color Dice" },
  roulette: { title:"Roulette", scope:"roulette", frame:`/games/roulette.html?v=${v}`, panel:"Roulette" },
  duel:     { title:"Duel Arena", scope:"duel", frame:`/games/duel.html?v=${v}`, panel:"Duel Arena" },
  support:  { title:"Support", scope:"lobby", frame:`/games/support.html?v=${v}`, panel:"Support" },
  staff:    { title:"Admin / Mod", scope:"lobby", frame:`/games/staff.html?v=${v}`, panel:"Staff" }
};

const me = await requireMe();
const $ = (id)=>document.getElementById(id);

$("meName").textContent = me.username;
$("meRole").textContent = me.role;
$("meCredits").textContent = commaTC(me.credits);

const isStaff = me.role === "Admin" || me.role === "Moderator";
if(isStaff){ $("staffSection").style.display=""; $("btnStaff").style.display=""; }

$("btnLogout").addEventListener("click", async ()=>{
  await fetch("/api/logout", { method:"POST", credentials:"same-origin" }).catch(()=>{});
  location.href="/login.html";
});

document.querySelectorAll(".tab-btn").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    document.querySelectorAll(".tab-btn").forEach(b=>b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    $("tabPlayers").classList.toggle("hidden", tab!=="players");
    $("tabChat").classList.toggle("hidden", tab!=="chat");
  });
});

let currentRoute = "lobby";
const playersList = $("playersList");
const chatLog = $("chatLog");

const rt = setupRealtime({
  scope:"lobby",
  onStatus:(s)=>{
    $("statusDot").classList.add("online");
    $("statusDot").classList.remove("offline");
    $("statusText").textContent = `Online: ${s.online} • Lobby:${s.lobby} • Dice:${s.dice} • Roulette:${s.roulette} • Duel:${s.duel}`;
  },
  onPlayers:({scope, players})=>{
    if(scope !== routes[currentRoute].scope) return;
    $("panelCount").textContent = String(players.length);
    playersList.innerHTML="";
    for(const p of players){
      const row=document.createElement("div");
      row.className="player";
      row.innerHTML = `<div><b>${escapeHtml(p.username)}</b><div class="role">${escapeHtml(p.role)}</div></div><div class="pill">${escapeHtml(scope.toUpperCase())}</div>`;
      playersList.appendChild(row);
    }
  },
  onChat:(m)=>{
    if(m.scope !== routes[currentRoute].scope) return;
    const el=document.createElement("div");
    el.className="msg";
    el.innerHTML = `<div class="mmeta"><span><b>${escapeHtml(m.from)}</b> • ${escapeHtml(m.role)}</span><span>${new Date(m.ts).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"})}</span></div><div class="mtext">${escapeHtml(m.text)}</div>`;
    chatLog.appendChild(el);
    chatLog.scrollTop = chatLog.scrollHeight;
  },
  onWallet:(w)=>{ if(w) $("meCredits").textContent = commaTC(w.credits); }
});

rt.socket.on("disconnect", ()=>{
  $("statusDot").classList.remove("online");
  $("statusDot").classList.add("offline");
  $("statusText").textContent = "Offline (no socket)";
});

window.addEventListener("message",(ev)=>{
  if(ev?.data?.type==="voice"){ $("voiceBadge").textContent = "Voice: " + (ev.data.on ? "ON" : "OFF"); }
});

function setRoute(name){
  let rname = (name in routes) ? name : "lobby";
  if(rname==="staff" && !isStaff) rname="lobby";
  currentRoute = rname;
  const r = routes[currentRoute];
  $("pageTitle").textContent = r.title;
  $("panelTitle").textContent = `Players • ${r.panel}`;
  $("gameFrame").src = r.frame;
  rt.setScope(r.scope);
  document.querySelectorAll(".nav-btn[data-route]").forEach(b=>b.classList.toggle("active", b.dataset.route===currentRoute));
  playersList.innerHTML=""; chatLog.innerHTML=""; $("panelCount").textContent="0";
}
document.querySelectorAll(".nav-btn[data-route]").forEach(btn=>btn.addEventListener("click", ()=>{ location.hash = btn.dataset.route; }));
window.addEventListener("hashchange", ()=>setRoute((location.hash||"#lobby").slice(1)));
setRoute((location.hash||"#lobby").slice(1));

$("chatForm").addEventListener("submit",(e)=>{
  e.preventDefault();
  const text = ($("chatInput").value||"").trim();
  if(!text) return;
  rt.sendChat(text, routes[currentRoute].scope);
  $("chatInput").value="";
});
