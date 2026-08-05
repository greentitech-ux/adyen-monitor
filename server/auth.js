// auth.js
// Contas de usuario do app: um Master (acesso total, cria e gerencia os
// outros acessos) e usuarios comuns com permissoes granulares (secoes do
// app, unidades e grupos do cofre de senhas que podem ver). Login por
// email+senha (bcrypt) com token JWT - isso fica por DENTRO do Basic Auth
// que ja protege o site inteiro (veja index.js), como uma segunda camada
// que sabe "quem" esta acessando, nao so "que tem a senha do site".
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./firestore');
const { createKeyedCache } = require('./liveCache');

const JWT_SECRET = process.env.JWT_SECRET || '';
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET ausente. Configure uma chave forte (veja server/.env.example).');
}

const usersRef = db.collection('users');

// permissoes vazias por padrao - o Master preenche na hora de criar o acesso
function emptyPermissions() {
  return { sections: [], unidades: [], vaultSubgroups: [] };
}

const MAX_TENTATIVAS = 3;

// minutos desde meia-noite, no horario de Brasilia - independente do fuso
// configurado no SO do servidor (UTC na hospedagem). Mesmo principio do
// agoraBrasilia() do frontend, so que devolve so a hora/minuto que interessa
// pra comparar com a janela de horario permitido.
function minutosAgoraBrasilia() {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const o = {};
  partes.forEach((p) => { if (p.type !== 'literal') o[p.type] = p.value; });
  const hora = o.hour === '24' ? '00' : o.hour;
  return Number(hora) * 60 + Number(o.minute);
}

// horarioPermitido: { ativo, inicio:'HH:MM', fim:'HH:MM' } - sem restricao se
// ativo for falso. Suporta janela que vira a meia-noite (ex: 22:00-06:00).
// inicio===fim e tratado como "sem restricao" (evita bloquear o dia inteiro
// por engano de configuracao).
function dentroDoHorarioPermitido(cfg) {
  if (!cfg || !cfg.ativo || !cfg.inicio || !cfg.fim) return true;
  const [hi, mi] = cfg.inicio.split(':').map(Number);
  const [hf, mf] = cfg.fim.split(':').map(Number);
  const inicio = hi * 60 + mi;
  const fim = hf * 60 + mf;
  if (inicio === fim) return true;
  const agora = minutosAgoraBrasilia();
  if (inicio < fim) return agora >= inicio && agora < fim;
  return agora >= inicio || agora < fim;
}

function mensagemHorarioPermitido(cfg) {
  return `Acesso permitido apenas das ${cfg.inicio} às ${cfg.fim}.`;
}

// garante que existe um Master assim que o servidor sobe. So cria se ainda
// nao existir nenhum - nao sobrescreve senha em runs seguintes (pra nao
// travar o Master fora caso o env var mude por engano).
async function ensureMaster() {
  const existing = await usersRef.where('role', '==', 'master').limit(1).get();
  if (!existing.empty) return;

  const email = (process.env.MASTER_EMAIL || '').trim().toLowerCase();
  const password = process.env.MASTER_PASSWORD || '';
  if (!email || !password) {
    console.warn('AVISO: nenhum usuario Master existe e MASTER_EMAIL/MASTER_PASSWORD nao estao configurados - login do app ficara indisponivel ate configurar (veja server/.env.example).');
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await usersRef.add({
    email,
    passwordHash,
    role: 'master',
    active: true,
    permissions: emptyPermissions(),
    createdAt: new Date().toISOString(),
  });
  console.log(`Usuario Master criado: ${email}`);
}

async function login(email, password) {
  email = String(email || '').trim().toLowerCase();
  const snap = await usersRef.where('email', '==', email).limit(1).get();
  if (snap.empty) throw new Error('Email ou senha invalidos.');
  const doc = snap.docs[0];
  const user = doc.data();
  if (user.active === false) throw new Error('Este acesso foi desativado.');
  if (user.locked) throw new Error('Acesso bloqueado após tentativas de senha erradas. Fale com o Master.');
  if (user.role !== 'master' && !dentroDoHorarioPermitido(user.horarioPermitido)) {
    throw new Error(mensagemHorarioPermitido(user.horarioPermitido));
  }

  const ok = await bcrypt.compare(String(password || ''), user.passwordHash);
  if (!ok) {
    // 3 senhas erradas seguidas bloqueia o acesso - so o Master destrava
    // (trocando a senha pela tela de Usuarios)
    const tentativas = (user.failedAttempts || 0) + 1;
    const bloqueou = tentativas >= MAX_TENTATIVAS && user.role !== 'master';
    await doc.ref.update({ failedAttempts: tentativas, locked: bloqueou });
    if (bloqueou) throw new Error('Acesso bloqueado após 3 tentativas de senha erradas. Fale com o Master.');
    throw new Error('Email ou senha invalidos.');
  }

  if (user.failedAttempts) await doc.ref.update({ failedAttempts: 0 });

  const token = jwt.sign({ sub: doc.id, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
  return { token, user: toPublicUser(doc.id, user) };
}

// reautenticacao (ex: confirmar a senha antes de solicitar um estorno) - nao
// gera token novo, so confirma que a senha bate com a conta logada
async function verifyPassword(userId, password) {
  const user = await getUserById(userId);
  if (!user) return false;
  return bcrypt.compare(String(password || ''), user.passwordHash);
}

function toPublicUser(id, user) {
  return {
    id,
    email: user.email,
    role: user.role,
    permissions: user.role === 'master' ? null : user.permissions || emptyPermissions(),
  };
}

// requireAuth chama isso em TODA requisicao autenticada (~90 rotas da API) -
// sem cache, era 1 leitura no Firestore por chamada, o maior contribuinte pro
// RESOURCE_EXHAUSTED (cota diaria de leitura estourada) que derrubou o login
// pra todo mundo, ate o Master. TTL curto: ainda reage rapido a
// active/locked/horarioPermitido mudando (o Master vendo o proprio efeito na
// hora importa mais que aqui), mas absorve as varias chamadas que acontecem
// quase juntas (ex: a pagina Painel dispara 6 chamadas em paralelo). Invalidado
// na hora sempre que o Master mexe no usuario (ver users.js).
const usuarioCache = createKeyedCache(async (id) => {
  const doc = await usersRef.doc(id).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}, 15 * 1000);

function getUserById(id) {
  return usuarioCache.cached(id);
}

function invalidarUsuario(id) {
  usuarioCache.invalidar(id);
}

// exige um token valido (via header Authorization: Bearer, ou ?token= na
// query - usado pelo EventSource do SSE, que nao manda headers custom) e
// carrega o usuario/permissoes atual em req.user
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, headerToken] = header.split(' ');
  const token = (scheme === 'Bearer' && headerToken) || req.query.token;
  if (!token) return res.status(401).json({ error: 'Autenticação necessária.' });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Sessão expirada, faça login novamente.' });
  }

  getUserById(payload.sub)
    .then((user) => {
      if (!user || user.active === false) return res.status(401).json({ error: 'Acesso inválido ou desativado.' });
      if (user.role !== 'master' && !dentroDoHorarioPermitido(user.horarioPermitido)) {
        return res.status(401).json({ error: mensagemHorarioPermitido(user.horarioPermitido) });
      }
      req.user = user;
      req.isMaster = user.role === 'master';
      req.isAdmin = !!user.isAdmin;
      req.podeCatalogoEstoque = !!user.podeCatalogoEstoque;
      req.permissions = req.isMaster ? null : user.permissions || emptyPermissions();
      next();
    })
    .catch(next);
}

// so deixa passar quem e Master - usado nas rotas de gestao de usuarios
function requireMaster(req, res, next) {
  if (!req.isMaster) return res.status(403).json({ error: 'Apenas o acesso Master pode fazer isso.' });
  next();
}

// Master ou usuario com a tag Admin (atribuida pelo Master em usuarios.html) -
// usado nas rotas de aprovar/rejeitar solicitacoes da Central, pra permitir
// que Admins decidam sem precisar do acesso Master completo
function requireMasterOrAdmin(req, res, next) {
  if (!req.isMaster && !req.isAdmin) return res.status(403).json({ error: 'Apenas Master ou Admin pode fazer isso.' });
  next();
}

// Master ou usuario com a permissao de Catalogo do Estoque (atribuida pelo
// Master em usuarios.html) - deixa um gerente organizar setor/tipo, ajustar
// custo de referencia e ativar/desativar item sem precisar de acesso Master
function requireMasterOuCatalogoEstoque(req, res, next) {
  if (!req.isMaster && !req.podeCatalogoEstoque) return res.status(403).json({ error: 'Você não tem permissão pra gerenciar o Catálogo do Estoque.' });
  next();
}

// checa se o usuario atual pode usar uma secao do app ('monitor' | 'disputas' | 'cofre')
function hasSection(req, section) {
  return req.isMaster || (req.permissions.sections || []).includes(section);
}

// filtra uma lista de itens com campo `unidade` pelas unidades permitidas
// (Master ve tudo, sem filtro)
function filterByUnidade(req, list) {
  if (req.isMaster) return list;
  const allowed = new Set(req.permissions.unidades || []);
  return list.filter((item) => item.unidade && allowed.has(item.unidade));
}

module.exports = {
  ensureMaster,
  login,
  verifyPassword,
  getUserById,
  toPublicUser,
  requireAuth,
  requireMaster,
  requireMasterOrAdmin,
  requireMasterOuCatalogoEstoque,
  hasSection,
  filterByUnidade,
  emptyPermissions,
  dentroDoHorarioPermitido,
  invalidarUsuario,
};
