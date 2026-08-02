# Zenith Ops

Backend que recebe os webhooks da Adyen em tempo real, normaliza os eventos
(aprovado, recusado, fraude suspeita, estornado, falha no estorno, chargeback,
notificação de chargeback, fim do período de disputa) e serve um dashboard
que atualiza sozinho.

## 1. Instalar

```bash
cd server
npm install
cp .env.example .env
```

Edite o `.env` e coloque a `ADYEN_HMAC_KEY` (Customer Area da Adyen →
Developers → Webhooks → seu webhook → HMAC Key). Sem isso, qualquer um que
descobrir a URL do seu webhook poderia mandar notificações falsas.

## 2. Rodar

```bash
npm start
```

O dashboard fica em `http://localhost:3000`. O endpoint do webhook é
`http://localhost:3000/webhooks/adyen`.

## 3. Testar com dados da planilha atual (opcional)

Se quiser ver o dashboard populado antes de configurar o webhook de verdade:

```bash
node seed.js /caminho/para/adyen_norm.json
```

## 4. Expor o webhook para a Adyen (ambiente local)

A Adyen precisa alcançar sua URL publicamente. Em desenvolvimento, use o
[ngrok](https://ngrok.com):

```bash
ngrok http 3000
```

Pegue a URL `https://xxxx.ngrok.app` e configure em: Customer Area →
Developers → Webhooks → Standard notification → Server configuration:
`https://xxxx.ngrok.app/webhooks/adyen`.

Em produção, troque isso pela URL real do servidor (rodando atrás de HTTPS).

## 5. Habilitar os campos extras na conta Adyen

Alguns dos dados que você pediu só chegam no webhook se estiverem habilitados
na configuração da conta (Customer Area → Developers → Additional data):

- **Últimos 4 dígitos do cartão** → habilite "Card summary" (`cardSummary`)
- **BIN do cartão** (usado para descobrir o banco emissor) → habilite
  "Card BIN" (`cardBin`)
- **Resultado de fraude** → habilite "Fraud results" se você usa o Risk
  da Adyen; caso contrário, o sistema usa o campo `reason` da recusa
  (quando o motivo é `FRAUD`) como sinal de fraude.

## 6. Sobre o "banco emissor"

A Adyen não manda o nome do banco (ex.: "ITAU UNIBANCO S.A.") diretamente -
só o BIN. O arquivo `binLookup.js` consulta um serviço de BIN lookup
(binlist.net por padrão) para resolver o nome do banco a partir do BIN, com
cache em memória. Se sua planilha atual já resolve isso de outra forma
(um serviço pago, por exemplo), é só trocar a implementação desse arquivo -
o resto do sistema não muda.

## Eventos e status mapeados

| eventCode da Adyen                | status no dashboard          |
|---|---|
| AUTHORISATION (sucesso)           | APROVADO                      |
| AUTHORISATION (falha)             | RECUSADO                      |
| REFUND (sucesso)                  | ESTORNADO                     |
| REFUND (falha) / REFUND_FAILED    | FALHA_ESTORNO                 |
| REFUNDED_REVERSED                 | ESTORNO_REVERTIDO             |
| CHARGEBACK / SECOND_CHARGEBACK    | CHARGEBACK                    |
| CHARGEBACK_REVERSED               | CHARGEBACK_REVERTIDO          |
| NOTIFICATION_OF_CHARGEBACK        | NOTIFICATION_OF_CHARGEBACK    |
| DISPUTE_DEFENSE_PERIOD_ENDED      | DISPUTE_DEFENSE_PERIOD_ENDED  |

Fraude é marcada separadamente (`fraudeSuspeita: true`) e pode aparecer em
qualquer status - ela não substitui o status, é um alerta adicional.

## Contas, permissões e Cofre de senhas

Além do Basic Auth do site inteiro (`DASHBOARD_USER`/`DASHBOARD_PASSWORD`),
o app tem seu próprio sistema de login (`JWT_SECRET`, `MASTER_EMAIL`,
`MASTER_PASSWORD` no `.env`): o Master é criado automaticamente na primeira
vez que o servidor sobe e, pela tela **Usuários** (`/usuarios.html`), cria
outros acessos com permissões granulares:

- **Seções**: `monitor` (este dashboard), `disputas` (`/relatorios.html`),
  `cofre` (`/cofre.html`, senhas da equipe - URL, usuário, senha, observação,
  organizadas em grupos/unidades, criptografadas com `ENCRYPTION_KEY`),
  `fechamentos`/`lancamento` (fechamento de caixa, ver acima) e
  `entregas`/`entregas-lancamento` (entregas dos motoboys - substitui o app
  de entregas do AppSheet: `/entrega-lancamento.html` é onde a loja lança
  cada corrida/turno de um entregador, `/entregas.html` é o painel de
  acompanhamento; o Master sempre vê tudo, cada loja só vê e lança nas
  próprias unidades).
  - O painel de Entregas também traz o **histórico** direto da planilha
    "MOTOS BRAVO" do Google Sheets (mesma planilha do AppSheet atual),
    sincronizado automaticamente pelo `entregasSync.js` (mesmo mecanismo do
    Fechamento, ver `SHEET_ID_ARCFOOD`/`SHEET_ID_BRAVO` acima) - a planilha
    (`SHEET_ID_ENTREGAS`, por padrão a "MOTOS BRAVO") precisa estar
    compartilhada com o email de serviço (`FIREBASE_CLIENT_EMAIL`) como
    leitora. Por padrão sincroniza as abas `Garanhuns,Bessa,Caruaru,Tirol,
    MMTirol` (`SHEET_ABAS_ENTREGAS`) - a aba `BDMotos` fica de fora por ora
    porque não tem a coluna "Data" preenchida na planilha de origem (só o
    dia da semana); assim que isso for corrigido na planilha (ou os dados
    virem de outra fonte), é só adicionar `BDMotos` à lista de abas. Esses
    registros históricos são só leitura (não passam pela fila de correção) e
    as etiquetas (fotos) ainda apontam pro arquivo original no Drive do
    AppSheet (`etiquetaOrigem`) - não foram migradas pro Storage do app.
- **Unidades**: filtra quais `merchantAccountCode`/código de unidade cada
  acesso vê no monitor, nas disputas, nos fechamentos e nas entregas.
- **Grupos do cofre**: quais grupos de senha cada acesso pode ver/gerenciar.

Ver `server/auth.js`, `server/users.js` e `server/vault*.js`.

## Limitações honestas

- O armazenamento é um arquivo JSON local (`data/transactions.json`) - ótimo
  para começar e para o volume que vi na sua planilha (centenas/dia). Se o
  volume crescer muito (milhares por hora), vale migrar para Postgres.
- O servidor precisa ficar rodando o tempo todo para não perder webhooks -
  rode em uma VPS, Railway, Render, ou similar, não só no seu notebook.
- Endpoints de escrita (webhook) não têm autenticação além do HMAC - é
  suficiente para o webhook da Adyen, mas não exponha `/api/*` publicamente
  sem pensar em quem mais pode acessar os dados de clientes.
