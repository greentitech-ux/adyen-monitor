// storageBucket.js
// Resolve automaticamente o bucket certo do Firebase Storage. Projetos
// criados depois de ~out/2024 tem o bucket padrao nomeado
// "<project-id>.firebasestorage.app"; projetos mais antigos usam
// "<project-id>.appspot.com". Se FIREBASE_STORAGE_BUCKET nao estiver
// configurada certinho no ambiente (Render, etc.) com a convencao certa, o
// upload falha com "The specified bucket does not exist.".
//
// A primeira versao deste modulo sondava cada candidato com bucket.exists(),
// mas essa chamada exige a permissao IAM storage.buckets.get - que a conta
// de servico padrao do Firebase muitas vezes NAO tem. Nesse caso toda
// sondagem falhava e o fallback usava o primeiro candidato (a env var
// errada), e o upload continuava quebrando em producao. Agora a deteccao e
// feita executando a OPERACAO REAL contra cada candidato (comBucket): se o
// erro for "bucket nao existe", tenta o proximo; o primeiro que funcionar
// fica fixado pro resto do processo.
const admin = require('firebase-admin');

let bucketFixado = null; // primeiro bucket que completou uma operacao real

function candidatos() {
  const lista = [
    process.env.FIREBASE_STORAGE_BUCKET,
    `${process.env.FIREBASE_PROJECT_ID}.firebasestorage.app`,
    `${process.env.FIREBASE_PROJECT_ID}.appspot.com`,
  ].filter(Boolean);
  return [...new Set(lista)];
}

function ehErroBucketInexistente(err) {
  const msg = String(err?.message || '');
  return err?.code === 404 || /bucket does not exist|notfound/i.test(msg);
}

// executa op(bucket) tentando cada candidato ate um funcionar - qualquer
// erro que NAO seja "bucket nao existe" (ex: rede, permissao no objeto) e
// relancado na hora, sem mascarar o problema real
async function comBucket(op) {
  if (bucketFixado) return op(bucketFixado);
  let ultimoErro = null;
  for (const nome of candidatos()) {
    const bucket = admin.storage().bucket(nome);
    try {
      const resultado = await op(bucket);
      bucketFixado = bucket;
      return resultado;
    } catch (err) {
      ultimoErro = err;
      if (!ehErroBucketInexistente(err)) throw err;
      console.warn(`Storage: bucket "${nome}" não existe, tentando o próximo candidato...`);
    }
  }
  throw ultimoErro || new Error('Nenhum bucket de Storage configurado (FIREBASE_STORAGE_BUCKET/FIREBASE_PROJECT_ID).');
}

// mantido pros caminhos de leitura/listagem (stream, backup) - se algum
// upload ja fixou o bucket certo, usa ele direto; senao tenta a sondagem
// exists() (funciona quando a conta tem permissao) e por fim cai no
// primeiro candidato, como antes
async function resolverBucket() {
  if (bucketFixado) return bucketFixado;
  for (const nome of candidatos()) {
    const bucket = admin.storage().bucket(nome);
    try {
      const [existe] = await bucket.exists();
      if (existe) {
        bucketFixado = bucket;
        return bucket;
      }
    } catch (err) {
      // sem permissao pra sondar (storage.buckets.get) - tenta o proximo
    }
  }
  return admin.storage().bucket(candidatos()[0]);
}

module.exports = { resolverBucket, comBucket };
