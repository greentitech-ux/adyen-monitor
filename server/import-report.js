// import-report.js
// Importa um "Payment accounting report" (CSV) baixado da Adyen para o
// historico local, preenchendo lacunas de antes do webhook existir.
//
// Uso: node import-report.js caminho/para/relatorio.csv
require('dotenv').config();
const fs = require('fs');
const { parse } = require('csv-parse/sync');
const store = require('./store');
const { rowToTx } = require('./reportImport');

const file = process.argv[2];
if (!file) {
  console.error('Uso: node import-report.js <arquivo.csv>');
  process.exit(1);
}

const content = fs.readFileSync(file, 'utf-8');
const rows = parse(content, { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true });

let imported = 0;
let skipped = 0;
for (const row of rows) {
  const tx = rowToTx(row);
  if (!tx) {
    skipped++;
    continue;
  }
  store.addOrUpdate(tx);
  imported++;
}

console.log(`Relatorio: ${file}`);
console.log(`Linhas no CSV: ${rows.length} · Importadas: ${imported} · Ignoradas (fees/tipos nao rastreados): ${skipped}`);
