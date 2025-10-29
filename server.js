const WebSocket = require('ws');
const PORT = process.env.PORT || 8080; 

// --- STRUCTURES DE DONNÉES GLOBALES ---

// Map pour stocker les connexions WebSocket par ID de client (joueur)
const connectedClients = new Map();

// Map pour stocker les salons de jeu actifs. Clé: roomId, Valeur: { players: Map<clientId, playerState>, hostId: string, state: GAME_STATES }
const gameRooms = new Map();

// États du jeu (pour le serveur)
const GAME_STATES = {
    WAITING_FOR_HOST: 'waiting',
    LOBBY: 'lobby',
    IN_GAME: 'in_game',
    GAME_OVER: 'game_over'
};

const MIN_PLAYERS = 2; // Nombre minimum de joueurs requis pour démarrer

// --- FONCTIONS UTILITAIRES ---

/**
 * Envoie un message JSON à un client spécifique.
 * @param {string} clientId L'ID du client destinataire.
 * @param {object} data L'objet de données à envoyer.
 */
function sendToClient(clientId, data) {
    const client = connectedClients.get(clientId);
    if (client && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
    }
}

/**
 * Diffuse un message JSON à tous les clients d'un salon de jeu.
 * @param {string} roomId L'ID du salon.
 * @param {object} data L'objet de données à envoyer.
 * @param {string} [excludeClientId=null] ID du client à exclure de la diffusion.
 */
function broadcastToRoom(roomId, data, excludeClientId = null) {
    const room = gameRooms.get(roomId);
    if (room) {
        const message = JSON.stringify(data);
        for (const [clientId, clientState] of room.players.entries()) {
            if (clientId !== excludeClientId) {
                const clientWs = connectedClients.get(clientId);
                if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(message);
                }
            }
        }
    }
}

/**
 * Génère un identifiant unique (UUID v4 simplifié).
 * @returns {string} Un identifiant unique.
 */
function generateId() {
    return 'id-' + Math.random().toString(36).substring(2, 9);
}

// --- LOGIQUE DU SERVEUR DE JEU ---

/**
 * Met à jour l'état du jeu côté client pour tous les joueurs du salon.
 * @param {string} roomId 
 */
function syncRoomState(roomId) {
    const room = gameRooms.get(roomId);
    if (!room) return;

    // Créer une liste simplifiée des joueurs pour l'envoi au client
    const playersList = Array.from(room.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        color: p.color,
        workPoints: p.workPoints,
        burnout: p.burnout,
        isHost: p.isHost
    }));

    broadcastToRoom(roomId, {
        type: 'game_state_sync',
        state: room.state,
        hostId: room.hostId,
        players: playersList,
        playerCount: playersList.length
    });
}

/**
 * Trouve le salon auquel appartient un client donné.
 * @param {string} clientId L'ID du client.
 * @returns {string | null} L'ID du salon ou null.
 */
function findRoomIdByClient(clientId) {
    for (const [roomId, room] of gameRooms.entries()) {
        if (room.players.has(clientId)) {
            return roomId;
        }
    }
    return null;
}

/**
 * Gère la déconnexion d'un client.
 * @param {string} clientId L'ID du client.
 */
function handleClientDisconnect(clientId) {
    const roomId = findRoomIdByClient(clientId);

    if (roomId) {
        const room = gameRooms.get(roomId);
        if (room) {
            const wasHost = room.hostId === clientId;
            
            // Retirer le joueur du salon
            room.players.delete(clientId);
            console.log(`Client ${clientId} retiré du salon ${roomId}. Restant: ${room.players.size}`);

            // Si c'était l'hôte, et qu'il reste des joueurs, attribuer un nouvel hôte
            if (wasHost && room.players.size > 0) {
                const newHostId = room.players.keys().next().value;
                room.hostId = newHostId;
                const newHostState = room.players.get(newHostId);
                newHostState.isHost = true;
                console.log(`Nouvel hôte attribué dans ${roomId}: ${newHostId}`);

                // Si le jeu était en cours, le mettre en mode LOBBY (pour plus de simplicité, on redémarre)
                if (room.state === GAME_STATES.IN_GAME) {
                    room.state = GAME_STATES.LOBBY;
                }
            } else if (room.players.size === 0) {
                // S'il n'y a plus de joueurs, détruire le salon
                gameRooms.delete(roomId);
                console.log(`Salon ${roomId} détruit car vide.`);
                return;
            }

            // Mettre à jour l'état du jeu pour les joueurs restants
            syncRoomState(roomId);
            
            // Informer les joueurs restants de la déconnexion
            broadcastToRoom(roomId, {
                type: 'player_left',
                leftId: clientId
            });
        }
    }
    
    // Finalement, retirer la connexion WS
    connectedClients.delete(clientId);
    console.log(`Client déconnecté et retiré: ${clientId}. Total enregistré: ${connectedClients.size}`);
}

/**
 * Gère le démarrage du jeu par l'hôte.
 * @param {string} roomId 
 */
function handleGameStart(roomId) {
    const room = gameRooms.get(roomId);
    if (!room) return;

    if (room.players.size < MIN_PLAYERS) {
        // Envoie un message d'erreur à l'hôte
        sendToClient(room.hostId, {
            type: 'error',
            message: `Vous devez avoir au moins ${MIN_PLAYERS} joueurs pour commencer.`
        });
        return;
    }

    room.state = GAME_STATES.IN_GAME;
    
    // Réinitialiser les points de travail/burnout
    for (const playerState of room.players.values()) {
        playerState.workPoints = 0;
        playerState.burnout = 0;
    }

    // Informer les clients que le jeu commence
    broadcastToRoom(roomId, {
        type: 'game_start'
    });
    syncRoomState(roomId);
    console.log(`Jeu démarré dans le salon ${roomId}`);
}

/**
 * Gère la mise à jour des points de travail d'un joueur.
 * @param {string} clientId 
 * @param {number} newPoints 
 */
function handleWorkPointUpdate(clientId, newPoints) {
    const roomId = findRoomIdByClient(clientId);
    if (!roomId) return;

    const room = gameRooms.get(roomId);
    const playerState = room.players.get(clientId);

    if (room.state === GAME_STATES.IN_GAME && playerState) {
        playerState.workPoints = newPoints;
        syncRoomState(roomId); // Synchronise l'état pour tous les joueurs
    }
}

/**
 * Gère la mise à jour du niveau de burnout d'un joueur.
 * @param {string} clientId 
 * @param {number} newBurnout 
 */
function handleBurnoutUpdate(clientId, newBurnout) {
    const roomId = findRoomIdByClient(clientId);
    if (!roomId) return;

    const room = gameRooms.get(roomId);
    const playerState = room.players.get(clientId);

    if (room.state === GAME_STATES.IN_GAME && playerState) {
        playerState.burnout = newBurnout;
        
        // Vérification de la condition de fin de jeu
        if (newBurnout >= 100) {
            room.state = GAME_STATES.GAME_OVER;
            broadcastToRoom(roomId, {
                type: 'game_over',
                winnerId: clientId, // Le premier à atteindre 100 est le gagnant de l'épuisement professionnel (pour la blague)
                reason: 'burnout'
            });
        }
        
        syncRoomState(roomId); // Synchronise l'état pour tous les joueurs
    }
}

// --- INITIALISATION DU SERVEUR WEBSOCKET ---

const wss = new WebSocket.Server({ port: PORT });
console.log(`Serveur de jeu centralisé démarré sur le port ${PORT}`);

wss.on('connection', function connection(ws) {
    let clientId = generateId(); // ID unique pour chaque connexion
    connectedClients.set(clientId, ws);

    console.log(`Nouveau client connecté. ID: ${clientId}. Total WS: ${wss.clients.size}`);
    
    // Informer le client de son ID immédiatement
    sendToClient(clientId, {
        type: 'client_id',
        id: clientId
    });

    // Événement lorsqu'un message est reçu d'un client
    ws.on('message', function incoming(message) {
        try {
            const data = JSON.parse(message);
            console.log(`Message reçu de ${clientId}: ${data.type}`);

            // Le client n'a pas encore son nom (étape modale), il ne peut que créer/joindre
            if (data.type === 'create_lobby' && data.playerName) {
                const roomId = generateId();
                
                // Palette de couleurs pour les joueurs (maintenant gérée par le serveur)
                const colors = ['color-A', 'color-B', 'color-C', 'color-D'];
                const playerColor = colors[0];

                const playerState = {
                    id: clientId,
                    name: data.playerName,
                    color: playerColor,
                    workPoints: 0,
                    burnout: 0,
                    isHost: true,
                    ws: ws // Pour un accès rapide si nécessaire
                };

                const room = {
                    roomId: roomId,
                    hostId: clientId,
                    state: GAME_STATES.LOBBY,
                    players: new Map([[clientId, playerState]])
                };

                gameRooms.set(roomId, room);
                console.log(`Salon créé: ${roomId} par ${clientId}`);

                // Informer l'hôte de l'ID du salon et de son propre état
                sendToClient(clientId, {
                    type: 'lobby_created',
                    roomId: roomId
                });
                
                // Synchroniser l'état initial
                syncRoomState(roomId);
            }
            
            else if (data.type === 'join_lobby' && data.roomId && data.playerName) {
                const room = gameRooms.get(data.roomId);

                if (!room || room.state !== GAME_STATES.LOBBY) {
                    sendToClient(clientId, {
                        type: 'error',
                        message: 'Salon introuvable ou déjà en jeu.'
                    });
                    return;
                }
                
                // Trouver une couleur non utilisée
                const existingColors = Array.from(room.players.values()).map(p => p.color);
                const availableColors = ['color-A', 'color-B', 'color-C', 'color-D'].filter(c => !existingColors.includes(c));

                if (availableColors.length === 0) {
                    sendToClient(clientId, {
                        type: 'error',
                        message: 'Le salon est complet (Max 4 joueurs).'
                    });
                    return;
                }

                const playerState = {
                    id: clientId,
                    name: data.playerName,
                    color: availableColors[0],
                    workPoints: 0,
                    burnout: 0,
                    isHost: false,
                    ws: ws
                };

                room.players.set(clientId, playerState);
                console.log(`Client ${clientId} a rejoint le salon ${data.roomId}`);
                
                // Informer le client qu'il a rejoint le salon
                sendToClient(clientId, {
                    type: 'lobby_joined',
                    roomId: data.roomId
                });

                // Synchroniser le nouvel état pour tous les joueurs
                syncRoomState(data.roomId);
            }

            // --- GESTION DES ACTIONS DE JEU ---
            
            else if (data.type === 'game_action') {
                const roomId = findRoomIdByClient(clientId);
                if (!roomId) return;
                
                const room = gameRooms.get(roomId);
                
                switch (data.action) {
                    case 'start_game':
                        if (room.hostId === clientId) {
                            handleGameStart(roomId);
                        }
                        break;
                    case 'update_work_points':
                        handleWorkPointUpdate(clientId, data.value);
                        break;
                    case 'update_burnout':
                        handleBurnoutUpdate(clientId, data.value);
                        break;
                    case 'chat_message':
                        // Diffuser le message de chat à tous les joueurs du salon
                        broadcastToRoom(roomId, {
                            type: 'chat_message',
                            senderId: clientId,
                            name: room.players.get(clientId).name,
                            text: data.text
                        });
                        break;
                    // TODO: Ajouter d'autres actions de jeu ici (cartes, événements, etc.)
                }
            }

        } catch (error) {
            console.error(`Erreur lors du traitement du message de ${clientId}:`, error);
        }
    });

    // Événement lorsqu'un client se déconnecte
    ws.on('close', () => {
        handleClientDisconnect(clientId);
    });

    // Événement d'erreur
    ws.on('error', (err) => {
        console.error(`Erreur WebSocket pour le client ${clientId}:`, err.message);
        ws.close(); // Fermer la connexion en cas d'erreur
    });
});
