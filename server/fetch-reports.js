// fetch-reports.js
// Baixa automaticamente os "payments_accounting_report" diarios da Adyen e
// importa cada um pro historico local. Preenche o backfill dos ultimos N dias
// de uma vez (padrao: 90 = 3 meses).
//
// Exige uma credencial de API do tipo "Report user" (Customer Area >
// Developers > API credentials > Create new credential > User type: Report
// user), com a permissao "Merchant Report Download role" e uma senha de
// Basic Auth configurada nela.
//
// Configure no .env:
//   ADYEN_REPORT_USER=ws_xxxxx@Company.SuaEmpresa
//   ADYEN_REPORT_PASSWORD=sua_senha_de_basic_auth
//   ADYEN_MERCHANT_ACCOUNT=NomeDaSuaContaMerchant
//   ADYEN_REPORTS_HOST=ca-live.adyen.com   (ou ca-test.adyen.com em sandbox)
//
// Uso: node fetch-reports.js --days 90
require('dotenv').config();
const { parse } = require('csv-parse/sync');
const store = require('./store');
const { rowToTx } = require('./reportImport');

const USER = process.env.ADYEN_REPORT_USER;
const PASS = process.env.ADYEN_REPORT_PASSWORD;
const MERCHANT_ACCOUNT = process.env.ADYEN_MERCHANT_ACCOUNT;
const HOST = process.env.ADYEN_REPORTS_HOST || 'ca-live.adyen.com';

const daysArg = process.argv.indexOf('--days');
const DAYS = daysArg >= 0 ? parseInt(process.argv[daysArg + 1], 10) : 90;

if (!USER || !PASS || !MERCHANT_ACCOUNT) {
  console.error(
    'Faltam variaveis no .env: ADYEN_REPORT_USER, ADYEN_REPORT_PASSWORD, ADYEN_MERCHANT_ACCOUNT.\n' +
      'Crie uma credencial "Report user" na Customer Area (Developers > API credentials) e configure-as antes de rodar este script.'
  );
  process.exit(1);
}

function dateStr(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '_');
}

async function fetchOneDay(d) {
  const filename = `payments_accounting_report_${dateStr(d)}.csv`;
  const url = `https://${HOST}/reports/download/MerchantAccount/${encodeURIComponent(MERCHANT_ACCOUNT)}/${filename}`;
  const auth = Buffer.from(`${USER}:${PASS}`).toString('base64');
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });

  if (res.status === 404) return { filename, status: 'sem relatorio nesse dia' };
  if (!res.ok) return { filename, status: `erro HTTP ${res.status}` };

  const content = await res.text();
  const rows = parse(content, { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true });
  let imported = 0;
  for (const row of rows) {
    const tx = rowToTx(row);
    if (!tx) continue;
    store.addOrUpdate(tx);
    imported++;
  }
  return { filename, status: `${imported} transacoes importadas (${rows.length} linhas no CSV)` };
}

async function main() {
  console.log(`Buscando relatorios dos ultimos ${DAYS} dias em ${HOST} para a conta ${MERCHANT_ACCOUNT}...`);
  const today = new Date();
  for (let i = 1; i <= DAYS; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    try {
      const r = await fetchOneDay(d);
      console.log(`${dateStr(d)} · ${r.filename} · ${r.status}`);
    } catch (e) {
      console.log(`${dateStr(d)} · erro: ${e.message}`);
    }
  }
  console.log('Concluido.');
}

main();
