// cardHopping.js
// Detecta o padrao "troca de cartao" (tipico de cartao clonado/roubado):
// o MESMO cliente (identificado pelo nome, ja que o numero do cartao muda a
// cada tentativa) testa varios finais de cartao diferentes num intervalo
// curto ate que um deles seja aprovado. Diferente do cardTesting.js (que
// detecta recusas repetidas do MESMO cartao), aqui o sinal e justamente
// varios cartoes DISTINTOS pra identidade.
const LIMIAR_CARTOES = 3; // finais de cartao distintos pro mesmo cliente
const JANELA_MS = 20 * 60 * 1000; // 20 minutos

const tentativasPorCliente = new Map(); // chave -> [{last4, ts}]

function normalizarNome(nome) {
  return String(nome || '').trim().toLowerCase();
}

function clienteKey(tx) {
  const nome = normalizarNome(tx.nomeCliente || tx.cardHolder);
  if (!nome || !tx.last4) return null;
  return `${tx.unidade}:${nome}`;
}

// registra uma tentativa (aprovada ou recusada) e, quando a tentativa atual
// e uma aprovacao que veio depois de LIMIAR_CARTOES finais de cartao
// distintos testados pela mesma pessoa na janela, devolve os dados do alerta
function registrarTentativa(tx) {
  const key = clienteKey(tx);
  if (!key) return null;

  const now = Date.now();
  const anteriores = (tentativasPorCliente.get(key) || []).filter((t) => now - t.ts < JANELA_MS);
  anteriores.push({ last4: tx.last4, ts: now });
  tentativasPorCliente.set(key, anteriores);

  const finaisDistintos = new Set(anteriores.map((t) => t.last4));
  if (tx.status === 'APROVADO' && finaisDistintos.size >= LIMIAR_CARTOES) {
    return { cartoesDistintos: finaisDistintos.size, tentativas: anteriores.length, janelaMinutos: JANELA_MS / 60000 };
  }
  return null;
}

// limpeza periodica pra nao vazar memoria com clientes antigos
const limpeza = setInterval(() => {
  const now = Date.now();
  for (const [key, tentativas] of tentativasPorCliente) {
    const restantes = tentativas.filter((t) => now - t.ts < JANELA_MS);
    if (restantes.length) tentativasPorCliente.set(key, restantes);
    else tentativasPorCliente.delete(key);
  }
}, 5 * 60 * 1000);
limpeza.unref(); // nao impede o processo de encerrar (ex: em testes)

module.exports = { registrarTentativa };
