const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const multer = require('multer');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: false } });
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'urubaits-demo';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'urubaits.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS participation_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  participant_id INTEGER,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,
  played INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  image_url TEXT NOT NULL,
  correct_answer TEXT NOT NULL CHECK(correct_answer IN ('REAL','FAKE')),
  difficulty TEXT NOT NULL DEFAULT 'MEDIA',
  clue TEXT NOT NULL DEFAULT '',
  explanation TEXT NOT NULL DEFAULT '',
  display_time_ms INTEGER NOT NULL DEFAULT 6000,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'WAITING',
  started_at TEXT,
  finished_at TEXT,
  current_question_id INTEGER,
  current_question_started_at INTEGER,
  duration_ms INTEGER NOT NULL DEFAULT 120000
);
CREATE TABLE IF NOT EXISTS session_participants (
  session_id INTEGER NOT NULL,
  participant_id INTEGER NOT NULL,
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(session_id, participant_id)
);
CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  participant_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  answer TEXT NOT NULL CHECK(answer IN ('REAL','FAKE')),
  correct INTEGER NOT NULL,
  response_time_ms INTEGER NOT NULL,
  points INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, participant_id, question_id)
);
`);

function nowMs(){ return Date.now(); }
function safeNick(s){ return String(s||'').replace(/[<>]/g,'').trim().slice(0,24); }
function randomCode(){
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out=''; for(let i=0;i<5;i++) out += chars[Math.floor(Math.random()*chars.length)];
  return out;
}
function ensureWaitingSession(){
  let s = db.prepare("SELECT * FROM sessions WHERE status IN ('WAITING','COUNTDOWN','PLAYING','QUESTION_TRANSITION') ORDER BY id DESC LIMIT 1").get();
  if(!s){
    const r=db.prepare("INSERT INTO sessions(status) VALUES('WAITING')").run();
    s=db.prepare('SELECT * FROM sessions WHERE id=?').get(r.lastInsertRowid);
  }
  return s;
}
function getSession(){ return ensureWaitingSession(); }
function listActiveQuestions(){ return db.prepare('SELECT * FROM questions WHERE active=1 ORDER BY sort_order ASC, id ASC').all(); }
function participantResult(pid){
  const p=db.prepare('SELECT * FROM participants WHERE id=?').get(pid);
  if(!p) return null;
  const row=db.prepare(`SELECT COALESCE(SUM(points),0) total_points, SUM(correct) correct_answers, COUNT(*) total_answers,
    MIN(CASE WHEN correct=1 THEN response_time_ms END) fastest_answer,
    AVG(response_time_ms) avg_response
    FROM answers WHERE participant_id=?`).get(pid);
  const rankRows = ranking();
  const pos = rankRows.findIndex(r=>r.participant_id===pid);
  const wrong = db.prepare(`SELECT q.id,q.title,q.image_url,q.correct_answer,q.clue,q.explanation,a.answer,a.response_time_ms
    FROM answers a JOIN questions q ON q.id=a.question_id WHERE a.participant_id=? AND a.correct=0 ORDER BY a.id`).all(pid);
  return {
    participant_id: pid, nickname:p.nickname,
    total_points:Number(row.total_points||0),
    correct_answers:Number(row.correct_answers||0),
    total_answers:Number(row.total_answers||0),
    accuracy: row.total_answers ? Math.round((row.correct_answers/row.total_answers)*100) : 0,
    fastest_answer: row.fastest_answer || null,
    avg_response: row.avg_response ? Math.round(row.avg_response) : null,
    ranking_position: pos>=0 ? pos+1 : null,
    wrong
  };
}
function ranking(){
  return db.prepare(`SELECT p.id participant_id,p.nickname,
    COALESCE(SUM(a.points),0) points,
    COALESCE(SUM(a.correct),0) correct_answers,
    COALESCE(AVG(a.response_time_ms),999999999) avg_response,
    COUNT(a.id) answers
    FROM participants p LEFT JOIN answers a ON a.participant_id=p.id
    WHERE p.played=1
    GROUP BY p.id
    ORDER BY points DESC, correct_answers DESC, avg_response ASC, p.id ASC`).all();
}
function stats(){
  const totalParticipants=db.prepare('SELECT COUNT(*) c FROM participants WHERE played=1').get().c;
  const totalAnswers=db.prepare('SELECT COUNT(*) c FROM answers').get().c;
  const correct=db.prepare('SELECT COALESCE(SUM(correct),0) c FROM answers').get().c;
  const avgTime=db.prepare('SELECT AVG(response_time_ms) a FROM answers').get().a;
  const byQuestion=db.prepare(`SELECT q.id,q.title,q.correct_answer,COUNT(a.id) total,SUM(a.correct) correct,
    ROUND(100.0*SUM(a.correct)/NULLIF(COUNT(a.id),0),1) accuracy
    FROM questions q LEFT JOIN answers a ON a.question_id=q.id GROUP BY q.id ORDER BY accuracy ASC`).all();
  return {totalParticipants,totalAnswers,accuracy: totalAnswers?Math.round(correct/totalAnswers*100):0,avgTime:avgTime?Math.round(avgTime):0,byQuestion};
}
function currentState(){
  const s=getSession();
  const participants=db.prepare(`SELECT p.id,p.nickname FROM session_participants sp JOIN participants p ON p.id=sp.participant_id WHERE sp.session_id=? ORDER BY sp.joined_at`).all(s.id);
  let q=null;
  if(s.current_question_id) q=db.prepare('SELECT id,title,image_url,difficulty,display_time_ms FROM questions WHERE id=?').get(s.current_question_id);
  const responded=q ? db.prepare('SELECT COUNT(*) c FROM answers WHERE session_id=? AND question_id=?').get(s.id,q.id).c : 0;
  return {session:{...s},participants,question:q,responded,ranking:ranking().slice(0,5),stats:stats()};
}
function broadcast(){ io.emit('state', currentState()); }

// Seed demo questions using local SVG placeholders.
const qCount=db.prepare('SELECT COUNT(*) c FROM questions').get().c;
if(qCount===0){
  const seed=[
    ['Correios — taxa de entrega','/demo/fake-correios.svg','FAKE','FACIL','Observe o domínio e a cobrança inesperada.','A página imita os Correios, mas usa domínio não oficial e cria urgência para cobrar uma taxa.'],
    ['Banco — acesso oficial','/demo/real-banco.svg','REAL','MEDIA','Procure coerência de domínio e contexto.','A captura representa uma página legítima de demonstração. Aparência por si só não prova autenticidade.'],
    ['Universidade — atualização cadastral','/demo/fake-universidade.svg','FAKE','MEDIA','O endereço não pertence à instituição.','Golpes de phishing imitam instituições conhecidas e usam ameaça de bloqueio para acelerar a decisão.'],
    ['Loja — promoção relâmpago','/demo/fake-loja.svg','FAKE','FACIL','Preço e urgência são sinais de alerta.','Oferta excessivamente vantajosa e pressão temporal são gatilhos comuns de engenharia social.'],
    ['Portal institucional antigo','/demo/real-antigo.svg','REAL','DIFICIL','Não julgue somente pelo visual.','Um site pode parecer antigo e ainda ser legítimo. Verifique origem, domínio e contexto.'],
    ['Streaming — pagamento recusado','/demo/fake-streaming.svg','FAKE','MEDIA','Mensagem inesperada pedindo atualização de pagamento.','Fraudes podem copiar a aparência de serviços conhecidos para roubar credenciais ou cobrar taxas.'],
    ['Loja conhecida — página legítima','/demo/real-loja.svg','REAL','MEDIA','A estrutura é consistente e não há pressão incomum.','Exemplo educativo de uma página legítima. Sempre confira o endereço real no navegador.'],
    ['Rastreamento — objeto retido','/demo/fake-rastreio.svg','FAKE','DIFICIL','Cobrança inesperada e domínio alternativo.','Golpes de rastreamento exploram ansiedade sobre encomendas e costumam solicitar pagamento imediato.'],
    ['Login de serviço oficial','/demo/real-login.svg','REAL','DIFICIL','Considere origem e domínio, não apenas aparência.','Exemplo educativo de página legítima.'],
    ['Prêmio liberado mediante taxa','/demo/fake-premio.svg','FAKE','FACIL','Prêmio que exige pagamento é um forte sinal de golpe.','A pequena taxa reduz a percepção de risco e induz uma ação rápida.']
  ];
  const ins=db.prepare(`INSERT INTO questions(title,image_url,correct_answer,difficulty,clue,explanation,display_time_ms,active,sort_order) VALUES(?,?,?,?,?,?,6000,1,?)`);
  seed.forEach((q,i)=>ins.run(...q,i+1));
}

app.use(express.json({limit:'2mb'}));
app.use(express.urlencoded({extended:true}));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/demo', express.static(path.join(ROOT,'public','demo')));
app.use(express.static(path.join(ROOT,'public')));

const upload=multer({storage:multer.diskStorage({destination:UPLOADS_DIR,filename:(req,file,cb)=>cb(null,Date.now()+'-'+file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_'))}),limits:{fileSize:8*1024*1024}});
const adminTokens=new Set();
function adminAuth(req,res,next){ const token=req.headers['x-admin-token']; if(token && adminTokens.has(token)) return next(); res.status(401).json({error:'Não autorizado'}); }

app.get('/api/state',(req,res)=>res.json(currentState()));
app.get('/api/ranking',(req,res)=>res.json(ranking()));
app.get('/api/stats',(req,res)=>res.json(stats()));
app.get('/api/qr', async (req,res)=>{
  const base=PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  const url=`${base}/entrar.html`;
  try{ const png=await QRCode.toBuffer(url,{width:600,margin:1}); res.type('png').send(png); }catch(e){ res.status(500).end(); }
});
app.post('/api/join',(req,res)=>{
  const nickname=safeNick(req.body.nickname); const code=String(req.body.code||'').trim().toUpperCase();
  if(!nickname) return res.status(400).json({error:'Digite um apelido.'});
  const c=db.prepare('SELECT * FROM participation_codes WHERE code=?').get(code);
  if(!c) return res.status(400).json({error:'Código inválido.'});
  if(c.used) return res.status(400).json({error:'Este código já foi utilizado. Cada participante possui apenas uma tentativa.'});
  const s=getSession();
  if(s.status!=='WAITING') return res.status(400).json({error:'A rodada já começou. Aguarde a próxima sala.'});
  const tx=db.transaction(()=>{
    const pr=db.prepare('INSERT INTO participants(nickname,code) VALUES(?,?)').run(nickname,code);
    const pid=Number(pr.lastInsertRowid);
    db.prepare('UPDATE participation_codes SET used=1,participant_id=?,used_at=CURRENT_TIMESTAMP WHERE id=?').run(pid,c.id);
    db.prepare('INSERT INTO session_participants(session_id,participant_id) VALUES(?,?)').run(s.id,pid);
    return pid;
  });
  const pid=tx(); broadcast();
  res.json({ok:true,participantId:pid,sessionId:s.id,nickname});
});
app.post('/api/answer',(req,res)=>{
  const pid=Number(req.body.participantId); const qid=Number(req.body.questionId); const answer=String(req.body.answer||'').toUpperCase();
  if(!['REAL','FAKE'].includes(answer)) return res.status(400).json({error:'Resposta inválida'});
  const s=getSession();
  if(s.status!=='PLAYING' || s.current_question_id!==qid) return res.status(409).json({error:'Questão não está ativa.'});
  const member=db.prepare('SELECT 1 FROM session_participants WHERE session_id=? AND participant_id=?').get(s.id,pid);
  if(!member) return res.status(403).json({error:'Participante fora da rodada.'});
  const q=db.prepare('SELECT * FROM questions WHERE id=?').get(qid);
  const elapsed=Math.max(0,nowMs()-Number(s.current_question_started_at||nowMs()));
  const correct=answer===q.correct_answer?1:0;
  const speedRatio=Math.max(0,Math.min(1,1-(elapsed/q.display_time_ms)));
  const points=correct ? 500+Math.round(500*speedRatio) : 0;
  try{
    db.prepare('INSERT INTO answers(session_id,participant_id,question_id,answer,correct,response_time_ms,points) VALUES(?,?,?,?,?,?,?)')
      .run(s.id,pid,qid,answer,correct,elapsed,points);
  }catch(e){ return res.status(409).json({error:'Resposta já registrada.'}); }
  broadcast(); res.json({ok:true});
});
app.get('/api/result/:pid',(req,res)=>{ const r=participantResult(Number(req.params.pid)); if(!r) return res.status(404).json({error:'Não encontrado'}); res.json(r); });

app.post('/api/admin/login',(req,res)=>{
  if(String(req.body.password||'')!==ADMIN_PASSWORD) return res.status(401).json({error:'Senha incorreta'});
  const token=crypto.randomBytes(24).toString('hex'); adminTokens.add(token); res.json({token});
});
app.post('/api/admin/codes',adminAuth,(req,res)=>{
  const qty=Math.max(1,Math.min(500,Number(req.body.quantity||20))); const made=[];
  const ins=db.prepare('INSERT INTO participation_codes(code) VALUES(?)');
  for(let i=0;i<qty;i++){
    let code; let ok=false; while(!ok){ code=randomCode(); try{ins.run(code);ok=true;}catch{} }
    made.push(code);
  }
  broadcast(); res.json({codes:made});
});
app.get('/api/admin/codes',adminAuth,(req,res)=>res.json(db.prepare('SELECT * FROM participation_codes ORDER BY id DESC').all()));
app.get('/api/admin/questions',adminAuth,(req,res)=>res.json(db.prepare('SELECT * FROM questions ORDER BY sort_order,id').all()));
app.post('/api/admin/questions',adminAuth,upload.single('image'),(req,res)=>{
  const image_url=req.file?'/uploads/'+req.file.filename:String(req.body.image_url||'');
  if(!image_url) return res.status(400).json({error:'Envie uma imagem.'});
  const r=db.prepare(`INSERT INTO questions(title,image_url,correct_answer,difficulty,clue,explanation,display_time_ms,active,sort_order)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(
      String(req.body.title||'Questão'),image_url,String(req.body.correct_answer||'FAKE').toUpperCase(),String(req.body.difficulty||'MEDIA').toUpperCase(),
      String(req.body.clue||''),String(req.body.explanation||''),Math.max(2000,Math.min(20000,Number(req.body.display_time_ms||6000))),1,Number(req.body.sort_order||0)
    );
  broadcast(); res.json({id:Number(r.lastInsertRowid)});
});
app.patch('/api/admin/questions/:id',adminAuth,(req,res)=>{
  const q=db.prepare('SELECT * FROM questions WHERE id=?').get(req.params.id); if(!q) return res.status(404).json({error:'Não encontrado'});
  const b=req.body;
  db.prepare(`UPDATE questions SET title=?,correct_answer=?,difficulty=?,clue=?,explanation=?,display_time_ms=?,active=?,sort_order=? WHERE id=?`).run(
    b.title??q.title,(b.correct_answer??q.correct_answer).toUpperCase(),(b.difficulty??q.difficulty).toUpperCase(),b.clue??q.clue,b.explanation??q.explanation,
    Number(b.display_time_ms??q.display_time_ms),Number(b.active??q.active),Number(b.sort_order??q.sort_order),q.id
  ); broadcast(); res.json({ok:true});
});
app.delete('/api/admin/questions/:id',adminAuth,(req,res)=>{ db.prepare('DELETE FROM questions WHERE id=?').run(req.params.id); broadcast(); res.json({ok:true}); });

let gameTimer=null;
let questionTimer=null;
function clearTimers(){ if(gameTimer) clearTimeout(gameTimer); if(questionTimer) clearTimeout(questionTimer); gameTimer=questionTimer=null; }
function finishGame(){
  clearTimers(); const s=getSession();
  if(s.status==='PLAYING' || s.status==='QUESTION_TRANSITION' || s.status==='COUNTDOWN'){
    db.prepare("UPDATE sessions SET status='FINISHED',finished_at=CURRENT_TIMESTAMP WHERE id=?").run(s.id);
    db.prepare('UPDATE participants SET played=1 WHERE id IN (SELECT participant_id FROM session_participants WHERE session_id=?)').run(s.id);
    broadcast();
    setTimeout(()=>{ db.prepare("INSERT INTO sessions(status) VALUES('WAITING')").run(); broadcast(); },7000);
  }
}
function nextQuestion(){
  const s=getSession(); if(s.status!=='PLAYING') return;
  const questions=listActiveQuestions();
  if(!questions.length) return finishGame();
  const currentIndex=s.current_question_id ? questions.findIndex(q=>q.id===s.current_question_id) : -1;
  const next=questions[currentIndex+1];
  if(!next) return finishGame();
  const elapsed= nowMs() - new Date(s.started_at).getTime();
  if(elapsed>=s.duration_ms) return finishGame();
  db.prepare('UPDATE sessions SET current_question_id=?,current_question_started_at=?,status=? WHERE id=?').run(next.id,nowMs(),'PLAYING',s.id);
  broadcast();
  questionTimer=setTimeout(()=>{ nextQuestion(); },next.display_time_ms);
}
app.post('/api/admin/start',adminAuth,(req,res)=>{
  const s=getSession(); if(s.status!=='WAITING') return res.status(409).json({error:'Sala não está aguardando.'});
  const count=db.prepare('SELECT COUNT(*) c FROM session_participants WHERE session_id=?').get(s.id).c;
  if(count<1) return res.status(400).json({error:'Nenhum participante conectado.'});
  const q=listActiveQuestions(); if(!q.length) return res.status(400).json({error:'Cadastre questões ativas.'});
  clearTimers();
  db.prepare("UPDATE sessions SET status='COUNTDOWN' WHERE id=?").run(s.id); broadcast();
  setTimeout(()=>{
    db.prepare("UPDATE sessions SET status='PLAYING',started_at=?,current_question_id=NULL,current_question_started_at=NULL WHERE id=?").run(new Date().toISOString(),s.id);
    broadcast(); nextQuestion(); gameTimer=setTimeout(finishGame,s.duration_ms);
  },3000);
  res.json({ok:true});
});
app.post('/api/admin/finish',adminAuth,(req,res)=>{finishGame();res.json({ok:true});});
app.post('/api/admin/new-room',adminAuth,(req,res)=>{ clearTimers(); const s=getSession(); if(s.status!=='FINISHED' && s.status!=='WAITING') finishGame(); db.prepare("INSERT INTO sessions(status) VALUES('WAITING')").run(); broadcast(); res.json({ok:true}); });

io.on('connection',(socket)=>{ socket.emit('state', currentState()); });

server.listen(PORT,()=>console.log(`REAL OU FAKE rodando na porta ${PORT}`));
