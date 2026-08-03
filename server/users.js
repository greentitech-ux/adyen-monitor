// users.js
// Gestao dos acessos criados pelo Master: cada usuario tem permissoes
// proprias (secoes do app, unidades, grupos do cofre). So o Master pode
// chamar essas funcoes (aplicado nas rotas via auth.requireMaster).
const bcrypt = require('bcryptjs');
const db = require('./firestore');
const { emptyPermissions } = require('./auth');

const usersRef = db.collection('users');

const VALID_SECTIONS = ['monitor', 'disputas', 'cofre', 'fechamentos', 'lancamento', 'sangria', 'entregas', 'entregas-lancamento', 'ifood', 'solicitacoes', 'tecnico'];

function sanitizePermissions(input) {
  const p = input || {};
  return {
    sections: Array.isArray(p.sections) ? p.sections.filter((s) => VALID_SECTIONS.includes(s)) : [],
    unidades: Array.isArray(p.unidades) ? p.unidades.map(String) : [],
    vaultSubgroups: Array.isArray(p.vaultSubgroups) ? p.vaultSubgroups.map(String) : [],
  };
}

async function list() {
  const snap = await usersRef.orderBy('createdAt', 'asc').get();
  return snap.docs.map(toPublic);
}

async function create({ email, password, permissions }) {
  email = String(email || '').trim().toLowerCase();
  if (!email || !password) throw new Error('Email e senha são obrigatórios.');
  if (password.length < 8) throw new Error('A senha deve ter pelo menos 8 caracteres.');

  const existing = await usersRef.where('email', '==', email).limit(1).get();
  if (!existing.empty) throw new Error('Já existe um acesso com esse email.');

  const passwordHash = await bcrypt.hash(password, 12);
  const doc = await usersRef.add({
    email,
    passwordHash,
    role: 'user',
    active: true,
    permissions: sanitizePermissions(permissions),
    createdAt: new Date().toISOString(),
  });
  return toPublic(await doc.get());
}

async function updatePermissions(id, permissions) {
  const ref = usersRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Acesso não encontrado.');
  if (snap.data().role === 'master') throw new Error('O acesso Master não usa permissões.');
  await ref.update({ permissions: sanitizePermissions(permissions) });
  return toPublic(await ref.get());
}

async function setActive(id, active) {
  const ref = usersRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Acesso não encontrado.');
  if (snap.data().role === 'master') throw new Error('O acesso Master não pode ser desativado.');
  await ref.update({ active: !!active });
  return toPublic(await ref.get());
}

async function resetPassword(id, password) {
  if (!password || password.length < 8) throw new Error('A senha deve ter pelo menos 8 caracteres.');
  const ref = usersRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Acesso não encontrado.');
  const passwordHash = await bcrypt.hash(password, 12);
  // o Master trocando a senha tambem desbloqueia o acesso (ex: apos 3 tentativas erradas)
  await ref.update({ passwordHash, locked: false, failedAttempts: 0 });
  return { ok: true };
}

async function remove(id) {
  const ref = usersRef.doc(id);
  const snap = await ref.get();
  if (!snap.exists) return;
  if (snap.data().role === 'master') throw new Error('O acesso Master não pode ser excluído.');
  await ref.delete();
}

function toPublic(doc) {
  const data = doc.data();
  return {
    id: doc.id,
    email: data.email,
    role: data.role,
    active: data.active !== false,
    locked: !!data.locked,
    permissions: data.role === 'master' ? null : data.permissions || emptyPermissions(),
    createdAt: data.createdAt,
  };
}

module.exports = { VALID_SECTIONS, list, create, updatePermissions, setActive, resetPassword, remove };
