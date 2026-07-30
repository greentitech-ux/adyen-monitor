// binLookup.js
// A Adyen normalmente NAO manda o nome do banco emissor no webhook - só o BIN
// (6 primeiros dígitos, em additionalData.cardBin quando habilitado na conta)
// e os últimos 4 dígitos (additionalData.cardSummary).
// Para descobrir o banco (ex.: "ITAU UNIBANCO S.A."), consultamos um serviço
// de BIN lookup. Trocar BIN_LOOKUP_URL pelo provedor que preferir
// (ex.: binlist.net, ou um serviço pago com melhor cobertura BR).

const cache = new Map();

async function lookupBank(bin) {
  if (!bin) return null;
  if (cache.has(bin)) return cache.get(bin);

  try {
    const res = await fetch(`https://lookup.binlist.net/${bin}`, {
      headers: { 'Accept-Version': '3' },
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    const bank = data?.bank?.name || null;
    cache.set(bin, bank);
    return bank;
  } catch (e) {
    cache.set(bin, null);
    return null;
  }
}

module.exports = { lookupBank };
