require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cron = require('node-cron');
const { readDb, writeDb } = require('./db');
const { sendMail } = require('./mailer');

const app = express();
const PORT = process.env.PORT || 3000;
const PERENUAL_API_KEY = process.env.PERENUAL_API_KEY || '';
const TREFLE_API_KEY = process.env.TREFLE_API_KEY || '';
const PLANTNET_API_KEY = process.env.PLANTNET_API_KEY || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '30d' }));

const USERNAME_RE = /^[a-z0-9_-]{2,24}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emptyGarden(){
  return { center: null, zoom: null, plants: [], addresses: [] };
}

// Resolves (and lazily migrates) the gardenId a user belongs to.
// Older accounts created before shared gardens existed didn't have a
// gardenId field — for those we treat their own username as the gardenId,
// same as their original, private garden always worked.
// Returns { gardenId, migrated } so callers only persist when needed.
function resolveGardenId(db, username){
  const user = db.users[username];
  if(!user) return { gardenId: username, migrated: false };
  if(!user.gardenId){
    user.gardenId = username;
    if(!db.gardens[username]) db.gardens[username] = emptyGarden();
    if(!db.gardens[username].members) db.gardens[username].members = [username];
    else if(!db.gardens[username].members.includes(username)) db.gardens[username].members.push(username);
    return { gardenId: user.gardenId, migrated: true };
  }
  return { gardenId: user.gardenId, migrated: false };
}

function authMiddleware(req, res, next){
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if(!token) return res.status(401).json({ error: 'Ikke logget ind' });
  const db = readDb();
  const session = db.sessions[token];
  if(!session) return res.status(401).json({ error: 'Session udløbet, log ind igen' });
  req.username = session.username;
  const { gardenId, migrated } = resolveGardenId(db, session.username);
  req.gardenId = gardenId;
  if(migrated) writeDb(db); // only persist when a lazy migration actually happened
  next();
}

// ---------- Auth ----------
app.post('/api/register', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const email = String(req.body.email || '').trim().toLowerCase();
  const inviteCode = String(req.body.inviteCode || '').trim();

  if(!USERNAME_RE.test(username)){
    return res.status(400).json({ error: 'Ugyldigt brugernavn (2-24 tegn: a-z, 0-9, - eller _)' });
  }
  if(password.length < 4){
    return res.status(400).json({ error: 'Adgangskoden skal være mindst 4 tegn' });
  }
  if(email && !EMAIL_RE.test(email)){
    return res.status(400).json({ error: 'Ugyldig e-mailadresse' });
  }
  const db = readDb();
  if(db.users[username]){
    return res.status(409).json({ error: 'Det brugernavn er allerede taget' });
  }

  let gardenId = username;
  if(inviteCode){
    const invite = db.invites[inviteCode];
    if(!invite){
      return res.status(400).json({ error: 'Ugyldig invitationskode' });
    }
    gardenId = invite.gardenId;
  }

  const hash = await bcrypt.hash(password, 10);
  db.users[username] = { hash, email: email || null, remindersEnabled: !!email, createdAt: Date.now(), gardenId };

  if(!db.gardens[gardenId]) db.gardens[gardenId] = emptyGarden();
  if(!db.gardens[gardenId].members) db.gardens[gardenId].members = [];
  if(!db.gardens[gardenId].members.includes(username)) db.gardens[gardenId].members.push(username);

  writeDb(db);
  res.json({ ok: true, joinedSharedGarden: !!inviteCode });
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

// ---------- Account settings (email, reminders) ----------
app.get('/api/account', authMiddleware, (req, res) => {
  const db = readDb();
  const user = db.users[req.username];
  const garden = db.gardens[req.gardenId] || emptyGarden();
  res.json({
    username: req.username,
    email: user.email || '',
    remindersEnabled: !!user.remindersEnabled,
    gardenId: req.gardenId,
    isOwnGarden: req.gardenId === req.username,
    members: garden.members || [req.username],
    createdAt: user.createdAt || null
  });
});

app.put('/api/account', authMiddleware, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const remindersEnabled = !!req.body.remindersEnabled;
  if(email && !EMAIL_RE.test(email)){
    return res.status(400).json({ error: 'Ugyldig e-mailadresse' });
  }
  if(remindersEnabled && !email){
    return res.status(400).json({ error: 'Angiv en e-mail for at slå påmindelser til' });
  }
  const db = readDb();
  db.users[req.username].email = email || null;
  db.users[req.username].remindersEnabled = remindersEnabled;
  writeDb(db);
  res.json({ ok: true });
});

// ---------- Shared gardens ----------
app.get('/api/garden/invite', authMiddleware, (req, res) => {
  const db = readDb();
  let code = Object.keys(db.invites).find(c => db.invites[c].gardenId === req.gardenId);
  if(!code){
    code = crypto.randomBytes(6).toString('hex');
    db.invites[code] = { gardenId: req.gardenId, createdAt: Date.now() };
    writeDb(db);
  }
  res.json({ code, joinUrl: PUBLIC_URL ? `${PUBLIC_URL}/?join=${code}` : null });
});

app.post('/api/garden/join', authMiddleware, (req, res) => {
  const code = String(req.body.code || '').trim();
  const db = readDb();
  const invite = db.invites[code];
  if(!invite) return res.status(400).json({ error: 'Ugyldig invitationskode' });

  const oldGardenId = req.gardenId;
  db.users[req.username].gardenId = invite.gardenId;
  if(!db.gardens[invite.gardenId]) db.gardens[invite.gardenId] = emptyGarden();
  if(!db.gardens[invite.gardenId].members) db.gardens[invite.gardenId].members = [];
  if(!db.gardens[invite.gardenId].members.includes(req.username)){
    db.gardens[invite.gardenId].members.push(req.username);
  }
  if(db.gardens[oldGardenId] && db.gardens[oldGardenId].members){
    db.gardens[oldGardenId].members = db.gardens[oldGardenId].members.filter(m => m !== req.username);
  }
  writeDb(db);
  res.json({ ok: true, gardenId: invite.gardenId });
});

app.post('/api/garden/leave', authMiddleware, (req, res) => {
  const db = readDb();
  if(req.gardenId === req.username){
    return res.status(400).json({ error: 'Du er allerede i din egen have' });
  }
  const oldGardenId = req.gardenId;
  db.users[req.username].gardenId = req.username;
  if(!db.gardens[req.username]) db.gardens[req.username] = emptyGarden();
  if(!db.gardens[req.username].members) db.gardens[req.username].members = [req.username];
  if(db.gardens[oldGardenId] && db.gardens[oldGardenId].members){
    db.gardens[oldGardenId].members = db.gardens[oldGardenId].members.filter(m => m !== req.username);
  }
  writeDb(db);
  res.json({ ok: true });
});

// ---------- Garden data ----------
app.get('/api/garden', authMiddleware, (req, res) => {
  const db = readDb();
  const garden = db.gardens[req.gardenId] || emptyGarden();
  res.json({ garden });
});

app.put('/api/garden', authMiddleware, (req, res) => {
  const garden = req.body.garden;
  if(!garden || typeof garden !== 'object'){
    return res.status(400).json({ error: 'Ugyldige havedata' });
  }
  const db = readDb();
  const existing = db.gardens[req.gardenId] || emptyGarden();
  garden.members = existing.members || [req.username]; // members list is server-managed, not client-writable
  db.gardens[req.gardenId] = garden;
  writeDb(db);
  res.json({ ok: true });
});

// ---------- Forgot / reset password ----------
app.post('/api/forgot-password', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  // Always respond the same way whether or not the email exists, so this
  // endpoint can't be used to check which addresses have an account.
  const genericResponse = { ok: true, message: 'Hvis adressen findes i systemet, er der sendt en mail med et link til at nulstille adgangskoden.' };
  if(!email || !EMAIL_RE.test(email)) return res.json(genericResponse);

  const db = readDb();
  const username = Object.keys(db.users).find(u => (db.users[u].email || '').toLowerCase() === email);
  if(!username) return res.json(genericResponse);

  const token = crypto.randomBytes(24).toString('hex');
  db.resetTokens[token] = { username, expires: Date.now() + 60 * 60 * 1000 };
  writeDb(db);

  const link = PUBLIC_URL ? `${PUBLIC_URL}/?reset=${token}` : null;
  const linkText = link ? `Klik her for at vælge en ny adgangskode: ${link}` : `Åbn Havehjulet og indsæt denne kode på nulstillingssiden: ${token}`;
  await sendMail({
    to: email,
    subject: 'Nulstil din adgangskode til Havehjulet',
    text: `Hej ${username}\n\n${linkText}\n\nLinket/koden udløber om 1 time. Har du ikke bedt om dette, kan du roligt ignorere denne mail.`,
  });

  res.json(genericResponse);
});

app.post('/api/reset-password', async (req, res) => {
  const token = String(req.body.token || '').trim();
  const password = String(req.body.password || '');
  if(password.length < 4){
    return res.status(400).json({ error: 'Adgangskoden skal være mindst 4 tegn' });
  }
  const db = readDb();
  const entry = db.resetTokens[token];
  if(!entry || entry.expires < Date.now()){
    return res.status(400).json({ error: 'Linket er ugyldigt eller udløbet — bed om et nyt' });
  }
  db.users[entry.username].hash = await bcrypt.hash(password, 10);
  delete db.resetTokens[token];
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

// ---------- Trefle proxy (keeps the API key server-side only) ----------
app.get('/api/trefle/search', authMiddleware, async (req, res) => {
  if(!TREFLE_API_KEY) return res.status(503).json({ error: 'Ingen Trefle-nøgle sat op på serveren' });
  const q = String(req.query.q || '').trim();
  if(!q) return res.json({ data: [] });
  try{
    const url = `https://trefle.io/api/v1/plants/search?token=${encodeURIComponent(TREFLE_API_KEY)}&q=${encodeURIComponent(q)}`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  }catch(e){
    res.status(502).json({ error: 'Kunne ikke kontakte Trefle' });
  }
});

app.get('/api/trefle/details/:id', authMiddleware, async (req, res) => {
  if(!TREFLE_API_KEY) return res.status(503).json({ error: 'Ingen Trefle-nøgle sat op på serveren' });
  const id = String(req.params.id).replace(/[^0-9]/g, '');
  try{
    const url = `https://trefle.io/api/v1/plants/${id}?token=${encodeURIComponent(TREFLE_API_KEY)}`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  }catch(e){
    res.status(502).json({ error: 'Kunne ikke kontakte Trefle' });
  }
});

// ---------- Pl@ntNet proxy: identify a plant from a photo ----------
app.post('/api/plantnet/identify', authMiddleware, upload.single('image'), async (req, res) => {
  if(!PLANTNET_API_KEY) return res.status(503).json({ error: 'Ingen Pl@ntNet-nøgle sat op på serveren' });
  if(!req.file) return res.status(400).json({ error: 'Intet billede modtaget' });
  try{
    const form = new FormData();
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype || 'image/jpeg' });
    form.append('images', blob, req.file.originalname || 'photo.jpg');
    form.append('organs', 'auto');
    const url = `https://my-api.plantnet.org/v2/identify/all?api-key=${encodeURIComponent(PLANTNET_API_KEY)}&lang=da`;
    const r = await fetch(url, { method: 'POST', body: form });
    const data = await r.json();
    res.status(r.status).json(data);
  }catch(e){
    res.status(502).json({ error: 'Kunne ikke kontakte Pl@ntNet' });
  }
});

// ---------- Photo uploads (growth log / plant photo history) ----------
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const EXT_BY_MIME = { 'image/jpeg':'jpg', 'image/png':'png', 'image/webp':'webp', 'image/gif':'gif' };

app.post('/api/upload-image', authMiddleware, upload.single('image'), (req, res) => {
  if(!req.file) return res.status(400).json({ error: 'Intet billede modtaget' });
  if(!ALLOWED_IMAGE_TYPES.includes(req.file.mimetype)){
    return res.status(400).json({ error: 'Kun JPEG, PNG, WEBP eller GIF er tilladt' });
  }
  const ext = EXT_BY_MIME[req.file.mimetype] || 'jpg';
  const filename = `${req.gardenId}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), req.file.buffer);
  res.json({ url: `/uploads/${filename}` });
});

// ---------- Monthly reminder emails ----------
const GENERIC_TASKS = {
  0:'Planlæg årets have og bestil frø, mens jorden hviler',
  1:'Beskær frugttræer og prydbuske i frostfrit vejr, inden saftspring',
  2:'Gød bede og græsplæne, forspir grøntsager indendørs',
  3:'Så direkte i bedet, fjern vinterdække, luft komposten',
  4:'Plant sommerblomster ud efter sidste nattefrost',
  5:'Vand nyplantede planter godt til, luk ukrudt væk mens det er småt',
  6:'Vand i tørkeperioder, høst tidlige grøntsager og bær',
  7:'Klip hække, høst løbende, så vintergrønt',
  8:'Plant efterårsløg, del stauder, så vinterdække-afgrøder',
  9:'Rag løv sammen (brug det som muld!), plant nye træer og buske',
  10:'Dæk sarte planter til inden frost, hjemtag potteplanter',
  11:'Beskyt potter mod frost, rens og olier haveredskaber, planlæg næste sæson'
};
const MONTHS_FULL = ['januar','februar','marts','april','maj','juni','juli','august','september','oktober','november','december'];

function buildMonthEmailBody(gardenId, month, db){
  const garden = db.gardens[gardenId] || emptyGarden();
  const plantTasks = (garden.plants || []).filter(p => p.tasks && p.tasks[month]);
  let lines = [];
  if(plantTasks.length){
    lines.push('Dine planter:');
    plantTasks.forEach(p => lines.push(`  • ${p.name}: ${p.tasks[month]}`));
    lines.push('');
  }
  lines.push('Generelt i haven:');
  lines.push(`  • ${GENERIC_TASKS[month]}`);
  return lines.join('\n');
}

async function runMonthlyReminders(targetUsername){
  const db = readDb();
  const month = new Date().getMonth();
  const usernames = targetUsername ? [targetUsername] : Object.keys(db.users);

  for(const username of usernames){
    const user = db.users[username];
    if(!user || !user.email || !user.remindersEnabled) continue;
    const gardenId = resolveGardenId(db, username).gardenId;
    const body = buildMonthEmailBody(gardenId, month, db);
    await sendMail({
      to: user.email,
      subject: `Havehjulet — det sker i din have i ${MONTHS_FULL[month]}`,
      text: `Hej ${username}\n\nHer er hvad der er værd at kigge på i haven i ${MONTHS_FULL[month]}:\n\n${body}\n\nÅbn Havehjulet for flere detaljer.`
    });
  }
  writeDb(db); // persists any gardenId migration from resolveGardenId
}

app.post('/api/reminders/send-test', authMiddleware, async (req, res) => {
  const db = readDb();
  const user = db.users[req.username];
  if(!user.email){
    return res.status(400).json({ error: 'Angiv en e-mail under kontoindstillinger først' });
  }
  await runMonthlyReminders(req.username);
  res.json({ ok: true });
});

// 08:00 on the 1st of every month
cron.schedule('0 8 1 * *', () => {
  runMonthlyReminders().catch(err => console.error('Fejl i månedlig påmindelse:', err));
});

app.listen(PORT, () => {
  console.log(`Havehjulet kører på port ${PORT}`);
});
