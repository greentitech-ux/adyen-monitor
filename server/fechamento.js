// fechamento.js
// Fechamento diario agregado por unidade: 1 documento por unidade+dia,
// sem prazo de retencao (diferente de "transactions", que e podada a cada
// RETENTION_DAYS). Serve para comparar faturamento entre anos (ano atual
// vs ano-1, ano-2 etc), quando o detalhe transacao-a-transacao ja nao
// existe mais.

const admin = require('firebase-admin');
const db = require('./firestore');
const COLLECTION = db.collection('fechamentos_diarios');

function diaFrom(dataHoraISO) {
  return (dataHoraISO || new Date().toISOString()).slice(0, 10); // AAAA-MM-DD
}

function docId(unidade, dia) {
  return `${unidade}_${dia}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

const CAMPO_POR_STATUS = {
  APROVADO: 'aprovado',
  RECUSADO: 'recusado',
  ESTORNADO: 'estornado',
  CHARGEBACK: 'chargeback',
};

// upsert incremental: soma valor/contagem do dia sem precisar reler o
// documento inteiro a cada transacao (FieldValue.increment cuida da
// concorrencia no proprio Firestore)
async function registrarFechamento(tx) {
  const campo = CAMPO_POR_STATUS[tx.status];
  if (!campo) return; // so agregamos os status relevantes para faturamento

  const unidade = tx.unidade || 'desconhecida';
  const dia = diaFrom(tx.dataHora);
  const ref = COLLECTION.doc(docId(unidade, dia));

  await ref.set(
    {
      unidade,
      dia,
      [`${campo}Valor`]: admin.firestore.FieldValue.increment(tx.valor || 0),
      [`${campo}Qtd`]: admin.firestore.FieldValue.increment(1),
      atualizadoEm: new Date().toISOString(),
    },
    { merge: true }
  );
}

// consulta o periodo pedido (ex: comparar ano atual vs ano-1) direto no
// Firestore - nao passa pelo cache em memoria, ja que esses documentos so
// precisam ser lidos quando alguem pede um relatorio
async function fechamentosNoPeriodo(unidade, de, ate) {
  let query = COLLECTION.where('dia', '>=', de).where('dia', '<=', ate);
  if (unidade) query = query.where('unidade', '==', unidade);
  const snap = await query.get();
  return snap.docs.map((d) => d.data());
}

module.exports = { registrarFechamento, fechamentosNoPeriodo };
