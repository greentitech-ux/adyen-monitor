// solicitacoes.js
// Pedidos genericos da loja que nao sao nem estorno (refunds.js) nem
// correcao de fechamento (fechamentosLive.js solicitarEdicao) - Compra,
// Manutencao e Suporte de TI. Mesmo fluxo de fila-com-aprovacao dos outros
// dois: a loja pede, o Master aprova/rejeita (com motivo opcional), com
// anexo (foto/print/orcamento) e observacao. Aprovar um pedido de Suporte
// de TI cria um Chamado (ver chamadosTI.js) pro tecnico ir na loja.
const crypto = require('crypto');
const db = require('./firestore');
const { createCache } = require('./liveCache');
const ticketCounter = require('./ticketCounter');
const centralChat = require('./centralChat');

const COLLECTION = db.collection('solicitacoes');

// 'pagamento': demanda de pagamento pro financeiro (boleto/fatura/despesa da
// unidade, com fornecedor e vencimento - aprovar = pago). 'nota': pedido de
// nota fiscal ao financeiro. Os dois entram na mesma fila/Kanban da Central.
const TIPOS = ['compra', 'manutencao', 'suporte-ti', 'pagamento', 'nota'];
// 'CONVERTIDO': o ticket saiu desse tipo/colecao e virou um Estorno (ver
// converterParaEstorno) - o registro fica de historico, quem continua a
// historia e o novo registro em refunds.js (convertidoParaId)
const STATUSES = ['PENDENTE', 'APROVADO', 'REJEITADO', 'CONVERTIDO'];

// andamento da EXECUCAO de verdade, depois que o ticket ja foi Aprovado -
// diferente do `status` (que e a decisao de aprovar/rejeitar). Ex: um
// Suporte de TI aprovado comeca Pendente, vira Em andamento quando o
// tecnico esta resolvendo, e Finalizado quando termina. So faz sentido
// (e so fica visivel) com status==='APROVADO'
const EXECUCAO_STATUSES = ['PENDENTE', 'EM_ANDAMENTO', 'FINALIZADO'];

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;

// itens da lista de compra (nome do que comprar + quantidade) - so pra
// tipo "compra", mesmo padrao repetivel de MAQUINAS/SAIDAS do lancamento.
// O valor estimado continua existindo a parte (campo unico, opcional, pra
// quando o pedido ja tem um total definido)
function sanitizarItens(lista) {
  if (!Array.isArray(lista)) return [];
  return lista
    .map((item) => ({
      descricao: String(item?.descricao || '').trim().slice(0, 200),
      quantidade: item?.quantidade != null && item.quantidade !== '' ? Number(item.quantidade) || 0 : null,
    }))
    .filter((item) => item.descricao);
}

async function create({ tipo, unidade, unidadeNome, titulo, valorEstimado, observacao, itens, anexos, ehOrcamento, fornecedor, vencimento, criadoPorId, criadoPorEmail, direcionadoParaId, direcionadoParaEmail, numeroTicket, convertidoDeTipo, convertidoDeId }) {
  if (!TIPOS.includes(tipo)) throw new Error('Tipo de solicitação inválido.');
  if (!unidade) throw new Error('Unidade é obrigatória.');
  if (!titulo || !String(titulo).trim()) throw new Error('Descreva o que está sendo pedido.');
  if (vencimento && !DATA_RE.test(vencimento)) throw new Error('Vencimento inválido (use AAAA-MM-DD).');

  const doc = COLLECTION.doc();
  const agora = new Date().toISOString();
  // numeroTicket normalmente e novo (Ticket #10000 em diante, sequencia unica
  // compartilhada com refunds.js/fechamentosLive.js) - so vem pre-definido
  // quando esse registro nasce de uma conversao de outro ticket (ver
  // converterParaEstorno() em refunds.js), pra manter o mesmo numero
  const ticket = numeroTicket != null ? numeroTicket : await ticketCounter.proximoTicket();
  const registro = {
    id: doc.id,
    numeroTicket: ticket,
    // trilha de qual(is) tipo(s) esse ticket ja passou - o primeiro registro
    // e sempre o tipo de criacao; mudarTipo()/conversoes acrescentam aqui
    historicoTipos: [{ tipo, em: agora, porEmail: criadoPorEmail || null }],
    // preenchido só quando esse registro NASCEU de uma conversão de outro
    // ticket (ver converterParaSolicitacao em refunds.js) - referencia de
    // onde ele veio, pra poder "voltar" no historico
    convertidoDeTipo: convertidoDeTipo || null,
    convertidoDeId: convertidoDeId || null,
    // preenchido quando ESSE ticket vira outro tipo/colecao (ver mudarTipo,
    // converterParaEstorno) - status vira 'CONVERTIDO' e esses dois campos
    // apontam pro registro que continua a historia do ticket
    convertidoParaTipo: null,
    convertidoParaId: null,
    tipo,
    unidade,
    unidadeNome: unidadeNome || unidade,
    titulo: String(titulo).trim().slice(0, 200),
    valorEstimado: valorEstimado != null && valorEstimado !== '' ? Number(valorEstimado) || 0 : null,
    observacao: observacao || '',
    itens: tipo === 'compra' ? sanitizarItens(itens) : [], // [{ descricao, quantidade }]
    anexos: Array.isArray(anexos) ? anexos : [], // [{ nome, path, tipo }]
    // destaca que o pedido e um orcamento (precisa de julgamento de quem tem
    // a tag Admin antes de aprovar, nao so registro de rotina)
    ehOrcamento: !!ehOrcamento,
    // so pra tipo 'pagamento'/'nota' - fornecedor da cobranca e data de
    // vencimento (o Kanban destaca pagamento vencido ainda pendente)
    fornecedor: fornecedor ? String(fornecedor).trim().slice(0, 120) : null,
    vencimento: vencimento || null,
    status: 'PENDENTE',
    // andamento da execucao, so preenchido (e so relevante) apos Aprovado -
    // ver EXECUCAO_STATUSES/atualizarExecucao
    execucaoStatus: null,
    criadoPorId,
    criadoPorEmail,
    // Master/Admin escolhido por quem lançou (opcional, ver grupos.js) - so
    // um "pra quem e mais direto", nao restringe quem mais pode decidir
    direcionadoParaId: direcionadoParaId || null,
    direcionadoParaEmail: direcionadoParaEmail || null,
    // notificacao (popup com som) fica ativa ate QUALQUER Master/Admin
    // sinalizar que viu - ver marcarNotificacaoVista
    notificacaoVista: false,
    notificacaoVistaPorEmail: null,
    notificacaoVistaPorUsername: null,
    notificacaoVistaEm: null,
    criadoEm: agora,
    decididoPorEmail: null,
    decididoEm: null,
    motivoDecisao: null,
    chamadoId: null, // preenchido se virar Chamado de TI (tipo 'suporte-ti' aprovado)
    // status de Comprada (so tipo 'compra' aprovado) - data de entrega prevista
    // e/ou print do comprovante da compra, ver marcarComprada
    comprada: false,
    dataEntregaPrevista: null,
    comprovante: null, // { nome, path, tipo }
    marcadoCompradoPorEmail: null,
    marcadoCompradoEm: null,
    // token de aprovar/recusar por e-mail, sem login (ver gerarTokenAcao/
    // decidirPorToken e GET+POST /decidir em index.js) - regenerado a cada
    // envio do relatorio diario, o que invalida sozinho o link de um e-mail
    // anterior (so o mais recente funciona)
    tokenAcao: null,
    tokenAcaoExpiraEm: null,
    tokenAcaoUsado: false,
  };
  await doc.set(registro);
  solicitacoesCache.invalidar();
  return registro;
}

async function marcarNotificacaoVista(id, { vistoPorEmail, vistoPorUsername }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  await ref.update({ notificacaoVista: true, notificacaoVistaPorEmail: vistoPorEmail, notificacaoVistaPorUsername: vistoPorUsername || null, notificacaoVistaEm: new Date().toISOString() });
  solicitacoesCache.invalidar();
  return getOne(id);
}

async function listAllUncached() {
  const snap = await COLLECTION.orderBy('criadoEm', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const solicitacoesCache = createCache(listAllUncached, 20 * 1000);
const listAll = solicitacoesCache.cached;

async function getOne(id) {
  const doc = await COLLECTION.doc(id).get();
  return doc.exists ? doc.data() : null;
}

async function updateStatus(id, status, { motivoDecisao, decidedByEmail }) {
  if (!['APROVADO', 'REJEITADO'].includes(status)) throw new Error('Status inválido.');
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  const patch = {
    status,
    motivoDecisao: motivoDecisao || null,
    decididoPorEmail: decidedByEmail,
    decididoEm: new Date().toISOString(),
  };
  // aprovar comeca o andamento de execucao em Pendente (ver EXECUCAO_STATUSES)
  if (status === 'APROVADO') patch.execucaoStatus = 'PENDENTE';
  await ref.update(patch);
  solicitacoesCache.invalidar();
  return getOne(id);
}

// gera (ou renova) o token de aprovar/recusar por e-mail sem login - so faz
// sentido pra pedido ainda PENDENTE. Chamado pelo relatorioMV.js toda vez
// que manda o relatorio diario; sobrescrever o token de um envio anterior
// invalida os links daquele e-mail mais antigo sozinho, sem precisar de
// nenhuma limpeza a parte
async function gerarTokenAcao(id, { validadeDias = 3 } = {}) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  if (snap.data().status !== 'PENDENTE') throw new Error('Só é possível gerar link de ação pra pedido ainda pendente.');
  const tokenAcao = crypto.randomUUID();
  const tokenAcaoExpiraEm = new Date(Date.now() + validadeDias * 24 * 60 * 60 * 1000).toISOString();
  await ref.update({ tokenAcao, tokenAcaoExpiraEm, tokenAcaoUsado: false });
  solicitacoesCache.invalidar();
  return { tokenAcao, tokenAcaoExpiraEm };
}

// confere um token recebido na pagina publica /decidir (ver index.js) -
// devolve o registro se o token bate, ainda esta dentro da validade, nao foi
// usado ainda e o pedido continua PENDENTE; null em qualquer outro caso (sem
// detalhar o motivo pro chamador, pra nao dar pista sobre tokens de outras
// solicitacoes - ver aviso de seguranca no cabecalho do arquivo)
async function validarToken(id, token) {
  if (!id || !token) return null;
  const registro = await getOne(id);
  if (!registro) return null;
  if (registro.status !== 'PENDENTE') return null;
  if (!registro.tokenAcao || registro.tokenAcao !== token) return null;
  if (registro.tokenAcaoUsado) return null;
  if (!registro.tokenAcaoExpiraEm || new Date(registro.tokenAcaoExpiraEm).getTime() < Date.now()) return null;
  return registro;
}

// decide (aprova/recusa) via o link publico do e-mail - mesma logica de
// updateStatus, mas validando o token em vez de exigir login, e anexando o
// comprovante (foto) enviado no formulario ao array de anexos do pedido (nao
// usa o campo `comprovante` porque esse ja significa outra coisa: o print da
// COMPRA em si, ver marcarComprada - aqui e o comprovante da DECISAO)
async function decidirPorToken(id, token, { acao, motivoDecisao, comprovante, decididoPorEmail }) {
  const registro = await validarToken(id, token);
  if (!registro) throw new Error('Link inválido, expirado ou já usado.');
  if (!['aprovar', 'recusar'].includes(acao)) throw new Error('Ação inválida.');
  const status = acao === 'aprovar' ? 'APROVADO' : 'REJEITADO';
  const ref = COLLECTION.doc(id);
  const patch = {
    status,
    motivoDecisao: motivoDecisao || null,
    decididoPorEmail: decididoPorEmail || registro.direcionadoParaEmail || 'via e-mail',
    decididoEm: new Date().toISOString(),
    tokenAcaoUsado: true,
  };
  if (status === 'APROVADO') patch.execucaoStatus = 'PENDENTE';
  if (comprovante) patch.anexos = [...(registro.anexos || []), comprovante];
  await ref.update(patch);
  solicitacoesCache.invalidar();
  return getOne(id);
}

// atualiza o andamento de execucao (Pendente/Em andamento/Finalizado) de um
// ticket ja Aprovado - Master/Admin acompanham a execucao de verdade depois
// da decisao (ex: tecnico ainda nao foi, esta indo, ja resolveu)
async function atualizarExecucao(id, execucaoStatus) {
  if (!EXECUCAO_STATUSES.includes(execucaoStatus)) throw new Error('Status de execução inválido.');
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  if (snap.data().status !== 'APROVADO') throw new Error('Só é possível atualizar o andamento de um ticket já aprovado.');
  await ref.update({ execucaoStatus });
  solicitacoesCache.invalidar();
  return getOne(id);
}

async function vincularChamado(id, chamadoId) {
  await COLLECTION.doc(id).update({ chamadoId });
  solicitacoesCache.invalidar();
}

// marca um pedido de Compra ja aprovado como comprado - data de entrega
// prevista e/ou print do comprovante, os dois opcionais (o Admin/Master
// pode marcar so com a data, so com o comprovante, ou com os dois)
async function marcarComprada(id, { dataEntregaPrevista, comprovante, marcadoPorEmail }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  const atual = snap.data();
  if (atual.tipo !== 'compra') throw new Error('Só pedidos de Compra podem ser marcados como Comprada.');
  if (atual.status !== 'APROVADO') throw new Error('Só pedidos já Aprovados podem ser marcados como Comprada.');
  const patch = {
    comprada: true,
    dataEntregaPrevista: dataEntregaPrevista || atual.dataEntregaPrevista || null,
    marcadoCompradoPorEmail: marcadoPorEmail,
    marcadoCompradoEm: new Date().toISOString(),
  };
  if (comprovante) patch.comprovante = comprovante;
  await ref.update(patch);
  solicitacoesCache.invalidar();
  return getOne(id);
}

async function desmarcarComprada(id) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  await ref.update({
    comprada: false, dataEntregaPrevista: null, comprovante: null,
    marcadoCompradoPorEmail: null, marcadoCompradoEm: null,
  });
  solicitacoesCache.invalidar();
  return getOne(id);
}

// edicao direta pelo Master - poder de corrigir qualquer campo do pedido
// (titulo, valor, observacao, itens, unidade), independente do status.
// So atualiza o que vier em `campos`, sem mexer em status/decisao/chamado.
async function update(id, campos) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  const atual = snap.data();
  const patch = {};
  if (campos.titulo != null) {
    if (!String(campos.titulo).trim()) throw new Error('Descreva o que está sendo pedido.');
    patch.titulo = String(campos.titulo).trim().slice(0, 200);
  }
  if (campos.unidade != null) patch.unidade = campos.unidade;
  if (campos.unidadeNome != null) patch.unidadeNome = campos.unidadeNome;
  if (Object.prototype.hasOwnProperty.call(campos, 'valorEstimado')) {
    patch.valorEstimado = campos.valorEstimado != null && campos.valorEstimado !== '' ? Number(campos.valorEstimado) || 0 : null;
  }
  if (campos.observacao != null) patch.observacao = campos.observacao;
  if (campos.itens != null) patch.itens = (atual.tipo === 'compra') ? sanitizarItens(campos.itens) : [];
  if (campos.ehOrcamento != null) patch.ehOrcamento = !!campos.ehOrcamento;
  if (campos.fornecedor != null) patch.fornecedor = String(campos.fornecedor).trim().slice(0, 120) || null;
  if (campos.vencimento != null) {
    if (campos.vencimento && !DATA_RE.test(campos.vencimento)) throw new Error('Vencimento inválido (use AAAA-MM-DD).');
    patch.vencimento = campos.vencimento || null;
  }
  await ref.update(patch);
  solicitacoesCache.invalidar();
  return getOne(id);
}

async function remove(id) {
  await COLLECTION.doc(id).delete();
  solicitacoesCache.invalidar();
}

// troca o Master/Admin responsavel por um pedido ja existente, seja qual for
// o status - ex: pedido foi direcionado a alguem que esta de folga, outro
// Admin assume. null limpa (volta a ser "qualquer Master/Admin do grupo").
// atribuidosIds/atribuidosEmails (arrays, 1+ pessoas) sao quem de fato
// enxerga o card na Central (ver todosCardsCentral em index.js) - so o
// Master ve tudo, os demais so o que criaram ou o que estiver aqui
async function redirecionar(id, { direcionadoParaId, direcionadoParaEmail, atribuidosIds, atribuidosEmails }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  await ref.update({
    direcionadoParaId: direcionadoParaId || null,
    direcionadoParaEmail: direcionadoParaEmail || null,
    atribuidosIds: Array.isArray(atribuidosIds) ? atribuidosIds.filter(Boolean) : [],
    atribuidosEmails: Array.isArray(atribuidosEmails) ? atribuidosEmails.filter(Boolean) : [],
  });
  solicitacoesCache.invalidar();
  return getOne(id);
}

// troca o tipo de um ticket dentro dos 5 tipos gerais (Compra, Manutencao,
// Suporte de TI, Pagamento, Nota) - ex: ticket de Manutencao virou Pagamento
// apos a execucao do servico. Mesmo registro/id, so o campo `tipo` muda - o
// numero do ticket e o historico continuam os mesmos (ver historicoTipos).
// Pra trocar PARA Estorno (outra colecao/schema), ver converterParaEstorno.
async function mudarTipo(id, novoTipo, porEmail) {
  if (!TIPOS.includes(novoTipo)) throw new Error('Tipo de destino inválido.');
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  const atual = snap.data();
  if (atual.status === 'CONVERTIDO') throw new Error('Este ticket já foi convertido, não é possível trocar o tipo.');
  if (atual.tipo === novoTipo) return atual;
  const historico = Array.isArray(atual.historicoTipos) ? atual.historicoTipos.slice() : [];
  historico.push({ tipo: novoTipo, em: new Date().toISOString(), porEmail: porEmail || null });
  await ref.update({ tipo: novoTipo, historicoTipos: historico });
  await centralChat.reatribuirCard(atual.tipo, id, novoTipo, id);
  solicitacoesCache.invalidar();
  return getOne(id);
}

// converte um dos 5 tipos gerais num pedido de Estorno (outra colecao,
// refunds.js) - ex: pedido de Manutencao virou um estorno pro cliente.
// Marca este registro como CONVERTIDO e cria um novo em refunds.js com o
// MESMO numero de ticket, preservando o historico. Require tardio de
// refunds.js (dependencia "de efeito colateral") pra evitar circular no
// topo do arquivo.
async function converterParaEstorno(id, dadosEstorno, porEmail) {
  const refunds = require('./refunds');
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  const atual = snap.data();
  if (atual.status === 'CONVERTIDO') throw new Error('Este ticket já foi convertido.');
  const d = dadosEstorno || {};
  const novo = await refunds.create({
    origem: 'conversao',
    unidade: d.unidade || atual.unidade,
    unidadeNome: d.unidadeNome || atual.unidadeNome || atual.unidade,
    observacao: d.observacao || atual.observacao || atual.titulo,
    motivoEstorno: d.motivoEstorno || null,
    motivoOutro: d.motivoOutro || null,
    valorVenda: d.valorVenda != null && d.valorVenda !== '' ? d.valorVenda : atual.valorEstimado,
    formaPagamento: d.formaPagamento || null,
    bandeira: d.bandeira || null,
    ultimos4: d.ultimos4 || null,
    dataVenda: d.dataVenda || null,
    horaVenda: d.horaVenda || null,
    valorEstornar: d.valorEstornar != null && d.valorEstornar !== '' ? d.valorEstornar : atual.valorEstimado,
    nomeCliente: d.nomeCliente || null,
    telefoneCliente: d.telefoneCliente || null,
    anexos: atual.anexos,
    requestedById: atual.criadoPorId,
    requestedByEmail: atual.criadoPorEmail,
    direcionadoParaId: atual.direcionadoParaId,
    direcionadoParaEmail: atual.direcionadoParaEmail,
    numeroTicket: atual.numeroTicket,
    convertidoDeTipo: atual.tipo,
    convertidoDeId: atual.id,
  });
  await ref.update({
    status: 'CONVERTIDO',
    convertidoParaTipo: 'estorno',
    convertidoParaId: novo.id,
  });
  await centralChat.reatribuirCard(atual.tipo, id, 'estorno', novo.id);
  solicitacoesCache.invalidar();
  return novo;
}

module.exports = {
  TIPOS, STATUSES, EXECUCAO_STATUSES, create, listAll, getOne, updateStatus, vincularChamado, update, remove,
  marcarNotificacaoVista, marcarComprada, desmarcarComprada, redirecionar, mudarTipo, converterParaEstorno,
  atualizarExecucao, gerarTokenAcao, validarToken, decidirPorToken,
};
