// normalize.js
// Converte um NotificationRequestItem da Adyen no formato que o dashboard usa.
// Referencia de eventCodes: https://docs.adyen.com/development-resources/webhooks/notification-structure/

function centsToReais(amount) {
  if (!amount || typeof amount.value !== 'number') return 0;
  return amount.value / 100;
}

function statusFromEvent(item) {
  const code = item.eventCode;
  const success = item.success === 'true' || item.success === true;
  const reason = item.reason || '';
  const additional = item.additionalData || {};

  if (code === 'AUTHORISATION') {
    return success ? 'APROVADO' : 'RECUSADO';
  }
  if (code === 'REFUND') return success ? 'ESTORNADO' : 'FALHA_ESTORNO';
  if (code === 'REFUND_FAILED') return 'FALHA_ESTORNO';
  if (code === 'POSTPONED_REFUND') return 'ESTORNO_AGENDADO';
  if (code === 'REFUNDED_REVERSED') return 'ESTORNO_REVERTIDO';
  if (code === 'CHARGEBACK') return 'CHARGEBACK';
  if (code === 'CHARGEBACK_REVERSED') return 'CHARGEBACK_REVERTIDO';
  if (code === 'SECOND_CHARGEBACK') return 'CHARGEBACK';
  if (code === 'NOTIFICATION_OF_CHARGEBACK') return 'NOTIFICATION_OF_CHARGEBACK';
  if (code === 'PROCESS_RETRIEVAL') return 'RETRIEVAL_REQUEST';
  // fim do periodo em que o lojista pode contestar a disputa
  if (code === 'DISPUTE_DEFENSE_PERIOD_ENDED' || additional.disputeStatus === 'DefensePeriodEnded') {
    return 'DISPUTE_DEFENSE_PERIOD_ENDED';
  }
  return code || 'DESCONHECIDO';
}

function isFraudSuspect(item) {
  const reason = (item.reason || '').toLowerCase();
  const additional = item.additionalData || {};
  if (reason.includes('fraud')) return true;
  if (additional.fraudResultType && additional.fraudResultType !== 'GREEN') return true;
  if (Number(additional.totalFraudScore) >= 30) return true; // ajuste o limite conforme sua configuracao de risco
  return false;
}

// a Adyen manda o shopperName como uma string no formato
// "[first name=Paulo, infix=null, last name=Hiram, gender=null]" - extrai
// so o nome, removendo "null" e espacos duplicados (mesma limpeza da formula
// MAP/REGEXREPLACE que ja era usada na planilha)
function cleanShopperNameString(str) {
  return str
    .replace(/\[first name=([^,]*), infix=[^,]*,,? ?last name=([^,]*), gender=.*\]/, '$1 $2')
    .replace(/\bnull\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// nome de quem fez o pedido (shopper) - separado do nome impresso no cartao,
// igual a planilha de referencia (colunas NOME_Cliente / NOME_Cartao).
// mesma logica do Apps Script antigo: shopperName -> shopperEmail -> null.
// shopperName pode chegar como objeto {firstName,lastName}, como string
// "[first name=..., last name=...]" ou como chaves separadas em formato de
// string "shopperName.firstName"/"shopperName.lastName" - tratamos os tres.
function shopperName(additional) {
  const sn = additional.shopperName;
  if (sn && typeof sn === 'object') {
    const full = `${sn.firstName || ''} ${sn.lastName || ''}`.trim();
    if (full) return full;
  } else if (typeof sn === 'string' && sn.trim()) {
    const cleaned = cleanShopperNameString(sn.trim());
    if (cleaned) return cleaned;
  }

  const first = additional['shopperName.firstName'] || '';
  const last = additional['shopperName.lastName'] || '';
  const full = `${first} ${last}`.trim();
  if (full) return full;

  if (additional.shopperEmail) return additional.shopperEmail;
  return null;
}

function normalize(item) {
  const additional = item.additionalData || {};
  const status = statusFromEvent(item);
  // mesma logica do Apps Script antigo: cardHolderName -> cardSummary -> null
  const cardHolder = additional.cardHolderName || additional.cardSummary || null;

  return {
    pspReference: item.pspReference,
    merchantReference: item.merchantReference,
    originalReference: item.originalReference || null,
    eventCode: item.eventCode,
    status,
    fraudeSuspeita: isFraudSuspect(item),
    motivo: item.reason || additional.refusalReasonRaw || '',
    valor: centsToReais(item.amount),
    moeda: item.amount?.currency || 'BRL',
    metodo: item.paymentMethod || '?',
    last4: additional.cardSummary || null,
    bin: additional.cardBin || (additional.cardSummary ? null : null),
    cardHolder, // nome do cartao (impresso no cartao)
    nomeCliente: shopperName(additional) || cardHolder, // nome do cliente que fez o pedido
    shopperReference: additional.shopperReference || item.merchantAccountCode + ':' + (additional.shopperEmail || ''),
    unidade: item.merchantAccountCode,
    dataHora: new Date().toISOString(), // Adyen nao manda timestamp do evento; usamos hora de recebimento
    disputeStatus: additional.disputeStatus || null,
    bancoEmissor: null, // preenchido depois via BIN lookup (assincrono)
  };  
}

module.exports = { normalize };
