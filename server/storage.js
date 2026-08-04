// storage.js
// Guarda os anexos das disputas/observacoes de pedido (foto, print, video,
// audio de ligacao, etc.) no Firebase Cloud Storage (mesmo projeto/credenciais
// do Firestore) - nao expomos URL publica, os arquivos sao servidos via
// streaming pelo proprio backend (index.js).
const admin = require('firebase-admin');
require('./firestore'); // garante que o app do firebase-admin ja foi inicializado
const { resolverBucket } = require('./storageBucket');

function caminhoSeguro(nome) {
  return (nome || 'arquivo').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

async function salvarArquivo(pedidoId, file, pasta = 'disputes') {
  const bucket = await resolverBucket();
  const caminho = `${pasta}/${caminhoSeguro(pedidoId)}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${caminhoSeguro(file.originalname)}`;
  try {
    await bucket.file(caminho).save(file.buffer, { contentType: file.mimetype || 'application/octet-stream' });
  } catch (err) {
    console.error('Erro ao salvar arquivo no Storage:', err.message);
    throw new Error('Não foi possível enviar o arquivo agora. Tente novamente em instantes ou contate o suporte.');
  }
  return caminho;
}

async function streamArquivo(caminho, tipo, res) {
  const bucket = await resolverBucket();
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
  const bucket = await resolverBucket();
  await bucket.file(caminho).delete({ ignoreNotFound: true });
}

module.exports = { salvarArquivo, streamArquivo, apagarArquivo };
