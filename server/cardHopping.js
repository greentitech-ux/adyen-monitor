// cardHopping.js
// Detecta o padrao "troca de cartao" (tipico de cartao clonado/roubado):
// o MESMO cliente (identificado pelo nome, ja que o numero do cartao muda a
// cada tentativa) testa varios finais de cartao diferentes num intervalo
// curto. Diferente do cardTesting.js (que detecta recusas repetidas do
// MESMO cartao), aqui o sinal e justamente varios cartoes DISTINTOS pra
// identidade - nao precisa nenhuma aprovacao acontecer pra contar como
// fraude (um ataque em massa que so recebe recusas e igualmente suspeito,
// as vezes mais).
const LIMIAR_CARTOES = 3; // finais de cartao distintos pro mesmo cliente
const JANELA_MS = 20 * 60 * 1000; // 20 minutos

const tentativasPorCliente = new Map(); // chave -> [{last4, ts}]

function normalizarNome(nome) {
  return String(nome || '').trim().toLowerCase();
}

// chave padrao (nome exato) - usada quando quem chama nao resolveu uma
// identidade de cluster (fraudIdentity.js) pra esse pedido
function clienteKey(tx) {
  const nome = normalizarNome(tx.nomeCliente || tx.cardHolder);
  if (!nome || !tx.last4) return null;
  return `${tx.unidade}:${nome}`;
}

// registra uma tentativa (aprovada ou recusada) e devolve os dados do
// alerta na tentativa EXATA que cruza LIMIAR_CARTOES finais de cartao
// distintos pra mesma identidade na janela - dispara so uma vez por ataque
// (nao fica repetindo a cada tentativa seguinte); as proximas tentativas
// dessa mesma pessoa ja entram sozinhas pela propagacao por identidade (ver
// index.js), sem precisar gerar um motivo detalhado pra cada uma - por
// isso nao importa se a tentativa que cruzou o limiar foi aprovada ou nao.
//
// chaveIdentidade e opcional: quando informada (normalmente o cluster de
// fraudIdentity.js, que liga nomes cruzados entre cliente/cartao), conta os
// cartoes distintos por esse cluster em vez de so pelo nome exato - assim
// um ataque que varia o NOME a cada tentativa (nao so o cartao) tambem e
// pego. Sem isso, cair no nome exato (comportamento antigo).
function registrarTentativa(tx, chaveIdentidade) {
  const key = chaveIdentidade || clienteKey(tx);
  if (!key || !tx.last4) return null;

  const now = Date.now();
  const anteriores = (tentativasPorCliente.get(key) || []).filter((t) => now - t.ts < JANELA_MS);
  anteriores.push({ last4: tx.last4, ts: now });
  tentativasPorCliente.set(key, anteriores);

  const finaisDistintos = new Set(anteriores.map((t) => t.last4));
  if (finaisDistintos.size === LIMIAR_CARTOES) {
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
