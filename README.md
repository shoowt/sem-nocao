# 😈 Sem Noção

Jogo de cartas online de completar frases, para **2 a 6 jogadores**, usando as cartas do PDF
(216 cartas pretas e 513 brancas, em `data/cartas.json`).

## Como rodar

Precisa só do [Node.js](https://nodejs.org) 18 ou mais novo, sem `npm install`.

```powershell
node server.js
```

Abra http://localhost:3000. O terminal também mostra o endereço para quem está **na mesma rede Wi-Fi**
(algo como `http://192.168.0.10:3000`).

### Jogar com amigos que estão longe

O servidor precisa estar acessível pela internet. Duas opções simples:

- **Túnel temporário** (o servidor continua no seu PC): com o [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) instalado,
  rode `cloudflared tunnel --url http://localhost:3000` e mande o link `https://….trycloudflare.com` pra galera.
- **Hospedar** em um serviço que roda Node (Render, Railway, Fly.io…): suba esta pasta, comando de start `npm start`.
  O servidor usa a variável `PORT` automaticamente.

## Regras implementadas

- Cada jogador tem 10 cartas brancas; a mão é completada no começo de toda rodada.
- O primeiro juiz é quem “fez cocô mais recentemente” (o anfitrião escolhe no lobby, ou sorteia).
- O juiz lê a carta preta; os outros jogam em segredo (cartas de 2 ou 3 lacunas pedem cartas na ordem).
- O juiz revela as respostas embaralhadas uma a uma e escolhe a melhor: +1 ponto, e a carta preta vai pro vencedor.
- O juiz passa para o próximo jogador.
- Fim: pontuação alvo (3, 5, 8, 10, 15) ou “∞”, que vai até acabarem as cartas pretas.
- Com 2 jogadores, entra a **Carta do Monte** 🎲: uma resposta aleatória do baralho (dá pra ligar com mais gente também).

Extras: reações com emoji, desfazer jogada, anfitrião pode apressar a rodada ou remover alguém,
reconexão automática (dá pra recarregar a página), revanche com um clique.

## Arquivos

| Arquivo | O quê |
| --- | --- |
| `server.js` | Servidor HTTP + tempo real (Server-Sent Events) e toda a lógica do jogo |
| `public/` | Site (HTML, CSS, JS puro) |
| `data/cartas.json` | Cartas extraídas do PDF; edite à vontade para adicionar ou remover cartas |

As salas ficam na memória: reiniciar o servidor encerra as partidas em andamento.
