/**
 * Serveur WebSocket pour l'application de jeu de déduction sociale.
 * * Ajout de la gestion de l'hôte, de l'état du jeu et de la synchronisation des données de lobby.
 */

const WebSocket = require('ws');

// Définition du port d'écoute.
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// Constantes de Jeu
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 10;
const GAME_STATUS = {
    WAITING: 'WAITING',
    STARTED: 'STARTED',
    VOTING: 'VOTING',
    ENDED: 'ENDED'
};

// Structure pour gérer les salons et les clients connectés.
// Format: { 'code': { code: '12345', hostId: 'uuid', clients: [ws1, ws2], gameStatus: 'WAITING', players: { 'userId': { nickname: 'name', role: null } } } }
const codeToLobbyMap = new Map();

console.log(`Serveur WebSocket démarré sur le port ${PORT}`);

// --- Fonctions utilitaires ---

/** Génère un code de salon unique à 5 chiffres. */
function generateUniqueCode() {
    let code;
    do {
        // Génère un nombre entre 10000 et 99999
        code = Math.floor(10000 + Math.random() * 90000).toString();
    } while (codeToLobbyMap.has(code));
    return code;
}

/** Envoie un message JSON à un client spécifique. */
function sendToClient(client, data) {
    if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
    }
}

/** Envoie un message JSON à tous les clients d'un salon. */
function broadcastToLobby(code, data, senderWs = null) {
    const lobby = codeToLobbyMap.get(code);
    if (lobby) {
        lobby.clients.forEach(client => {
            // N'envoie pas à l'expéditeur si spécifié
            if (client.readyState === WebSocket.OPEN && client !== senderWs) {
                sendToClient(client, data);
            }
        });
    }
}

/** Envoie l'état actuel du lobby à tous les clients. */
function sendLobbyUpdate(code, senderWs = null) {
    const lobby = codeToLobbyMap.get(code);
    if (!lobby) return;

    // Créer une structure de données simplifiée pour le client
    const lobbyData = {
        code: lobby.code,
        hostId: lobby.hostId,
        playerCount: lobby.clients.length,
        maxPlayers: MAX_PLAYERS,
        gameStatus: lobby.gameStatus,
        // À l'avenir, inclure l'état du jeu ici
    };

    const updatePayload = {
        action: 'LOBBY_UPDATE',
        lobby: lobbyData
    };

    lobby.clients.forEach(client => {
        sendToClient(client, updatePayload);
    });
}


// --- Gestion des Connexions ---

wss.on('connection', (ws) => {
    // Les métadonnées de la connexion WS
    ws.id = null; // ID persistant du client (UUID)
    ws.lobbyCode = null;
    ws.nickname = null;

    console.log(`Nouvelle connexion WebSocket établie.`);

    // --- Gestion des Messages Entrants ---
    ws.on('message', (message) => {
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(message);
        } catch (e) {
            console.error("Message invalide reçu:", message.toString());
            sendToClient(ws, { action: 'ERROR', message: 'Format de message invalide.' });
            return;
        }

        const { action, code, nickname, content, userId } = parsedMessage; 

        // Attribue l'ID et le nickname à la connexion WS.
        if (userId) {
            ws.id = userId;
        }
        if (nickname) {
            ws.nickname = nickname;
        }
        
        // Sécurité: Refuser toute action nécessitant un ID si l'ID est manquant.
        if (!ws.id && action !== 'CREATE_LOBBY' && action !== 'JOIN_LOBBY') {
             return sendToClient(ws, { action: 'ERROR', message: 'Identifiant utilisateur manquant. Veuillez vous reconnecter.' });
        }


        switch (action) {
            case 'CREATE_LOBBY':
                handleCreateLobby(ws, nickname, userId); 
                break;

            case 'JOIN_LOBBY':
                handleJoinLobby(ws, code, nickname, userId); 
                break;
                
            case 'START_GAME':
                handleStartGame(ws);
                break;

            case 'MESSAGE':
                handleChatMessage(ws, content);
                break;

            case 'LEAVE_LOBBY':
                handleLeaveLobby(ws);
                break;

            default:
                sendToClient(ws, { action: 'ERROR', message: 'Action non reconnue.' });
                break;
        }
    });

    // --- Gestion de la Déconnexion ---
    ws.on('close', () => {
        console.log(`Client ${ws.id} déconnecté.`);
        if (ws.lobbyCode) {
            handleLeaveLobby(ws, true); 
        }
    });

    ws.on('error', (error) => {
        console.error(`Erreur WebSocket pour le client ${ws.id}:`, error.message);
    });
});

// --- Gestionnaires d'Actions ---

/** Gère la création d'un nouveau salon. */
function handleCreateLobby(ws, nickname, userId) {
    if (!nickname || !userId) {
        return sendToClient(ws, { action: 'ERROR', message: 'Pseudonyme et ID utilisateur requis.' });
    }

    if (ws.lobbyCode) {
        handleLeaveLobby(ws);
    }

    const newCode = generateUniqueCode();
    // NOUVEAU: Ajout de hostId et gameStatus
    const newLobby = { 
        code: newCode, 
        hostId: userId, // L'hôte est le créateur
        clients: [ws],
        gameStatus: GAME_STATUS.WAITING,
    };
    codeToLobbyMap.set(newCode, newLobby);

    ws.lobbyCode = newCode;

    // Réponse au client
    sendToClient(ws, { 
        action: 'LOBBY_CREATED', 
        code: newCode, 
        message: `Salon créé avec le code ${newCode}. Vous êtes l'hôte.`,
        lobby: { // Envoie l'état initial du lobby
            code: newCode,
            hostId: userId,
            playerCount: 1,
            maxPlayers: MAX_PLAYERS,
            gameStatus: newLobby.gameStatus,
        }
    });
    console.log(`Salon ${newCode} créé par ${nickname} (${ws.id}).`);
}

/** Gère la jonction à un salon existant. */
function handleJoinLobby(ws, code, nickname, userId) {
    if (!nickname || !code || code.length !== 5 || !userId) {
        return sendToClient(ws, { action: 'ERROR', message: 'Code, ID et pseudonyme valides requis.' });
    }

    if (ws.lobbyCode) {
        handleLeaveLobby(ws);
    }

    const lobby = codeToLobbyMap.get(code);

    if (lobby) {
        if (lobby.clients.length >= MAX_PLAYERS) {
            return sendToClient(ws, { action: 'ERROR', message: 'Le salon est complet.' });
        }
        if (lobby.gameStatus !== GAME_STATUS.WAITING) {
            return sendToClient(ws, { action: 'ERROR', message: `Le jeu est déjà en cours dans le salon ${code}.` });
        }

        // Retrait de la connexion précédente du même ID si elle existe (pour gérer la reconnexion)
        lobby.clients = lobby.clients.filter(client => client.id !== userId);

        // Ajouter la nouvelle connexion au salon
        lobby.clients.push(ws);
        ws.lobbyCode = code;

        // Réponse au client
        sendToClient(ws, { 
            action: 'LOBBY_JOINED', 
            code: code, 
            message: `Vous avez rejoint le salon ${code}.`,
            lobby: { // Envoie l'état initial du lobby
                code: lobby.code,
                hostId: lobby.hostId,
                playerCount: lobby.clients.length,
                maxPlayers: MAX_PLAYERS,
                gameStatus: lobby.gameStatus,
            }
        });
        
        console.log(`${nickname} (${ws.id}) a rejoint le salon ${code}.`);

        // Notifier les autres clients
        broadcastToLobby(code, {
            action: 'SYSTEM_MESSAGE',
            content: `${nickname} a rejoint le salon.`,
            timestamp: Date.now()
        }, ws);

        // Mettre à jour l'UI de tous les clients du lobby (nouveau nombre de joueurs)
        sendLobbyUpdate(code);

    } else {
        sendToClient(ws, { action: 'ERROR', message: `Le salon avec le code ${code} n'existe pas.` });
    }
}

/** Gère l'envoi d'un message dans le salon. */
function handleChatMessage(ws, content) {
    const lobby = codeToLobbyMap.get(ws.lobbyCode);
    if (!lobby) {
        return sendToClient(ws, { action: 'ERROR', message: 'Vous devez être dans un salon pour envoyer des messages.' });
    }
    // Vérification de l'état du jeu pour le chat (le client vérifie aussi, mais le serveur est le maître)
    if (lobby.gameStatus !== GAME_STATUS.STARTED) {
        return sendToClient(ws, { action: 'ERROR', message: 'Le chat n\'est actif que lorsque le jeu est DÉMARRÉ.' });
    }
    if (!content || content.trim() === '') {
        return; 
    }

    const messagePayload = {
        action: 'MESSAGE_RECEIVED',
        senderId: ws.id,
        senderNickname: ws.nickname,
        content: content,
        timestamp: Date.now()
    };

    // Envoyer le message à tous les membres du salon, y compris l'expéditeur
    if (lobby) {
        lobby.clients.forEach(client => {
            sendToClient(client, messagePayload);
        });
    }

    console.log(`[Salon ${ws.lobbyCode}] ${ws.nickname}: ${content}`);
}

/** Gère la demande de démarrage du jeu par l'hôte. */
function handleStartGame(ws) {
    const lobby = codeToLobbyMap.get(ws.lobbyCode);

    if (!lobby) {
        return sendToClient(ws, { action: 'ERROR', message: 'Vous n\'êtes dans aucun salon.' });
    }
    // 1. Vérification de l'hôte
    if (ws.id !== lobby.hostId) {
        return sendToClient(ws, { action: 'ERROR', message: 'Seul l\'hôte peut démarrer le jeu.' });
    }
    // 2. Vérification du nombre de joueurs
    if (lobby.clients.length < MIN_PLAYERS) {
        return sendToClient(ws, { action: 'ERROR', message: `Le jeu nécessite au moins ${MIN_PLAYERS} joueurs.` });
    }
    // 3. Vérification du statut
    if (lobby.gameStatus !== GAME_STATUS.WAITING) {
        return sendToClient(ws, { action: 'ERROR', message: 'Le jeu est déjà en cours ou a un statut invalide.' });
    }

    // --- Logique de Démarrage ---
    lobby.gameStatus = GAME_STATUS.STARTED;
    
    // TODO: Dans le futur, ajouter ici la logique d'attribution des rôles.

    // Notifier le succès à tous les clients
    const startPayload = { action: 'GAME_STARTED' };
    lobby.clients.forEach(client => {
        sendToClient(client, startPayload);
    });
    
    // Mettre à jour l'UI de tous les clients
    sendLobbyUpdate(ws.lobbyCode);

    console.log(`Jeu démarré dans le salon ${ws.lobbyCode} par l'hôte ${ws.nickname}.`);
}


/** Gère le départ d'un client d'un salon. */
function handleLeaveLobby(ws, isDisconnect = false) {
    const code = ws.lobbyCode;
    const nickname = ws.nickname || 'Un utilisateur inconnu';
    const userId = ws.id || 'ID inconnu';

    if (code) {
        const lobby = codeToLobbyMap.get(code);
        if (lobby) {
            // Retirer le client de la liste
            lobby.clients = lobby.clients.filter(client => client.id !== userId);
            
            console.log(`Client ${nickname} (${userId}) a quitté le salon ${code}. Clients restants: ${lobby.clients.length}`);

            let newHostId = null;
            // Gérer le changement d'hôte si l'hôte actuel quitte
            if (userId === lobby.hostId && lobby.clients.length > 0) {
                // Le nouvel hôte est le premier client restant
                newHostId = lobby.clients[0].id;
                lobby.hostId = newHostId;
                console.log(`L'hôte a quitté. Nouvel hôte dans le salon ${code}: ${newHostId}`);

                // Informer le nouvel hôte
                 sendToClient(lobby.clients[0], {
                    action: 'SYSTEM_MESSAGE',
                    content: `Vous êtes le nouvel hôte du salon !`,
                    timestamp: Date.now()
                });
            } else if (lobby.clients.length === 0) {
                // Si le salon est vide, le supprimer
                codeToLobbyMap.delete(code);
                console.log(`Salon ${code} supprimé car il est vide.`);
            }

            // Si le salon existe encore, notifier les autres clients
            if (codeToLobbyMap.has(code)) {
                // Envoyer un message système aux membres restants
                broadcastToLobby(code, {
                    action: 'SYSTEM_MESSAGE',
                    content: `${nickname} a quitté le salon.`,
                    timestamp: Date.now()
                });

                // Mettre à jour l'UI de tous les clients restants (compte de joueurs, nouvel hôte)
                sendLobbyUpdate(code);
            }

            // Informer le client qu'il a quitté (seulement s'il ne se déconnecte pas)
            if (!isDisconnect) {
                sendToClient(ws, { action: 'LOBBY_LEFT' });
            }
        }
        ws.lobbyCode = null;
        ws.nickname = null;
    }
}
