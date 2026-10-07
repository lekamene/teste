# REAL OU FAKE — Urubaits

Web app multiplayer para feira universitária.

## O que já está implementado
- Tela principal para TV/projetor (`/tela.html`)
- Entrada pelo celular via QR Code (`/entrar.html`)
- Respostas REAL/FAKE no celular (`/jogo.html`)
- Cronômetro geral de 2 minutos
- Pontuação por acerto + velocidade (até 1000 pontos por questão)
- Uma única participação por código
- Ranking geral
- Resultado individual e revisão dos erros
- Painel administrativo (`/admin.html`)
- Geração de códigos de participação
- Cadastro de questões com upload de imagem
- Estatísticas
- Sincronização em tempo real via Socket.IO
- Persistência SQLite

## Rodar localmente
1. Instale Node.js 18+.
2. Execute `npm install`.
3. Defina `ADMIN_PASSWORD` e, se publicar, `PUBLIC_BASE_URL`.
4. Execute `npm start`.
5. Abra `http://localhost:3000/admin.html`.

Senha padrão local se `ADMIN_PASSWORD` não for definida: `urubaits-demo`.
Troque isso antes da feira.

## Publicação
Este projeto precisa de um host Node com processo persistente e disco persistente por usar Socket.IO + SQLite + uploads. Exemplos adequados: Render, Railway, Fly.io, VPS ou Replit manual com runtime Node. Para Vercel serverless, troque SQLite/Socket.IO por um banco/realtime externo (Supabase/Firebase/Ably etc.).

## Importante
As 10 imagens iniciais são apenas placeholders educativos gerados localmente. Substitua-as no painel pelas imagens reais/simuladas do seu trabalho.
