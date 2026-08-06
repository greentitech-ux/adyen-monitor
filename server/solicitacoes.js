// solicitacoes.js
// Pedidos genericos da loja que nao sao nem estorno (refunds.js) nem
// correcao de fechamento (fechamentosLive.js solicitarEdicao) - Compra,
// Manutencao e Suporte de TI. Mesmo fluxo de fila-com-aprovacao dos outros
// dois: a loja pede, o Master aprova/rejeita (com motivo opcional), com
// anexo (foto/print/orcamento) e observacao. Aprovar um pedido de Suporte
// de TI cria um Chamado (ver chamadosTI.js) pro tecnico ir na loja.
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('solicitacoes');

// 'pagamento': demanda de pagamento pro financeiro (boleto/fatura/despesa da
// unidade, com fornecedor e vencimento - aprovar = pago). 'nota': pedido de
// nota fiscal ao financeiro. Os dois entram na mesma fila/Kanban da Central.
const TIPOS = ['compra', 'manutencao', 'suporte-ti', 'pagamento', 'nota'];
const STATUSES = ['PENDENTE', 'APROVADO', 'REJEITADO'];

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

async function create({ tipo, unidade, unidadeNome, titulo, valorEstimado, observacao, itens, anexos, ehOrcamento, fornecedor, vencimento, criadoPorId, criadoPorEmail, direcionadoParaId, direcionadoParaEmail }) {
  if (!TIPOS.includes(tipo)) throw new Error('Tipo de solicitação inválido.');
  if (!unidade) throw new Error('Unidade é obrigatória.');
  if (!titulo || !String(titulo).trim()) throw new Error('Descreva o que está sendo pedido.');
  if (vencimento && !DATA_RE.test(vencimento)) throw new Error('Vencimento inválido (use AAAA-MM-DD).');

  const doc = COLLECTION.doc();
  const agora = new Date().toISOString();
  const registro = {
    id: doc.id,
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
  };
  await doc.set(registro);
  solicitacoesCache.invalidar();
  return registro;
}

async function marcarNotificacaoVista(id, { vistoPorEmail }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  await ref.update({ notificacaoVista: true, notificacaoVistaPorEmail: vistoPorEmail, notificacaoVistaEm: new Date().toISOString() });
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
  await ref.update({
    status,
    motivoDecisao: motivoDecisao || null,
    decididoPorEmail: decidedByEmail,
    decididoEm: new Date().toISOString(),
  });
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
// Admin assume. null limpa (volta a ser "qualquer Master/Admin do grupo")
async function redirecionar(id, { direcionadoParaId, direcionadoParaEmail }) {
  const ref = COLLECTION.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Solicitação não encontrada.');
  await ref.update({
    direcionadoParaId: direcionadoParaId || null,
    direcionadoParaEmail: direcionadoParaEmail || null,
  });
  solicitacoesCache.invalidar();
  return getOne(id);
}

module.exports = {
  TIPOS, STATUSES, create, listAll, getOne, updateStatus, vincularChamado, update, remove,
  marcarNotificacaoVista, marcarComprada, desmarcarComprada, redirecionar,
};
