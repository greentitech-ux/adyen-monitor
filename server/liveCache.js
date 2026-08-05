// liveCache.js
// Helper generico de cache em memoria com TTL curto, usado pelos modulos que
// tem uma listAll() cara (le a colecao inteira do Firestore) e sao chamados
// toda vez que alguem abre/atualiza uma tela do dashboard. Cada tela chama
// esse listAll() do zero a cada render, e como o SSE ja avisa o dashboard
// quando algo muda (eventos 'fechamento-lancado', 'entrega-lancada',
// 'sangria-lancada', 'dispute-changed', 'refund-request-changed' etc.), a
// gente pode cachear o resultado por alguns segundos sem risco de mostrar
// dado desatualizado por muito tempo - e ainda assim invalidar na hora
// (createCache().invalidar()) sempre que um create/update/decisao acontece,
// pra quem CRIOU/decidiu ja ver o proprio registro novo imediatamente.
//
// Isso reduz MUITO o numero de leituras diarias do Firestore em telas
// abertas com frequencia (Fechamentos, Entregas, Disputas, etc.), que foi
// identificado como uma das causas do "RESOURCE_EXHAUSTED" (cota de leitura
// estourada) que derrubava o app no Render.
function createCache(fnOriginal, ttlMs = 20 * 1000) {
  let cache = { valor: null, expiraEm: 0, emAndamento: null };

  function invalidar() {
    cache = { valor: null, expiraEm: 0, emAndamento: null };
  }

  async function cached(...args) {
    const agora = Date.now();
    if (cache.valor && agora < cache.expiraEm) return cache.valor;
    if (cache.emAndamento) return cache.emAndamento;

    const promessa = fnOriginal(...args)
      .then((valor) => {
        cache = { valor, expiraEm: Date.now() + ttlMs, emAndamento: null };
        return valor;
      })
      .catch((err) => {
        cache.emAndamento = null;
        throw err;
      });
    cache.emAndamento = promessa;
    return promessa;
  }

  return { cached, invalidar };
}

// variante com chave, pra quando o resultado depende de um argumento (ex:
// getUserById(id) - cada usuario tem seu proprio cache, ao inves de um valor
// unico compartilhado por todo mundo como no createCache() acima)
function createKeyedCache(fnOriginal, ttlMs = 20 * 1000) {
  const cache = new Map(); // key -> { valor, expiraEm, emAndamento }

  function invalidar(key) {
    if (key === undefined) { cache.clear(); return; }
    cache.delete(key);
  }

  async function cached(key, ...restArgs) {
    const agora = Date.now();
    const entry = cache.get(key);
    if (entry && entry.valor !== undefined && agora < entry.expiraEm) return entry.valor;
    if (entry && entry.emAndamento) return entry.emAndamento;

    const promessa = fnOriginal(key, ...restArgs)
      .then((valor) => {
        cache.set(key, { valor, expiraEm: Date.now() + ttlMs, emAndamento: null });
        return valor;
      })
      .catch((err) => {
        cache.delete(key);
        throw err;
      });
    cache.set(key, { valor: undefined, expiraEm: 0, emAndamento: promessa });
    return promessa;
  }

  return { cached, invalidar };
}

module.exports = { createCache, createKeyedCache };
