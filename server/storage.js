// storage.js
// Guarda os anexos das disputas/observacoes de pedido (foto, print, video,
// audio de ligacao, etc.) no Firebase Cloud Storage (mesmo projeto/credenciais
// do Firestore) - nao expomos URL publica, os arquivos sao servidos via
// streaming pelo proprio backend (index.js).
const admin = require('firebase-admin');
require('./firestore'); // garante que o app do firebase-admin ja foi inicializado

const bucketName = process.env.FIREBASE_STORAGE_BUCKET || `${process.env.FIREBASE_PROJECT_ID}.appspot.com`;
const bucket = admin.storage().bucket(bucketName);

function caminhoSeguro(nome) {
  return (nome || 'arquivo').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

async function salvarArquivo(pedidoId, file) {
  const caminho = `disputes/${caminhoSeguro(pedidoId)}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${caminhoSeguro(file.originalname)}`;
  const blob = bucket.file(caminho);
  await blob.save(file.buffer, { contentType: file.mimetype || 'application/octet-stream' });
  return caminho;
}

function streamArquivo(caminho, tipo, res) {
  if (tipo) res.set('Content-Type', tipo);
  bucket
    .file(caminho)
    .createReadStream()
    .on('error', (err) => {
      console.error('Erro ao ler arquivo do Storage:', err.message);
      if (!res.headersSent) res.sendStatus(404);
    })
    .pipe(res);
}

async function apagarArquivo(caminho) {
  await bucket.file(caminho).delete({ ignoreNotFound: true });
}

module.exports = { salvarArquivo, streamArquivo, apagarArquivo };
