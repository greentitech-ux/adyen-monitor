// storage.js
// Guarda as imagens anexadas nas disputas de chargeback no Firebase Cloud
// Storage (mesmo projeto/credenciais do Firestore) - nao expomos URL publica,
// as imagens sao servidas via streaming pelo nosso proprio backend (index.js).
const admin = require('firebase-admin');
require('./firestore'); // garante que o app do firebase-admin ja foi inicializado

const bucketName = process.env.FIREBASE_STORAGE_BUCKET || `${process.env.FIREBASE_PROJECT_ID}.appspot.com`;
const bucket = admin.storage().bucket(bucketName);

function caminhoSeguro(nome) {
  return (nome || 'imagem').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

async function salvarImagem(pedidoId, file) {
  const caminho = `disputes/${caminhoSeguro(pedidoId)}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${caminhoSeguro(file.originalname)}`;
  const blob = bucket.file(caminho);
  await blob.save(file.buffer, { contentType: file.mimetype || 'application/octet-stream' });
  return caminho;
}

function streamImagem(caminho, res) {
  bucket
    .file(caminho)
    .createReadStream()
    .on('error', (err) => {
      console.error('Erro ao ler imagem do Storage:', err.message);
      if (!res.headersSent) res.sendStatus(404);
    })
    .pipe(res);
}

async function apagarImagem(caminho) {
  await bucket.file(caminho).delete({ ignoreNotFound: true });
}

module.exports = { salvarImagem, streamImagem, apagarImagem };
