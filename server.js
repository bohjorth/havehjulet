require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const { readDb, writeDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const PERENUAL_API_KEY = process.env.PERENUAL_API_KEY || '';

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const USERNAME_RE = /^[a-z0-9_-]{2,24}$/;

function authMiddleware(req, res, next){
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if(!token) return res.status(401).json({ error: 'Ikke logget ind' });
  const db = readDb();
  const session = db.sessions[token];
  if(!session) return res.status(401).json({ error: 'Session udløbet, log ind igen' });
  req.username = session.username;
  next();
}

// ---------- Auth ----------
app.post('/api/register', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if(!USERNAME_RE.test(username)){
    return res.status(400).json({ error: 'Ugyldigt brugernavn (2-24 tegn: a-z, 0-9, - eller _)' });
  }
  if(password.length < 4){
    return res.status(400).json({ error: 'Adgangskoden skal være mindst 4 tegn' });
  }
  const db = readDb();
  if(db.users[username]){
    return res.status(409).json({ error: 'Det brugernavn er allerede taget' });
  }
  const hash = await bcrypt.hash(password, 10);
  db.users[username] = { hash, createdAt: Date.now() };
  db.gardens[username] = { center: null, zoom: null, plants: [] };
  writeDb(db);
  res.json({ ok: true });
});

app.post('/api/login', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const db = readDb();
  const user = db.users[username];
  if(!user) return res.status(401).json({ error: 'Ingen konto med det brugernavn' });
  const ok = await bcrypt.compare(password, user.hash);
  if(!ok) return res.status(401).json({ error: 'Forkert adgangskode' });
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { username, createdAt: Date.now() };
  writeDb(db);
  res.json({ token });
});

app.post('/api/logout', authMiddleware, (req, res) => {
  const header = req.headers['authorization'] || '';
  const token = header.slice(7);
  const db = readDb();
  delete db.sessions[token];
  writeDb(db);
  res.json({ ok: true });
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ username: req.username });
});

// ---------- Garden data ----------
app.get('/api/garden', authMiddleware, (req, res) => {
  const db = readDb();
  const garden = db.gardens[req.username] || { center: null, zoom: null, plants: [] };
  res.json({ garden });
});

app.put('/api/garden', authMiddleware, (req, res) => {
  const garden = req.body.garden;
  if(!garden || typeof garden !== 'object'){
    return res.status(400).json({ error: 'Ugyldige havedata' });
  }
  const db = readDb();
  db.gardens[req.username] = garden;
  writeDb(db);
  res.json({ ok: true });
});

// ---------- Perenual proxy (keeps the API key server-side only) ----------
app.get('/api/plants/search', authMiddleware, async (req, res) => {
  if(!PERENUAL_API_KEY) return res.status(503).json({ error: 'Ingen Perenual-nøgle sat op på serveren' });
  const q = String(req.query.q || '').trim();
  if(!q) return res.json({ data: [] });
  try{
    const url = `https://perenual.com/api/species-list?key=${encodeURIComponent(PERENUAL_API_KEY)}&q=${encodeURIComponent(q)}`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  }catch(e){
    res.status(502).json({ error: 'Kunne ikke kontakte Perenual' });
  }
});

app.get('/api/plants/details/:id', authMiddleware, async (req, res) => {
  if(!PERENUAL_API_KEY) return res.status(503).json({ error: 'Ingen Perenual-nøgle sat op på serveren' });
  const id = String(req.params.id).replace(/[^0-9]/g, '');
  try{
    const url = `https://perenual.com/api/species/details/${id}?key=${encodeURIComponent(PERENUAL_API_KEY)}`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  }catch(e){
    res.status(502).json({ error: 'Kunne ikke kontakte Perenual' });
  }
});

app.listen(PORT, () => {
  console.log(`Havehjulet kører på port ${PORT}`);
});
