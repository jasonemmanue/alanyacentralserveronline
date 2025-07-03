/**
 * Alanya - Serveur Central en Node.js (Version finale et complète)
 * Gère l'authentification, la présence et le signaling pour les connexions P2P et les appels.
 */

// --- Imports des librairies nécessaires ---
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const mysql = require('mysql2/promise');
const crypto = require('crypto');

// --- Configuration ---
const PORT = 9000; // Port d'écoute interne pour Node.js.

// Configuration de la BDD
const dbConfig = {
    host: '163.123.183.89',
    port: 17705,
    user: 'military',
    password: 'people2025',
    database: 'alaniaBD',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};
const pool = mysql.createPool(dbConfig);
console.log("Pool de connexions configuré.");

// Map pour garder en mémoire les clients connectés
// Clé: username, Valeur: { ws: WebSocket, id: userId, p2pHost: '...', p2pPort: '...' }
const connectedClients = new Map();


// --- Fonctions Utilitaires ---

/**
 * Hash un mot de passe avec SHA-256 pour correspondre à la logique Java.
 */
function hashMotDePasse(password) {
    return crypto.createHash('sha256').update(password, 'utf-8').digest('hex');
}

/**
 * Envoie une réponse structurée à un client via WebSocket.
 */
function sendResponse(ws, type, data, success, message) {
    if (ws && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
            type: type,
            success: success,
            message: message,
            data: data || {}
        }));
    }
}


// --- Initialisation du Serveur Express et WebSocket ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

console.log(`Serveur Node.js démarré. WebSocket écoutera sur le port ${PORT}`);


// --- Logique Principale du Serveur WebSocket ---
wss.on('connection', (ws) => {
    console.log('Nouveau client WebSocket connecté.');
    let authenticatedUser = null;

    // Gestion des messages reçus du client
    ws.on('message', async (message) => {
        let command;
        try {
            command = JSON.parse(message);
        } catch (error) {
            console.error('Erreur: Message reçu non-JSON:', message.toString());
            return;
        }

        // Si le client n'est pas authentifié, seule la commande AUTHENTICATE est autorisée
        if (!authenticatedUser && command.type !== 'AUTHENTICATE') {
            sendResponse(ws, 'AUTHENTICATION_FAILED', null, false, "Authentification requise.");
            return;
        }

        // Routeur de commandes
        switch (command.type) {
            
            case 'AUTHENTICATE':
                try {
                    const { identifier, password } = command.data;
                    const hashedPassword = hashMotDePasse(password);

                    const [rows] = await pool.execute(
                        "SELECT id, nom_utilisateur, mot_de_passe FROM Utilisateurs WHERE nom_utilisateur = ? OR email = ? OR telephone = ?",
                        [identifier, identifier, identifier]
                    );

                    if (rows.length === 0 || rows[0].mot_de_passe !== hashedPassword) {
                        sendResponse(ws, 'AUTHENTICATION_FAILED', null, false, "Identifiants incorrects.");
                        return;
                    }

                    const user = rows[0];
                    if (connectedClients.has(user.nom_utilisateur)) {
                        sendResponse(ws, 'USER_ALREADY_CONNECTED', null, false, "Ce compte est déjà connecté.");
                        ws.close();
                        return;
                    }

                    authenticatedUser = { id: user.id, username: user.nom_utilisateur, ws: ws, p2pHost: null, p2pPort: null };
                    connectedClients.set(user.nom_utilisateur, authenticatedUser);
                    
                    await pool.execute("UPDATE Utilisateurs SET statut = 'actif', derniere_connexion_timestamp = CURRENT_TIMESTAMP WHERE id = ?", [user.id]);

                    console.log(`Utilisateur ${user.nom_utilisateur} (ID: ${user.id}) authentifié.`);
                    sendResponse(ws, 'AUTHENTICATION_SUCCESS', { id: user.id, username: user.nom_utilisateur }, true, "Authentification réussie.");

                } catch (dbError) {
                    console.error("Erreur de BDD lors de l'authentification:", dbError);
                    sendResponse(ws, 'AUTHENTICATION_FAILED', null, false, "Erreur serveur.");
                }
                break;

            case 'CLIENT_SERVER_STARTED':
                const { host, port } = command.data;
                if (authenticatedUser) {
                    authenticatedUser.p2pHost = host;
                    authenticatedUser.p2pPort = port;
                    
                    await pool.execute("UPDATE Utilisateurs SET last_known_ip = ?, last_known_port = ? WHERE id = ?", [host, port, authenticatedUser.id]);
                    
                    console.log(`Infos P2P (IP/Port Publics) pour ${authenticatedUser.username} mises à jour: ${host}:${port}`);
                    sendResponse(ws, 'P2P_SERVER_REGISTERED', null, true, "Connecté et visible.");
                }
                break;

            case 'GET_PEER_INFO':
                const targetUsername = command.data.targetUsername;
                const requesterInfo = authenticatedUser;
                const targetInfo = connectedClients.get(targetUsername);

                if (targetInfo && targetInfo.p2pHost && targetInfo.p2pPort) {
                    console.log(`[Hole Punching] Étape 1: Envoi des infos de ${targetUsername} à ${requesterInfo.username}`);
                    sendResponse(requesterInfo.ws, 'P2P_PEER_INFO', { 
                        username: targetUsername, 
                        host: targetInfo.p2pHost, 
                        port: targetInfo.p2pPort 
                    }, true, "Peer en ligne.");

                    console.log(`[Hole Punching] Étape 2: Envoi d'une demande de connexion de ${requesterInfo.username} à ${targetUsername}`);
                    sendResponse(targetInfo.ws, 'P2P_CONNECT_REQUEST', {
                        username: requesterInfo.username,
                        host: requesterInfo.p2pHost,
                        port: requesterInfo.p2pPort
                    }, true, "Demande de connexion P2P entrante.");

                } else {
                    sendResponse(ws, 'P2P_PEER_INFO', { username: targetUsername }, false, "Peer non joignable");
                }
                break;

            case 'INITIATE_AUDIO_CALL':
            case 'INITIATE_VIDEO_CALL':
                const targetCallUsername = command.data.targetUsername;
                const targetClient = connectedClients.get(targetCallUsername);
                if (targetClient) {
                    console.log(`Relai de la demande d'appel de ${authenticatedUser.username} vers ${targetCallUsername}`);
                    sendResponse(targetClient.ws, 'NEW_INCOMING_CALL', {
                        callerUsername: authenticatedUser.username,
                        callId: command.data.callId,
                        type: command.type === 'INITIATE_VIDEO_CALL' ? 'video' : 'audio'
                    }, true, "Appel entrant");
                } else {
                    sendResponse(ws, 'CALL_REJECTED_BY_PEER', { responderUsername: targetCallUsername, type: command.type.includes('VIDEO') ? 'video' : 'audio' }, false, "L'utilisateur n'est pas connecté.");
                }
                break;

            case 'CALL_RESPONSE':
                const initiatorUsername = command.data.callId.split('_')[0];
                const initiatorClient = connectedClients.get(initiatorUsername);
                if (initiatorClient) {
                    console.log(`Relai de la réponse à l'appel de ${authenticatedUser.username} vers ${initiatorUsername}`);
                    
                    const responseData = { ...command.data, ip: authenticatedUser.p2pHost }; 
                    const responseType = command.data.accepted === 'true' ? 'CALL_ACCEPTED_BY_PEER' : 'CALL_REJECTED_BY_PEER';
                    
                    sendResponse(initiatorClient.ws, responseType, responseData, true, "Réponse à l'appel.");
                }
                break;

            case 'END_CALL':
                 const targetEndCallUsername = command.data.targetUsername;
                 const targetEndClient = connectedClients.get(targetEndCallUsername);
                 if (targetEndClient) {
                    console.log(`Relai de la fin d'appel de ${authenticatedUser.username} vers ${targetEndCallUsername}`);
                    sendResponse(targetEndClient.ws, 'CALL_ENDED_BY_PEER', {
                        username: authenticatedUser.username,
                        callId: command.data.callId,
                        type: command.data.type
                    }, true, "Appel terminé par le pair.");
                 }
                 break;

            case 'DISCONNECT':
                ws.close();
                break;
                
            default:
                 console.log(`Commande non gérée reçue: ${command.type}`);
                 sendResponse(ws, 'GENERIC_ERROR', null, false, `Commande inconnue: ${command.type}`);
                 break;
        }
    });

    // Gestion de la déconnexion
    ws.on('close', async () => {
        if (authenticatedUser) {
            console.log(`Client ${authenticatedUser.username} déconnecté.`);
            connectedClients.delete(authenticatedUser.username);
            try {
                await pool.execute(
                    "UPDATE Utilisateurs SET statut = 'hors-ligne', derniere_deconnexion_timestamp = CURRENT_TIMESTAMP WHERE id = ?",
                    [authenticatedUser.id]
                );
            } catch (dbError) {
                console.error(`Erreur BDD lors de la déconnexion de ${authenticatedUser.username}:`, dbError);
            }
        } else {
             console.log('Client non authentifié déconnecté.');
        }
    });

    ws.on('error', (error) => console.error('Erreur WebSocket:', error));
});

// Lancement final du serveur HTTP (qui héberge le serveur WebSocket)
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Serveur HTTP et WebSocket écoute sur toutes les interfaces locales sur le port ${PORT}`);
});