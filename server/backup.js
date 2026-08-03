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

// esse backup le TODAS as colecoes por inteiro (a de "transactions" e de
// longe a maior) - antes rodava sem nenhuma guarda de frequencia, direto no
// boot do servidor (server/index.js chama no start() e depois 1x/dia). Isso
// e barato quando o servidor sobe uma vez e fica no ar, mas em hospedagem
// com "sleep" por inatividade (ex: plano free do Render) o processo reinicia
// a cada acesso apos um periodo ocioso - e cada reinicio rodava o backup de
// novo, relendo TODAS as colecoes inteiras do zero. Foi isso (nao um bug de
// logica) que estourou a cota diaria de leitura do Firestore (free tier:
// 50 mil leituras/dia) e derrubou o servico. O cooldown abaixo garante que a
// releitura completa acontece no maximo 1x a cada ~20h, nao importa quantas
// vezes o processo reiniciar nesse meio tempo - mesmo que o upload pro
// Storage esteja falhando (ex: bucket mal configurado), o que evitaria o
// cooldown "resetar" via listarBackups() sozinho.
const COOLDOWN_MS = 20 * 60 * 60 * 1000;
const META_DOC = db.collection('meta').doc('backupStatus');

async function exportarColecao(nome) {
  const snap = await db.collection(nome).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// forcar:true ignora o cooldown - usado pelo botao "rodar agora" do Master
// (POST /api/backups/run), que e uma acao explicita e rara, nao um boot
async function rodarBackup({ forcar = false } = {}) {
  if (!forcar) {
    const statusSnap = await META_DOC.get();
    const ultimaTentativaEm = statusSnap.exists ? statusSnap.data().ultimaTentativaEm : null;
    if (ultimaTentativaEm && Date.now() - new Date(ultimaTentativaEm).getTime() < COOLDOWN_MS) {
      return { pulou: true, motivo: 'Backup já tentado há menos de 20h - pulado pra não reler o banco inteiro a cada reinício do servidor.', ultimaTentativaEm };
    }
  }
  // grava a tentativa ANTES de ler as colecoes - assim, mesmo que o processo
  // reinicie no meio do backup (ex: novo deploy), o cooldown ja vale e o
  // proximo boot nao repete a leitura completa em seguida
  const agora = new Date().toISOString();
  await META_DOC.set({ ultimaTentativaEm: agora }, { merge: true });

  const dump = {};
  for (const nome of COLECOES) {
    dump[nome] = await exportarColecao(nome);
  }
  const carimbo = agora.replace(/[:.]/g, '-');
  const caminho = `backups/${carimbo}.json`;
  await bucket.file(caminho).save(JSON.stringify(dump), { contentType: 'application/json' });
  await limparAntigos();
  await META_DOC.set({ ultimoSucessoEm: new Date().toISOString() }, { merge: true });

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
