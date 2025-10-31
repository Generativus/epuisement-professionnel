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
const ENERGY_COST_MESSAGE = 1; // Coût en énergie pour envoyer un message
const ENERGY_GAIN_PER_SECOND = 0.5; // Gain d'énergie par seconde
// Pas de MAX_ENERGY, l'énergie peut s'accumuler indéfiniment.

const GAME_STATUS = {
    WAITING: 'WAITING',
    STARTED: 'STARTED',
    VOTING: 'VOTING',
    ENDED: 'ENDED',
    ROUND_END: 'ROUND_END' // Nouvel état pour gérer la fin de manche et la conservation de l'énergie
};

// Structure pour gérer les salons et les clients connectés.
// Format: { 'code': { code: '12345', hostId: 'uuid', clients: [ws1, ws2], gameStatus: 'WAITING', players: { 'userId': { nickname: 'name', role: null, energy: 0, score: 0 } }, gameData: { currentRound: 0, roundTimer: null, patronneMessageInterval: null, previousPlayersData: {} } } }
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
function sendToClient(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

/** Envoie un message à tous les clients d'un salon. */
function broadcastToLobby(code, data) {
    const lobby = codeToLobbyMap.get(code);
    if (lobby) {
        lobby.clients.forEach(client => {
            sendToClient(client, data);
        });
    }
}

/** Met à jour et envoie les données de lobby à tous les clients. */
function sendLobbyUpdate(code) {
    const lobby = codeToLobbyMap.get(code);
    if (lobby) {
        const payload = {
            action: 'LOBBY_UPDATE',
            lobbyData: {
                code: lobby.code,
                hostId: lobby.hostId,
                gameStatus: lobby.gameStatus,
                players: Object.values(lobby.players).map(player => ({
                    id: player.id,
                    nickname: player.nickname,
                    isHost: player.id === lobby.hostId,
                    energy: player.energy, // Inclure l'énergie dans l'update
                    score: player.score,
                    role: lobby.gameStatus === GAME_STATUS.STARTED ? player.role : null // Masquer les rôles
                }))
            }
        };
        broadcastToLobby(code, payload);
    }
}

/** Génère un message de la Patronne (maintenant un message normal). */
function sendPatronneMessage(code, content) {
    const lobby = codeToLobbyMap.get(code);
    if (lobby) {
        // POINT 3: Envoi du message de la Patronne comme un message de chat normal.
        broadcastToLobby(code, {
            action: 'MESSAGE',
            sender: 'La Patronne', // Le nom de l'expéditeur
            content: content,
            timestamp: Date.now(),
            isPatronne: true // Flag pour l'affichage (optionnel, mais bon pour la clarté)
        });
    }
}

/** Gère le gain d'énergie pour tous les joueurs. */
function startEnergyGain(code) {
    const lobby = codeToLobbyMap.get(code);
    if (lobby && !lobby.gameData.energyInterval) {
        lobby.gameData.energyInterval = setInterval(() => {
            if (lobby.gameStatus === GAME_STATUS.STARTED) {
                Object.keys(lobby.players).forEach(userId => {
                    const player = lobby.players[userId];
                    // POINT 1: Pas de MAX_ENERGY, l'énergie augmente simplement
                    player.energy = (player.energy || 0) + ENERGY_GAIN_PER_SECOND;
                });
                sendLobbyUpdate(code);
            }
        }, 1000); // Mise à jour chaque seconde
        console.log(`Gain d'énergie démarré pour le salon ${code}.`);
    }
}

/** Arrête le gain d'énergie. */
function stopEnergyGain(code) {
    const lobby = codeToLobbyMap.get(code);
    if (lobby && lobby.gameData.energyInterval) {
        clearInterval(lobby.gameData.energyInterval);
        lobby.gameData.energyInterval = null;
        console.log(`Gain d'énergie arrêté pour le salon ${code}.`);
    }
}

/** Démarre le jeu. */
function startGame(code) {
    const lobby = codeToLobbyMap.get(code);
    if (!lobby || lobby.gameStatus !== GAME_STATUS.WAITING || lobby.clients.length < MIN_PLAYERS) {
        console.log(`Impossible de démarrer le jeu dans le salon ${code}. (Statut: ${lobby.gameStatus}, Joueurs: ${lobby.clients.length})`);
        return;
    }

    // POINT 2: Conservation de l'énergie de la manche précédente
    const previousPlayersData = lobby.gameData.previousPlayersData || {};

    // Initialisation des rôles, de l'énergie et du score pour la nouvelle manche
    const roles = ['Patronne', 'Employée']; // Exemple de rôles
    const rolesToAssign = [];
    rolesToAssign.push('Patronne'); // 1 Patronne
    for (let i = 0; i < lobby.clients.length - 1; i++) {
        rolesToAssign.push('Employée'); // Reste des Employées
    }
    
    // Mélange des rôles
    rolesToAssign.sort(() => Math.random() - 0.5);

    let roleIndex = 0;
    Object.keys(lobby.players).forEach(userId => {
        const player = lobby.players[userId];
        player.role = rolesToAssign[roleIndex++];
        player.score = player.score || 0; // Conserve le score total
        
        // Initialiser l'énergie: utiliser l'énergie conservée, sinon 5 par défaut
        const conservedEnergy = previousPlayersData[userId] ? previousPlayersData[userId].energy : 5;
        player.energy = conservedEnergy;
    });

    lobby.gameStatus = GAME_STATUS.STARTED;
    lobby.gameData.currentRound++;
    lobby.gameData.previousPlayersData = {}; // Réinitialiser pour la prochaine conservation

    broadcastToLobby(code, {
        action: 'SYSTEM_MESSAGE',
        content: `Le jeu commence ! Manche n°${lobby.gameData.currentRound}. Bonne chance.`
    });

    startEnergyGain(code); // Commence le gain d'énergie
    // TODO: Démarrer le timer de la manche et les événements de la Patronne
    
    sendLobbyUpdate(code); // Envoie l'update avec les rôles (visibles par le joueur lui-même)
}

/** Démarre la manche suivante. */
function startNextRound(code) {
    const lobby = codeToLobbyMap.get(code);
    if (!lobby || lobby.gameStatus !== GAME_STATUS.ROUND_END) return;

    // POINT 2: Conserver l'énergie avant de démarrer la prochaine manche
    Object.keys(lobby.players).forEach(userId => {
        const player = lobby.players[userId];
        lobby.gameData.previousPlayersData[userId] = {
            energy: player.energy // Conserve la valeur actuelle d'énergie
        };
    });

    broadcastToLobby(code, {
        action: 'SYSTEM_MESSAGE',
        content: `Préparation de la manche suivante...`
    });

    // Remettre le statut à WAITING (ou STARTED directement si on veut enchainer)
    // Ici, on remet à WAITING pour que l'hôte puisse cliquer à nouveau sur Démarrer
    lobby.gameStatus = GAME_STATUS.WAITING; 
    
    // Si on veut enchainer directement:
    // startGame(code);

    sendLobbyUpdate(code);
}


// --- Gestionnaire d'événements WebSocket ---

wss.on('connection', (ws, req) => {
    // Assigner un identifiant unique (UUID ou similaire) à la connexion
    ws.id = require('crypto').randomUUID(); 
    ws.lobbyCode = null;
    ws.nickname = null;

    console.log(`Nouveau client connecté: ${ws.id}`);

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleClientAction(ws, data);
        } catch (e) {
            console.error(`Erreur de parsing JSON: ${e.message}`, message);
            sendToClient(ws, { action: 'ERROR', content: 'Format de message invalide.' });
        }
    });

    ws.on('close', () => {
        console.log(`Client déconnecté: ${ws.id}`);
        handleLeaveLobby(ws, true); // true = isDisconnect
    });

    ws.on('error', (error) => {
        console.error(`Erreur WebSocket pour ${ws.id}:`, error.message);
    });
});

/** Traite les actions envoyées par les clients. */
function handleClientAction(ws, data) {
    const lobby = codeToLobbyMap.get(ws.lobbyCode);
    
    switch (data.action) {
        case 'CREATE_LOBBY':
            handleCreateLobby(ws, data.nickname);
            break;

        case 'JOIN_LOBBY':
            handleJoinLobby(ws, data.code, data.nickname);
            break;

        case 'LEAVE_LOBBY':
            handleLeaveLobby(ws, false);
            break;

        case 'START_GAME':
            if (lobby && ws.id === lobby.hostId && lobby.gameStatus === GAME_STATUS.WAITING) {
                startGame(ws.lobbyCode);
            } else {
                sendToClient(ws, { action: 'ERROR', content: "Seul l'hôte peut démarrer le jeu en attente." });
            }
            break;
            
        case 'START_NEXT_ROUND':
             if (lobby && ws.id === lobby.hostId && lobby.gameStatus === GAME_STATUS.ROUND_END) {
                startNextRound(ws.lobbyCode);
            } else {
                sendToClient(ws, { action: 'ERROR', content: "Seul l'hôte peut démarrer la prochaine manche." });
            }
            break;

        case 'MESSAGE':
            if (lobby && lobby.gameStatus === GAME_STATUS.STARTED && ws.lobbyCode) {
                const player = lobby.players[ws.id];
                const content = data.content.trim();

                if (content && player) {
                    // Vérification de l'énergie
                    if (player.energy >= ENERGY_COST_MESSAGE) {
                        player.energy -= ENERGY_COST_MESSAGE;
                        
                        // Envoi du message à tous les clients
                        broadcastToLobby(ws.lobbyCode, {
                            action: 'MESSAGE',
                            sender: player.nickname,
                            content: content,
                            timestamp: Date.now()
                        });
                        
                        // Mettre à jour l'énergie de tous les joueurs (pour l'affichage)
                        sendLobbyUpdate(ws.lobbyCode);

                    } else {
                        sendToClient(ws, { action: 'ERROR', content: "Énergie insuffisante pour envoyer un message." });
                    }
                }
            }
            break;
            
        case 'REQUEST_TEAMWORK':
            if (lobby && lobby.gameStatus === GAME_STATUS.STARTED && ws.lobbyCode) {
                const requestingPlayer = lobby.players[ws.id];
                const targetPlayerId = data.targetId;
                const targetPlayer = lobby.players[targetPlayerId];

                // POINT 4: Empêcher le joueur de s'inclure lui-même dans les travaux
                if (ws.id === targetPlayerId) {
                    sendToClient(ws, { 
                        action: 'ERROR', 
                        content: `Vous ne pouvez pas demander de travailler en équipe avec vous-même.` 
                    });
                    return;
                }

                if (requestingPlayer && targetPlayer) {
                    // Logic for teamwork request (e.g., spending energy, sending request to target)
                    // Pour l'instant, on envoie juste un message de chat pour simuler
                    const content = `${requestingPlayer.nickname} demande à travailler en équipe avec ${targetPlayer.nickname} !`;

                    // Envoi d'un message système dans le chat pour annoncer la demande
                    broadcastToLobby(ws.lobbyCode, {
                        action: 'SYSTEM_MESSAGE',
                        content: content,
                        timestamp: Date.now()
                    });
                    
                    // TODO: Envoyer l'action spécifique au joueur cible pour qu'il puisse accepter/refuser
                    sendToClient(targetPlayer, {
                        action: 'TEAMWORK_REQUEST_RECEIVED',
                        from: requestingPlayer.nickname,
                        fromId: ws.id
                    });
                    
                } else {
                    sendToClient(ws, { action: 'ERROR', content: "Joueur cible introuvable." });
                }
            }
            break;

        default:
            console.warn(`Action inconnue reçue de ${ws.id}: ${data.action}`);
            break;
    }
}

/** Crée un nouveau salon. */
function handleCreateLobby(ws, nickname) {
    if (ws.lobbyCode) {
        sendToClient(ws, { action: 'ERROR', content: `Vous êtes déjà dans le salon ${ws.lobbyCode}.` });
        return;
    }

    const code = generateUniqueCode();
    ws.lobbyCode = code;
    ws.nickname = nickname.substring(0, 15).trim() || `Joueur${code}`; // 15 caractères max

    const newLobby = {
        code: code,
        hostId: ws.id,
        clients: [ws],
        gameStatus: GAME_STATUS.WAITING,
        players: {
            [ws.id]: {
                id: ws.id,
                nickname: ws.nickname,
                role: null,
                energy: 5, // Initial energy
                score: 0
            }
        },
        gameData: {
            currentRound: 0,
            energyInterval: null,
            // roundTimer: null,
            // patronneMessageInterval: null,
            previousPlayersData: {} // Stocke l'énergie des joueurs de la manche précédente
        }
    };
    codeToLobbyMap.set(code, newLobby);

    console.log(`Salon créé par ${ws.id} (${ws.nickname}) avec le code ${code}.`);

    sendToClient(ws, { 
        action: 'LOBBY_CREATED', 
        code: code 
    });
    
    sendLobbyUpdate(code);
}

/** Rejoindre un salon existant. */
function handleJoinLobby(ws, code, nickname) {
    if (ws.lobbyCode) {
        sendToClient(ws, { action: 'ERROR', content: `Vous êtes déjà dans le salon ${ws.lobbyCode}.` });
        return;
    }

    const lobby = codeToLobbyMap.get(code);

    if (!lobby) {
        sendToClient(ws, { action: 'ERROR', content: `Salon ${code} introuvable.` });
        return;
    }

    if (lobby.gameStatus !== GAME_STATUS.WAITING) {
        sendToClient(ws, { action: 'ERROR', content: `Le jeu a déjà commencé dans le salon ${code}.` });
        return;
    }

    if (lobby.clients.length >= MAX_PLAYERS) {
        sendToClient(ws, { action: 'ERROR', content: `Le salon ${code} est plein.` });
        return;
    }
    
    // Vérifier si le pseudonyme est déjà pris (insensible à la casse)
    const existingNicknames = Object.values(lobby.players).map(p => p.nickname.toLowerCase());
    const newNickname = nickname.substring(0, 15).trim() || `Joueur${code}`;
    
    if (existingNicknames.includes(newNickname.toLowerCase())) {
         sendToClient(ws, { action: 'ERROR', content: `Le pseudonyme '${newNickname}' est déjà utilisé dans ce salon.` });
         return;
    }

    // Ajout au salon
    ws.lobbyCode = code;
    ws.nickname = newNickname;
    lobby.clients.push(ws);
    lobby.players[ws.id] = {
        id: ws.id,
        nickname: ws.nickname,
        role: null,
        energy: 5, // Initial energy
        score: 0
    };

    console.log(`${ws.nickname} a rejoint le salon ${code}.`);
    
    sendToClient(ws, { action: 'LOBBY_JOINED', code: code });

    // Informer les autres
    broadcastToLobby(code, {
        action: 'SYSTEM_MESSAGE',
        content: `${ws.nickname} a rejoint le salon.`
    });

    sendLobbyUpdate(code);
}

/** Gère la sortie du salon. */
function handleLeaveLobby(ws, isDisconnect) {
    const code = ws.lobbyCode;
    const nickname = ws.nickname;
    
    if (code) {
        const lobby = codeToLobbyMap.get(code);

        if (lobby) {
            // Retirer le client et le joueur
            lobby.clients = lobby.clients.filter(client => client.id !== ws.id);
            if (lobby.players[ws.id]) {
                delete lobby.players[ws.id];
            }
            
            // Si le joueur qui quitte était l'hôte
            if (lobby.hostId === ws.id) {
                if (lobby.clients.length > 0) {
                    // Transférer l'hôte au premier client restant
                    const newHostId = lobby.clients[0].id;
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
                    stopEnergyGain(code); // S'assurer d'arrêter le gain d'énergie si le salon est vide
                    console.log(`Salon ${code} supprimé car il est vide.`);
                }
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
