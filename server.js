/**
 * Serveur WebSocket pour l'application de chat de groupe.
 *
 * Ce script utilise Node.js et la bibliothèque 'ws' pour gérer :
 * 1. La création et la jonction de salons (lobbies) via un code à 5 chiffres.
 * 2. Le routage des messages en temps réel uniquement aux membres du même salon.
 *
 * Pour exécuter ce fichier, vous devez d'abord installer Node.js et la bibliothèque 'ws' :
 * npm install ws
 * node server.js
 */

const WebSocket = require('ws');

// Définition du port d'écoute. IMPORTANT : Sur Render, cela sera généralement
// défini par la variable d'environnement PORT, mais nous utilisons 8080 comme défaut local.
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// Structure pour gérer les salons et les clients connectés.
// Format: { 'codeA': [client1, client2, ...], 'codeB': [...] }
const activeLobbies = new Map();
// Structure pour s'assurer que les codes de salon sont uniques.
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
            // Optionnel: n'envoie pas à l'expéditeur si spécifié (utile pour les confirmations)
            if (client.readyState === WebSocket.OPEN && client !== senderWs) {
                sendToClient(client, data);
            }
        });
    }
}

// --- Gestion des Connexions ---

wss.on('connection', (ws) => {
    // Attache les métadonnées spécifiques au client (l'ID du client est géré côté client pour l'instant)
    ws.id = require('crypto').randomUUID(); // ID unique pour ce client
    ws.lobbyCode = null;
    ws.nickname = null;

    console.log(`Client ${ws.id} connecté.`);

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

        const { action, code, nickname, content } = parsedMessage;

        // Mise à jour du nickname si non défini ou action de connexion
        if (nickname) {
            ws.nickname = nickname;
        }

        switch (action) {
            case 'CREATE_LOBBY':
                handleCreateLobby(ws, nickname);
                break;

            case 'JOIN_LOBBY':
                handleJoinLobby(ws, code, nickname);
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
            handleLeaveLobby(ws, true); // Le deuxième argument indique qu'il s'agit d'une fermeture brutale
        }
    });

    ws.on('error', (error) => {
        console.error(`Erreur WebSocket pour le client ${ws.id}:`, error.message);
    });
});

// --- Gestionnaires d'Actions ---

/** Gère la création d'un nouveau salon. */
function handleCreateLobby(ws, nickname) {
    if (!nickname) {
        return sendToClient(ws, { action: 'ERROR', message: 'Pseudonyme requis pour créer le salon.' });
    }

    // Si le client est déjà dans un salon, le faire quitter d'abord (prévention)
    if (ws.lobbyCode) {
        handleLeaveLobby(ws);
    }

    const newCode = generateUniqueCode();
    const newLobby = { code: newCode, clients: [ws] };
    codeToLobbyMap.set(newCode, newLobby);

    ws.lobbyCode = newCode;
    ws.nickname = nickname;

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
function handleJoinLobby(ws, code, nickname) {
    if (!nickname || !code || code.length !== 5) {
        return sendToClient(ws, { action: 'ERROR', message: 'Code et pseudonyme valides requis.' });
    }

    // Si le client est déjà dans un salon, le faire quitter d'abord
    if (ws.lobbyCode) {
        handleLeaveLobby(ws);
    }

    const lobby = codeToLobbyMap.get(code);

    if (lobby) {
        // Ajouter le client au salon
        lobby.clients.push(ws);
        ws.lobbyCode = code;
        ws.nickname = nickname;

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
        senderId: ws.id, // Utilisé pour distinguer "Moi" côté client
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

    if (code) {
        const lobby = codeToLobbyMap.get(code);
        if (lobby) {
            // Retirer le client de la liste
            lobby.clients = lobby.clients.filter(client => client !== ws);
            console.log(`Client ${nickname} a quitté le salon ${code}. Clients restants: ${lobby.clients.length}`);

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
