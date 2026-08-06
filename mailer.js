const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || 'havehjulet@localhost';
const SMTP_SECURE = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true';

let transporter = null;
const isConfigured = !!(SMTP_HOST && SMTP_USER && SMTP_PASS);

if(isConfigured){
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE || SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
}

async function sendMail({ to, subject, text, html }){
  if(!isConfigured){
    console.log(`[mailer] SMTP ikke konfigureret — ville have sendt til ${to}: "${subject}"`);
    return { skipped: true };
  }
  return transporter.sendMail({ from: `Havehjulet <${SMTP_FROM}>`, to, subject, text, html });
}

module.exports = { sendMail, isConfigured };
