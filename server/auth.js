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

const JWT_SECRET = process.env.JWT_SECRET || '';
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET ausente. Configure uma chave forte (veja server/.env.example).');
}

const usersRef = db.collection('users');

// permissoes vazias por padrao - o Master preenche na hora de criar o acesso
function emptyPermissions() {
  return { sections: [], unidades: [], vaultGroups: [] };
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
  const ok = await bcrypt.compare(String(password || ''), user.passwordHash);
  if (!ok) throw new Error('Email ou senha invalidos.');

  const token = jwt.sign({ sub: doc.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
  return { token, user: toPublicUser(doc.id, user) };
}

function toPublicUser(id, user) {
  return {
    id,
    email: user.email,
    role: user.role,
    permissions: user.role === 'master' ? null : user.permissions || emptyPermissions(),
  };
}

async function getUserById(id) {
  const doc = await usersRef.doc(id).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
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
      req.user = user;
      req.isMaster = user.role === 'master';
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
  getUserById,
  toPublicUser,
  requireAuth,
  requireMaster,
  hasSection,
  filterByUnidade,
  emptyPermissions,
};
