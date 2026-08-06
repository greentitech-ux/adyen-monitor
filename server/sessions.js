// sessions.js
// Uma sessao por token de login emitido - existe pra responder "quantos
// locais estao logados com esse usuario, e desde quando cada um esta ativo"
// (usuarios.html) e pra permitir o Master encerrar um acesso especifico sem
// precisar trocar a senha (o que derrubaria TODOS os locais de uma vez).
// Colecao pequena por natureza: cada sessao expira sozinha (mesma janela de
// 8h do token JWT, ver auth.js) e a limpeza acontece de gracinha no proximo
// login do mesmo usuario - nao precisa de job/cron separado.
const crypto = require('crypto');
const db = require('./firestore');
const { createCache } = require('./liveCache');

const COLLECTION = db.collection('sessions');
const DURACAO_MS = 8 * 60 * 60 * 1000; // mesma janela do JWT (auth.js: expiresIn '8h')
const ONLINE_JANELA_MS = 5 * 60 * 1000; // atividade a menos de 5min = "online agora"
const TOQUE_MIN_INTERVALO_MS = 60 * 1000; // nao regrava ultimaAtividadeEm a cada request

async function criar({ userId, userAgent, ip }) {
  const agora = Date.now();

  // aproveita a escrita nova pra limpar as sessoes ja vencidas desse mesmo
  // usuario - assim a colecao nunca cresce sem limite
  const antigas = await COLLECTION.where('userId', '==', userId).get();
  await Promise.all(
    antigas.docs
      .filter((d) => (d.data().expiraEm || 0) < agora)
      .map((d) => d.ref.delete()),
  );

  const doc = COLLECTION.doc(crypto.randomUUID());
  const registro = {
    id: doc.id,
    userId,
    userAgent: String(userAgent || '').slice(0, 300),
    ip: String(ip || '').slice(0, 100),
    criadoEm: new Date(agora).toISOString(),
    ultimaAtividadeEm: new Date(agora).toISOString(),
    expiraEm: agora + DURACAO_MS,
  };
  await doc.set(registro);
  sessionsCache.invalidar();
  return registro;
}

// throttle em memoria (nao no Firestore) pra nao regravar a cada uma das
// ~90 rotas autenticadas que cada tela dispara - so escreve de novo depois
// de passado TOQUE_MIN_INTERVALO_MS desde a ultima escrita real
const ultimoToqueEmMemoria = new Map(); // sessionId -> epoch ms
function tocar(sessionId) {
  if (!sessionId) return;
  const agora = Date.now();
  const ultimo = ultimoToqueEmMemoria.get(sessionId) || 0;
  if (agora - ultimo < TOQUE_MIN_INTERVALO_MS) return;
  ultimoToqueEmMemoria.set(sessionId, agora);
  COLLECTION.doc(sessionId)
    .update({ ultimaAtividadeEm: new Date(agora).toISOString() })
    .then(() => sessionsCache.invalidar())
    .catch(() => {}); // sessao pode ter sido encerrada/expirada entre o check e a escrita - ignora
}

async function listAllUncached() {
  const snap = await COLLECTION.get();
  return snap.docs.map((d) => d.data());
}
const sessionsCache = createCache(listAllUncached, 10 * 1000);

function estaOnline(sessao, agora = Date.now()) {
  return agora - new Date(sessao.ultimaAtividadeEm).getTime() < ONLINE_JANELA_MS;
}

// chamado pelo requireAuth em toda requisicao - true se o token ainda
// corresponde a uma sessao ativa (nao encerrada pelo Master, nem vencida)
async function existeEValida(sessionId) {
  if (!sessionId) return false;
  const todas = await sessionsCache.cached();
  const sessao = todas.find((s) => s.id === sessionId);
  return !!sessao && sessao.expiraEm > Date.now();
}

async function listarDoUsuario(userId) {
  const todas = await sessionsCache.cached();
  const agora = Date.now();
  return todas
    .filter((s) => s.userId === userId && s.expiraEm > agora)
    .map((s) => ({ ...s, online: estaOnline(s, agora) }))
    .sort((a, b) => b.ultimaAtividadeEm.localeCompare(a.ultimaAtividadeEm));
}

// resumo pra tabela de Usuarios (contagem de locais + online agora), sem
// precisar abrir o modal de sessoes pra cada linha
async function resumoPorUsuario() {
  const todas = await sessionsCache.cached();
  const agora = Date.now();
  const porUsuario = {};
  todas.forEach((s) => {
    if (s.expiraEm <= agora) return;
    const atual = porUsuario[s.userId] || { locais: 0, online: false, ultimaAtividadeEm: null };
    atual.locais += 1;
    atual.online = atual.online || estaOnline(s, agora);
    if (!atual.ultimaAtividadeEm || s.ultimaAtividadeEm > atual.ultimaAtividadeEm) atual.ultimaAtividadeEm = s.ultimaAtividadeEm;
    porUsuario[s.userId] = atual;
  });
  return porUsuario;
}

async function encerrar(sessionId) {
  console.log('DEBUG encerrar() chamando delete pra', sessionId.slice(0,8));
  await COLLECTION.doc(sessionId).delete();
  console.log('DEBUG encerrar() delete concluido, chamando invalidar()');
  ultimoToqueEmMemoria.delete(sessionId);
  sessionsCache.invalidar();
  console.log('DEBUG encerrar() invalidar() concluido');
}

// chamado quando a senha e trocada/reset ou o acesso e desativado - sem isso
// um token emitido antes continuaria valido ate as 8h expirarem sozinhas
async function encerrarTodasDoUsuario(userId) {
  const snap = await COLLECTION.where('userId', '==', userId).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
  sessionsCache.invalidar();
}

module.exports = { criar, tocar, existeEValida, listarDoUsuario, resumoPorUsuario, encerrar, encerrarTodasDoUsuario };
