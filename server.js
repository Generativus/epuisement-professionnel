const WebSocket = require('ws');
const PORT = process.env.PORT || 8080; 

// Créez un serveur WebSocket. Render assignera la variable PORT
const wss = new WebSocket.Server({ port: PORT });

console.log(`Serveur de signalisation démarré sur le port ${PORT}`);

// Événement lorsqu'un nouveau client se connecte
wss.on('connection', function connection(ws) {
  console.log('Nouveau client connecté. Total:', wss.clients.size);

  // Événement lorsqu'un message est reçu d'un client
  ws.on('message', function incoming(message) {
    console.log(`Message reçu: ${message}`);

    // Relayer le message à tous les AUTRES clients connectés
    wss.clients.forEach(function each(client) {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  });

  // Événement lorsqu'un client se déconnecte
  ws.on('close', () => {
    console.log('Client déconnecté. Total:', wss.clients.size);
  });

  // En cas d'erreur
  ws.on('error', (error) => {
    console.error('Erreur WebSocket:', error);
  });
});
