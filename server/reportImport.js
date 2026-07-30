// reportImport.js
// Converte linhas do "Payment accounting report" da Adyen (CSV) no mesmo formato
// que normalize.js gera a partir dos webhooks - assim os dois caminhos alimentam
// o mesmo store e o agrupamento por pedido (merchantReference) funciona igual.
// https://docs.adyen.com/reporting/invoice-reconciliation/payment-accounting-report

const RECORD_TYPE_TO_EVENT = {
  authorised: { eventCode: 'AUTHORISATION', success: true },
  captured: { eventCode: 'AUTHORISATION', success: true },
  settled: { eventCode: 'AUTHORISATION', success: true },
  refunded: { eventCode: 'REFUND', success: true },
  refundfailed: { eventCode: 'REFUND_FAILED', success: false },
  chargeback: { eventCode: 'CHARGEBACK', success: true },
  secondchargeback: { eventCode: 'CHARGEBACK', success: true },
  chargebackexternally: { eventCode: 'CHARGEBACK', success: true },
  chargebackexternallywithinfo: { eventCode: 'CHARGEBACK', success: true },
  chargebackreversed: { eventCode: 'CHARGEBACK_REVERSED', success: true },
  chargebackreversedexternallywithinfo: { eventCode: 'CHARGEBACK_REVERSED', success: true },
};

function statusForEvent(eventCode, success) {
  if (eventCode === 'AUTHORISATION') return success ? 'APROVADO' : 'RECUSADO';
  if (eventCode === 'REFUND') return success ? 'ESTORNADO' : 'FALHA_ESTORNO';
  if (eventCode === 'REFUND_FAILED') return 'FALHA_ESTORNO';
  if (eventCode === 'CHARGEBACK') return 'CHARGEBACK';
  if (eventCode === 'CHARGEBACK_REVERSED') return 'CHARGEBACK_REVERTIDO';
  return eventCode;
}

function normalizeHeader(h) {
  return h.trim().toLowerCase().replace(/\s+/g, ' ');
}

// os nomes de coluna variam um pouco conforme a versao/idioma do relatorio -
// procura por qualquer uma das variantes dadas
function pick(row, ...names) {
  const keys = Object.keys(row);
  for (const wanted of names) {
    const key = keys.find((k) => normalizeHeader(k) === wanted);
    if (key && row[key] !== undefined && row[key] !== '') return row[key];
  }
  return null;
}

function last4FromCardNumber(v) {
  if (!v) return null;
  const digits = String(v).replace(/[^0-9]/g, '');
  return digits ? digits.slice(-4) : null;
}

function parseBookingDate(dateStr) {
  if (!dateStr) return new Date().toISOString();
  const trimmed = String(dateStr).trim().replace(' ', 'T');
  const d = new Date(trimmed.length === 19 ? trimmed + 'Z' : trimmed);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

// converte uma linha (objeto com as colunas do CSV) numa transacao no formato
// do dashboard, ou null se for um tipo de registro que nao rastreamos
// (taxas, linhas reservadas, etc.)
function rowToTx(row) {
  const recordType = (pick(row, 'record type') || '').trim().toLowerCase();
  const mapping = RECORD_TYPE_TO_EVENT[recordType];
  if (!mapping) return null;

  const pspReference = pick(row, 'psp reference');
  if (!pspReference) return null;

  const status = statusForEvent(mapping.eventCode, mapping.success);
  const amountStr = pick(row, 'main amount', 'payable (sc)') || '0';
  const valor = Math.abs(parseFloat(String(amountStr).replace(',', '.')) || 0);
  const unidade = pick(row, 'merchant account');

  return {
    pspReference,
    merchantReference: pick(row, 'merchant reference'),
    eventCode: mapping.eventCode,
    status,
    fraudeSuspeita: false,
    motivo: '',
    valor,
    moeda: pick(row, 'main currency', 'payment currency') || 'BRL',
    metodo: pick(row, 'payment method') || '?',
    last4: last4FromCardNumber(pick(row, 'card number')),
    bin: null,
    cardHolder: null,
    shopperReference: unidade ? `${unidade}:` : null,
    unidade,
    dataHora: parseBookingDate(pick(row, 'booking date')),
    disputeStatus: null,
    bancoEmissor: null,
    origem: 'backfill-report',
  };
}

module.exports = { rowToTx, normalizeHeader, pick };
