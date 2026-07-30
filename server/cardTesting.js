// cardTesting.js
// Detecta possivel teste de cartao clonado: N recusas seguidas do mesmo
// cartao em poucos minutos. Fica so em memoria (nao precisa varrer o
// historico inteiro a cada evento).

const LIMIAR_RECUSAS = 3; // recusas seguidas do mesmo cartao
const JANELA_MS = 10 * 60 * 1000; // 10 minutos

const recusasPorCartao = new Map(); // chave -> [timestamps]

function cardKey(tx) {
  if (!tx.last4) return null;
  return `${tx.unidade}:${tx.bin || ''}:${tx.last4}`;
}

// registra uma recusa e retorna { alerta, tentativas } se atingiu o limiar
// nesta chamada (evita alertar de novo a cada recusa subsequente)
function registrarRecusa(tx) {
  const key = cardKey(tx);
  if (!key) return null;

  const now = Date.now();
  const anteriores = (recusasPorCartao.get(key) || []).filter((t) => now - t < JANELA_MS);
  anteriores.push(now);
  recusasPorCartao.set(key, anteriores);

  if (anteriores.length === LIMIAR_RECUSAS) {
    return { tentativas: anteriores.length, janelaMinutos: JANELA_MS / 60000 };
  }
  return null;
}

// limpeza periodica pra nao vazar memoria com cartoes antigos
const limpeza = setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of recusasPorCartao) {
    const restantes = timestamps.filter((t) => now - t < JANELA_MS);
    if (restantes.length) recusasPorCartao.set(key, restantes);
    else recusasPorCartao.delete(key);
  }
}, 5 * 60 * 1000);
limpeza.unref(); // nao impede o processo de encerrar (ex: em testes)

module.exports = { registrarRecusa };
