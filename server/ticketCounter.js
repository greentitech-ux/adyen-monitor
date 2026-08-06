// ticketCounter.js
// Numero sequencial e global de ticket (Ticket #10000, #10001...) atribuido a
// QUALQUER solicitacao criada na Central - estorno, ajuste de fechamento,
// compra, manutencao, suporte de TI, pagamento ou nota. E uma unica sequencia
// compartilhada entre os 3 modulos (refunds.js, fechamentosLive.js,
// solicitacoes.js), nao um contador por tipo - assim o numero do ticket
// continua fazendo sentido mesmo quando ele muda de tipo (ver mudarTipo/
// converterPara* em solicitacoes.js e refunds.js).
const db = require('./firestore');

const REF = db.collection('contadores').doc('tickets');
const INICIAL = 10000;

async function proximoTicket() {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(REF);
    const atual = snap.exists && Number.isFinite(snap.data().proximo) ? snap.data().proximo : INICIAL;
    tx.set(REF, { proximo: atual + 1 }, { merge: true });
    return atual;
  });
}

module.exports = { proximoTicket };
