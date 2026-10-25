# Painel de apuração · 2º turno (domingo, 25/10/2026)

Placar ao vivo, **mapa por cidade** (5.564 cidades, vermelho Lula, azul Flávio), **mapa dos estados**, regiões, gráfico e espaço de patrocínio.

## O que tem na pasta

| Arquivo | Para quê |
|---|---|
| `coletor.mjs` | Busca os dados no TSE e já serve o site. É o único programa que você roda. |
| `index.html` + `malha.json` | O site e o desenho das cidades. O coletor entrega os dois. |
| `mock-tse.mjs` | TSE de mentira, usado pelo ensaio. |

Precisa do Node 18 ou mais novo (`node --version`). Não instala mais nada.

## Sem computador: rodar na nuvem (Render, grátis, só com o celular)

1. Crie uma conta grátis em github.com e um repositório **público** chamado `apuracao`.
2. No repositório: Add file → Upload files, e envie **todos** os arquivos desta pasta (`coletor.mjs`, `index.html`, `malha.json`, `mock-tse.mjs`, `package.json`, `LEIA-ME.md`). Commit changes.
3. Em render.com, entre com o GitHub. New → Web Service → escolha o repositório. Preencha: Language `Node`, Build Command `npm install`, Start Command `node coletor.mjs`, Instance Type **Free**.
4. Em Environment, para o **teste com dados reais**, crie `TURNO` = `1`. Para ver o **ensaio**, crie `ENSAIO` = `1` (ou os dois). **Para o domingo, apague essas variáveis.**
5. Abra o endereço `https://apuracao-xxxx.onrender.com` que o Render mostra, e `/diag` no fim dele.
6. Para o serviço não dormir: em uptimerobot.com (grátis) crie um monitor HTTP em `https://SEU-ENDERECO.onrender.com/saude` a cada 5 minutos. O Render grátis dorme depois de 15 minutos sem visita, e dormindo ele não coleta.

## Passo a passo (computador)

**1. Ensaio, hoje, sem depender do TSE**

```
node coletor.mjs --ensaio
```

Abra http://localhost:8787. Roda uma noite de apuração inventada em uns 3 minutos, com aviso de "dados fictícios" na tela. Serve para ver o mapa acendendo cidade por cidade.

**2. Teste com dados reais do 1º turno** (já 100% apurado)

```
node coletor.mjs --turno 1
```

Abra http://localhost:8787/diag e confira:
- `config.ok` deve ser `true`;
- `cidades.ligadas` deve ficar perto de 5.564;
- `semLigacaoNoTSE` lista as cidades que não casaram com o IBGE. Ficam cinza no mapa.

Se `config.ok` vier `false`, copie o conteúdo de `/diag` e me mande.

**3. Domingo**

Ligue às 16h30 e deixe rodando até o fim:

```
node coletor.mjs
```

As urnas fecham às 17h (Brasília). Até o TSE publicar, a página mostra a contagem regressiva.

**4. Colocar na internet**

Instale o `cloudflared` (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) e rode, com o coletor já ligado:

```
cloudflared tunnel --url http://localhost:8787
```

Ele mostra um endereço `https://alguma-coisa.trycloudflare.com`. Esse é o link do site. O endereço muda a cada vez que você roda o comando, então ligue no sábado, anote e não feche. Deixe o computador na tomada e sem suspender.

Para muita gente ao mesmo tempo, rode o mesmo coletor num servidor pequeno na nuvem, com domínio. Pelo seu computador em casa, o que limita é a internet de upload: cada visitante baixa uns 0,5 MB na entrada e uns 50 KB a cada 30 segundos.

## Patrocínio

No `index.html`, procure `PATROCINIO`. Troque `titulo`, `detalhe` e `href` (link do anunciante). `ativo: false` esconde o espaço.

## Opções do coletor

| Opção | O que faz |
|---|---|
| `--turno 1` | Usa o 1º turno. |
| `--ensaio` | Noite inventada. `--duracao 200` muda a duração em segundos. |
| `--porta 8787` | Porta do site. |
| `--taxa 60` | Requisições por segundo ao TSE. O limite do TSE é 100 por IP, o máximo aceito aqui é 90. |
| `--config URL` | Endereço do arquivo de configuração de cidades, se o padrão falhar. |
| `--diag` | Só confere o que o TSE responde e mostra um resumo. |

Se o TSE responder 403 ou 429, o coletor para por 2 minutos sozinho e volta.

## O que não consegui conferir

- **Nunca falei com o TSE de verdade.** A minha rede não alcança o site deles. Usei a documentação pública (nome dos arquivos por cidade, formato do arquivo) e testei tudo contra um TSE de mentira que imita esse formato. Os passos 1 e 2 acima existem para pegar qualquer diferença antes de domingo.
- O endereço do arquivo que lista as cidades do TSE (`.../6258/config/mun-e006258-cm.json`) é o padrão das eleições anteriores. Se não for esse, use `--config`.
- O código de cidade do TSE é ligado ao do IBGE pelo nome, com tolerância para pequenas diferenças de grafia. Algumas podem sobrar sem ligação.
- A malha tem 5.564 cidades, e o Brasil tem 5.570. As que faltam ficam cinza.
- O 2º turno só existe no TSE a partir de domingo às 17h.
