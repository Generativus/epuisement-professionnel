/**
 * Serveur WebSocket pour l'application de jeu de déduction sociale.
 * * Ajout de la gestion de l'hôte, de l'état du jeu et de la synchronisation des données de lobby.
 * * NOUVEAU: Logique complète de jeu (manches, énergie, travail d'équipe, vote).
 */

const WebSocket = require('ws');

// Définition du port d'écoute.
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// --- Constantes de Jeu ---
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 10;
const TOTAL_ROUNDS = 3;
const ROUND_DURATION = 900; // 15 minutes en secondes (900s)

// Énergie et Coûts
const MAX_ENERGY = 100;
const ENERGY_GAIN_RATE = 10000; // 10 secondes en ms
const ENERGY_GAIN_AMOUNT = 10;
const ENERGY_MESSAGE_COST = 1;
const WORK_COST = 200; // Coût total d'un rapport

// Objectifs
const WORK_GOAL = 200; // Points de travail à atteindre par manche

const GAME_STATUS = {
    WAITING: 'WAITING',
    STARTED: 'STARTED', // Manche en cours
    VOTING: 'VOTING',   // Phase de vote
    ENDED: 'ENDED'      // Jeu terminé
};

// Structure pour gérer les salons et les clients connectés.
// Format: { 
//   'code': { 
//      code: '12345', hostId: 'uuid', clients: [ws1, ws2], gameStatus: 'WAITING', 
//      currentRound: 0, jobPointsGoal: 200, currentJobPoints: 0, roundTimer: 0, 
//      gameTimerInterval: null, energyInterval: null,
//      pendingWork: { proposerId: null, targetIds: [], targetNames: [], costPerPlayer: 0, contributions: {} },
//      votes: {}, // { voterId: targetId }
//      players: { 
//          'userId': { nickname: 'name', role: null, energy: 100, jobPoints: 0, totalScore: 0 } 
//      } 
//   } 
// }
const codeToLobbyMap = new Map();

console.log(`Serveur WebSocket démarré sur le port ${PORT}`);

// --- Fonctions utilitaires ---

/** Génère un code de salon unique à 5 chiffres. */
function generateUniqueCode() {
    let code;
    do {
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
function sendLobbyUpdate(code, specificData = {}) {
    const lobby = codeToLobbyMap.get(code);
    if (!lobby) return;

    // Créer une version sérialisable du lobby sans les objets ws
    const serializableLobby = {
        code: lobby.code,
        hostId: lobby.hostId,
        gameStatus: lobby.gameStatus,
        currentRound: lobby.currentRound,
        jobPointsGoal: lobby.jobPointsGoal,
        currentJobPoints: lobby.currentJobPoints,
        players: lobby.players,
        clients: lobby.clients.map(c => ({ id: c.userId, code: c.lobbyCode }))
    };

    lobby.clients.forEach(client => {
        // Envoi des données spécifiques au joueur (énergie) via GAME_STATUS_UPDATE
        sendToClient(client, {
            action: 'GAME_STATUS_UPDATE',
            status: lobby.gameStatus,
            currentRound: lobby.currentRound,
            totalRounds: TOTAL_ROUNDS,
            timer: lobby.roundTimer,
            currentJobPoints: lobby.currentJobPoints,
            jobPointsGoal: lobby.jobPointsGoal,
            playerState: lobby.players[client.userId], // Inclut l'énergie
            ...specificData
        });
    });

    // Mettre à jour le lobby UI général (qui n'inclut pas les infos de jeu)
    broadcastToLobby(code, {
        action: 'LOBBY_UPDATE',
        lobby: serializableLobby
    });
}

// --- Logique de Jeu (Manches, Timer, Points) ---

/** Initialise ou réinitialise une manche. */
function startNewRound(code) {
    const lobby = codeToLobbyMap.get(code);
    if (!lobby) return;

    lobby.currentRound++;
    lobby.gameStatus = GAME_STATUS.STARTED;
    lobby.currentJobPoints = 0;
    lobby.roundTimer = ROUND_DURATION;
    lobby.jobPointsGoal = WORK_GOAL;
    lobby.pendingWork = { proposerId: null, targetIds: [], targetNames: [], costPerPlayer: 0, contributions: {} };
    lobby.votes = {};

    // Réinitialiser les scores des joueurs pour la manche
    for (const userId in lobby.players) {
        lobby.players[userId].energy = MAX_ENERGY; // Réinitialiser l'énergie
        lobby.players[userId].roundScore = 0; // Nouveau score pour suivre la performance de la manche
        // Assigner les rôles si besoin (non implémenté ici)
    }

    startEnergyTimer(code);
    startRoundTimer(code);
    
    // Message de la Patrone
    broadcastToLobby(code, {
        action: 'SYSTEM_MESSAGE',
        nickname: 'Patrone',
        content: `Manche ${lobby.currentRound} : Bienvenue ! L'objectif de points de travail est de ${WORK_GOAL}. Vous avez 15 minutes. Au travail !`
    });

    sendLobbyUpdate(code);
}

/** Démarre le gain d'énergie. */
function startEnergyTimer(code) {
    const lobby = codeToLobbyMap.get(code);
    if (lobby.energyInterval) clearInterval(lobby.energyInterval);

    lobby.energyInterval = setInterval(() => {
        let needsUpdate = false;
        lobby.clients.forEach(client => {
            const player = lobby.players[client.userId];
            if (player && player.energy < MAX_ENERGY) {
                player.energy = Math.min(MAX_ENERGY, player.energy + ENERGY_GAIN_AMOUNT);
                needsUpdate = true;
            }
        });

        if (needsUpdate) {
            sendLobbyUpdate(code); // Mettre à jour l'énergie des joueurs
        }
    }, ENERGY_GAIN_RATE);
}

/** Démarre le chronomètre de la manche. */
function startRoundTimer(code) {
    const lobby = codeToLobbyMap.get(code);
    if (lobby.gameTimerInterval) clearInterval(lobby.gameTimerInterval);

    lobby.gameTimerInterval = setInterval(() => {
        if (lobby.roundTimer > 0) {
            lobby.roundTimer--;
            sendLobbyUpdate(code);
            
            // Vérification de la condition de fin de manche (temps écoulé)
            if (lobby.roundTimer <= 0) {
                clearInterval(lobby.gameTimerInterval);
                endRound(code, false); // Échoué par manque de temps
            }
        }
    }, 1000);
}

/** Arrête les timers. */
function stopLobbyTimers(code) {
    const lobby = codeToLobbyMap.get(code);
    if (lobby.gameTimerInterval) clearInterval(lobby.gameTimerInterval);
    if (lobby.energyInterval) clearInterval(lobby.energyInterval);
    lobby.gameTimerInterval = null;
    lobby.energyInterval = null;
}

/** Gère la fin de la manche. */
function endRound(code, isSuccessful) {
    const lobby = codeToLobbyMap.get(code);
    if (!lobby || lobby.gameStatus === GAME_STATUS.ENDED) return;
    
    stopLobbyTimers(code);

    // Mettre à jour le score total avec l'énergie finale de la manche
    for (const userId in lobby.players) {
        lobby.players[userId].roundScore = lobby.players[userId].energy;
    }

    if (isSuccessful) {
        startVotingPhase(code);
    } else {
        // Manche non réussie
        handleFailedRound(code);
    }
}

// --- Phase de Vote (Manche Réussie) ---

function startVotingPhase(code) {
    const lobby = codeToLobbyMap.get(code);
    lobby.gameStatus = GAME_STATUS.VOTING;
    lobby.votes = {};

    // 1. Collecter les scores d'énergie et les rendre anonymes
    const energyScores = lobby.clients.map(client => lobby.players[client.userId].energy);
    // Triez pour l'anonymat, puis affichez
    energyScores.sort((a, b) => b - a); // Du plus élevé au plus bas

    const scoreList = energyScores.map((score, index) => `Joueur ${index + 1} : ${score}`).join('\n');
    const playerNicknames = lobby.clients.map(client => lobby.players[client.userId].nickname).join(', ');

    // 2. Message de la Patrone
    broadcastToLobby(code, {
        action: 'SYSTEM_MESSAGE',
        nickname: 'Patrone',
        content: `Félicitations, l'objectif est atteint ! Voici l'énergie finale des joueurs :\n${scoreList}\n\nVotez pour le joueur le plus fainéant (celui qui a le plus d'énergie non dépensée) en écrivant "vote [Pseudonyme]". Options: ${playerNicknames}`
    });

    sendLobbyUpdate(code);
}

function handleVote(ws, data) {
    const code = ws.lobbyCode;
    const lobby = codeToLobbyMap.get(code);
    if (!lobby || lobby.gameStatus !== GAME_STATUS.VOTING) {
        return sendToClient(ws, { action: 'ERROR', content: 'Le vote n\'est pas en cours.' });
    }

    const targetNickname = data.targetNickname;
    const targetClient = lobby.clients.find(c => lobby.players[c.userId].nickname.toLowerCase() === targetNickname.toLowerCase());
    
    if (!targetClient) {
        return sendToClient(ws, { action: 'ERROR', content: `Le joueur "${targetNickname}" n'a pas été trouvé.` });
    }

    // Enregistrement du vote
    lobby.votes[ws.userId] = targetClient.userId;

    sendToClient(ws, { action: 'SYSTEM_MESSAGE', content: `Vous avez voté pour ${targetNickname}.` });
    
    // Vérification de la fin du vote
    if (Object.keys(lobby.votes).length === lobby.clients.length) {
        processVoteResults(code);
    }
}

function processVoteResults(code) {
    const lobby = codeToLobbyMap.get(code);
    let voteCounts = {};
    let highestVotes = 0;
    let laziestPlayerId = null;

    // Compter les votes
    for (const voterId in lobby.votes) {
        const targetId = lobby.votes[voterId];
        voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
        if (voteCounts[targetId] > highestVotes) {
            highestVotes = voteCounts[targetId];
            laziestPlayerId = targetId;
        }
    }
    
    // Trouver le nickname du joueur sanctionné
    const laziestPlayerNickname = lobby.players[laziestPlayerId]?.nickname || 'Inconnu';

    // Sanction: Le joueur perd tous les points accumulés lors de cette manche.
    // Dans notre cas, cela signifie que son score final (énergie) pour la manche est ramené à 0.
    if (laziestPlayerId) {
        const oldScore = lobby.players[laziestPlayerId].roundScore;
        lobby.players[laziestPlayerId].roundScore = 0;
        
        broadcastToLobby(code, {
            action: 'SYSTEM_MESSAGE',
            nickname: 'Patrone',
            content: `Le vote est terminé. ${laziestPlayerNickname} est jugé le plus fainéant (avec ${highestVotes} votes). Sanction: ses points de cette manche (${oldScore} Énergie) sont perdus !`
        });
    } else {
        broadcastToLobby(code, {
            action: 'SYSTEM_MESSAGE',
            nickname: 'Patrone',
            content: 'Le vote est terminé, mais il y a eu égalité ou une erreur. Pas de sanction cette fois.'
        });
    }

    // Ajouter le score de la manche au score total
    for (const userId in lobby.players) {
        lobby.players[userId].totalScore += lobby.players[userId].roundScore;
    }

    // Passer à la manche suivante ou terminer le jeu
    setTimeout(() => {
        if (lobby.currentRound < TOTAL_ROUNDS) {
            startNewRound(code);
        } else {
            endGame(code);
        }
    }, 5000); // 5 secondes pour que les joueurs lisent le résultat
}

// --- Phase de Manque de Temps (Manche Échouée) ---

function handleFailedRound(code) {
    const lobby = codeToLobbyMap.get(code);

    broadcastToLobby(code, {
        action: 'SYSTEM_MESSAGE',
        nickname: 'Patrone',
        content: 'Manche échouée ! Je ne suis pas fière de cette performance. En punition, les scores d\'énergie (points) du joueur le plus faible et du joueur le plus fort sont inversés !'
    });

    // Inversion des scores basés sur l'énergie de fin de manche
    let playersArray = Object.values(lobby.players).map(p => ({ ...p }));
    playersArray.sort((a, b) => a.energy - b.energy); // Trier par énergie (du plus faible au plus fort)
    
    if (playersArray.length >= 2) {
        const lowestEnergyPlayer = playersArray[0];
        const highestEnergyPlayer = playersArray[playersArray.length - 1];

        // Inversion (seuls les scores de la manche sont inversés)
        const tempScore = lowestEnergyPlayer.roundScore;
        
        // Mettre à jour les scores de la manche dans le lobby
        const lowId = lobby.clients.find(c => lobby.players[c.userId].nickname === lowestEnergyPlayer.nickname)?.userId;
        const highId = lobby.clients.find(c => lobby.players[c.userId].nickname === highestEnergyPlayer.nickname)?.userId;

        if (lowId && highId) {
            lobby.players[lowId].roundScore = highestEnergyPlayer.roundScore;
            lobby.players[highId].roundScore = tempScore;

            broadcastToLobby(code, {
                action: 'SYSTEM_MESSAGE',
                content: `Inversion: ${lowestEnergyPlayer.nickname} reçoit ${lobby.players[lowId].roundScore} points et ${highestEnergyPlayer.nickname} reçoit ${lobby.players[highId].roundScore} points.`
            });
        }
    }

    // Ajouter le score de la manche au score total
    for (const userId in lobby.players) {
        lobby.players[userId].totalScore += lobby.players[userId].roundScore;
    }

    // Passer à la manche suivante ou terminer le jeu
    setTimeout(() => {
        if (lobby.currentRound < TOTAL_ROUNDS) {
            startNewRound(code);
        } else {
            endGame(code);
        }
    }, 5000);
}

// --- Fin de Jeu ---

function endGame(code) {
    const lobby = codeToLobbyMap.get(code);
    lobby.gameStatus = GAME_STATUS.ENDED;

    let winner = null;
    let maxScore = -1;

    // Trouver le joueur avec le score total le plus élevé
    for (const userId in lobby.players) {
        if (lobby.players[userId].totalScore > maxScore) {
            maxScore = lobby.players[userId].totalScore;
            winner = lobby.players[userId];
        }
    }
    
    const finalScores = Object.values(lobby.players).map(p => `${p.nickname}: ${p.totalScore} pts`).join('\n');

    broadcastToLobby(code, {
        action: 'SYSTEM_MESSAGE',
        nickname: 'Patrone',
        content: `**FIN DU JEU !**\nScores finaux:\n${finalScores}\n\nFélicitations, ${winner.nickname} ! Votre excellente gestion de l'énergie et votre travail acharné vous valent une promotion !`
    });

    sendLobbyUpdate(code);
}


// --- Logique de Travail d'Équipe ---

function handleTeamworkProposal(ws, data) {
    const code = ws.lobbyCode;
    const lobby = codeToLobbyMap.get(code);
    if (!lobby || lobby.gameStatus !== GAME_STATUS.STARTED) {
        return sendToClient(ws, { action: 'ERROR', content: 'Le travail d\'équipe ne peut être lancé que pendant une manche.' });
    }
    if (lobby.pendingWork.proposerId) {
        return sendToClient(ws, { action: 'ERROR', content: 'Un travail d\'équipe est déjà en cours de proposition.' });
    }

    // Format: "rapport [nom1] [nom2] ..."
    const targetNames = data.content.substring(8).split(' ').filter(n => n.trim() !== '');

    if (targetNames.length === 0) {
        return sendToClient(ws, { action: 'ERROR', content: 'Vous devez nommer au moins un joueur pour un rapport d\'équipe.' });
    }
    
    // Identifier les joueurs ciblés et vérifier l'énergie
    const allNames = [...targetNames, ws.nickname];
    const targetClients = [];
    const targetUserIds = [];
    
    for (const name of allNames) {
        const client = lobby.clients.find(c => c.nickname.toLowerCase() === name.toLowerCase());
        if (!client) {
            return sendToClient(ws, { action: 'ERROR', content: `Joueur "${name}" non trouvé.` });
        }
        if (client.userId !== ws.userId) {
            targetClients.push(client);
            targetUserIds.push(client.userId);
        }
    }
    
    if (allNames.length < 2) {
         return sendToClient(ws, { action: 'ERROR', content: 'Minimum deux joueurs (vous-même inclus) sont nécessaires pour un travail d\'équipe.' });
    }

    const totalPlayers = allNames.length;
    const costPerPlayer = WORK_COST / totalPlayers;
    
    // Vérification de l'énergie (proposer doit avoir assez)
    if (lobby.players[ws.userId].energy < costPerPlayer) {
         return sendToClient(ws, { action: 'ERROR', content: `Vous n'avez pas assez d'énergie (${costPerPlayer} requis) pour proposer ce travail.` });
    }
    
    // Initialiser la proposition
    lobby.pendingWork = {
        proposerId: ws.userId,
        targetIds: targetUserIds,
        targetNames: targetNames,
        costPerPlayer: costPerPlayer,
        contributions: { [ws.userId]: 'oui' } // L'initiateur accepte automatiquement
    };

    // Notifier les joueurs ciblés
    targetClients.forEach(client => {
        sendToClient(client, {
            action: 'WORK_PROPOSAL',
            proposerNickname: ws.nickname,
            targetNames: allNames // Envoyer tous les noms pour affichage
        });
    });

    sendToClient(ws, { action: 'SYSTEM_MESSAGE', content: `Proposition de travail d'équipe envoyée à ${targetNames.join(', ')}. En attente de leurs réponses...` });
}

function handleTeamworkResponse(ws, data) {
    const code = ws.lobbyCode;
    const lobby = codeToLobbyMap.get(code);
    if (!lobby || lobby.gameStatus !== GAME_STATUS.STARTED || !lobby.pendingWork.proposerId) {
        return sendToClient(ws, { action: 'ERROR', content: 'Aucun travail d\'équipe en cours.' });
    }
    
    // Si ce client n'est pas ciblé, ignorer
    if (lobby.pendingWork.targetIds.indexOf(ws.userId) === -1) {
        return sendToClient(ws, { action: 'ERROR', content: 'Cette proposition ne vous concerne pas.' });
    }
    
    const response = data.response; // "oui" ou "non"

    if (response === 'non') {
        // Un joueur refuse, annuler le travail
        const proposerNickname = lobby.players[lobby.pendingWork.proposerId]?.nickname || 'L\'hôte';
        broadcastToLobby(code, {
            action: 'SYSTEM_MESSAGE',
            content: `Le travail d'équipe pour le rapport (proposé par ${proposerNickname}) a été refusé par ${ws.nickname}.`
        });
        lobby.pendingWork = { proposerId: null, targetIds: [], targetNames: [], costPerPlayer: 0, contributions: {} };
    } else if (response === 'oui') {
        // Enregistrer l'acceptation
        lobby.pendingWork.contributions[ws.userId] = 'oui';
        sendToClient(ws, { action: 'SYSTEM_MESSAGE', content: 'Vous avez accepté le travail d\'équipe.' });
        
        // Vérifier si tout le monde a accepté
        const requiredAcceptances = lobby.pendingWork.targetIds.length + 1; // Tous les ciblés + le proposant
        const currentAcceptances = Object.keys(lobby.pendingWork.contributions).length;

        if (currentAcceptances === requiredAcceptances) {
            // Tous ont accepté, passer à la phase de contribution
            const allPlayerIds = [lobby.pendingWork.proposerId, ...lobby.pendingWork.targetIds];
            
            // Notifier les joueurs d'entrer leur contribution
            allPlayerIds.forEach(id => {
                 const client = lobby.clients.find(c => c.userId === id);
                 if (client) {
                    sendToClient(client, {
                        action: 'REQUEST_WORK_CONTRIBUTION',
                        cost: lobby.pendingWork.costPerPlayer 
                    });
                 }
            });
            
            broadcastToLobby(code, { action: 'SYSTEM_MESSAGE', content: `Tous les joueurs ont accepté ! Veuillez entrer votre contribution.` });
            
            // Changer le statut local des contributions pour être prêt à recevoir des montants
            lobby.pendingWork.contributions = {}; 
        }
    }
}

function handleSubmitContribution(ws, data) {
    const code = ws.lobbyCode;
    const lobby = codeToLobbyMap.get(code);
    if (!lobby || lobby.gameStatus !== GAME_STATUS.STARTED || lobby.pendingWork.contributions[ws.userId] !== undefined) {
        return sendToClient(ws, { action: 'ERROR', content: 'Soumission de contribution impossible.' });
    }

    const contribution = parseInt(data.contribution, 10);
    const cost = lobby.pendingWork.costPerPlayer;
    const playerEnergy = lobby.players[ws.userId].energy;

    if (isNaN(contribution) || contribution < 1 || contribution > 100) {
        return sendToClient(ws, { action: 'ERROR', content: 'Contribution invalide (doit être entre 1 et 100).' });
    }
    if (contribution > playerEnergy) {
        return sendToClient(ws, { action: 'ERROR', content: 'Contribution supérieure à votre énergie disponible.' });
    }
    if (contribution > cost) {
         return sendToClient(ws, { action: 'ERROR', content: `Contribution maximale autorisée: ${cost}.` });
    }

    // Enregistrer la contribution
    lobby.pendingWork.contributions[ws.userId] = contribution;
    sendToClient(ws, { action: 'SYSTEM_MESSAGE', content: `Votre contribution de ${contribution} points est enregistrée.` });

    const totalPlayers = lobby.pendingWork.targetIds.length + 1; // Cibles + Proposer
    
    // Vérifier si toutes les contributions sont reçues
    if (Object.keys(lobby.pendingWork.contributions).length === totalPlayers) {
        
        const allContributions = Object.values(lobby.pendingWork.contributions);
        const totalContribution = allContributions.reduce((sum, val) => sum + val, 0);
        
        // Vérification de la réussite (Chance de réussite = totalContribution / 200)
        // La réussite est basée sur un jet aléatoire
        const successChance = totalContribution / WORK_COST; // Max 1.0 (100%) si totalContribution = 200
        const successRoll = Math.random(); // Nombre aléatoire entre 0 et 1

        let workSuccessful = successRoll < successChance;
        let resultMessage;
        
        if (workSuccessful) {
            lobby.currentJobPoints += WORK_COST;
            resultMessage = `SUCCÈS ! Les contributions totalisent ${totalContribution} points (Chance: ${Math.round(successChance * 100)}%). ${WORK_COST} points de travail ajoutés.`;
        } else {
            resultMessage = `ÉCHEC ! Les contributions totalisent ${totalContribution} points (Chance: ${Math.round(successChance * 100)}%). Zéro point ajouté.`;
        }

        // Pénalité/Récompense
        allPlayerIds = [lobby.pendingWork.proposerId, ...lobby.pendingWork.targetIds];
        allPlayerIds.forEach(id => {
            const contributionAmount = lobby.pendingWork.contributions[id];
            // Les joueurs perdent leur énergie (qu'il y ait succès ou échec)
            lobby.players[id].energy = Math.max(0, lobby.players[id].energy - contributionAmount);
            // La logique du user dit "perdent leur énergie" si échec, et "s'ajoute les 200 points" si succès.
            // Cependant, le coût est déduit via la contribution. Si échec, l'énergie est perdue sans gain.
        });
        
        broadcastToLobby(code, { action: 'SYSTEM_MESSAGE', content: `**Rapport Final:** ${resultMessage}` });
        
        // Réinitialiser le travail en cours
        lobby.pendingWork = { proposerId: null, targetIds: [], targetNames: [], costPerPlayer: 0, contributions: {} };
        
        // Vérification de la fin de manche (points atteints)
        if (lobby.currentJobPoints >= lobby.jobPointsGoal) {
            clearInterval(lobby.gameTimerInterval);
            broadcastToLobby(code, { action: 'SYSTEM_MESSAGE', content: 'OBJECTIF ATTEINT ! Fin de la manche.' });
            endRound(code, true);
        } else {
            // Mise à jour de l'UI et de l'énergie après résolution
            sendLobbyUpdate(code);
        }
    }
}


// --- Gestionnaires d'actions du client ---

// (Fonctions handleCreateLobby, handleJoinLobby, handleLeaveLobby restent inchangées dans leur structure de base)

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
        currentRound: 0,
        jobPointsGoal: WORK_GOAL,
        currentJobPoints: 0,
        roundTimer: 0,
        gameTimerInterval: null,
        energyInterval: null,
        pendingWork: { proposerId: null, targetIds: [], targetNames: [], costPerPlayer: 0, contributions: {} },
        votes: {},
        players: {
            [userId]: { nickname: nickname, role: null, energy: MAX_ENERGY, jobPoints: 0, totalScore: 0, roundScore: 0 }
        }
    };
    codeToLobbyMap.set(code, lobby);

    ws.lobbyCode = code;
    ws.userId = userId;
    ws.nickname = nickname;

    console.log(`Salon créé: ${code} par ${nickname} (${userId})`);

    sendToClient(ws, { action: 'LOBBY_CREATED', code: code, userId: userId });
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
    
    // Si déjà présent, rejeter
    if (lobby.clients.some(client => client.userId === userId)) {
        return sendToClient(ws, { action: 'ERROR', content: `Un utilisateur avec cet ID est déjà connecté au salon ${code}.` });
    }

    // Ajouter le client au salon
    lobby.clients.push(ws);
    lobby.players[userId] = { nickname: nickname, role: null, energy: MAX_ENERGY, jobPoints: 0, totalScore: 0, roundScore: 0 };

    ws.lobbyCode = code;
    ws.userId = userId;
    ws.nickname = nickname;

    console.log(`${nickname} (${userId}) a rejoint le salon ${code}.`);

    sendToClient(ws, { action: 'LOBBY_JOINED', code: code, userId: userId });

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
    const lobby = codeToLobbyMap.get(code);
    if (!code || !lobby) return; 
    
    // Déduite de l'énergie pour un message standard
    if (lobby.gameStatus === GAME_STATUS.STARTED || lobby.gameStatus === GAME_STATUS.VOTING) {
        const player = lobby.players[ws.userId];
        if (player.energy >= ENERGY_MESSAGE_COST) {
            player.energy -= ENERGY_MESSAGE_COST;
            sendLobbyUpdate(code); // Mise à jour de l'énergie
        } else {
             return sendToClient(ws, { action: 'ERROR', content: 'Énergie insuffisante pour envoyer un message de chat.' });
        }
    }

    // Diffuser le message
    broadcastToLobby(code, {
        action: 'MESSAGE',
        userId: ws.userId,
        nickname: ws.nickname,
        content: data.content,
        timestamp: Date.now()
    });
}

/** Gère le lancement de la partie. */
function handleStartGame(ws) {
    const code = ws.lobbyCode;
    const lobby = codeToLobbyMap.get(code);

    if (!lobby || lobby.gameStatus !== GAME_STATUS.WAITING || lobby.hostId !== ws.userId || lobby.clients.length < MIN_PLAYERS) {
        return sendToClient(ws, { action: 'ERROR', content: 'Impossible de démarrer la partie (conditions non remplies).' });
    }

    broadcastToLobby(code, {
        action: 'SYSTEM_MESSAGE',
        content: `L'hôte a démarré la partie !`,
        timestamp: Date.now()
    });
    
    startNewRound(code);
}


// --- Événements WebSocket ---

wss.on('connection', function connection(ws, req) {
    console.log('Nouveau client connecté.');

    // Ajouter les propriétés de base pour le nettoyage
    ws.lobbyCode = null;
    ws.userId = null;
    ws.nickname = null;

    ws.on('message', function incoming(message) {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error('Erreur de parsing du message:', message);
            return;
        }

        switch (data.action) {
            case 'CREATE_LOBBY':
                handleCreateLobby(ws, data);
                break;
            case 'JOIN_LOBBY':
                handleJoinLobby(ws, data);
                break;
            case 'MESSAGE':
                handleMessage(ws, data); // Chat normal (avec coût énergie)
                break;
            case 'START_GAME': 
                handleStartGame(ws);
                break;
            case 'LEAVE_LOBBY':
                handleLeaveLobby(ws, false); 
                break;
            case 'TEAMWORK_PROPOSAL':
                 handleTeamworkProposal(ws, data); // "rapport [nom]"
                 break;
            case 'WORK_RESPONSE':
                 handleTeamworkResponse(ws, data); // "oui" ou "non"
                 break;
            case 'SUBMIT_CONTRIBUTION':
                handleSubmitContribution(ws, data); // Montant du travail (1-100)
                break;
            case 'VOTE':
                 handleVote(ws, data); // "vote [nom]"
                 break;
            default:
                sendToClient(ws, { action: 'ERROR', content: 'Action inconnue.' });
                break;
        }
    });

    ws.on('close', () => {
        console.log(`Client déconnecté: ${ws.nickname} (${ws.userId})`);
        handleLeaveLobby(ws, true); 
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

        const clientIndex = lobby.clients.findIndex(client => client.userId === ws.userId);
        if (clientIndex !== -1) {
            lobby.clients.splice(clientIndex, 1);
            delete lobby.players[ws.userId]; 
            console.log(`${nickname} a quitté/déconnecté du salon ${code}.`);
        }

        // Si c'était l'hôte, transférer les droits et arrêter les timers si vide
        if (lobby.hostId === ws.userId) {
            if (lobby.clients.length > 0) {
                const newHostId = lobby.clients[0].userId;
                lobby.hostId = newHostId;
                
                sendToClient(lobby.clients[0], {
                    action: 'SYSTEM_MESSAGE',
                    content: `Vous êtes le nouvel hôte du salon !`,
                    timestamp: Date.now()
                });
            } else if (lobby.clients.length === 0) {
                stopLobbyTimers(code); // Arrêter les timers avant de supprimer
                codeToLobbyMap.delete(code);
                console.log(`Salon ${code} supprimé car il est vide.`);
            }
        } 
        
        // Si le salon est vide après le départ
        if (lobby.clients.length === 0 && codeToLobbyMap.has(code)) {
             stopLobbyTimers(code); // Arrêter les timers
             codeToLobbyMap.delete(code);
             console.log(`Salon ${code} supprimé car il est vide.`);
        }


        // Si le salon existe encore, notifier les autres clients
        if (codeToLobbyMap.has(code)) {
            broadcastToLobby(code, {
                action: 'SYSTEM_MESSAGE',
                content: `${nickname} a quitté le salon.`,
                timestamp: Date.now()
            });
            sendLobbyUpdate(code);
        }

        if (!isDisconnect) {
            sendToClient(ws, { action: 'LOBBY_LEFT' });
        }

        ws.lobbyCode = null;
        ws.userId = null;
        ws.nickname = null;
    }
}
