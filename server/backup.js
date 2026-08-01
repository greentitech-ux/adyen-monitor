// backup.js
// Backup automatico do banco: 1x por dia (e sob pedido do Master) exporta as
// colecoes criticas do Firestore para um arquivo JSON no Firebase Storage.
// Isso e o que garante que os dados nao se perdem mesmo se algo apagar/
// corromper o Firestore por engano - o Master consegue restaurar a partir
// de qualquer um desses arquivos. Mantem so os ultimos RETENCAO_DIAS pra nao
// crescer pra sempre.
const admin = require('firebase-admin');
const db = require('./firestore'); // garante que o app do firebase-admin ja foi inicializado

const bucketName = process.env.FIREBASE_STORAGE_BUCKET || `${process.env.FIREBASE_PROJECT_ID}.appspot.com`;
const bucket = admin.storage().bucket(bucketName);

const COLECOES = [
  'transactions', 'orders', 'chargebacks', 'disputes', 'users',
  'vaultGroups', 'vaultSubgroups', 'vaultEntries', 'refundRequests',
  'fechamentosLive', 'fechamentoEdicoes',
];

const RETENCAO_DIAS = 30;

async function exportarColecao(nome) {
  const snap = await db.collection(nome).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function rodarBackup() {
  const dump = {};
  for (const nome of COLECOES) {
    dump[nome] = await exportarColecao(nome);
  }
  const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
  const caminho = `backups/${carimbo}.json`;
  await bucket.file(caminho).save(JSON.stringify(dump), { contentType: 'application/json' });
  await limparAntigos();

  const registros = Object.values(dump).reduce((soma, lista) => soma + lista.length, 0);
  console.log(`Backup do banco criado: ${caminho} (${registros} registros em ${COLECOES.length} coleções).`);
  return { caminho, colecoes: COLECOES.length, registros, criadoEm: new Date().toISOString() };
}

async function limparAntigos() {
  const [arquivos] = await bucket.getFiles({ prefix: 'backups/' });
  const limite = Date.now() - RETENCAO_DIAS * 24 * 60 * 60 * 1000;
  await Promise.all(
    arquivos
      .filter((f) => new Date(f.metadata.timeCreated).getTime() < limite)
      .map((f) => f.delete().catch(() => {})),
  );
}

async function listarBackups() {
  const [arquivos] = await bucket.getFiles({ prefix: 'backups/' });
  return arquivos
    .map((f) => ({ nome: f.name.replace('backups/', ''), criadoEm: f.metadata.timeCreated, tamanhoBytes: Number(f.metadata.size) || 0 }))
    .sort((a, b) => (b.criadoEm || '').localeCompare(a.criadoEm || ''));
}

module.exports = { rodarBackup, listarBackups };
