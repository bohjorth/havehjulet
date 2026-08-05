// Simple JSON-file "database". Fine for a small, personal/family-scale app.
// Not built for heavy concurrent write load, but Node's single-threaded
// event loop plus synchronous writes keeps it safe for this use case.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'db.json');

function ensureDb(){
  const dir = path.dirname(DB_PATH);
  if(!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if(!fs.existsSync(DB_PATH)){
    fs.writeFileSync(DB_PATH, JSON.stringify({ users:{}, sessions:{}, gardens:{} }, null, 2));
  }
}

function readDb(){
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function writeDb(data){
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

module.exports = { readDb, writeDb, ensureDb };
