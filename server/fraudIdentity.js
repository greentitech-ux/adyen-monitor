// fraudIdentity.js
// Cruza o nome do cliente (shopper) com o nome impresso no cartao pra ligar
// pedidos que, olhados isoladamente, pareceriam de pessoas diferentes - mas
// na pratica sao o mesmo anel de fraude usando nomes/cartoes diferentes a
// cada tentativa. Exemplo real: um pedido tem nomeCliente "Thais Mendes" e
// cardHolder "Luciano Jose"; outro pedido tem nomeCliente "Luciano Silva" e
// cardHolder "Thais M Mendes" - os nomes se cruzam entre os dois campos
// (shopper de um bate com o cartao do outro), entao viram o mesmo cluster
// de identidade mesmo sem nenhum nome ser identico.
//
// Guarda tudo em memoria com uma janela de tempo (igual ao cardHopping.js/
// cardTesting.js) - nao precisa persistir, e so pra ligar atividade recente.
const JANELA_MS = 24 * 60 * 60 * 1000; // 24h - liga pedidos recentes com nomes cruzados

const STOPWORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);

function normalizarTexto(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// termos com 3+ letras, ignorando preposicoes/conectivos - "Thais", "Mendes",
// "Luciano", "Silva" contam; "de", "da" nao contam
function tokensSignificativos(nome) {
  return normalizarTexto(nome).split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

let proximoId = 1;
const clusters = new Map(); // id -> {id, pedidos:Set, tokens:Set, nomeContagem:Map, ultimaAtividade}
const tokenParaCluster = new Map(); // token -> clusterId

function limparAntigos() {
  const agora = Date.now();
  for (const [id, c] of clusters) {
    if (agora - c.ultimaAtividade > JANELA_MS) {
      c.tokens.forEach((t) => tokenParaCluster.delete(t));
      clusters.delete(id);
    }
  }
}

// nome mais frequente do cluster vira o "nome representativo" (o que
// aparece mais vezes entre nomeCliente/cardHolder de todos os pedidos
// ligados) - normalmente e o nome real da pessoa, os outros sao variacoes/
// cartoes emprestados/roubados
function nomeRepresentativo(cluster) {
  let melhor = null;
  let melhorContagem = -1;
  cluster.nomeContagem.forEach((qtd, nome) => {
    if (qtd > melhorContagem) {
      melhor = nome;
      melhorContagem = qtd;
    }
  });
  return melhor;
}

// registra um pedido (nome do cliente + nome do cartao) na malha de
// identidades cruzadas e devolve o cluster resolvido - cria um cluster novo
// se nenhum termo do nome bate com nada visto antes, ou junta com o(s)
// cluster(s) existente(s) que compartilham algum termo
function registrarPedido(pedidoId, nomeCliente, cardHolder) {
  limparAntigos();
  const nomes = [nomeCliente, cardHolder].filter(Boolean);
  const todosTokens = new Set();
  nomes.forEach((n) => tokensSignificativos(n).forEach((t) => todosTokens.add(t)));
  if (!todosTokens.size) return null;

  const idsEncontrados = new Set();
  todosTokens.forEach((t) => {
    const id = tokenParaCluster.get(t);
    if (id != null) idsEncontrados.add(id);
  });

  let clusterFinal;
  if (idsEncontrados.size === 0) {
    clusterFinal = { id: proximoId++, pedidos: new Set(), tokens: new Set(), nomeContagem: new Map(), ultimaAtividade: Date.now() };
    clusters.set(clusterFinal.id, clusterFinal);
  } else {
    const ids = [...idsEncontrados];
    clusterFinal = clusters.get(ids[0]);
    for (let i = 1; i < ids.length; i++) {
      const outro = clusters.get(ids[i]);
      if (!outro || outro.id === clusterFinal.id) continue;
      outro.pedidos.forEach((p) => clusterFinal.pedidos.add(p));
      outro.tokens.forEach((t) => {
        clusterFinal.tokens.add(t);
        tokenParaCluster.set(t, clusterFinal.id);
      });
      outro.nomeContagem.forEach((qtd, nome) => clusterFinal.nomeContagem.set(nome, (clusterFinal.nomeContagem.get(nome) || 0) + qtd));
      clusters.delete(outro.id);
    }
  }

  nomes.forEach((n) => clusterFinal.nomeContagem.set(n, (clusterFinal.nomeContagem.get(n) || 0) + 1));
  todosTokens.forEach((t) => {
    clusterFinal.tokens.add(t);
    tokenParaCluster.set(t, clusterFinal.id);
  });
  clusterFinal.pedidos.add(pedidoId);
  clusterFinal.ultimaAtividade = Date.now();

  return {
    clusterId: clusterFinal.id,
    nomes: [...clusterFinal.nomeContagem.keys()],
    totalPedidos: clusterFinal.pedidos.size,
    nomeRepresentativo: nomeRepresentativo(clusterFinal),
  };
}

const limpeza = setInterval(limparAntigos, 5 * 60 * 1000);
limpeza.unref(); // nao impede o processo de encerrar (ex: em testes)

module.exports = { registrarPedido, tokensSignificativos };
