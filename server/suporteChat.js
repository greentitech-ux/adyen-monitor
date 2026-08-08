// suporteChat.js
// Chat de suporte do site: o widget flutuante (💬, canto inferior direito de
// TODAS as telas - inclusive o login) deixa qualquer pessoa, logada ou nao,
// abrir uma conversa com o time de Suporte pedindo ajuda (computador,
// sistema, acesso...). O visitante recebe um token proprio na criacao e usa
// ele pra ler/escrever na conversa (sem login); o atendimento e feito pelo
// time de Suporte/Master na tela de Chamados TI, que pode responder,
// transformar a conversa num chamado remoto (banco de evidencias) e
// finalizar. Nada de dado sensivel do atendente vaza pro lado publico:
// a visao do visitante rotula mensagens do time apenas como "Suporte".
const crypto = require('crypto');
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('suporteChats');

const MAX_TEXTO = 1000;
const MAX_MENSAGENS = 300;

function limpar(texto, max) {
  return String(texto || '').trim().slice(0, max);
}

async function criar({ nome, contato, texto }) {
  const nomeLimpo = limpar(nome, 120);
  const contatoLimpo = limpar(contato, 120);
  const textoLimpo = limpar(texto, MAX_TEXTO);
  if (!nomeLimpo) throw new Error('Informe seu nome.');
  if (!contatoLimpo) throw new Error('Informe um contato (e-mail ou telefone).');
  if (!textoLimpo) throw new Error('Escreva sua mensagem.');

  const doc = COLLECTION.doc();
  const agora = new Date().toISOString();
  const registro = {
    id: doc.id,
    // chave do visitante - quem tem o token le/escreve nessa conversa
    token: crypto.randomBytes(24).toString('hex'),
    nome: nomeLimpo,
    contato: contatoLimpo,
    status: 'ABERTO',
    mensagens: [{ de: 'visitante', texto: textoLimpo, em: agora }],
    chamadoId: null,
    atendidoPorEmail: null,
    criadoEm: agora,
    atualizadoEm: agora,
    finalizadoEm: null,
  };
  await doc.set(registro);
  chatsCache.invalidar();
  return registro;
}

async function getOne(id) {
  const doc = await COLLECTION.doc(id).get();
  return doc.exists ? doc.data() : null;
}

// visao do visitante: exige o token certo e omite o que e interno (token de
// outros, e-mail de quem atendeu) - mensagens do time viram so "Suporte"
async function getPublico(id, token) {
  const chat = await getOne(id);
  if (!chat || !token || chat.token !== token) return null;
  return {
    id: chat.id,
    nome: chat.nome,
    status: chat.status,
    mensagens: (chat.mensagens || []).map((m) => ({ de: m.de, texto: m.texto, em: m.em })),
    criadoEm: chat.criadoEm,
  };
}

async function adicionarMensagem(id, { de, texto, autorEmail, token }) {
  const chat = await getOne(id);
  if (!chat) throw new Error('Conversa não encontrada.');
  if (de === 'visitante' && chat.token !== token) throw new Error('Conversa não encontrada.');
  if (chat.status !== 'ABERTO') throw new Error('Essa conversa já foi finalizada. Inicie uma nova.');
  const textoLimpo = limpar(texto, MAX_TEXTO);
  if (!textoLimpo) throw new Error('Escreva a mensagem.');
  if ((chat.mensagens || []).length >= MAX_MENSAGENS) throw new Error('Essa conversa ficou muito longa. Inicie uma nova.');
  const agora = new Date().toISOString();
  const mensagens = [...(chat.mensagens || []), { de, texto: textoLimpo, em: agora, ...(de === 'suporte' ? { autorEmail: autorEmail || null } : {}) }];
  const patch = { mensagens, atualizadoEm: agora };
  if (de === 'suporte' && !chat.atendidoPorEmail) patch.atendidoPorEmail = autorEmail || null;
  await COLLECTION.doc(id).update(patch);
  chatsCache.invalidar();
  return getOne(id);
}

async function finalizar(id, { autorEmail }) {
  const chat = await getOne(id);
  if (!chat) throw new Error('Conversa não encontrada.');
  if (chat.status !== 'ABERTO') return chat;
  await COLLECTION.doc(id).update({
    status: 'FINALIZADO',
    finalizadoEm: new Date().toISOString(),
    atendidoPorEmail: chat.atendidoPorEmail || autorEmail || null,
    atualizadoEm: new Date().toISOString(),
  });
  chatsCache.invalidar();
  return getOne(id);
}

async function vincularChamado(id, chamadoId) {
  await COLLECTION.doc(id).update({ chamadoId, atualizadoEm: new Date().toISOString() });
  chatsCache.invalidar();
  return getOne(id);
}

async function listAllUncached() {
  const snap = await COLLECTION.orderBy('criadoEm', 'desc').get();
  return snap.docs.map((d) => d.data());
}
const chatsCache = createCache(listAllUncached, 15 * 1000);
const listAll = chatsCache.cached;

module.exports = { criar, getOne, getPublico, adicionarMensagem, finalizar, vincularChamado, listAll };
