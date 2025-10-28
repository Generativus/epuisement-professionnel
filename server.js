const WebSocket = require('ws');
const PORT = process.env.PORT || 8080; 

// Map pour stocker les connexions WebSocket par ID de client (pour le routage ciblé)
const connectedClients = new Map();

// Créez un serveur WebSocket. Render assignera la variable PORT
const wss = new WebSocket.Server({ port: PORT });

console.log(`Serveur de signalisation démarré sur le port ${PORT}`);

// Événement lorsqu'un nouveau client se connecte
wss.on('connection', function connection(ws) {
  let clientId = null; // L'ID du client sera défini lors de l'enregistrement

  console.log('Nouveau client connecté. Total:', wss.clients.size);

  // Événement lorsqu'un message est reçu d'un client
  ws.on('message', function incoming(message) {
    try {
      const data = JSON.parse(message);
      console.log(`Message reçu de ${clientId || 'un client non enregistré'}: ${message}`);

      // 1. Gérer l'enregistrement initial du client
      if (data.type === 'register_client' && data.senderId) {
        // Enregistrer l'ID du client et stocker la connexion
        clientId = data.senderId;
        connectedClients.set(clientId, ws);
        console.log(`Client enregistré: ${clientId}. Total enregistré: ${connectedClients.size}`);
        return; // Fin du traitement pour l'enregistrement
      }

      // Le client n'est pas enregistré, ne peut pas router les messages P2P
      if (!clientId) {
        console.log("Erreur: Message P2P reçu d'un client non enregistré.");
        return; 
      }
      
      // 2. Gérer le routage ciblé (Offer, Answer, Candidate)
      if (data.receiverId) {
        const targetClient = connectedClients.get(data.receiverId);
        if (targetClient && targetClient.readyState === WebSocket.OPEN) {
          // Acheminer le message uniquement au destinataire spécifié
          targetClient.send(message);
          console.log(`Message routé de ${clientId} vers ${data.receiverId}`);
        } else {
          console.log(`Erreur de routage: Destinataire ${data.receiverId} introuvable ou non prêt.`);
        }
      } 
      
      // 3. Gérer la demande de jonction initiale (join_request)
      // La demande de jonction est la seule exception où l'on utilise le hostId
      // pour trouver la connexion cible.
      else if (data.type === 'join_request' && data.hostId) {
          const hostClient = connectedClients.get(data.hostId);
          if (hostClient && hostClient.readyState === WebSocket.OPEN) {
              // Acheminer la demande de jonction uniquement à l'hôte
              hostClient.send(message);
              console.log(`Demande de jonction routée de ${clientId} vers l'hôte ${data.hostId}`);
          } else {
              console.log(`Erreur de routage: Hôte ${data.hostId} introuvable ou non prêt.`);
          }
      }

      // 4. Gérer les messages de diffusion (host_ready, game_start, etc.)
      // Si le message n'est pas routable, diffusez-le à tous les autres clients enregistrés.
      // NOTE: Dans un jeu P2P, ce type de diffusion est rare (souvent seulement pour des événements généraux)
      else if (data.type === 'host_ready') {
          // host_ready n'a pas besoin d'être diffusé car il est géré côté client
          console.log(`Message de type ${data.type} reçu mais pas diffusé ni routé.`);
      }


    } catch (error) {
      console.error('Erreur lors du traitement du message:', error);
    }
  });

  // Événement lorsqu'un client se déconnecte
  ws.on('close', () => {
    // Retirer le client de la map s'il était enregistré
    if (clientId) {
      connectedClients.delete(clientId);
      console.log(`Client déconnecté et retiré: ${clientId}. Total enregistré: ${connectedClients.size}`);
    }
    console.log('Client déconnecté. Total des connexions:', wss.clients.size);
  });

  // En cas d'erreur
  ws.on('error', (error) => {
    console.error('Erreur WebSocket:', error);
  });
});
