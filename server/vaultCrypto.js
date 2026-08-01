// vaultCrypto.js
// Criptografia das senhas guardadas no cofre (AES-256-GCM) antes de salvar no
// Firestore - assim, quem tiver acesso direto ao banco nao ve as senhas em
// texto puro. A chave vem de ENCRYPTION_KEY (env var), nunca do codigo.
const crypto = require('crypto');

const RAW_KEY = process.env.ENCRYPTION_KEY || '';
if (!RAW_KEY) {
  throw new Error('ENCRYPTION_KEY ausente. Configure uma chave forte (veja server/.env.example).');
}
// aceita qualquer string e deriva uma chave de 32 bytes (AES-256) a partir dela
const KEY = crypto.createHash('sha256').update(RAW_KEY).digest();

function encrypt(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString('hex'),
    tag: authTag.toString('hex'),
    data: encrypted.toString('hex'),
  };
}

function decrypt(payload) {
  if (!payload || !payload.iv || !payload.tag || !payload.data) return '';
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(payload.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(payload.data, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt };
