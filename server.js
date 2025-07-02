    /**
 * Alanya - Serveur Central en Node.js
 * Remplace AlanyaCentralServer.java
 * Gère l'authentification, la présence et le signaling pour les appels P2P.
 */

// --- Imports des librairies nécessaires ---
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const mysql = require('mysql2/promise');
const crypto = require('crypto');

// --- Configuration ---
const PORT = 9000; // Port d'écoute interne pour Node.js. NGINX redirigera vers lui.

// Configuration de la BDD (identique à votre fichier DatabaseConnection.java)
const dbConfig = {
    host: '163.123.183.89',   // ✅ L'IP de votre base de données en ligne
    port: 17705,               // ✅ Le port de votre base de données en ligne
    user: 'military',          // ✅ L'utilisateur de la base de données
    password: 'people2025',      // ✅ Le mot de passe
    database: 'alaniaBD',        // ✅ Le nom de la base de données
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};
const pool = mysql.createPool(dbConfig);
console.log("Pool de connexions configuré pour la base de données en ligne.");

// Map pour garder en mémoire les clients connectés et leurs informations
// Clé: username, Valeur: { ws: WebSocket, id: userId, p2pHost: '...', p2pPort: '...' }
const connectedClients = new Map();


// --- Fonctions Utilitaires ---

/**
 * Hash un mot de passe avec SHA-256 pour correspondre à la logique Java.
 * (Logique tirée de votre fichier Client.java)
 * @param {string} password Le mot de passe en clair.
 * @returns {string} Le mot de passe haché en hexadécimal.
 */
function hashMotDePasse(password) {
    return crypto.createHash('sha256').update(password, 'utf-8').digest('hex');
}

/**
 * Envoie une réponse structurée à un client via WebSocket.
 * @param {WebSocket} ws Le socket du client.
 * @param {string} type Le type de réponse (ex: AUTHENTICATION_SUCCESS).
 * @param {object} data Les données à envoyer.
 * @param {boolean} success Le statut de la réussite.
 * @param {string} message Un message descriptif.
 */
function sendResponse(ws, type, data, success, message) {
    if (ws.readyState === ws.OPEN) {
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
    
    // Variable pour stocker l'état d'authentification de cette connexion spécifique
    let authenticatedUser = null;

    // Gestion des messages reçus du client
    ws.on('message', async (message) => {
        let command;
        try {
            // Les commandes du client Java arrivent sérialisées, on suppose ici qu'elles seront envoyées en JSON
            command = JSON.parse(message);
            console.log(`Commande reçue de ${authenticatedUser?.username || 'client non authentifié'}:`, command.type);
        } catch (error) {
            console.error('Erreur: Message reçu non-JSON:', message.toString());
            return;
        }

        // Si le client n'est pas authentifié, seule la commande AUTHENTICATE est autorisée
        if (!authenticatedUser && command.type !== 'AUTHENTICATE') {
            sendResponse(ws, 'AUTHENTICATION_FAILED', null, false, "Authentification requise.");
            return;
        }

        // Routeur de commandes (similaire à votre `processCommand` en Java)
        switch (command.type) {
            
            case 'AUTHENTICATE':
                try {
                    const { identifier, password } = command.data;
                    const hashedPassword = hashMotDePasse(password);

                    const [rows] = await pool.execute(
                        "SELECT id, nom_utilisateur, mot_de_passe, statut FROM Utilisateurs WHERE nom_utilisateur = ? OR email = ? OR telephone = ?",
                        [identifier, identifier, identifier]
                    );

                    if (rows.length === 0 || rows[0].mot_de_passe !== hashedPassword) {
                        sendResponse(ws, 'AUTHENTICATION_FAILED', null, false, "Identifiant ou mot de passe incorrect.");
                        return;
                    }

                    const user = rows[0];

                    if (connectedClients.has(user.nom_utilisateur)) {
                        sendResponse(ws, 'USER_ALREADY_CONNECTED', null, false, "Ce compte est déjà connecté.");
                        ws.close();
                        return;
                    }

                    // Authentification réussie
                    authenticatedUser = {
                        id: user.id,
                        username: user.nom_utilisateur,
                        ws: ws,
                        p2pHost: null,
                        p2pPort: null
                    };
                    connectedClients.set(user.nom_utilisateur, authenticatedUser);
                    
                    await pool.execute("UPDATE Utilisateurs SET statut = 'actif', derniere_connexion_timestamp = CURRENT_TIMESTAMP WHERE id = ?", [user.id]);

                    console.log(`Utilisateur ${user.nom_utilisateur} (ID: ${user.id}) authentifié avec succès.`);
                    sendResponse(ws, 'AUTHENTICATION_SUCCESS', { id: user.id, username: user.nom_utilisateur }, true, "Authentification réussie. Bienvenue !");

                } catch (dbError) {
                    console.error("Erreur de BDD lors de l'authentification:", dbError);
                    sendResponse(ws, 'AUTHENTICATION_FAILED', null, false, "Erreur serveur lors de l'authentification.");
                }
                break;

            case 'CLIENT_SERVER_STARTED':
                const { host, port } = command.data;
                if (authenticatedUser) {
                    authenticatedUser.p2pHost = host;
                    authenticatedUser.p2pPort = port;
                    await pool.execute("UPDATE Utilisateurs SET last_known_ip = ?, last_known_port = ? WHERE id = ?", [host, port, authenticatedUser.id]);
                    console.log(`Infos P2P pour ${authenticatedUser.username} mises à jour: ${host}:${port}`);
                    sendResponse(ws, 'P2P_SERVER_REGISTERED', null, true, "Connecté et visible par les autres utilisateurs.");
                }
                break;

            case 'GET_PEER_INFO':
                const { targetUsername } = command.data;
                const peerInfo = connectedClients.get(targetUsername);
                if (peerInfo && peerInfo.p2pPort) {
                    sendResponse(ws, 'P2P_PEER_INFO', { username: targetUsername, host: peerInfo.p2pHost, port: peerInfo.p2pPort }, true, "Peer en ligne.");
                } else {
                    sendResponse(ws, 'P2P_PEER_INFO', { username: targetUsername }, false, "Peer non joignable");
                }
                break;

            // --- Logique de 'Signaling' pour les appels ---
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
                    sendResponse(ws, 'CALL_REJECTED_BY_PEER', { responderUsername: targetCallUsername }, false, "L'utilisateur n'est pas connecté.");
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
        }
    });

    // Gestion de la déconnexion
    ws.on('close', async () => {
        if (authenticatedUser) {
            console.log(`Client ${authenticatedUser.username} déconnecté.`);
            connectedClients.delete(authenticatedUser.username);
            try {
                // Met à jour le statut en BDD
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

    ws.on('error', (error) => {
        console.error('Erreur WebSocket:', error);
    });
});

// Lancement final du serveur HTTP (qui héberge le serveur WebSocket)
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Serveur HTTP et WebSocket écoute sur toutes les interfaces locales sur le port ${PORT}`);
});