// storageBucket.js
// Resolve automaticamente o bucket certo do Firebase Storage. Projetos
// criados depois de ~out/2024 tem o bucket padrao nomeado
// "<project-id>.firebasestorage.app"; projetos mais antigos usam
// "<project-id>.appspot.com". Se FIREBASE_STORAGE_BUCKET nao estiver
// configurada certinho no ambiente (Render, etc.) com a convencao certa, o
// upload falha com "The specified bucket does not exist." - esse modulo
// tenta os candidatos nessa ordem e usa o primeiro que existir de fato,
// evitando depender de acertar a env var manualmente.
const admin = require('firebase-admin');

let bucketPromise = null;

async function resolverBucket() {
  if (bucketPromise) return bucketPromise;
  bucketPromise = (async () => {
    const candidatos = [
      process.env.FIREBASE_STORAGE_BUCKET,
      `${process.env.FIREBASE_PROJECT_ID}.firebasestorage.app`,
      `${process.env.FIREBASE_PROJECT_ID}.appspot.com`,
    ].filter(Boolean);

    for (const nome of candidatos) {
      const bucket = admin.storage().bucket(nome);
      try {
        const [existe] = await bucket.exists();
        if (existe) return bucket;
      } catch (err) {
        // tenta o proximo candidato
      }
    }
    // nenhum candidato confirmado - usa o primeiro mesmo assim (o erro real
    // aparece na hora do upload, ja com mensagem tratada em storage.js)
    return admin.storage().bucket(candidatos[0]);
  })();
  return bucketPromise;
}

module.exports = { resolverBucket };
