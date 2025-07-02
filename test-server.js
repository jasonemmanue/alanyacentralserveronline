// Fichier : test-server.js (version mise à jour pour le navigateur)

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = 9001;

// 1. Créer un serveur HTTP de base
const server = http.createServer((req, res) => {
  // Cette partie répondra à votre navigateur
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('✅ Le serveur de test est en ligne et fonctionne !');
});

// 2. Attacher notre serveur WebSocket au serveur HTTP
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('🎉 UN CLIENT WEBSOCKET S\'EST CONNECTÉ AVEC SUCCÈS ! 🎉');
  ws.send('Bienvenue ! Vous êtes connecté au serveur de test.');
});

// 3. Démarrer le serveur HTTP
server.listen(PORT, () => {
  console.log(`--- SERVEUR DE TEST ULTIME ---`);
  console.log(`Prêt. Ouvrez votre navigateur web à l'adresse : http://localhost:${PORT}`);
});