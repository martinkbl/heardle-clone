const fs = require('fs');
const path = require('path');

// Load playlists data
let playlists = {};
try {
    const playlistsPath = path.join(__dirname, '..', 'playlists.json');
    if (fs.existsSync(playlistsPath)) {
        playlists = JSON.parse(fs.readFileSync(playlistsPath, 'utf8'));
    }
} catch (err) {
    console.error('Error loading playlists.json in multiplayer server:', err.message);
}

// Fallback to songs.json if needed
let defaultSongs = [];
try {
    const songsPath = path.join(__dirname, '..', 'songs.json');
    if (fs.existsSync(songsPath)) {
        defaultSongs = JSON.parse(fs.readFileSync(songsPath, 'utf8'));
    }
} catch (err) {
    console.error('Error loading songs.json in multiplayer server:', err.message);
}

// Active rooms in memory: roomCode -> Room Object
const rooms = new Map();

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

function normalizeText(str) {
    if (!str) return '';
    return str
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]/g, "");
}

function checkGuessMatch(guess, song) {
    if (!guess || !song) return false;
    const cleanGuess = normalizeText(guess);
    const cleanTitle = normalizeText(song.title);
    const cleanArtist = normalizeText(song.artist);
    const cleanOriginal = normalizeText(song.original_title || '');

    if (!cleanGuess) return false;

    // Direct match with title or original_title
    if (cleanGuess === cleanTitle || (cleanTitle && cleanGuess.includes(cleanTitle))) return true;
    if (cleanOriginal && cleanGuess.includes(cleanOriginal)) return true;

    // Artist + Title match
    if (cleanArtist && cleanTitle && (cleanGuess.includes(cleanArtist) && cleanGuess.includes(cleanTitle))) return true;

    return false;
}

function calculateScore(elapsedSeconds, skips, wrongAttempts) {
    const totalDuration = 60;
    const basePoints = 500;
    const timeRemaining = Math.max(0, totalDuration - elapsedSeconds);
    const speedBonus = Math.floor((timeRemaining / totalDuration) * 500); // 0 to 500
    const skipPenalty = (skips || 0) * 100;
    const wrongPenalty = (wrongAttempts || 0) * 50;

    const total = basePoints + speedBonus - skipPenalty - wrongPenalty;
    return Math.max(100, total); // Minimum 100 points for a correct answer
}

function getRoomSongs(room) {
    if (room.playlistKey && playlists[room.playlistKey] && playlists[room.playlistKey].songs && playlists[room.playlistKey].songs.length > 0) {
        return playlists[room.playlistKey].songs;
    }
    if (defaultSongs && defaultSongs.length > 0) {
        return defaultSongs;
    }
    // Search any playlist with songs
    for (const key of Object.keys(playlists)) {
        if (playlists[key].songs && playlists[key].songs.length > 0) {
            return playlists[key].songs;
        }
    }
    return [];
}

class MultiplayerManager {
    constructor(wss) {
        this.wss = wss;
        this.clientRooms = new Map(); // socket -> roomCode
        this.setupWebSocket();
    }

    setupWebSocket() {
        this.wss.on('connection', (ws) => {
            ws.id = 'p_' + Math.random().toString(36).substring(2, 9);
            ws.isAlive = true;

            ws.on('pong', () => {
                ws.isAlive = true;
            });

            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message);
                    this.handleMessage(ws, data);
                } catch (e) {
                    console.error('Multiplayer invalid JSON:', e.message);
                }
            });

            ws.on('close', () => {
                this.handleDisconnect(ws);
            });

            ws.on('error', (err) => {
                console.warn(`WebSocket error on client ${ws.id}:`, err.message);
            });
        });

        // Heartbeat ping/pong to clean up dead sockets
        setInterval(() => {
            this.wss.clients.forEach((ws) => {
                if (ws.isAlive === false) return ws.terminate();
                ws.isAlive = false;
                ws.ping();
            });
        }, 30000);
    }

    send(ws, type, payload = {}) {
        if (ws && ws.readyState === 1) { // OPEN
            ws.send(JSON.stringify({ type, ...payload }));
        }
    }

    broadcast(room, type, payload = {}, excludeWs = null) {
        if (!room || !room.players) return;
        const message = JSON.stringify({ type, ...payload });
        room.players.forEach((player) => {
            if (player.ws && player.ws.readyState === 1 && player.ws !== excludeWs) {
                player.ws.send(message);
            }
        });
    }

    handleMessage(ws, data) {
        const { type } = data;

        switch (type) {
            case 'CREATE_ROOM':
                this.handleCreateRoom(ws, data);
                break;
            case 'JOIN_ROOM':
                this.handleJoinRoom(ws, data);
                break;
            case 'UPDATE_SETTINGS':
                this.handleUpdateSettings(ws, data);
                break;
            case 'START_GAME':
                this.handleStartGame(ws, data);
                break;
            case 'NEXT_ROUND':
                this.handleNextRound(ws, data);
                break;
            case 'SUBMIT_GUESS':
                this.handleSubmitGuess(ws, data);
                break;
            case 'SUBMIT_SKIP':
                this.handleSubmitSkip(ws, data);
                break;
            case 'RESTART_GAME':
                this.handleRestartGame(ws, data);
                break;
            case 'LEAVE_ROOM':
                this.handleDisconnect(ws);
                break;
            default:
                console.warn('Unknown multiplayer action:', type);
        }
    }

    handleCreateRoom(ws, data) {
        const playerName = (data.playerName || 'Hôte').trim().substring(0, 20);
        let roomCode = generateRoomCode();
        while (rooms.has(roomCode)) {
            roomCode = generateRoomCode();
        }

        const playlistKeys = Object.keys(playlists);
        const defaultPlaylist = playlistKeys.length > 0 ? playlistKeys[0] : 'default';

        const room = {
            code: roomCode,
            hostId: ws.id,
            state: 'LOBBY', // 'LOBBY', 'PLAYING', 'ROUND_OVER', 'MATCH_OVER'
            playlistKey: data.playlistKey || defaultPlaylist,
            winningRounds: parseInt(data.winningRounds, 10) || 5, // First to X wins
            currentRound: 0,
            players: new Map(),
            currentSong: null,
            roundStartTime: 0,
            roundDuration: 60,
            roundTimer: null,
            playedSongIds: new Set()
        };

        const player = {
            id: ws.id,
            name: playerName,
            isHost: true,
            score: 0,
            roundsWon: 0,
            avatar: data.avatar || '🎧',
            ws: ws,
            roundState: {
                hasGuessed: false,
                isCorrect: false,
                guessTime: null,
                skips: 0,
                wrongAttempts: 0,
                pointsThisRound: 0,
                isFinished: false
            }
        };

        room.players.set(ws.id, player);
        rooms.set(roomCode, room);
        this.clientRooms.set(ws, roomCode);

        this.send(ws, 'ROOM_CREATED', {
            room: this.sanitizeRoomForClient(room),
            playerId: ws.id,
            availablePlaylists: this.getAvailablePlaylistsSummary()
        });
    }

    handleJoinRoom(ws, data) {
        const roomCode = (data.roomCode || '').toUpperCase().trim();
        const playerName = (data.playerName || 'Joueur').trim().substring(0, 20);
        const room = rooms.get(roomCode);

        if (!room) {
            return this.send(ws, 'ERROR', { message: 'Salon introuvable. Vérifiez le code du salon.' });
        }

        if (room.players.size >= 12) {
            return this.send(ws, 'ERROR', { message: 'Ce salon est plein (max 12 joueurs).' });
        }

        const player = {
            id: ws.id,
            name: playerName,
            isHost: false,
            score: 0,
            roundsWon: 0,
            avatar: data.avatar || '🎵',
            ws: ws,
            roundState: {
                hasGuessed: false,
                isCorrect: false,
                guessTime: null,
                skips: 0,
                wrongAttempts: 0,
                pointsThisRound: 0,
                isFinished: false
            }
        };

        room.players.set(ws.id, player);
        this.clientRooms.set(ws, roomCode);

        // Notify the joining player
        this.send(ws, 'ROOM_JOINED', {
            room: this.sanitizeRoomForClient(room),
            playerId: ws.id,
            availablePlaylists: this.getAvailablePlaylistsSummary()
        });

        // Notify everyone else in the room
        this.broadcast(room, 'PLAYER_JOINED', {
            player: this.sanitizePlayer(player),
            room: this.sanitizeRoomForClient(room)
        }, ws);
    }

    handleUpdateSettings(ws, data) {
        const roomCode = this.clientRooms.get(ws);
        const room = rooms.get(roomCode);
        if (!room || room.hostId !== ws.id || room.state !== 'LOBBY') return;

        if (data.playlistKey) {
            room.playlistKey = data.playlistKey;
        }
        if (data.winningRounds) {
            room.winningRounds = Math.max(1, Math.min(20, parseInt(data.winningRounds, 10) || 5));
        }

        this.broadcast(room, 'SETTINGS_UPDATED', {
            room: this.sanitizeRoomForClient(room)
        });
    }

    handleStartGame(ws, data) {
        const roomCode = this.clientRooms.get(ws);
        const room = rooms.get(roomCode);
        if (!room || room.hostId !== ws.id || (room.state !== 'LOBBY' && room.state !== 'MATCH_OVER')) return;

        // Reset scores and rounds
        room.currentRound = 0;
        room.playedSongIds.clear();
        room.players.forEach(p => {
            p.score = 0;
            p.roundsWon = 0;
        });

        this.startNextRound(room);
    }

    handleNextRound(ws, data) {
        const roomCode = this.clientRooms.get(ws);
        const room = rooms.get(roomCode);
        if (!room || room.hostId !== ws.id || room.state !== 'ROUND_OVER') return;

        this.startNextRound(room);
    }

    startNextRound(room) {
        if (room.roundTimer) {
            clearTimeout(room.roundTimer);
            room.roundTimer = null;
        }

        const songPool = getRoomSongs(room);
        if (!songPool || songPool.length === 0) {
            return this.broadcast(room, 'ERROR', { message: 'Aucun son disponible dans cette playlist.' });
        }

        // Pick unplayed song if available
        let availableSongs = songPool.filter(s => s && s.id && !room.playedSongIds.has(s.id));
        if (availableSongs.length === 0) {
            room.playedSongIds.clear();
            availableSongs = songPool;
        }

        const selectedSong = availableSongs[Math.floor(Math.random() * availableSongs.length)];
        room.currentSong = selectedSong;
        if (selectedSong && selectedSong.id) {
            room.playedSongIds.add(selectedSong.id);
        }

        room.currentRound += 1;
        room.state = 'PLAYING';
        room.roundStartTime = Date.now();
        room.roundDuration = 60;

        // Reset round state for all players
        room.players.forEach(p => {
            p.roundState = {
                hasGuessed: false,
                isCorrect: false,
                guessTime: null,
                skips: 0,
                wrongAttempts: 0,
                pointsThisRound: 0,
                isFinished: false
            };
        });

        // Broadcast ROUND_START with masked song info (DO NOT leak title/artist to client!)
        this.broadcast(room, 'ROUND_START', {
            round: room.currentRound,
            winningRounds: room.winningRounds,
            duration: room.roundDuration,
            songAudio: {
                id: selectedSong.id,
                audioPreviewUrl: selectedSong.audioPreviewUrl || null
            },
            room: this.sanitizeRoomForClient(room)
        });

        // Set 60-second round timer
        room.roundTimer = setTimeout(() => {
            this.endRound(room, 'TIME_UP');
        }, (room.roundDuration + 1) * 1000);
    }

    handleSubmitGuess(ws, data) {
        const roomCode = this.clientRooms.get(ws);
        const room = rooms.get(roomCode);
        if (!room || room.state !== 'PLAYING') return;

        const player = room.players.get(ws.id);
        if (!player || player.roundState.isFinished) return;

        const guess = (data.guess || '').trim();
        if (!guess) return;

        const elapsed = (Date.now() - room.roundStartTime) / 1000;
        const isCorrect = checkGuessMatch(guess, room.currentSong);

        if (isCorrect) {
            player.roundState.isCorrect = true;
            player.roundState.hasGuessed = true;
            player.roundState.guessTime = parseFloat(elapsed.toFixed(1));
            player.roundState.pointsThisRound = calculateScore(elapsed, player.roundState.skips, player.roundState.wrongAttempts);
            player.roundState.isFinished = true;
            player.score += player.roundState.pointsThisRound;

            // Notify player of success
            this.send(ws, 'GUESS_RESULT', {
                isCorrect: true,
                points: player.roundState.pointsThisRound,
                guessTime: player.roundState.guessTime,
                guess: guess
            });

            // Notify everyone that this player solved it
            this.broadcast(room, 'PLAYER_GUESSED', {
                playerId: player.id,
                playerName: player.name,
                guessTime: player.roundState.guessTime,
                points: player.roundState.pointsThisRound,
                room: this.sanitizeRoomForClient(room)
            }, ws);

            this.checkAllPlayersFinished(room);
        } else {
            player.roundState.wrongAttempts += 1;
            const totalAttempts = player.roundState.skips + player.roundState.wrongAttempts;

            if (totalAttempts >= 6) {
                player.roundState.isFinished = true;
            }

            this.send(ws, 'GUESS_RESULT', {
                isCorrect: false,
                attemptsUsed: totalAttempts,
                isFinished: player.roundState.isFinished,
                guess: guess
            });

            this.broadcast(room, 'PLAYER_ATTEMPT', {
                playerId: player.id,
                attemptsUsed: totalAttempts,
                isFinished: player.roundState.isFinished,
                room: this.sanitizeRoomForClient(room)
            }, ws);

            if (player.roundState.isFinished) {
                this.checkAllPlayersFinished(room);
            }
        }
    }

    handleSubmitSkip(ws, data) {
        const roomCode = this.clientRooms.get(ws);
        const room = rooms.get(roomCode);
        if (!room || room.state !== 'PLAYING') return;

        const player = room.players.get(ws.id);
        if (!player || player.roundState.isFinished) return;

        player.roundState.skips += 1;
        const totalAttempts = player.roundState.skips + player.roundState.wrongAttempts;

        if (totalAttempts >= 6) {
            player.roundState.isFinished = true;
        }

        this.send(ws, 'SKIP_RESULT', {
            skips: player.roundState.skips,
            attemptsUsed: totalAttempts,
            isFinished: player.roundState.isFinished
        });

        this.broadcast(room, 'PLAYER_SKIPPED', {
            playerId: player.id,
            skips: player.roundState.skips,
            attemptsUsed: totalAttempts,
            isFinished: player.roundState.isFinished,
            room: this.sanitizeRoomForClient(room)
        }, ws);

        if (player.roundState.isFinished) {
            this.checkAllPlayersFinished(room);
        }
    }

    checkAllPlayersFinished(room) {
        if (!room || room.state !== 'PLAYING') return;
        let allFinished = true;
        for (const player of room.players.values()) {
            if (!player.roundState.isFinished) {
                allFinished = false;
                break;
            }
        }

        if (allFinished) {
            // Short delay so last player animations finish smoothly
            setTimeout(() => {
                this.endRound(room, 'ALL_FINISHED');
            }, 800);
        }
    }

    endRound(room, reason) {
        if (!room || room.state !== 'PLAYING') return;
        if (room.roundTimer) {
            clearTimeout(room.roundTimer);
            room.roundTimer = null;
        }

        room.state = 'ROUND_OVER';

        // Determine round winner (fastest correct answer)
        let roundWinner = null;
        let fastestTime = Infinity;

        room.players.forEach(p => {
            if (p.roundState.isCorrect && p.roundState.guessTime < fastestTime) {
                fastestTime = p.roundState.guessTime;
                roundWinner = p;
            }
        });

        if (roundWinner) {
            roundWinner.roundsWon += 1;
        }

        // Check if any player reached the target winning rounds
        let matchWinner = null;
        room.players.forEach(p => {
            if (p.roundsWon >= room.winningRounds) {
                if (!matchWinner || p.score > matchWinner.score) {
                    matchWinner = p;
                }
            }
        });

        if (matchWinner) {
            room.state = 'MATCH_OVER';
        }

        // Reveal the full song details to everyone
        this.broadcast(room, 'ROUND_OVER', {
            reason: reason,
            song: {
                id: room.currentSong.id,
                title: room.currentSong.title,
                artist: room.currentSong.artist,
                original_title: room.currentSong.original_title,
                thumbnail: room.currentSong.thumbnail,
                audioPreviewUrl: room.currentSong.audioPreviewUrl || null
            },
            roundWinner: roundWinner ? this.sanitizePlayer(roundWinner) : null,
            matchWinner: matchWinner ? this.sanitizePlayer(matchWinner) : null,
            room: this.sanitizeRoomForClient(room)
        });
    }

    handleRestartGame(ws, data) {
        const roomCode = this.clientRooms.get(ws);
        const room = rooms.get(roomCode);
        if (!room || room.hostId !== ws.id) return;

        room.state = 'LOBBY';
        room.currentRound = 0;
        room.playedSongIds.clear();
        room.players.forEach(p => {
            p.score = 0;
            p.roundsWon = 0;
            p.roundState = {
                hasGuessed: false,
                isCorrect: false,
                guessTime: null,
                skips: 0,
                wrongAttempts: 0,
                pointsThisRound: 0,
                isFinished: false
            };
        });

        this.broadcast(room, 'GAME_RESTARTED', {
            room: this.sanitizeRoomForClient(room)
        });
    }

    handleDisconnect(ws) {
        const roomCode = this.clientRooms.get(ws);
        if (!roomCode) return;

        this.clientRooms.delete(ws);
        const room = rooms.get(roomCode);
        if (!room) return;

        const leavingPlayer = room.players.get(ws.id);
        room.players.delete(ws.id);

        if (room.players.size === 0) {
            // Delete empty room and clear timer
            if (room.roundTimer) clearTimeout(room.roundTimer);
            rooms.delete(roomCode);
            return;
        }

        // If host left, assign host role to the next player
        if (room.hostId === ws.id) {
            const nextHost = room.players.values().next().value;
            if (nextHost) {
                room.hostId = nextHost.id;
                nextHost.isHost = true;
            }
        }

        // Notify remaining players
        this.broadcast(room, 'PLAYER_LEFT', {
            playerId: ws.id,
            playerName: leavingPlayer ? leavingPlayer.name : 'Un joueur',
            room: this.sanitizeRoomForClient(room)
        });

        // If during gameplay, check if remaining players are finished
        if (room.state === 'PLAYING') {
            this.checkAllPlayersFinished(room);
        }
    }

    sanitizePlayer(player) {
        return {
            id: player.id,
            name: player.name,
            isHost: player.isHost,
            score: player.score,
            roundsWon: player.roundsWon,
            avatar: player.avatar,
            roundState: {
                hasGuessed: player.roundState.hasGuessed,
                isCorrect: player.roundState.isCorrect,
                guessTime: player.roundState.guessTime,
                skips: player.roundState.skips,
                wrongAttempts: player.roundState.wrongAttempts,
                pointsThisRound: player.roundState.pointsThisRound,
                isFinished: player.roundState.isFinished
            }
        };
    }

    sanitizeRoomForClient(room) {
        return {
            code: room.code,
            hostId: room.hostId,
            state: room.state,
            playlistKey: room.playlistKey,
            playlistName: playlists[room.playlistKey] ? playlists[room.playlistKey].name : 'Playlist par défaut',
            winningRounds: room.winningRounds,
            currentRound: room.currentRound,
            roundDuration: room.roundDuration,
            players: Array.from(room.players.values()).map(p => this.sanitizePlayer(p))
        };
    }

    getAvailablePlaylistsSummary() {
        return Object.keys(playlists).map(key => ({
            key: key,
            name: playlists[key].name || key,
            count: playlists[key].songs ? playlists[key].songs.length : 0
        }));
    }
}

module.exports = MultiplayerManager;
