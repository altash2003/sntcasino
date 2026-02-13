import express from "express";
import session from "express-session";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import bcrypt from "bcryptjs";
import multer from "multer";
import path from "path";

const app = express();
const server = http.createServer(app);

// 1. Trust Render's proxy (Important for secure cookies on cloud hosting)
app.set("trust proxy", 1);

const io = new SocketIOServer(server, { cors: { origin: true, credentials: true } });

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret";
const HEAD_ADMIN_KEY = process.env.HEAD_ADMIN_KEY || "";

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// 2. CREATE THE SESSION ONCE (The Shared Guest List)
const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { 
    httpOnly: true, 
    sameSite: "lax",
    secure: false // Keep false for now to prevent HTTPS mismatches, Render handles SSL
  }
});

// 3. Use the SAME session for both Express (Website) and Socket.io (Game)
app.use(sessionMiddleware);
io.use((socket, next) => {
  sessionMiddleware(socket.request, socket.request.res || {}, next);
});

app.use("/uploads", express.static(path.join(process.cwd(), "public", "uploads")));
app.use(express.static(path.join(process.cwd(), "public")));

const users = new Map();
const devLogs = [];
const requests = [];

function log(line){
  const ts = new Date().toISOString();
  devLogs.unshift(`[${ts}] ${line}`);
  if(devLogs.length > 1000) devLogs.pop();
  console.log(line);
}
function newId(prefix="id"){ return prefix + "_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }

function normalizeUsername(u){ return String(u||"").trim(); }
function validUsername(u){ return /^[A-Za-z][A-Za-z0-9]{4,11}$/.test(u); }
function validPassword(p){ p=String(p||""); return p.length>=5 && p.length<=12; }

function getMe(req){
  const uid = req.session.userId;
  if(!uid) return null;
  for(const u of users.values()) if(u.id===uid) return u;
  return null;
}
function requireAuth(req,res,next){ if(!req.session.userId) return res.status(401).json({error:"Not authenticated"}); next(); }
function requireRole(...roles){
  return (req,res,next)=>{
    const me=getMe(req); if(!me) return res.status(401).json({error:"Not authenticated"});
    if(!roles.includes(me.role)) return res.status(403).json({error:"No access"});
    next();
  };
}

const upload = multer({
  storage: multer.diskStorage({
    destination:(req,file,cb)=>cb(null, path.join(process.cwd(),"public","uploads")),
    filename:(req,file,cb)=>cb(null, `${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g,"_")}`)
  }),
  limits:{ fileSize: 5*1024*1024 }
});

app.post("/api/bootstrap-admin", async (req,res)=>{
  const { username, password, key } = req.body || {};
  if(!HEAD_ADMIN_KEY || key !== HEAD_ADMIN_KEY) return res.status(403).json({ error:"Invalid HEAD_ADMIN_KEY" });
  const u=normalizeUsername(username);
  if(!validUsername(u)) return res.status(400).json({ error:"Username must be 5-12 chars, letters/numbers, start with letter." });
  if(!validPassword(password)) return res.status(400).json({ error:"Password must be 5-12 chars." });
  const k=u.toLowerCase();
  if(users.has(k)) return res.status(400).json({ error:"Username exists." });
  const passHash = await bcrypt.hash(String(password), 10);
  const user = { id:newId("u"), username:u, passHash, role:"Admin", credits: 999999999, createdAt:new Date().toISOString() };
  users.set(k,user); log(`BOOTSTRAP admin created: ${u}`);
  res.json({ ok:true });
});

app.post("/api/signup", async (req,res)=>{
  const { username, password } = req.body || {};
  const u=normalizeUsername(username);
  if(!validUsername(u)) return res.status(400).json({ error:"Username must be 5-12 chars, letters/numbers, start with letter." });
  if(!validPassword(password)) return res.status(400).json({ error:"Password must be 5-12 chars." });
  const k=u.toLowerCase();
  if(users.has(k)) return res.status(400).json({ error:"Username already taken." });
  const passHash = await bcrypt.hash(String(password), 10);
  const user = { id:newId("u"), username:u, passHash, role:"Player", credits:1000, createdAt:new Date().toISOString() };
  users.set(k,user);
  req.session.userId=user.id;
  log(`SIGNUP: ${u}`);
  res.json({ ok:true });
});

app.post("/api/login", async (req,res)=>{
  const { username, password } = req.body || {};
  const u=normalizeUsername(username);
  const user=users.get(u.toLowerCase());
  if(!user) return res.status(401).json({ error:"Invalid username/password." });
  const ok = await bcrypt.compare(String(password||""), user.passHash);
  if(!ok) return res.status(401).json({ error:"Invalid username/password." });
  req.session.userId=user.id;
  log(`LOGIN: ${user.username}`);
  res.json({ ok:true });
});

app.post("/api/logout",(req,res)=>{ const me=getMe(req); req.session.destroy(()=>{}); if(me) log(`LOGOUT: ${me.username}`); res.json({ ok:true }); });

app.get("/api/me", requireAuth, (req,res)=>{
  const me=getMe(req);
  if(!me) return res.status(401).json({ error:"Not authenticated" });
  res.json({ user:{ username:me.username, role:me.role, credits:me.credits, createdAt:me.createdAt } });
});

app.post("/api/topup-request", requireAuth, upload.single("proof"), (req,res)=>{
  const me=getMe(req);
  const amount=Number(req.body?.amount||0);
  const note=String(req.body?.note||"").slice(0,200);
  if(!Number.isFinite(amount) || amount<=0) return res.status(400).json({ error:"Invalid amount" });
  const id=newId("req");
  const proofUrl=req.file ? `/uploads/${req.file.filename}` : "";
  requests.unshift({ id, type:"topup", username:me.username, amount, note, status:"pending", createdAt:new Date().toISOString(), proofUrl });
  log(`TOPUP request: ${me.username} amount=${amount}`);
  res.json({ ok:true, id });
});

app.post("/api/withdraw-request", requireAuth, (req,res)=>{
  const me=getMe(req);
  const amount=Number(req.body?.amount||0);
  const note=String(req.body?.note||"").slice(0,200);
  if(!Number.isFinite(amount) || amount<=0) return res.status(400).json({ error:"Invalid amount" });
  if(me.credits < amount) return res.status(400).json({ error:"Insufficient credits" });
  me.credits -= amount;
  io.to(`user:${me.id}`).emit("wallet:update",{ credits: me.credits });
  const id=newId("req");
  requests.unshift({ id, type:"withdraw", username:me.username, amount, note, status:"pending", createdAt:new Date().toISOString(), proofUrl:"" });
  log(`WITHDRAW request: ${me.username} amount=${amount}`);
  res.json({ ok:true, id });
});

app.get("/api/my-requests", requireAuth, (req,res)=>{
  const me=getMe(req);
  res.json({ items: requests.filter(r=>r.username===me.username).slice(0,200) });
});

app.get("/api/staff/requests", requireRole("Admin","Moderator"), (req,res)=>{
  res.json({ items: requests.filter(r=>r.status==="pending").slice(0,300) });
});
app.post("/api/staff/requests/:id", requireRole("Admin","Moderator"), (req,res)=>{
  const { action } = req.body || {};
  const it = requests.find(r=>r.id===req.params.id);
  if(!it) return res.status(404).json({ error:"Not found" });
  if(it.status!=="pending") return res.status(400).json({ error:"Already handled" });
  const target = users.get(it.username.toLowerCase());
  if(!target) return res.status(400).json({ error:"User missing" });

  if(action==="approve"){
    it.status="approved";
    if(it.type==="topup"){ target.credits += it.amount; io.to(`user:${target.id}`).emit("wallet:update",{credits:target.credits}); log(`APPROVE topup: ${it.username} +${it.amount}`); }
    else { log(`APPROVE withdraw: ${it.username} -${it.amount} (kept)`); }
  }else if(action==="decline"){
    it.status="declined";
    if(it.type==="withdraw"){ target.credits += it.amount; io.to(`user:${target.id}`).emit("wallet:update",{credits:target.credits}); log(`DECLINE withdraw: ${it.username} refund +${it.amount}`); }
    else { log(`DECLINE topup: ${it.username}`); }
  }else return res.status(400).json({ error:"Invalid action" });

  res.json({ ok:true });
});

app.post("/api/staff/create-user", requireRole("Admin"), async (req,res)=>{
  const { username, password, role } = req.body || {};
  const u=normalizeUsername(username);
  if(!validUsername(u)) return res.status(400).json({ error:"Bad username" });
  if(!validPassword(password)) return res.status(400).json({ error:"Bad password" });
  if(role!=="Admin" && role!=="Moderator") return res.status(400).json({ error:"Bad role" });
  if(users.has(u.toLowerCase())) return res.status(400).json({ error:"Username exists" });
  const passHash=await bcrypt.hash(String(password),10);
  users.set(u.toLowerCase(), { id:newId("u"), username:u, passHash, role, credits:0, createdAt:new Date().toISOString() });
  log(`CREATE staff: ${u} role=${role}`);
  res.json({ ok:true });
});

app.get("/api/staff/logs", requireRole("Admin","Moderator"), (req,res)=>{
  const limit=Math.max(1, Math.min(1000, Number(req.query.limit||200)));
  res.json({ lines: devLogs.slice(0,limit) });
});

// --- realtime presence + games ---
const presence = { lobby:new Map(), dice:new Map(), roulette:new Map(), duel:new Map() };
function getCounts(){ return { online: io.engine.clientsCount, lobby: presence.lobby.size, dice: presence.dice.size, roulette: presence.roulette.size, duel: presence.duel.size }; }
function emitStatus(){ io.emit("status", getCounts()); }
function listPlayers(scope){ return Array.from(presence[scope].values()).map(p=>({ username:p.username, role:p.role })); }
function broadcastPlayers(scope){ io.to(`scope:${scope}`).emit("players:update",{ scope, players: listPlayers(scope) }); }
function setPresence(socket, scope, me){
  for(const s of Object.keys(presence)){
    if(presence[s].has(socket.id)){ presence[s].delete(socket.id); socket.leave(`scope:${s}`); broadcastPlayers(s); }
  }
  presence[scope].set(socket.id,{ id:me.id, username:me.username, role:me.role });
  socket.join(`scope:${scope}`); broadcastPlayers(scope); emitStatus();
}

// dice engine
const diceState = { phase:"betting", round:1, secondsLeft:15, dice:[1,1,1], pools:{RED:0,BLUE:0,GREEN:0,YELLOW:0}, bets:new Map() };
const diceCfg = { betSeconds:15, revealSeconds:6 };
function diceColorFromValue(v){ if(v<=2) return "RED"; if(v<=3) return "BLUE"; if(v<=5) return "GREEN"; return "YELLOW"; }
function publicDice(){ return { phase:diceState.phase, round:diceState.round, secondsLeft:diceState.secondsLeft, dice:diceState.dice, pools:diceState.pools }; }
function diceTick(){
  diceState.secondsLeft--;
  if(diceState.secondsLeft<=0){
    if(diceState.phase==="betting"){
      diceState.phase="reveal"; diceState.secondsLeft=diceCfg.revealSeconds;
      diceState.dice=[1+Math.floor(Math.random()*6),1+Math.floor(Math.random()*6),1+Math.floor(Math.random()*6)];
      const colors=diceState.dice.map(diceColorFromValue);
      const counts=colors.reduce((a,c)=>{a[c]=(a[c]||0)+1; return a;},{});
      let winner="RED", best=-1; for(const c of ["RED","BLUE","GREEN","YELLOW"]){ const n=counts[c]||0; if(n>best){best=n; winner=c;} }
      for(const [uid,b] of diceState.bets.entries()){
        const u=[...users.values()].find(x=>x.id===uid); if(!u) continue;
        const betAmt=b.byColor[winner]||0; if(betAmt>0){ u.credits += betAmt*2; io.to(`user:${u.id}`).emit("wallet:update",{credits:u.credits}); }
      }
      io.to("scope:dice").emit("game:event",{type:"dice:toast",ok:true,text:`Result: ${winner} (${diceState.dice.join("-")})`});
      io.to("scope:dice").emit("game:event",{type:"dice:state",state:publicDice()});
    } else {
      diceState.phase="betting"; diceState.round++; diceState.secondsLeft=diceCfg.betSeconds;
      diceState.dice=[1,1,1]; diceState.pools={RED:0,BLUE:0,GREEN:0,YELLOW:0}; diceState.bets.clear();
      io.to("scope:dice").emit("game:event",{type:"dice:state",state:publicDice()});
    }
  } else io.to("scope:dice").emit("game:event",{type:"dice:state",state:publicDice()});
}

// roulette engine
const rouletteState={ phase:"betting", round:1, secondsLeft:18, lastResult:null, pools:{RED:0,BLACK:0,EVEN:0,ODD:0}, bets:new Map() };
const rouletteCfg={ betSeconds:18, revealSeconds:6 };
function rouletteMeta(n){
  if(n===0) return { number:0, color:"GREEN", parity:"NONE" };
  const redNums=new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
  const color=redNums.has(n)?"RED":"BLACK";
  const parity=(n%2===0)?"EVEN":"ODD";
  return { number:n, color, parity };
}
function publicRoulette(){ return { phase:rouletteState.phase, round:rouletteState.round, secondsLeft:rouletteState.secondsLeft, lastResult:rouletteState.lastResult, pools:rouletteState.pools }; }
function rouletteTick(){
  rouletteState.secondsLeft--;
  if(rouletteState.secondsLeft<=0){
    if(rouletteState.phase==="betting"){
      rouletteState.phase="spin"; rouletteState.secondsLeft=rouletteCfg.revealSeconds;
      rouletteState.lastResult=rouletteMeta(Math.floor(Math.random()*37));
      for(const [uid,b] of rouletteState.bets.entries()){
        const u=[...users.values()].find(x=>x.id===uid); if(!u) continue;
        const res=rouletteState.lastResult; let won=0;
        if(res.color==="RED") won += (b.byBet.RED||0)*2;
        if(res.color==="BLACK") won += (b.byBet.BLACK||0)*2;
        if(res.parity==="EVEN") won += (b.byBet.EVEN||0)*2;
        if(res.parity==="ODD") won += (b.byBet.ODD||0)*2;
        if(won>0){ u.credits += won; io.to(`user:${u.id}`).emit("wallet:update",{credits:u.credits}); }
      }
      io.to("scope:roulette").emit("game:event",{type:"roulette:toast",ok:true,text:`Result: ${rouletteState.lastResult.number} (${rouletteState.lastResult.color})`});
      io.to("scope:roulette").emit("game:event",{type:"roulette:state",state:publicRoulette()});
    } else {
      rouletteState.phase="betting"; rouletteState.round++; rouletteState.secondsLeft=rouletteCfg.betSeconds;
      rouletteState.pools={RED:0,BLACK:0,EVEN:0,ODD:0}; rouletteState.bets.clear();
      io.to("scope:roulette").emit("game:event",{type:"roulette:state",state:publicRoulette()});
    }
  } else io.to("scope:roulette").emit("game:event",{type:"roulette:state",state:publicRoulette()});
}

// duel engine (simple)
const duelState={ phase:"betting", match:1, secondsLeft:20, left:null, right:null, pools:{L:0,R:0}, bets:new Map(), rtcPeers:new Set() };
const duelCfg={ betSeconds:20, resolveSeconds:6 };
function publicDuel(){
  return { phase:duelState.phase, match:duelState.match, secondsLeft:duelState.secondsLeft,
    left: duelState.left ? { username:duelState.left.username, score:duelState.left.score||0 } : null,
    right: duelState.right ? { username:duelState.right.username, score:duelState.right.score||0 } : null,
    pools: duelState.pools
  };
}
function duelTick(){
  duelState.secondsLeft--;
  if(duelState.secondsLeft<=0){
    if(duelState.phase==="betting"){
      duelState.phase="resolve"; duelState.secondsLeft=duelCfg.resolveSeconds;
      let winner=null;
      if(duelState.left && duelState.right) winner = Math.random()<0.5?"L":"R";
      else if(duelState.left) winner="L"; else if(duelState.right) winner="R";
      if(winner){
        const seat = winner==="L"?duelState.left:duelState.right; seat.score=(seat.score||0)+1;
        for(const [uid,b] of duelState.bets.entries()){
          const u=[...users.values()].find(x=>x.id===uid); if(!u) continue;
          const betAmt=b.bySide[winner]||0;
          if(betAmt>0){ u.credits += betAmt*2; io.to(`user:${u.id}`).emit("wallet:update",{credits:u.credits}); }
        }
        io.to("scope:duel").emit("game:event",{type:"duel:toast",ok:true,text:`Winner: ${seat.username}`});
      } else io.to("scope:duel").emit("game:event",{type:"duel:toast",ok:false,text:"No players seated."});
      io.to("scope:duel").emit("game:event",{type:"duel:state",state:publicDuel()});
    } else {
      duelState.phase="betting"; duelState.match++; duelState.secondsLeft=duelCfg.betSeconds;
      duelState.pools={L:0,R:0}; duelState.bets.clear();
      io.to("scope:duel").emit("game:event",{type:"duel:state",state:publicDuel()});
    }
  } else io.to("scope:duel").emit("game:event",{type:"duel:state",state:publicDuel()});
}

setInterval(diceTick, 1000);
setInterval(rouletteTick, 1000);
setInterval(duelTick, 1000);
setInterval(emitStatus, 1500);

io.on("connection",(socket)=>{
  const me=getMe({ session: socket.request.session });
  if(!me) return socket.disconnect(true);
  socket.join(`user:${me.id}`);
  setPresence(socket,"lobby",me);

  socket.on("presence",({scope})=>{
    const sc=["lobby","dice","roulette","duel"].includes(scope)?scope:"lobby";
    setPresence(socket, sc, me);
    if(sc==="dice") socket.emit("game:event",{type:"dice:state",state:publicDice()});
    if(sc==="roulette") socket.emit("game:event",{type:"roulette:state",state:publicRoulette()});
    if(sc==="duel"){ socket.emit("game:event",{type:"duel:state",state:publicDuel()});
      socket.emit("game:event",{type:"duel:rtc-peers",peers:[...duelState.rtcPeers].map(id=>({id}))});
    }
  });

  socket.on("chat:send",({scope,text})=>{
    const sc=["lobby","dice","roulette","duel"].includes(scope)?scope:"lobby";
    const t=String(text||"").slice(0,250).trim(); if(!t) return;
    io.to(`scope:${sc}`).emit("chat:msg",{ scope:sc, from:me.username, role:me.role, text:t, ts:Date.now() });
  });

  socket.on("dice:sync",()=>socket.emit("game:event",{type:"dice:state",state:publicDice()}));
  socket.on("dice:bet",({color,amount})=>{
    if(diceState.phase!=="betting") return socket.emit("game:event",{type:"dice:toast",ok:false,text:"Betting closed"});
    if(!["RED","BLUE","GREEN","YELLOW"].includes(color)) return;
    const amt=Number(amount||0); if(!Number.isFinite(amt)||amt<=0) return;
    if(me.credits<amt) return socket.emit("game:event",{type:"dice:toast",ok:false,text:"Insufficient credits"});
    me.credits-=amt; io.to(`user:${me.id}`).emit("wallet:update",{credits:me.credits});
    diceState.pools[color]+=amt;
    const b=diceState.bets.get(me.id)||{total:0,byColor:{RED:0,BLUE:0,GREEN:0,YELLOW:0}};
    b.total+=amt; b.byColor[color]+=amt; diceState.bets.set(me.id,b);
    io.to("scope:dice").emit("game:event",{type:"dice:state",state:publicDice()});
    socket.emit("game:event",{type:"dice:toast",ok:true,text:`Bet placed: ${color} ${amt}TC`});
  });
  socket.on("dice:cancel",()=>{
    if(diceState.phase!=="betting") return socket.emit("game:event",{type:"dice:toast",ok:false,text:"Too late"});
    const b=diceState.bets.get(me.id); if(!b) return socket.emit("game:event",{type:"dice:toast",ok:false,text:"No bets"});
    me.credits+=b.total; io.to(`user:${me.id}`).emit("wallet:update",{credits:me.credits});
    for(const c of Object.keys(b.byColor)) diceState.pools[c]-=b.byColor[c];
    diceState.bets.delete(me.id);
    io.to("scope:dice").emit("game:event",{type:"dice:state",state:publicDice()});
    socket.emit("game:event",{type:"dice:toast",ok:true,text:"Bets cancelled"});
  });

  socket.on("roulette:sync",()=>socket.emit("game:event",{type:"roulette:state",state:publicRoulette()}));
  socket.on("roulette:bet",({bet,amount})=>{
    if(rouletteState.phase!=="betting") return socket.emit("game:event",{type:"roulette:toast",ok:false,text:"Betting closed"});
    if(!["RED","BLACK","EVEN","ODD"].includes(bet)) return;
    const amt=Number(amount||0); if(!Number.isFinite(amt)||amt<=0) return;
    if(me.credits<amt) return socket.emit("game:event",{type:"roulette:toast",ok:false,text:"Insufficient credits"});
    me.credits-=amt; io.to(`user:${me.id}`).emit("wallet:update",{credits:me.credits});
    rouletteState.pools[bet]+=amt;
    const b=rouletteState.bets.get(me.id)||{total:0,byBet:{RED:0,BLACK:0,EVEN:0,ODD:0}};
    b.total+=amt; b.byBet[bet]+=amt; rouletteState.bets.set(me.id,b);
    io.to("scope:roulette").emit("game:event",{type:"roulette:state",state:publicRoulette()});
    socket.emit("game:event",{type:"roulette:toast",ok:true,text:`Bet placed: ${bet} ${amt}TC`});
  });
  socket.on("roulette:cancel",()=>{
    if(rouletteState.phase!=="betting") return socket.emit("game:event",{type:"roulette:toast",ok:false,text:"Too late"});
    const b=rouletteState.bets.get(me.id); if(!b) return socket.emit("game:event",{type:"roulette:toast",ok:false,text:"No bets"});
    me.credits+=b.total; io.to(`user:${me.id}`).emit("wallet:update",{credits:me.credits});
    for(const k of Object.keys(b.byBet)) rouletteState.pools[k]-=b.byBet[k];
    rouletteState.bets.delete(me.id);
    io.to("scope:roulette").emit("game:event",{type:"roulette:state",state:publicRoulette()});
    socket.emit("game:event",{type:"roulette:toast",ok:true,text:"Bets cancelled"});
  });

  socket.on("duel:sync",()=>{ socket.emit("game:event",{type:"duel:state",state:publicDuel()});
    socket.emit("game:event",{type:"duel:rtc-peers",peers:[...duelState.rtcPeers].map(id=>({id}))});
  });
  socket.on("duel:join",({side})=>{
    if(side==="L"){ if(duelState.left) return socket.emit("game:event",{type:"duel:toast",ok:false,text:"Left taken"}); duelState.left={id:me.id,username:me.username,score:0}; }
    else if(side==="R"){ if(duelState.right) return socket.emit("game:event",{type:"duel:toast",ok:false,text:"Right taken"}); duelState.right={id:me.id,username:me.username,score:0}; }
    io.to("scope:duel").emit("game:event",{type:"duel:state",state:publicDuel()});
    socket.emit("game:event",{type:"duel:toast",ok:true,text:"Seated"});
  });
  socket.on("duel:bet",({side,amount})=>{
    if(duelState.phase!=="betting") return socket.emit("game:event",{type:"duel:toast",ok:false,text:"Betting closed"});
    if(!["L","R"].includes(side)) return;
    const amt=Number(amount||0); if(!Number.isFinite(amt)||amt<=0) return;
    if(me.credits<amt) return socket.emit("game:event",{type:"duel:toast",ok:false,text:"Insufficient credits"});
    me.credits-=amt; io.to(`user:${me.id}`).emit("wallet:update",{credits:me.credits});
    duelState.pools[side]+=amt;
    const b=duelState.bets.get(me.id)||{total:0,bySide:{L:0,R:0}};
    b.total+=amt; b.bySide[side]+=amt; duelState.bets.set(me.id,b);
    io.to("scope:duel").emit("game:event",{type:"duel:state",state:publicDuel()});
    socket.emit("game:event",{type:"duel:toast",ok:true,text:`Bet placed: ${side} ${amt}TC`});
  });
  socket.on("duel:cancel",()=>{
    if(duelState.phase!=="betting") return socket.emit("game:event",{type:"duel:toast",ok:false,text:"Too late"});
    const b=duelState.bets.get(me.id); if(!b) return socket.emit("game:event",{type:"duel:toast",ok:false,text:"No bet"});
    me.credits+=b.total; io.to(`user:${me.id}`).emit("wallet:update",{credits:me.credits});
    duelState.pools.L-=b.bySide.L; duelState.pools.R-=b.bySide.R; duelState.bets.delete(me.id);
    io.to("scope:duel").emit("game:event",{type:"duel:state",state:publicDuel()});
    socket.emit("game:event",{type:"duel:toast",ok:true,text:"Bet cancelled"});
  });

  socket.on("duel:rtc-join",()=>{ duelState.rtcPeers.add(socket.id); io.to("scope:duel").emit("game:event",{type:"duel:rtc-peers",peers:[...duelState.rtcPeers].map(id=>({id}))}); });
  socket.on("duel:rtc-leave",()=>{ duelState.rtcPeers.delete(socket.id); io.to("scope:duel").emit("game:event",{type:"duel:rtc-peers",peers:[...duelState.rtcPeers].map(id=>({id}))}); });
  socket.on("rtc:signal",({to,type,sdp,cand})=>{ io.to(to).emit("rtc:signal",{from:socket.id,type,sdp,cand}); });

  socket.on("disconnect",()=>{
    for(const s of Object.keys(presence)){ if(presence[s].has(socket.id)){ presence[s].delete(socket.id); broadcastPlayers(s); } }
    duelState.rtcPeers.delete(socket.id);
    io.to("scope:duel").emit("game:event",{type:"duel:rtc-peers",peers:[...duelState.rtcPeers].map(id=>({id}))});
    emitStatus();
  });

  socket.emit("status", getCounts());
});

app.get("/", (req,res)=>{ if(req.session.userId) return res.redirect("/app.html"); return res.redirect("/login.html"); });

server.listen(PORT, ()=>log(`Server running on port ${PORT}`));
