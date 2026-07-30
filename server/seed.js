// seed.js
// Uso opcional: importa o snapshot que já tínhamos da planilha para popular
// o dashboard com dados de teste antes de plugar o webhook de verdade.
//   node seed.js caminho/para/adyen_norm.json

const fs = require('fs');
const store = require('./store');

const file = process.argv[2];
if (!file) {
  console.error('Uso: node seed.js caminho/para/adyen_norm.json');
  process.exit(1);
}

const rows = JSON.parse(fs.readFileSync(file, 'utf-8'));

let n = 0;
for (const r of rows) {
  store.addOrUpdate({
    pspReference: 'seed-' + n,
    merchantReference: null,
    eventCode: r.status === 'APROVADO' || r.status === 'RECUSADO' ? 'AUTHORISATION' : r.status,
    status: r.status,
    fraudeSuspeita: (r.motivo || '').toLowerCase().includes('fraud'),
    motivo: r.motivo || '',
    valor: r.valor,
    moeda: 'BRL',
    metodo: r.metodo,
    last4: (r.cartao || '').slice(-4),
    bin: null,
    cardHolder: r.cliente,
    shopperReference: null,
    unidade: r.unidade,
    dataHora: r.dt,
    disputeStatus: null,
    bancoEmissor: null,
  });
  n++;
}

console.log(`Importadas ${n} transações de teste.`);
