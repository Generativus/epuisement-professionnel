/**
 * Serveur WebSocket pour l'application de jeu de déduction sociale.
 * * Ajout de la gestion de l'hôte, de l'état du jeu et de la synchronisation des données de lobby.
 * * Ajout de la gestion du démarrage de la partie (START_GAME).
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

/** Envoie un message à un client spécifique. */
function sendToClient(client, message) {
    if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
    }
}

/** Diffuse un message à tous les clients d'un salon. */
function broadcastToLobby(code, message) {
    const lobby = codeToLobbyMap.get(code);
    if (lobby) {
        lobby.clients.forEach(client => {
            sendToClient(client, message);
        });
    }
}

/** Envoie une mise à jour complète du lobby à tous les clients. */
function sendLobbyUpdate(code) {
    const lobby = codeToLobbyMap.get(code);
    if (!lobby) return;

    // Créer une version sérialisable du lobby sans les objets ws
    const serializableLobby = {
        code: lobby.code,
        hostId: lobby.hostId,
        gameStatus: lobby.gameStatus,
        players: lobby.players,
        // Inclure uniquement les IDs et les codes de clients pour le client
        clients: lobby.clients.map(c => ({ id: c.userId, code: c.lobbyCode }))
    };

    broadcastToLobby(code, {
        action: 'LOBBY_UPDATE',
        lobby: serializableLobby
    });
}

// --- Gestionnaires d'actions du client ---

/** Gère la création d'un nouveau salon. */
function handleCreateLobby(ws, data) {
    if (ws.lobbyCode) {
        return sendToClient(ws, { action: 'ERROR', content: 'Vous êtes déjà dans le salon ' + ws.lobbyCode });
    }

    const code = generateUniqueCode();
    const nickname = data.nickname || 'Anonyme';
    const userId = data.userId;

    const lobby = {
        code: code,
        hostId: userId,
        clients: [ws],
        gameStatus: GAME_STATUS.WAITING,
        players: {
            [userId]: { nickname: nickname, role: null }
        }
    };
    codeToLobbyMap.set(code, lobby);

    ws.lobbyCode = code;
    ws.userId = userId;
    ws.nickname = nickname;

    console.log(`Salon créé: ${code} par ${nickname} (${userId})`);

    // Notifier le client qu'il a créé le salon
    sendToClient(ws, { action: 'LOBBY_CREATED', code: code, userId: userId });

    // Mettre à jour les autres clients (aucun pour l'instant)
    sendLobbyUpdate(code);
}

/** Gère la tentative de rejoindre un salon existant. */
function handleJoinLobby(ws, data) {
    if (ws.lobbyCode) {
        return sendToClient(ws, { action: 'ERROR', content: 'Vous êtes déjà dans le salon ' + ws.lobbyCode });
    }

    const code = data.code;
    const nickname = data.nickname || 'Anonyme';
    const userId = data.userId;
    const lobby = codeToLobbyMap.get(code);

    if (!lobby) {
        return sendToClient(ws, { action: 'ERROR', content: `Salon ${code} introuvable.` });
    }

    if (lobby.clients.length >= MAX_PLAYERS) {
        return sendToClient(ws, { action: 'ERROR', content: `Salon ${code} est plein.` });
    }
    
    // Vérification: l'utilisateur est-il déjà présent dans ce salon?
    if (lobby.clients.some(client => client.userId === userId)) {
        // Optionnel: Gérer la reconnexion. Ici, on va simplement rejeter l'accès.
        return sendToClient(ws, { action: 'ERROR', content: `Un utilisateur avec cet ID est déjà connecté au salon ${code}.` });
    }

    // Ajouter le client au salon
    lobby.clients.push(ws);
    lobby.players[userId] = { nickname: nickname, role: null };

    ws.lobbyCode = code;
    ws.userId = userId;
    ws.nickname = nickname;

    console.log(`${nickname} (${userId}) a rejoint le salon ${code}.`);

    // Notifier le nouveau client
    sendToClient(ws, { action: 'LOBBY_JOINED', code: code, userId: userId });

    // Diffuser le message système et la mise à jour aux autres
    broadcastToLobby(code, {
        action: 'SYSTEM_MESSAGE',
        content: `${nickname} a rejoint le salon.`,
        timestamp: Date.now()
    });

    sendLobbyUpdate(code);
}

/** Gère l'envoi d'un message de chat. */
function handleMessage(ws, data) {
    const code = ws.lobbyCode;
    if (!code) return; // Ignorer si non dans un lobby

    // Diffuser le message à tout le salon, y compris l'expéditeur
    broadcastToLobby(code, {
        action: 'MESSAGE',
        userId: ws.userId,
        nickname: ws.nickname,
        content: data.content,
        timestamp: Date.now()
    });
}

/** Gère le lancement de la partie (NOUVEAU). */
function handleStartGame(ws) {
    const code = ws.lobbyCode;
    const lobby = codeToLobbyMap.get(code);

    if (!lobby) {
        return sendToClient(ws, { action: 'ERROR', content: 'Salon introuvable.' });
    }

    if (lobby.hostId !== ws.userId) {
        return sendToClient(ws, { action: 'ERROR', content: 'Seul l\'hôte peut démarrer la partie.' });
    }

    if (lobby.clients.length < MIN_PLAYERS) {
        return sendToClient(ws, { action: 'ERROR', content: `Il faut au moins ${MIN_PLAYERS} joueurs pour démarrer la partie.` });
    }

    if (lobby.gameStatus !== GAME_STATUS.WAITING) {
        return sendToClient(ws, { action: 'ERROR', content: 'La partie est déjà en cours ou terminée.' });
    }

    // --- Logique de Démarrage de la Partie ---
    lobby.gameStatus = GAME_STATUS.STARTED;
    console.log(`Partie démarrée dans le salon ${code} par l'hôte ${ws.nickname}`);

    // TODO: Implémenter la logique d'assignation des rôles/mots ici (étape suivante)

    // Notifier tous les clients du changement de statut
    broadcastToLobby(code, {
        action: 'SYSTEM_MESSAGE',
        content: `L'hôte a démarré la partie ! C'est parti !`,
        timestamp: Date.now()
    });

    sendLobbyUpdate(code); // Met à jour l'UI pour masquer le bouton START
    
    // Envoyer le premier statut de jeu (temps, rôle, etc.)
    // On utilise 300 secondes (5 minutes) comme exemple de durée de jeu.
    broadcastToLobby(code, {
        action: 'GAME_STATUS_UPDATE',
        status: lobby.gameStatus,
        players: lobby.players,
        timer: 300 // 5 minutes
        // role: ... (sera envoyé individuellement à chaque client avec la logique des rôles)
    });
}


// --- Événements WebSocket ---

wss.on('connection', function connection(ws, req) {
    console.log('Nouveau client connecté.');

    ws.on('message', function incoming(message) {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error('Erreur de parsing du message:', message);
            return;
        }

        // console.log(`Action reçue (${data.action}) de ${ws.userId || 'nouvel utilisateur'}:`, data);

        switch (data.action) {
            case 'CREATE_LOBBY':
                handleCreateLobby(ws, data);
                break;
            case 'JOIN_LOBBY':
                handleJoinLobby(ws, data);
                break;
            case 'MESSAGE':
                handleMessage(ws, data);
                break;
            case 'START_GAME': // NOUVEAU GESTIONNAIRE
                handleStartGame(ws);
                break;
            case 'LEAVE_LOBBY':
                handleLeaveLobby(ws, false); // false = ce n'est pas une déconnexion
                break;
            default:
                sendToClient(ws, { action: 'ERROR', content: 'Action inconnue.' });
                break;
        }
    });

    ws.on('close', () => {
        console.log(`Client déconnecté: ${ws.nickname} (${ws.userId})`);
        handleLeaveLobby(ws, true); // true = c'est une déconnexion
    });

    ws.on('error', (err) => {
        console.error('Erreur WebSocket:', err);
    });
});

/** Gère le départ d'un client (volontaire ou déconnexion). */
function handleLeaveLobby(ws, isDisconnect) {
    const code = ws.lobbyCode;
    const nickname = ws.nickname || 'Un joueur';

    if (code && codeToLobbyMap.has(code)) {
        const lobby = codeToLobbyMap.get(code);

        // Retirer le client du tableau clients
        const clientIndex = lobby.clients.findIndex(client => client.userId === ws.userId);
        if (clientIndex !== -1) {
            lobby.clients.splice(clientIndex, 1);
            delete lobby.players[ws.userId]; // Supprimer de la liste des joueurs
            console.log(`${nickname} a quitté/déconnecté du salon ${code}.`);
        }

        // Si c'était l'hôte, transférer les droits
        if (lobby.hostId === ws.userId) {
            if (lobby.clients.length > 0) {
                const newHostId = lobby.clients[0].userId; // Utiliser userId
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
        } else if (lobby.clients.length === 0) {
             // Si le salon est vide et l'hôte a déjà quitté (ou n'était pas l'hôte), le supprimer
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

        ws.lobbyCode = null;
        ws.userId = null;
        ws.nickname = null;
    }
}
