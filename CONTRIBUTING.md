# Fluxo de trabalho: ambiente de teste (staging) x produção (main)

Este projeto usa **duas branches longas** e um Firebase separado para teste,
para nunca arriscar dados/cota de produção enquanto se testa algo novo.

```
feature/xxx  →  staging  →  master (produção)
   (você)      (teste)      (Render de produção, dados reais)
```

- `master` = **produção**. É a branch que o serviço do Render em produção
  usa (`zenith-ops`, ver `render.yaml`). Só recebe código já testado.
- `staging` = **ambiente de teste**. Roda num 2º serviço no Render, com um
  Firebase próprio de teste (cota e dados separados dos de produção).
- `feature/nome-da-mudanca` = branch onde você desenvolve cada mudança,
  criada a partir da `staging`.

## Passo a passo do dia a dia

1. Atualize a `staging` local e crie sua branch de feature a partir dela:
   ```bash
   git checkout staging
   git pull
   git checkout -b feature/minha-mudanca
   ```
2. Desenvolva e **teste localmente primeiro** (mais rápido que esperar
   deploy): rode `npm run dev` dentro de `server/` com um `.env` local
   apontando para o Firebase de teste (ver seção abaixo).
3. Quando estiver satisfeito, suba a branch e abra um Pull Request para
   `staging` (não para `master`):
   ```bash
   git push -u origin feature/minha-mudanca
   ```
   No GitHub, abra o PR com base em `staging`.
4. Faça o merge do PR em `staging`. O Render (serviço de staging) reimplanta
   sozinho automaticamente. Teste "no ar" na URL de staging.
5. Só depois de validar no staging, abra um PR de `staging` → `master`.
   Faça o merge. O Render de **produção** reimplanta sozinho.

> Nunca dê merge direto numa branch de feature para `master`. Sempre passe
> por `staging` primeiro.

## Ambiente local (.env de teste)

Dentro de `server/`, copie o exemplo e preencha com credenciais de **teste**:

```bash
cd server
cp .env.example .env
```

Use no `.env` local:
- `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` →
  do projeto Firebase de **teste** (veja abaixo como criar), nunca o de
  produção.
- `DASHBOARD_USER` / `DASHBOARD_PASSWORD`, `MASTER_EMAIL` / `MASTER_PASSWORD`,
  `JWT_SECRET`, `ENCRYPTION_KEY` → valores próprios de teste, diferentes dos
  de produção (gere novos com o comando sugerido no `.env.example`).
- `ADYEN_HMAC_KEYS` → pode deixar em branco em teste local (o servidor aceita
  webhooks sem verificar assinatura quando não configurado - só faça isso
  localmente, nunca em produção).

## Criando o projeto Firebase de teste (uma vez só)

1. Acesse [console.firebase.google.com](https://console.firebase.google.com)
   e clique em **Adicionar projeto**.
2. Dê um nome, ex: `zenith-ops-teste` (pode desativar o Google Analytics,
   não é necessário).
3. Ative o **Firestore Database** (modo produção, região `southamerica-east1`
   por exemplo) e, se for testar anexos de disputa, também o **Storage**.
4. Vá em **Configurações do projeto → Contas de serviço → Gerar nova chave
   privada**. Isso baixa um JSON com `project_id`, `client_email` e
   `private_key` - são exatamente os 3 valores do `.env`.

Esse projeto tem sua **própria cota gratuita** (Firestore: 50 mil
leituras/dia, 20 mil escritas/dia), totalmente separada da cota do projeto
de produção - testar à vontade aqui nunca afeta produção.

## Serviço de staging no Render (uma vez só)

1. No [Render Dashboard](https://dashboard.render.com), clique em
   **New → Web Service**.
2. Conecte o mesmo repositório GitHub (`adyen-monitor`), mas selecione a
   branch **`staging`** (em vez de `master`).
3. Configurações (iguais ao `render.yaml`, só que manual, pois o
   `render.yaml` de produção não deve controlar dois serviços):
   - Root Directory: `server`
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Plan: Free
   - Nome sugerido: `zenith-ops-staging`
4. Preencha as variáveis de ambiente com os valores de **teste** (o Firebase
   de teste criado acima, senhas de teste, etc - nunca reutilize os
   segredos de produção aqui).
5. Deploy automático: no Render, ligue "Auto-Deploy" para a branch
   `staging` - assim todo merge nessa branch já reimplanta sozinho.

O serviço de produção (`zenith-ops`, já existente, definido em
`render.yaml`) continua ligado apenas à branch `master` e não é afetado por
nada disso.
