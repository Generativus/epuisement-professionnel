/**
 * Serveur WebSocket pour l'application de chat de groupe.
 * * Mise à jour pour gérer un userId persistant envoyé par le client,
 * essentiel pour un jeu de déduction sociale où l'identité doit survivre aux reconnexions.
 */

const WebSocket = require('ws');

// Définition du port d'écoute.
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// Structure pour gérer les salons et les clients connectés.
// Format: { 'code': { code: '12345', clients: [ws1, ws2] } }
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

// --- Gestion des Connexions ---

wss.on('connection', (ws) => {
    // Initialise les métadonnées. L'ID sera attribué lors de CREATE/JOIN.
    // L'ID du client vient maintenant du localStorage côté client.
    ws.id = null; 
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

        // Récupère userId envoyé par le client
        const { action, code, nickname, content, userId } = parsedMessage; 

        // Attribue l'ID et le nickname si fournis lors de la création/jonction
        if (userId) {
            ws.id = userId;
        }
        if (nickname) {
            ws.nickname = nickname;
        }
        
        // Sécurité de base: Si le client tente d'agir sans ID après la connexion, refuser.
        if (action !== 'CREATE_LOBBY' && action !== 'JOIN_LOBBY' && !ws.id) {
             return sendToClient(ws, { action: 'ERROR', message: 'Identifiant utilisateur manquant. Veuillez vous reconnecter.' });
        }


        switch (action) {
            case 'CREATE_LOBBY':
                // On passe les données pour validation et traitement
                handleCreateLobby(ws, nickname, userId); 
                break;

            case 'JOIN_LOBBY':
                // On passe les données pour validation et traitement
                handleJoinLobby(ws, code, nickname, userId); 
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
        // Assurez-vous que le client quitte son salon lors de la déconnexion
        if (ws.lobbyCode) {
            // isDisconnect = true pour éviter d'envoyer LOBBY_LEFT au client qui se ferme
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

    // Si le client est déjà dans un salon, le faire quitter d'abord (prévention)
    if (ws.lobbyCode) {
        handleLeaveLobby(ws);
    }

    const newCode = generateUniqueCode();
    // Stocker le client dans le salon
    const newLobby = { code: newCode, clients: [ws] };
    codeToLobbyMap.set(newCode, newLobby);

    ws.lobbyCode = newCode;

    sendToClient(ws, { action: 'LOBBY_CREATED', code: newCode, message: `Salon créé avec le code ${newCode}.` });
    console.log(`Salon ${newCode} créé par ${nickname} (${ws.id}).`);

    // Envoyer un message système aux membres du salon
    broadcastToLobby(newCode, {
        action: 'SYSTEM_MESSAGE',
        content: `${nickname} a créé et rejoint le salon.`,
        timestamp: Date.now()
    }, ws); // N'envoie pas à l'expéditeur lui-même
}

/** Gère la jonction à un salon existant. */
function handleJoinLobby(ws, code, nickname, userId) {
    if (!nickname || !code || code.length !== 5 || !userId) {
        return sendToClient(ws, { action: 'ERROR', message: 'Code, ID et pseudonyme valides requis.' });
    }

    // Si le client est déjà dans un salon, le faire quitter d'abord
    if (ws.lobbyCode) {
        handleLeaveLobby(ws);
    }

    const lobby = codeToLobbyMap.get(code);

    if (lobby) {
        // Retrait de la connexion précédente du même ID si elle existe (ex: reconnexion rapide)
        // Cela garantit qu'il n'y a qu'une seule connexion active par ID par salon.
        lobby.clients = lobby.clients.filter(client => client.id !== userId);

        // Ajouter la nouvelle connexion au salon
        lobby.clients.push(ws);
        ws.lobbyCode = code;

        sendToClient(ws, { action: 'LOBBY_JOINED', code: code, message: `Vous avez rejoint le salon ${code}.` });
        console.log(`${nickname} (${ws.id}) a rejoint le salon ${code}.`);

        // Envoyer un message système aux autres membres du salon
        broadcastToLobby(code, {
            action: 'SYSTEM_MESSAGE',
            content: `${nickname} a rejoint le salon.`,
            timestamp: Date.now()
        }, ws);
    } else {
        sendToClient(ws, { action: 'ERROR', message: `Le salon avec le code ${code} n'existe pas.` });
    }
}

/** Gère l'envoi d'un message dans le salon. */
function handleChatMessage(ws, content) {
    if (!ws.lobbyCode) {
        return sendToClient(ws, { action: 'ERROR', message: 'Vous devez être dans un salon pour envoyer des messages.' });
    }
    if (!content || content.trim() === '') {
        return; // Ignorer les messages vides
    }

    const messagePayload = {
        action: 'MESSAGE_RECEIVED',
        senderId: ws.id, // ID persistant
        senderNickname: ws.nickname,
        content: content,
        timestamp: Date.now()
    };

    // Envoyer le message à tous les membres du salon, y compris l'expéditeur pour confirmation
    const lobby = codeToLobbyMap.get(ws.lobbyCode);
    if (lobby) {
        lobby.clients.forEach(client => {
            sendToClient(client, messagePayload);
        });
    }

    console.log(`[Salon ${ws.lobbyCode}] ${ws.nickname}: ${content}`);
}

/** Gère le départ d'un client d'un salon. */
function handleLeaveLobby(ws, isDisconnect = false) {
    const code = ws.lobbyCode;
    const nickname = ws.nickname || 'Un utilisateur inconnu';
    const userId = ws.id || 'ID inconnu';

    if (code) {
        const lobby = codeToLobbyMap.get(code);
        if (lobby) {
            // Retirer le client de la liste en utilisant son ID persistant
            lobby.clients = lobby.clients.filter(client => client.id !== userId);
            
            console.log(`Client ${nickname} (${userId}) a quitté le salon ${code}. Clients restants: ${lobby.clients.length}`);

            // Envoyer un message système aux membres restants
            broadcastToLobby(code, {
                action: 'SYSTEM_MESSAGE',
                content: `${nickname} a quitté le salon.`,
                timestamp: Date.now()
            });

            // Si le salon est vide, le supprimer
            if (lobby.clients.length === 0) {
                codeToLobbyMap.delete(code);
                console.log(`Salon ${code} supprimé car il est vide.`);
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
