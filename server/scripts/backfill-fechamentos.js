// backfill-fechamentos.js
// Roda uma unica vez: le tudo que ainda existe em "transactions" (ate 90
// dias, por causa da retencao) e popula "fechamentos_diarios" com esse
// historico, para nao perder o que ja esta disponivel hoje antes de a
// retencao apagar essas transacoes.
//
// Uso: node server/scripts/backfill-fechamentos.js

const db = require('../firestore');
const { registrarFechamento } = require('../fechamento');

async function main() {
  const snap = await db.collection('transactions').get();
  console.log(`Encontradas ${snap.size} transacoes em "transactions".`);

  let processadas = 0;
  for (const doc of snap.docs) {
    await registrarFechamento(doc.data());
    processadas += 1;
    if (processadas % 100 === 0) console.log(`${processadas}/${snap.size}...`);
  }

  console.log(`Concluido: ${processadas} transacoes agregadas em "fechamentos_diarios".`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Erro no backfill:', err);
    process.exit(1);
  });
