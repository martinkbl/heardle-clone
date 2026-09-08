/**
 * Heardle Unlimited - Hybrid Multiplayer Client Module
 * Standalone Engine for multiplayer.html
 * Supports both WebSocket (Node dev server) and WebRTC PeerJS (Vercel / Static deployments).
 */

(function () {
    'use strict';

    // State
    const MP = {
        transport: null, // 'websocket' | 'webrtc'
        ws: null,
        peer: null,
        peerConnections: new Map(), // connId -> DataConnection
        hostConn: null, // for guests in WebRTC mode
        isConnected: false,
        playerId: 'p_' + Math.random().toString(36).substring(2, 9),
        room: null,
        isHost: false,
        currentRoundData: null,
        roundTimerInterval: null,
        roundSecondsLeft: 60,
        roundDuration: 60,
        availablePlaylists: [],
        playerAvatar: '🎧',
        playerName: localStorage.getItem('heardle_mp_name') || '',
        pendingRoomCodeFromUrl: null,
        p2pRoomState: null // in-browser room state when hosting via WebRTC
    };

    const AVATARS = ['🎧', '🎵', '🔥', '⚡', '👑', '🚀', '🎸', '🎹', '🦊', '🐯', '💎', '⭐'];

    // ==========================================
    // STANDALONE AUDIO ENGINE & YOUTUBE PLAYER
    // ==========================================
    let mpYtPlayer = null;
    let mpYtReady = false;

    function loadMpYouTubeAPI() {
        if (window.YT && window.YT.Player) {
            initMpYTPlayer();
            return;
        }
        if (!document.getElementById('yt-iframe-api-script')) {
            const tag = document.createElement('script');
            tag.id = 'yt-iframe-api-script';
            tag.src = "https://www.youtube.com/iframe_api";
            const first = document.getElementsByTagName('script')[0];
            if (first) first.parentNode.insertBefore(tag, first);
            else document.head.appendChild(tag);
        }
    }

    window.onYouTubeIframeAPIReady = function () {
        initMpYTPlayer();
    };

    function initMpYTPlayer() {
        if (!window.YT || !window.YT.Player) return;
        let host = document.getElementById('globalAudioContainer');
        if (!host) {
            host = document.createElement('div');
            host.id = 'globalAudioContainer';
            host.style.cssText = "position: fixed; bottom: 0; right: 0; width: 160px; height: 120px; opacity: 0.01; pointer-events: none; z-index: -1; overflow: hidden;";
            document.body.appendChild(host);
        }
        let audioEl = document.getElementById('gameAudio');
        if (!audioEl) {
            audioEl = document.createElement('div');
            audioEl.id = 'gameAudio';
            host.appendChild(audioEl);
        }

        try {
            if (mpYtPlayer && mpYtPlayer.destroy) {
                try { mpYtPlayer.destroy(); } catch(e) {}
                audioEl = document.createElement('div');
                audioEl.id = 'gameAudio';
                host.appendChild(audioEl);
            }

            mpYtPlayer = new YT.Player('gameAudio', {
                height: '100%',
                width: '100%',
                playerVars: {
                    'playsinline': 1,
                    'controls': 0,
                    'disablekb': 1,
                    'fs': 0,
                    'autoplay': 0,
                    'origin': window.location.origin
                },
                events: {
                    'onReady': (e) => {
                        mpYtReady = true;
                        try {
                            mpYtPlayer.unMute();
                            mpYtPlayer.setVolume(100);
                        } catch (err) {}
                    },
                    'onError': (e) => console.warn('MP YT Player Error:', e.data)
                }
            });
        } catch (e) {
            console.error('Error creating MP YT Player:', e);
        }
    }

    window.HeardleAudioEngine = {
        activeType: 'youtube',
        currentSong: null,
        htmlAudio: null,
        isPlaying: false,
        playbackTimer: null,
        progressRaf: null,
        checkInterval: null,

        cueSong: function (song) {
            this.stop();
            this.currentSong = song || null;
            if (!song) return;

            if (song.audioPreviewUrl) {
                this.activeType = 'preview';
                if (!this.htmlAudio) this.htmlAudio = new Audio();
                this.htmlAudio.src = song.audioPreviewUrl;
                this.htmlAudio.preload = 'auto';
                this.htmlAudio.currentTime = 0;
                return;
            }

            if (song.id) {
                this.activeType = 'youtube';
                if (mpYtPlayer && typeof mpYtPlayer.cueVideoById === 'function') {
                    try {
                        mpYtPlayer.unMute();
                        mpYtPlayer.setVolume(100);
                        mpYtPlayer.cueVideoById(song.id);
                    } catch (e) {
                        initMpYTPlayer();
                    }
                } else {
                    initMpYTPlayer();
                }
            }
        },

        playSnippet: function (duration, onProgress, onFinish) {
            this.stop();
            this.isPlaying = true;

            if (this.activeType === 'preview' && this.htmlAudio) {
                try {
                    this.htmlAudio.currentTime = 0;
                    const p = this.htmlAudio.play();
                    if (p !== undefined) p.catch(e => console.warn('Preview play error:', e));
                } catch (e) {
                    console.warn('Preview play exception:', e);
                }

                const start = performance.now();
                const step = (timestamp) => {
                    if (!this.isPlaying) return;
                    const elapsed = (timestamp - start) / 1000;
                    const progress = Math.min(elapsed / duration, 1);
                    if (typeof onProgress === 'function') onProgress(progress, elapsed, duration);
                    if (progress < 1) {
                        this.progressRaf = requestAnimationFrame(step);
                    } else {
                        this.stop();
                        if (typeof onFinish === 'function') onFinish();
                    }
                };
                this.progressRaf = requestAnimationFrame(step);

                this.playbackTimer = setTimeout(() => {
                    this.stop();
                    if (typeof onFinish === 'function') onFinish();
                }, duration * 1000);

            } else if (this.activeType === 'youtube') {
                if (!mpYtPlayer || typeof mpYtPlayer.playVideo !== 'function') {
                    initMpYTPlayer();
                    this.isPlaying = false;
                    if (typeof onFinish === 'function') onFinish();
                    return;
                }

                try {
                    mpYtPlayer.unMute();
                    mpYtPlayer.setVolume(100);
                    const videoData = mpYtPlayer.getVideoData ? mpYtPlayer.getVideoData() : null;
                    if (this.currentSong && this.currentSong.id && (!videoData || videoData.video_id !== this.currentSong.id)) {
                        mpYtPlayer.loadVideoById({ videoId: this.currentSong.id, startSeconds: 0 });
                    } else {
                        mpYtPlayer.seekTo(0, true);
                        mpYtPlayer.playVideo();
                    }
                } catch (e) {
                    console.warn('YT playVideo error:', e);
                }

                let playbackStarted = false;
                let start = 0;

                const startSnippetTimer = () => {
                    if (playbackStarted || !this.isPlaying) return;
                    playbackStarted = true;
                    start = performance.now();

                    const step = (timestamp) => {
                        if (!this.isPlaying) return;
                        const elapsed = (timestamp - start) / 1000;
                        const progress = Math.min(elapsed / duration, 1);
                        if (typeof onProgress === 'function') onProgress(progress, elapsed, duration);

                        if (progress < 1) {
                            this.progressRaf = requestAnimationFrame(step);
                        } else {
                            this.stop();
                            if (typeof onFinish === 'function') onFinish();
                        }
                    };
                    this.progressRaf = requestAnimationFrame(step);

                    this.playbackTimer = setTimeout(() => {
                        this.stop();
                        if (typeof onFinish === 'function') onFinish();
                    }, duration * 1000);
                };

                let checks = 0;
                this.checkInterval = setInterval(() => {
                    if (!this.isPlaying) {
                        clearInterval(this.checkInterval);
                        return;
                    }
                    checks++;
                    try {
                        const state = mpYtPlayer.getPlayerState ? mpYtPlayer.getPlayerState() : -1;
                        const time = mpYtPlayer.getCurrentTime ? mpYtPlayer.getCurrentTime() : 0;
                        if (state === 1 || time > 0) {
                            clearInterval(this.checkInterval);
                            startSnippetTimer();
                        } else if (checks >= 25) {
                            clearInterval(this.checkInterval);
                            startSnippetTimer();
                        }
                    } catch (e) {
                        clearInterval(this.checkInterval);
                        startSnippetTimer();
                    }
                }, 100);
            }
        },

        stop: function () {
            this.isPlaying = false;
            if (this.playbackTimer) {
                clearTimeout(this.playbackTimer);
                this.playbackTimer = null;
            }
            if (this.checkInterval) {
                clearInterval(this.checkInterval);
                this.checkInterval = null;
            }
            if (this.progressRaf) {
                cancelAnimationFrame(this.progressRaf);
                this.progressRaf = null;
            }
            if (this.htmlAudio) {
                try {
                    this.htmlAudio.pause();
                    this.htmlAudio.currentTime = 0;
                } catch (e) {}
            }
            if (mpYtPlayer && typeof mpYtPlayer.pauseVideo === 'function') {
                try {
                    mpYtPlayer.pauseVideo();
                    mpYtPlayer.seekTo(0, true);
                } catch (e) {}
            }
        },

        playFull: function () {
            this.isPlaying = true;
            if (this.activeType === 'preview' && this.htmlAudio) {
                this.htmlAudio.play().catch(e => console.warn('Full audio error:', e));
            } else if (mpYtPlayer && typeof mpYtPlayer.playVideo === 'function') {
                try {
                    mpYtPlayer.unMute();
                    mpYtPlayer.setVolume(100);
                    mpYtPlayer.playVideo();
                } catch (e) {}
            }
        },

        pauseFull: function () {
            this.isPlaying = false;
            if (this.htmlAudio) {
                try { this.htmlAudio.pause(); } catch (e) {}
            }
            if (mpYtPlayer && typeof mpYtPlayer.pauseVideo === 'function') {
                try { mpYtPlayer.pauseVideo(); } catch (e) {}
            }
        }
    };

    // ==========================================
    // ALL SEARCHABLE SONGS POOL
    // ==========================================
    function getAllSearchableSongs(roomPlaylistKey = '') {
        const seen = new Set();
        const result = [];

        function addSong(s, priority = 0) {
            if (!s || !s.title) return;
            const key = `${normalizeText(s.artist || '')} - ${normalizeText(s.title || '')}`;
            if (!seen.has(key)) {
                seen.add(key);
                result.push({ ...s, priority });
            }
        }

        // 1. Current room playlist songs (highest priority)
        const plPool = getP2PSongs(roomPlaylistKey || (MP.room ? MP.room.playlistKey : ''));
        if (plPool && Array.isArray(plPool)) {
            plPool.forEach(s => addSong(s, 10));
        }

        // 2. All playlists in window.HEARDLE_PLAYLISTS
        if (window.HEARDLE_PLAYLISTS) {
            Object.keys(window.HEARDLE_PLAYLISTS).forEach(k => {
                const pl = window.HEARDLE_PLAYLISTS[k];
                if (pl && Array.isArray(pl.songs)) {
                    pl.songs.forEach(s => addSong(s, 5));
                }
            });
        }

        // 3. Fallback window.songs / window.HEARDLE_SONGS
        if (window.songs && Array.isArray(window.songs)) {
            window.songs.forEach(s => addSong(s, 3));
        }

        return result;
    }

    // ==========================================
    // URL PARAMS & NAVIGATION
    // ==========================================
    function checkUrlParams() {
        const urlParams = new URLSearchParams(window.location.search);
        const roomCode = urlParams.get('room') || urlParams.get('join');
        if (roomCode) {
            MP.pendingRoomCodeFromUrl = roomCode.toUpperCase().trim();
            setTimeout(() => {
                if (MP.pendingRoomCodeFromUrl) {
                    const joinInput = document.getElementById('mpJoinCodeInput');
                    if (joinInput) joinInput.value = MP.pendingRoomCodeFromUrl;
                    showJoinTab();
                }
            }, 200);
        }
    }

    function setupReturnSoloButton() {
        const btnReturnSolo = document.getElementById('btnReturnSolo');
        if (btnReturnSolo) {
            btnReturnSolo.addEventListener('click', (e) => {
                e.preventDefault();
                if (MP.room && (MP.room.state === 'PLAYING' || MP.room.state === 'ROUND_OVER')) {
                    if (!confirm('Voulez-vous vraiment quitter la partie multijoueur en cours et retourner au mode Solo ?')) {
                        return;
                    }
                }
                window.location.href = '/';
            });
        }
    }

    // ==========================================
    // TRANSPORT (WEBSOCKET / WEBRTC PEERJS)
    // ==========================================
    function initTransport(callback) {
        const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

        if (!isLocalhost && typeof Peer !== 'undefined') {
            MP.transport = 'webrtc';
            MP.isConnected = true;
            updateConnectionStatus(true);
            if (callback) callback();
            return;
        }

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host || 'localhost:3000';
        const wsUrl = `${protocol}//${host}`;

        try {
            MP.ws = new WebSocket(wsUrl);

            const connectTimeout = setTimeout(() => {
                if (!MP.isConnected) {
                    console.log('⚡ WebSocket timeout, switching to WebRTC PeerJS transport...');
                    if (MP.ws) {
                        try { MP.ws.close(); } catch (e) {}
                    }
                    MP.transport = 'webrtc';
                    MP.isConnected = true;
                    updateConnectionStatus(true);
                    if (callback) callback();
                }
            }, 1200);

            MP.ws.onopen = () => {
                clearTimeout(connectTimeout);
                console.log('✅ Connected via WebSocket');
                MP.transport = 'websocket';
                MP.isConnected = true;
                updateConnectionStatus(true);
                if (callback) callback();
            };

            MP.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    handleIncomingMessage(data);
                } catch (e) {
                    console.error('Error parsing MP message:', e);
                }
            };

            MP.ws.onclose = () => {
                if (MP.transport === 'websocket') {
                    MP.isConnected = false;
                    updateConnectionStatus(false);
                }
            };

            MP.ws.onerror = () => {
                clearTimeout(connectTimeout);
                console.log('⚡ WebSocket not available, fallback to WebRTC PeerJS...');
                MP.transport = 'webrtc';
                MP.isConnected = true;
                updateConnectionStatus(true);
                if (callback) callback();
            };
        } catch (e) {
            MP.transport = 'webrtc';
            MP.isConnected = true;
            updateConnectionStatus(true);
            if (callback) callback();
        }
    }

    function send(type, payload = {}) {
        const message = { type, ...payload };

        if (MP.transport === 'websocket' && MP.ws && MP.ws.readyState === WebSocket.OPEN) {
            MP.ws.send(JSON.stringify(message));
        } else if (MP.transport === 'webrtc') {
            handleWebRTCClientSend(message);
        } else {
            initTransport(() => {
                send(type, payload);
            });
        }
    }

    function handleWebRTCClientSend(message) {
        if (MP.isHost && MP.p2pRoomState) {
            handleP2PHostAction(MP.playerId, message);
        } else if (MP.hostConn && MP.hostConn.open) {
            MP.hostConn.send(message);
        } else if (message.type === 'CREATE_ROOM') {
            initP2PHostRoom(message);
        } else if (message.type === 'JOIN_ROOM') {
            initP2PGuestJoin(message);
        }
    }

    function generateCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code = '';
        for (let i = 0; i < 6; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return code;
    }

    function getAvailablePlaylistsList() {
        const plObj = window.HEARDLE_PLAYLISTS || window.playlists || {};
        const keys = Object.keys(plObj);
        if (keys.length > 0) {
            return keys.map(k => ({
                key: k,
                name: plObj[k].name || k,
                count: plObj[k].songs ? plObj[k].songs.length : 0
            }));
        }
        return [
            { key: 'abdoul', name: 'Abdoul', count: 499 },
            { key: 'gustave', name: 'Gustave', count: 641 },
            { key: 'erwan', name: 'Erwan', count: 3198 },
            { key: 'rayane', name: 'Rayane', count: 2314 },
            { key: 'anir', name: 'Anir', count: 312 }
        ];
    }

    function initP2PHostRoom(data) {
        showToast('Création du salon en cours...', 'info');
        const roomCode = generateCode();
        const peerId = 'heardle-v2-' + roomCode.toLowerCase();
        const btnCreate = document.getElementById('btnCreateRoomSubmit');

        if (typeof Peer === 'undefined') {
            showToast('Chargement de PeerJS... Veuillez réessayer dans 2 secondes.', 'error');
            if (btnCreate) {
                btnCreate.disabled = false;
                btnCreate.textContent = 'Créer le salon privé 🚀';
            }
            return;
        }

        try {
            if (MP.peer) {
                try { MP.peer.destroy(); } catch (e) {}
            }

            const hostTimeout = setTimeout(() => {
                if (!MP.p2pRoomState) {
                    if (btnCreate) {
                        btnCreate.disabled = false;
                        btnCreate.textContent = 'Créer le salon privé 🚀';
                    }
                    showToast('Délai d\'attente dépassé pour la création du salon. Veuillez réessayer.', 'error');
                }
            }, 8000);

            MP.peer = new Peer(peerId, {
                debug: 1,
                config: {
                    iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:global.stun.twilio.com:3478' }
                    ]
                }
            });

            MP.peer.on('open', (id) => {
                clearTimeout(hostTimeout);
                console.log('✅ P2P Host Room initialized with ID:', id);
                MP.isHost = true;
                MP.playerId = 'host_' + Math.random().toString(36).substring(2, 7);

                const player = {
                    id: MP.playerId,
                    name: (data.playerName || 'Hôte').trim(),
                    avatar: data.avatar || MP.playerAvatar,
                    isHost: true,
                    score: 0,
                    roundsWon: 0,
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

                MP.p2pRoomState = {
                    code: roomCode,
                    hostId: MP.playerId,
                    state: 'LOBBY',
                    playlistKey: data.playlistKey || 'abdoul',
                    winningRounds: parseInt(data.winningRounds, 10) || 5,
                    currentRound: 0,
                    players: new Map([[MP.playerId, player]]),
                    currentSong: null,
                    roundStartTime: 0,
                    roundDuration: 60,
                    playedSongIds: new Set()
                };

                MP.room = sanitizeP2PRoom(MP.p2pRoomState);
                renderLobbyView();
                showToast(`Salon ${roomCode} créé avec succès !`, 'success');
            });

            MP.peer.on('connection', (conn) => {
                console.log('Incoming guest connection:', conn.peer);
                setupP2PHostConnection(conn);
            });

            MP.peer.on('error', (err) => {
                clearTimeout(hostTimeout);
                console.error('PeerJS Host Error:', err);
                if (btnCreate) {
                    btnCreate.disabled = false;
                    btnCreate.textContent = 'Créer le salon privé 🚀';
                }
                if (err.type === 'unavailable-id') {
                    initP2PHostRoom(data);
                } else {
                    showToast('Erreur de connexion P2P : ' + err.message, 'error');
                }
            });
        } catch (e) {
            console.error('PeerJS init failed:', e);
            if (btnCreate) {
                btnCreate.disabled = false;
                btnCreate.textContent = 'Créer le salon privé 🚀';
            }
            showToast('Erreur lors de la création du salon P2P.', 'error');
        }
    }

    function setupP2PHostConnection(conn) {
        let guestId = null;

        conn.on('open', () => {
            console.log('Data connection opened with guest:', conn.peer);
        });

        conn.on('data', (data) => {
            if (data.type === 'JOIN_ROOM') {
                guestId = 'guest_' + Math.random().toString(36).substring(2, 7);
                MP.peerConnections.set(guestId, conn);

                const guest = {
                    id: guestId,
                    name: (data.playerName || 'Joueur').trim(),
                    avatar: data.avatar || '🎵',
                    isHost: false,
                    score: 0,
                    roundsWon: 0,
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

                MP.p2pRoomState.players.set(guestId, guest);
                MP.room = sanitizeP2PRoom(MP.p2pRoomState);

                conn.send({
                    type: 'ROOM_JOINED',
                    room: MP.room,
                    playerId: guestId
                });

                broadcastP2P({
                    type: 'PLAYER_JOINED',
                    player: guest,
                    room: MP.room
                }, guestId);

                renderLobbyPlayers();
                showToast(`👋 ${guest.name} a rejoint le salon !`);
            } else {
                handleP2PHostAction(guestId, data);
            }
        });

        conn.on('close', () => {
            if (guestId && MP.p2pRoomState && MP.p2pRoomState.players.has(guestId)) {
                const leavingPlayer = MP.p2pRoomState.players.get(guestId);
                MP.p2pRoomState.players.delete(guestId);
                MP.peerConnections.delete(guestId);
                MP.room = sanitizeP2PRoom(MP.p2pRoomState);

                broadcastP2P({
                    type: 'PLAYER_LEFT',
                    playerId: guestId,
                    playerName: leavingPlayer ? leavingPlayer.name : 'Un joueur',
                    room: MP.room
                });

                renderLobbyPlayers();
                showToast(`🚪 ${leavingPlayer ? leavingPlayer.name : 'Un joueur'} a quitté.`);
            }
        });
    }

    function initP2PGuestJoin(data) {
        showToast('Connexion au salon en cours...', 'info');
        const roomCode = (data.roomCode || '').toUpperCase().trim();
        const hostPeerId = 'heardle-v2-' + roomCode.toLowerCase();
        const btnJoin = document.getElementById('btnJoinRoomSubmit');

        if (typeof Peer === 'undefined') {
            showToast('Chargement de PeerJS... Veuillez réessayer dans 2 secondes.', 'error');
            if (btnJoin) {
                btnJoin.disabled = false;
                btnJoin.textContent = 'Rejoindre la partie 🎮';
            }
            return;
        }

        try {
            if (MP.peer) {
                try { MP.peer.destroy(); } catch (e) {}
            }

            const guestTimeout = setTimeout(() => {
                if (!MP.room) {
                    if (btnJoin) {
                        btnJoin.disabled = false;
                        btnJoin.textContent = 'Rejoindre la partie 🎮';
                    }
                    showToast('Délai d\'attente dépassé. Salon introuvable ou inactif.', 'error');
                }
            }, 8000);

            MP.peer = new Peer({
                debug: 1,
                config: {
                    iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:global.stun.twilio.com:3478' }
                    ]
                }
            });

            MP.peer.on('open', (myId) => {
                console.log('Guest peer initialized with ID:', myId);
                const conn = MP.peer.connect(hostPeerId, { reliable: true });
                MP.hostConn = conn;

                conn.on('open', () => {
                    clearTimeout(guestTimeout);
                    console.log('Connected to Host Peer!');
                    conn.send({
                        type: 'JOIN_ROOM',
                        roomCode: roomCode,
                        playerName: data.playerName,
                        avatar: data.avatar
                    });
                });

                conn.on('data', (serverMsg) => {
                    handleIncomingMessage(serverMsg);
                });

                conn.on('close', () => {
                    showToast('Déconnecté du salon (l\'hôte a quitté).', 'error');
                    MP.room = null;
                    renderHubView();
                });

                conn.on('error', (err) => {
                    clearTimeout(guestTimeout);
                    console.error('Guest connection error:', err);
                    if (btnJoin) {
                        btnJoin.disabled = false;
                        btnJoin.textContent = 'Rejoindre la partie 🎮';
                    }
                    showToast('Impossible de rejoindre le salon : ' + err.message, 'error');
                });
            });

            MP.peer.on('error', (err) => {
                clearTimeout(guestTimeout);
                console.error('PeerJS Guest Error:', err);
                if (btnJoin) {
                    btnJoin.disabled = false;
                    btnJoin.textContent = 'Rejoindre la partie 🎮';
                }
                showToast('Erreur : Salon introuvable ou code incorrect.', 'error');
            });
        } catch (e) {
            console.error('Guest join failed:', e);
            if (btnJoin) {
                btnJoin.disabled = false;
                btnJoin.textContent = 'Rejoindre la partie 🎮';
            }
            showToast('Erreur lors de la connexion au salon.', 'error');
        }
    }

    function broadcastP2P(message, excludePlayerId = null) {
        MP.peerConnections.forEach((conn, pid) => {
            if (pid !== excludePlayerId && conn.open) {
                conn.send(message);
            }
        });
    }

    function getP2PSongs(playlistKey) {
        if (window.HEARDLE_PLAYLISTS && window.HEARDLE_PLAYLISTS[playlistKey] && window.HEARDLE_PLAYLISTS[playlistKey].songs) {
            return window.HEARDLE_PLAYLISTS[playlistKey].songs;
        }
        if (window.playlists && window.playlists[playlistKey] && window.playlists[playlistKey].songs) {
            return window.playlists[playlistKey].songs;
        }
        if (window.songs && window.songs.length > 0) {
            return window.songs;
        }
        if (window.HEARDLE_SONGS && window.HEARDLE_SONGS.length > 0) {
            return window.HEARDLE_SONGS;
        }
        return [];
    }

    function normalizeText(str) {
        if (!str) return '';
        return str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
    }

    function checkGuess(guess, song) {
        if (!guess || !song) return false;
        const cleanGuess = normalizeText(guess);
        const cleanTitle = normalizeText(song.title);
        const cleanArtist = normalizeText(song.artist);
        const cleanOriginal = normalizeText(song.original_title || '');

        if (!cleanGuess) return false;
        if (cleanGuess === cleanTitle || (cleanTitle && cleanGuess.includes(cleanTitle))) return true;
        if (cleanOriginal && cleanGuess.includes(cleanOriginal)) return true;
        if (cleanArtist && cleanTitle && cleanGuess.includes(cleanArtist) && cleanGuess.includes(cleanTitle)) return true;
        return false;
    }

    function calcPoints(elapsed, skips, wrongAttempts) {
        const timeRemaining = Math.max(0, 60 - elapsed);
        const speedBonus = Math.floor((timeRemaining / 60) * 500);
        const total = 500 + speedBonus - ((skips || 0) * 100) - ((wrongAttempts || 0) * 50);
        return Math.max(100, total);
    }

    function handleP2PHostAction(senderId, data) {
        const r = MP.p2pRoomState;
        if (!r) return;

        switch (data.type) {
            case 'UPDATE_SETTINGS':
                if (senderId !== r.hostId) return;
                if (data.playlistKey) r.playlistKey = data.playlistKey;
                if (data.winningRounds) r.winningRounds = data.winningRounds;
                MP.room = sanitizeP2PRoom(r);
                broadcastP2P({ type: 'SETTINGS_UPDATED', room: MP.room });
                updateLobbySettingsDisplay();
                break;

            case 'START_GAME':
            case 'NEXT_ROUND':
                if (senderId !== r.hostId) return;
                startP2PRound();
                break;

            case 'SUBMIT_GUESS': {
                const player = r.players.get(senderId);
                if (!player || player.roundState.isFinished || r.state !== 'PLAYING') return;

                const elapsed = (Date.now() - r.roundStartTime) / 1000;
                const isCorrect = checkGuess(data.guess, r.currentSong);

                if (isCorrect) {
                    player.roundState.isCorrect = true;
                    player.roundState.hasGuessed = true;
                    player.roundState.guessTime = parseFloat(elapsed.toFixed(1));
                    player.roundState.pointsThisRound = calcPoints(elapsed, player.roundState.skips, player.roundState.wrongAttempts);
                    player.roundState.isFinished = true;
                    player.score += player.roundState.pointsThisRound;

                    const resultMsg = {
                        type: 'GUESS_RESULT',
                        isCorrect: true,
                        points: player.roundState.pointsThisRound,
                        guessTime: player.roundState.guessTime,
                        guess: data.guess
                    };

                    if (senderId === MP.playerId) {
                        handleIncomingMessage(resultMsg);
                    } else if (MP.peerConnections.has(senderId)) {
                        MP.peerConnections.get(senderId).send(resultMsg);
                    }

                    MP.room = sanitizeP2PRoom(r);
                    const notif = {
                        type: 'PLAYER_GUESSED',
                        playerId: player.id,
                        playerName: player.name,
                        guessTime: player.roundState.guessTime,
                        points: player.roundState.pointsThisRound,
                        room: MP.room
                    };

                    broadcastP2P(notif, senderId);
                    if (senderId !== MP.playerId) handleIncomingMessage(notif);

                    checkP2PAllFinished();
                } else {
                    player.roundState.wrongAttempts += 1;
                    const totalAttempts = player.roundState.skips + player.roundState.wrongAttempts;
                    if (totalAttempts >= 6) player.roundState.isFinished = true;

                    const resultMsg = {
                        type: 'GUESS_RESULT',
                        isCorrect: false,
                        attemptsUsed: totalAttempts,
                        isFinished: player.roundState.isFinished,
                        guess: data.guess
                    };

                    if (senderId === MP.playerId) {
                        handleIncomingMessage(resultMsg);
                    } else if (MP.peerConnections.has(senderId)) {
                        MP.peerConnections.get(senderId).send(resultMsg);
                    }

                    MP.room = sanitizeP2PRoom(r);
                    const notif = {
                        type: 'PLAYER_ATTEMPT',
                        playerId: player.id,
                        attemptsUsed: totalAttempts,
                        isFinished: player.roundState.isFinished,
                        room: MP.room
                    };

                    broadcastP2P(notif, senderId);
                    if (senderId !== MP.playerId) handleIncomingMessage(notif);

                    if (player.roundState.isFinished) checkP2PAllFinished();
                }
                break;
            }

            case 'SUBMIT_SKIP': {
                const player = r.players.get(senderId);
                if (!player || player.roundState.isFinished || r.state !== 'PLAYING') return;

                player.roundState.skips += 1;
                const totalAttempts = player.roundState.skips + player.roundState.wrongAttempts;
                if (totalAttempts >= 6) player.roundState.isFinished = true;

                const resultMsg = {
                    type: 'SKIP_RESULT',
                    skips: player.roundState.skips,
                    attemptsUsed: totalAttempts,
                    isFinished: player.roundState.isFinished
                };

                if (senderId === MP.playerId) {
                    handleIncomingMessage(resultMsg);
                } else if (MP.peerConnections.has(senderId)) {
                    MP.peerConnections.get(senderId).send(resultMsg);
                }

                MP.room = sanitizeP2PRoom(r);
                const notif = {
                    type: 'PLAYER_SKIPPED',
                    playerId: player.id,
                    skips: player.roundState.skips,
                    attemptsUsed: totalAttempts,
                    isFinished: player.roundState.isFinished,
                    room: MP.room
                };

                broadcastP2P(notif, senderId);
                if (senderId !== MP.playerId) handleIncomingMessage(notif);

                if (player.roundState.isFinished) checkP2PAllFinished();
                break;
            }

            case 'RESTART_GAME':
                if (senderId !== r.hostId) return;
                if (window.HeardleAudioEngine) {
                    window.HeardleAudioEngine.stop();
                    window.HeardleAudioEngine.currentSong = null;
                }
                r.state = 'LOBBY';
                r.currentRound = 0;
                r.currentSong = null;
                r.playedSongIds.clear();
                r.players.forEach(p => {
                    p.score = 0;
                    p.roundsWon = 0;
                    p.roundState = { hasGuessed: false, isCorrect: false, guessTime: null, skips: 0, wrongAttempts: 0, pointsThisRound: 0, isFinished: false };
                });
                MP.room = sanitizeP2PRoom(r);
                broadcastP2P({ type: 'GAME_RESTARTED', room: MP.room });
                renderLobbyView();
                break;
        }
    }

    function startP2PRound() {
        const r = MP.p2pRoomState;
        const songPool = getP2PSongs(r.playlistKey);

        if (!songPool || songPool.length === 0) {
            showToast('Aucun son trouvé dans cette playlist.', 'error');
            return;
        }

        let available = songPool.filter(s => s && s.id && !r.playedSongIds.has(s.id));
        if (available.length === 0) {
            r.playedSongIds.clear();
            available = songPool;
        }

        const song = available[Math.floor(Math.random() * available.length)];
        r.currentSong = song;
        if (song && song.id) r.playedSongIds.add(song.id);

        r.currentRound += 1;
        r.state = 'PLAYING';
        r.roundStartTime = Date.now();
        r.roundDuration = 60;

        r.players.forEach(p => {
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

        MP.room = sanitizeP2PRoom(r);

        const roundStartMsg = {
            type: 'ROUND_START',
            round: r.currentRound,
            winningRounds: r.winningRounds,
            duration: r.roundDuration,
            songAudio: {
                id: song.id,
                audioPreviewUrl: song.audioPreviewUrl || null
            },
            room: MP.room
        };

        broadcastP2P(roundStartMsg);
        handleIncomingMessage(roundStartMsg);

        if (r.roundTimer) clearTimeout(r.roundTimer);
        r.roundTimer = setTimeout(() => {
            endP2PRound('TIME_UP');
        }, (r.roundDuration + 1) * 1000);
    }

    function checkP2PAllFinished() {
        const r = MP.p2pRoomState;
        if (!r || r.state !== 'PLAYING') return;

        let allFinished = true;
        r.players.forEach(p => {
            if (!p.roundState.isFinished) allFinished = false;
        });

        if (allFinished) {
            setTimeout(() => { endP2PRound('ALL_FINISHED'); }, 800);
        }
    }

    function endP2PRound(reason) {
        const r = MP.p2pRoomState;
        if (!r || r.state !== 'PLAYING') return;
        if (r.roundTimer) {
            clearTimeout(r.roundTimer);
            r.roundTimer = null;
        }

        r.state = 'ROUND_OVER';

        let roundWinner = null;
        let fastestTime = Infinity;
        r.players.forEach(p => {
            if (p.roundState.isCorrect && p.roundState.guessTime < fastestTime) {
                fastestTime = p.roundState.guessTime;
                roundWinner = p;
            }
        });

        if (roundWinner) roundWinner.roundsWon += 1;

        let matchWinner = null;
        r.players.forEach(p => {
            if (p.roundsWon >= r.winningRounds) {
                if (!matchWinner || p.score > matchWinner.score) matchWinner = p;
            }
        });

        if (matchWinner) r.state = 'MATCH_OVER';

        MP.room = sanitizeP2PRoom(r);

        const roundOverMsg = {
            type: 'ROUND_OVER',
            reason: reason,
            song: {
                id: r.currentSong.id,
                title: r.currentSong.title,
                artist: r.currentSong.artist,
                original_title: r.currentSong.original_title,
                thumbnail: r.currentSong.thumbnail,
                audioPreviewUrl: r.currentSong.audioPreviewUrl || null
            },
            roundWinner: roundWinner,
            matchWinner: matchWinner,
            room: MP.room
        };

        broadcastP2P(roundOverMsg);
        handleIncomingMessage(roundOverMsg);
    }

    function sanitizeP2PRoom(r) {
        const pl = (window.HEARDLE_PLAYLISTS && window.HEARDLE_PLAYLISTS[r.playlistKey]) 
            || (window.playlists && window.playlists[r.playlistKey]) 
            || null;
        return {
            code: r.code,
            hostId: r.hostId,
            state: r.state,
            playlistKey: r.playlistKey,
            playlistName: pl ? (pl.name || r.playlistKey) : r.playlistKey,
            winningRounds: r.winningRounds,
            currentRound: r.currentRound,
            roundDuration: r.roundDuration,
            players: Array.from(r.players.values())
        };
    }

    // ==========================================
    // UI DISPATCHER & EVENT HANDLERS
    // ==========================================
    function handleIncomingMessage(data) {
        const { type } = data;

        switch (type) {
            case 'ROOM_CREATED':
                MP.playerId = data.playerId;
                MP.room = data.room;
                MP.isHost = true;
                MP.availablePlaylists = data.availablePlaylists || [];
                renderLobbyView();
                break;

            case 'ROOM_JOINED':
                MP.playerId = data.playerId;
                MP.room = data.room;
                MP.isHost = (data.room.hostId === data.playerId);
                MP.availablePlaylists = data.availablePlaylists || [];
                renderLobbyView();
                break;

            case 'PLAYER_JOINED':
                MP.room = data.room;
                renderLobbyPlayers();
                showToast(`👋 ${data.player.name} a rejoint la partie !`);
                break;

            case 'PLAYER_LEFT':
                MP.room = data.room;
                MP.isHost = (data.room.hostId === MP.playerId);
                renderLobbyPlayers();
                showToast(`🚪 ${data.playerName} a quitté le salon.`);
                break;

            case 'SETTINGS_UPDATED':
                MP.room = data.room;
                updateLobbySettingsDisplay();
                break;

            case 'ROUND_START':
                handleRoundStart(data);
                break;

            case 'GUESS_RESULT':
                handleGuessResult(data);
                break;

            case 'SKIP_RESULT':
                handleSkipResult(data);
                break;

            case 'PLAYER_GUESSED':
                MP.room = data.room;
                updateLiveLeaderboard();
                showToast(`🎯 ${data.playerName} a trouvé en ${data.guessTime}s (+${data.points} pts) !`, 'success');
                break;

            case 'PLAYER_ATTEMPT':
            case 'PLAYER_SKIPPED':
                MP.room = data.room;
                updateLiveLeaderboard();
                break;

            case 'ROUND_OVER':
                handleRoundOver(data);
                break;

            case 'GAME_RESTARTED':
                if (window.HeardleAudioEngine) {
                    window.HeardleAudioEngine.stop();
                    window.HeardleAudioEngine.currentSong = null;
                }
                if (MP.roundTimerInterval) {
                    clearInterval(MP.roundTimerInterval);
                    MP.roundTimerInterval = null;
                }
                MP.currentRoundData = null;
                MP.room = data.room;
                renderLobbyView();
                showToast('🔄 La partie a été réinitialisée par l\'hôte.');
                break;

            case 'ERROR':
                showToast(`⚠️ ${data.message}`, 'error');
                break;
        }
    }

    function updateConnectionStatus(connected) {
        const dot = document.getElementById('mpConnectionDot');
        const text = document.getElementById('mpConnectionText');
        if (dot) {
            dot.className = connected ? 'connection-dot online' : 'connection-dot offline';
        }
        if (text) {
            text.textContent = connected ? (MP.transport === 'webrtc' ? 'P2P Connecté' : 'En ligne') : 'Hors ligne';
        }
    }

    // Render Hub View
    function renderHubView() {
        if (window.HeardleAudioEngine) {
            window.HeardleAudioEngine.stop();
            window.HeardleAudioEngine.currentSong = null;
        }
        const container = document.getElementById('mpDynamicArea');
        if (!container) return;

        const randomAvatar = AVATARS[Math.floor(Math.random() * AVATARS.length)];
        MP.playerAvatar = MP.playerAvatar || randomAvatar;

        container.innerHTML = `
            <div class="mp-hub-card">
                <div class="mp-hub-header">
                    <div class="mp-hub-icon">👥</div>
                    <h2>Partie Multijoueur Privée</h2>
                    <p>Affrontez vos amis en temps réel sur la même musique. Le plus rapide gagne un maximum de points !</p>
                </div>

                <div class="mp-player-profile-box">
                    <label>Votre Profil</label>
                    <div class="mp-profile-row">
                        <div class="mp-avatar-selector" id="mpAvatarPickerBtn" title="Changer d'avatar">
                            <span id="mpCurrentAvatar">${MP.playerAvatar}</span>
                            <div class="avatar-edit-badge">✏️</div>
                        </div>
                        <input type="text" id="mpPlayerNameInput" class="mp-input" placeholder="Entrez votre pseudo..." value="${escapeHtml(MP.playerName)}" maxlength="20" />
                    </div>
                    <div class="avatar-dropdown hidden" id="mpAvatarDropdown">
                        ${AVATARS.map(av => `<button type="button" class="avatar-btn ${av === MP.playerAvatar ? 'selected' : ''}" data-avatar="${av}">${av}</button>`).join('')}
                    </div>
                </div>

                <div class="mp-hub-tabs">
                    <button type="button" class="mp-tab-btn active" id="tabCreateBtn">Créer un salon</button>
                    <button type="button" class="mp-tab-btn" id="tabJoinBtn">Rejoindre un salon</button>
                </div>

                <!-- Create Room Panel -->
                <div class="mp-tab-panel" id="panelCreateRoom">
                    <div class="mp-form-group">
                        <label for="mpPlaylistSelect">🎵 Playlist à jouer</label>
                        <select id="mpPlaylistSelect" class="mp-select">
                            ${getAvailablePlaylistsList().map(pl => `
                                <option value="${pl.key}">${escapeHtml(pl.name)} (${pl.count} sons)</option>
                            `).join('')}
                        </select>
                    </div>

                    <div class="mp-form-group">
                        <label for="mpWinningRoundsSelect">🏆 Nombre de manches gagnantes</label>
                        <select id="mpWinningRoundsSelect" class="mp-select">
                            <option value="3">Premier à 3 manches</option>
                            <option value="5" selected>Premier à 5 manches (Classique)</option>
                            <option value="7">Premier à 7 manches</option>
                            <option value="10">Premier à 10 manches (Marathon)</option>
                        </select>
                    </div>

                    <button type="button" class="mp-action-btn primary" id="btnCreateRoomSubmit">
                        Créer le salon privé 🚀
                    </button>
                </div>

                <!-- Join Room Panel -->
                <div class="mp-tab-panel hidden" id="panelJoinRoom">
                    <div class="mp-form-group">
                        <label for="mpJoinCodeInput">🔑 Code du salon (6 lettres)</label>
                        <input type="text" id="mpJoinCodeInput" class="mp-input code-input" placeholder="Ex: HEARDL" maxlength="6" value="${MP.pendingRoomCodeFromUrl || ''}" />
                    </div>

                    <button type="button" class="mp-action-btn primary" id="btnJoinRoomSubmit">
                        Rejoindre la partie 🎮
                    </button>
                </div>
            </div>
        `;

        setupHubEventListeners();
    }

    function setupHubEventListeners() {
        const nameInput = document.getElementById('mpPlayerNameInput');
        if (nameInput) {
            nameInput.addEventListener('input', (e) => {
                MP.playerName = e.target.value.trim();
                localStorage.setItem('heardle_mp_name', MP.playerName);
            });
        }

        const avatarPickerBtn = document.getElementById('mpAvatarPickerBtn');
        const avatarDropdown = document.getElementById('mpAvatarDropdown');
        if (avatarPickerBtn && avatarDropdown) {
            avatarPickerBtn.addEventListener('click', () => {
                avatarDropdown.classList.toggle('hidden');
            });

            avatarDropdown.querySelectorAll('.avatar-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const av = btn.getAttribute('data-avatar');
                    MP.playerAvatar = av;
                    document.getElementById('mpCurrentAvatar').textContent = av;
                    avatarDropdown.querySelectorAll('.avatar-btn').forEach(b => b.classList.remove('selected'));
                    btn.classList.add('selected');
                    avatarDropdown.classList.add('hidden');
                });
            });
        }

        const tabCreate = document.getElementById('tabCreateBtn');
        const tabJoin = document.getElementById('tabJoinBtn');
        if (tabCreate && tabJoin) {
            tabCreate.addEventListener('click', showCreateTab);
            tabJoin.addEventListener('click', showJoinTab);
        }

        const btnCreate = document.getElementById('btnCreateRoomSubmit');
        if (btnCreate) {
            btnCreate.addEventListener('click', () => {
                const name = (document.getElementById('mpPlayerNameInput')?.value || '').trim() || 'Hôte';
                MP.playerName = name;
                localStorage.setItem('heardle_mp_name', name);

                const playlistKey = document.getElementById('mpPlaylistSelect')?.value || 'abdoul';
                const winningRounds = parseInt(document.getElementById('mpWinningRoundsSelect')?.value, 10) || 5;

                btnCreate.disabled = true;
                btnCreate.textContent = 'Création en cours...';

                send('CREATE_ROOM', {
                    playerName: name,
                    avatar: MP.playerAvatar,
                    playlistKey: playlistKey,
                    winningRounds: winningRounds
                });
            });
        }

        const btnJoin = document.getElementById('btnJoinRoomSubmit');
        if (btnJoin) {
            btnJoin.addEventListener('click', () => {
                const name = (document.getElementById('mpPlayerNameInput')?.value || '').trim() || 'Joueur';
                MP.playerName = name;
                localStorage.setItem('heardle_mp_name', name);

                const code = (document.getElementById('mpJoinCodeInput')?.value || '').trim().toUpperCase();
                if (!code || code.length < 3) {
                    showToast('Veuillez saisir un code de salon valide.', 'error');
                    return;
                }

                btnJoin.disabled = true;
                btnJoin.textContent = 'Connexion...';

                send('JOIN_ROOM', {
                    roomCode: code,
                    playerName: name,
                    avatar: MP.playerAvatar
                });
            });
        }
    }

    function showCreateTab() {
        document.getElementById('tabCreateBtn')?.classList.add('active');
        document.getElementById('tabJoinBtn')?.classList.remove('active');
        document.getElementById('panelCreateRoom')?.classList.remove('hidden');
        document.getElementById('panelJoinRoom')?.classList.add('hidden');
    }

    function showJoinTab() {
        document.getElementById('tabJoinBtn')?.classList.add('active');
        document.getElementById('tabCreateBtn')?.classList.remove('active');
        document.getElementById('panelJoinRoom')?.classList.remove('hidden');
        document.getElementById('panelCreateRoom')?.classList.add('hidden');
    }

    // Render Lobby View
    function renderLobbyView() {
        if (window.HeardleAudioEngine) {
            window.HeardleAudioEngine.stop();
            window.HeardleAudioEngine.currentSong = null;
        }
        const container = document.getElementById('mpDynamicArea');
        if (!container || !MP.room) return;

        const baseUrl = window.location.origin.includes('localhost') 
            ? window.location.origin 
            : (window.location.origin || 'https://heardle-clone-delta.vercel.app');
        const shareUrl = `${baseUrl}/multiplayer.html?room=${MP.room.code}`;

        container.innerHTML = `
            <div class="mp-lobby-card">
                <div class="mp-lobby-header">
                    <div class="room-code-badge">
                        <span class="label">SALON PRIVÉ</span>
                        <span class="code">${MP.room.code}</span>
                    </div>
                    <div class="share-link-row">
                        <input type="text" class="mp-share-url-input" value="${shareUrl}" readonly id="mpShareUrlInput" />
                        <button type="button" class="mp-copy-btn" id="mpCopyLinkBtn">
                            📋 Copier le lien
                        </button>
                    </div>
                </div>

                <div class="mp-lobby-settings-box">
                    <div class="settings-col">
                        <span class="setting-label">🎵 Playlist</span>
                        ${MP.isHost ? `
                            <select id="mpLobbyPlaylistSelect" class="mp-select compact">
                                ${getAvailablePlaylistsList().map(pl => `
                                    <option value="${pl.key}" ${MP.room.playlistKey === pl.key ? 'selected' : ''}>${escapeHtml(pl.name)}</option>
                                `).join('')}
                            </select>
                        ` : `
                            <span class="setting-val">${escapeHtml(MP.room.playlistName || 'Abdoul')}</span>
                        `}
                    </div>
                    <div class="settings-col">
                        <span class="setting-label">🏆 Manches gagnantes</span>
                        ${MP.isHost ? `
                            <select id="mpLobbyWinningSelect" class="mp-select compact">
                                <option value="3" ${MP.room.winningRounds === 3 ? 'selected' : ''}>3 manches</option>
                                <option value="5" ${MP.room.winningRounds === 5 ? 'selected' : ''}>5 manches</option>
                                <option value="7" ${MP.room.winningRounds === 7 ? 'selected' : ''}>7 manches</option>
                                <option value="10" ${MP.room.winningRounds === 10 ? 'selected' : ''}>10 manches</option>
                            </select>
                        ` : `
                            <span class="setting-val">Premier à ${MP.room.winningRounds} points</span>
                        `}
                    </div>
                </div>

                <div class="mp-lobby-players-section">
                    <h3>Joueurs connectés (<span id="mpPlayerCount">${MP.room.players.length}</span>/12)</h3>
                    <div class="mp-players-grid" id="mpLobbyPlayersGrid"></div>
                </div>

                <div class="mp-lobby-footer">
                    <button type="button" class="mp-action-btn secondary" id="mpLeaveRoomBtn">
                        Quitter le salon
                    </button>

                    ${MP.isHost ? `
                        <button type="button" class="mp-action-btn primary large glow" id="mpStartGameBtn">
                            Lancer la partie 🚀
                        </button>
                    ` : `
                        <div class="mp-waiting-text">
                            <div class="spinner-dot"></div>
                            <span>En attente du lancement par l'hôte...</span>
                        </div>
                    `}
                </div>
            </div>
        `;

        renderLobbyPlayers();
        setupLobbyEventListeners(shareUrl);
    }

    function renderLobbyPlayers() {
        const grid = document.getElementById('mpLobbyPlayersGrid');
        const countSpan = document.getElementById('mpPlayerCount');
        if (!grid || !MP.room) return;

        if (countSpan) countSpan.textContent = MP.room.players.length;

        grid.innerHTML = MP.room.players.map(p => `
            <div class="mp-player-card ${p.id === MP.playerId ? 'me' : ''}">
                <div class="player-avatar">${p.avatar || '🎧'}</div>
                <div class="player-info">
                    <span class="player-name">${escapeHtml(p.name)} ${p.id === MP.playerId ? '(Vous)' : ''}</span>
                    <span class="player-role">${p.isHost ? '👑 Hôte' : 'Joueur'}</span>
                </div>
                <div class="player-status-badge ready">Prêt</div>
            </div>
        `).join('');
    }

    function updateLobbySettingsDisplay() {
        const playlistVal = document.querySelector('.setting-val');
        if (playlistVal && !MP.isHost) {
            playlistVal.textContent = MP.room.playlistName || 'Abdoul';
        }
    }

    function setupLobbyEventListeners(shareUrl) {
        const copyBtn = document.getElementById('mpCopyLinkBtn');
        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                navigator.clipboard.writeText(shareUrl).then(() => {
                    copyBtn.textContent = '✅ Lien copié !';
                    setTimeout(() => { copyBtn.textContent = '📋 Copier le lien'; }, 2000);
                    showToast('Lien de la partie copié dans le presse-papier !', 'success');
                }).catch(() => {
                    showToast(`Copiez ce lien : ${shareUrl}`);
                });
            });
        }

        const playlistSelect = document.getElementById('mpLobbyPlaylistSelect');
        const winningSelect = document.getElementById('mpLobbyWinningSelect');

        if (playlistSelect && MP.isHost) {
            playlistSelect.addEventListener('change', (e) => {
                send('UPDATE_SETTINGS', { playlistKey: e.target.value });
            });
        }

        if (winningSelect && MP.isHost) {
            winningSelect.addEventListener('change', (e) => {
                send('UPDATE_SETTINGS', { winningRounds: parseInt(e.target.value, 10) });
            });
        }

        const startBtn = document.getElementById('mpStartGameBtn');
        if (startBtn && MP.isHost) {
            startBtn.addEventListener('click', () => {
                startBtn.disabled = true;
                startBtn.textContent = 'Lancement en cours...';
                send('START_GAME');
            });
        }

        const leaveBtn = document.getElementById('mpLeaveRoomBtn');
        if (leaveBtn) {
            leaveBtn.addEventListener('click', () => {
                send('LEAVE_ROOM');
                MP.room = null;
                MP.isHost = false;
                renderHubView();
            });
        }
    }

    // ==========================================
    // IN-GAME ROUND & CIRCULAR TIMER
    // ==========================================
    function handleRoundStart(data) {
        MP.currentRoundData = data;
        MP.room = data.room;
        MP.roundDuration = data.duration || 60;
        MP.roundSecondsLeft = MP.roundDuration;
        MP.currentAttempt = 1;

        if (window.HeardleAudioEngine && data.songAudio) {
            window.HeardleAudioEngine.cueSong(data.songAudio);
        }

        const container = document.getElementById('mpDynamicArea');
        if (!container) return;

        container.innerHTML = `
            <div class="mp-gameplay-container">
                <div class="mp-gameplay-header">
                    <div class="mp-round-badge">
                        Manche <span class="highlight">${data.round}</span> • Premier à <span class="highlight">${data.winningRounds}</span> ⭐
                    </div>

                    <div class="circular-timer-container">
                        <svg class="circular-timer-svg" viewBox="0 0 100 100">
                            <circle class="timer-bg-circle" cx="50" cy="50" r="44"></circle>
                            <circle class="timer-progress-circle" id="mpTimerCircle" cx="50" cy="50" r="44"></circle>
                        </svg>
                        <div class="timer-text-content">
                            <span class="timer-number" id="mpTimerNumber">${MP.roundSecondsLeft}</span>
                            <span class="timer-unit">sec</span>
                        </div>
                    </div>

                    <div class="mp-scoring-info-tip">
                        ⚡ Répondez vite pour maximiser vos points ! (-100 pts par skip)
                    </div>
                </div>

                <div class="mp-game-arena">
                    <div class="mp-player-board">
                        <div class="mp-game-stats">
                            <span>Tentative: <span id="mpCurrentAttempt">1</span>/6</span>
                            <span>Extrait: <span id="mpClipLength">1</span>s</span>
                            <span id="mpSongSource">Source: ${escapeHtml(data.room.playlistName || 'Multijoueur')}</span>
                        </div>

                        <div class="mp-answer-boxes" id="mpAnswerBoxes">
                            <div class="answer-box current" data-attempt="1"><div class="attempt-number">1</div></div>
                            <div class="answer-box" data-attempt="2"><div class="attempt-number">2</div></div>
                            <div class="answer-box" data-attempt="3"><div class="attempt-number">3</div></div>
                            <div class="answer-box" data-attempt="4"><div class="attempt-number">4</div></div>
                            <div class="answer-box" data-attempt="5"><div class="attempt-number">5</div></div>
                            <div class="answer-box" data-attempt="6"><div class="attempt-number">6</div></div>
                        </div>

                        <p class="instruction-text" id="mpInstructionText">Écoutez l'extrait et devinez le titre ou l'artiste !</p>

                        <div class="audio-player">
                            <div class="progress-container" id="mpProgressContainer">
                                <div class="progress-bar" id="mpProgressBar"></div>
                            </div>
                            <div class="time-display">
                                <span id="mpCurrentTime">0:00</span>
                                <span id="mpTotalTime">0:01</span>
                            </div>
                            <button type="button" class="play-button" id="mpPlayButton" title="Jouer / Pause (Espace)">▶</button>
                        </div>

                        <div class="search-container">
                            <input type="text" class="search-input" placeholder="Titre ou artiste... (Touche D pour chercher)" id="mpSearchInput" autocomplete="off" spellcheck="false" />
                            <button type="button" class="clear-button" id="mpClearButton">✕</button>
                            <div class="autocomplete-dropdown hidden" id="mpAutocompleteDropdown"></div>
                        </div>

                        <div class="action-buttons">
                            <button type="button" class="action-button skip-button" id="mpSkipButton" title="Passer la tentative (Touche S)">SKIP (+1s)</button>
                            <button type="button" class="action-button submit-button" id="mpSubmitButton" title="Valider la réponse (Entrée)">VALIDER</button>
                        </div>

                        <!-- Shortcuts legend matching index.html -->
                        <div class="shortcuts-legend" style="display: flex; justify-content: center; gap: 14px; font-size: 12px; color: #888; margin-top: 10px;">
                            <span class="shortcut-item"><kbd class="kbd-key" style="background: #282828; border: 1px solid #444; padding: 2px 5px; border-radius: 3px; font-size: 11px;">Space</kbd> Play/Pause</span>
                            <span class="shortcut-item"><kbd class="kbd-key" style="background: #282828; border: 1px solid #444; padding: 2px 5px; border-radius: 3px; font-size: 11px;">S</kbd> Passer</span>
                            <span class="shortcut-item"><kbd class="kbd-key" style="background: #282828; border: 1px solid #444; padding: 2px 5px; border-radius: 3px; font-size: 11px;">D</kbd> Recherche</span>
                        </div>

                        <div class="mp-solved-banner hidden" id="mpSolvedBanner">
                            <div class="solved-icon">🎉</div>
                            <div class="solved-text">
                                <h4>Bien joué !</h4>
                                <p id="mpSolvedDetails">Réponse enregistrée. En attente des autres joueurs...</p>
                            </div>
                        </div>
                    </div>

                    <div class="mp-live-scoreboard">
                        <div class="scoreboard-header">
                            <h4>Classement en direct</h4>
                        </div>
                        <div class="scoreboard-list" id="mpLiveScoreboardList"></div>
                    </div>
                </div>
            </div>
        `;

        setupGameplayControls(data.songAudio);
        startCircularTimer(MP.roundDuration);
        updateLiveLeaderboard();
    }

    function startCircularTimer(durationSeconds) {
        if (MP.roundTimerInterval) clearInterval(MP.roundTimerInterval);

        const circle = document.getElementById('mpTimerCircle');
        const numberSpan = document.getElementById('mpTimerNumber');
        const totalCircumference = 2 * Math.PI * 44;

        if (circle) {
            circle.style.strokeDasharray = `${totalCircumference}`;
            circle.style.strokeDashoffset = '0';
        }

        const startTime = Date.now();

        MP.roundTimerInterval = setInterval(() => {
            const elapsed = (Date.now() - startTime) / 1000;
            const remaining = Math.max(0, Math.ceil(durationSeconds - elapsed));
            MP.roundSecondsLeft = remaining;

            if (numberSpan) numberSpan.textContent = remaining;

            if (circle) {
                const fraction = Math.max(0, (durationSeconds - elapsed) / durationSeconds);
                const offset = totalCircumference * (1 - fraction);
                circle.style.strokeDashoffset = `${offset}`;

                if (remaining <= 10) {
                    circle.style.stroke = '#ef4444';
                    circle.classList.add('urgent-pulse');
                } else if (remaining <= 25) {
                    circle.style.stroke = '#f59e0b';
                    circle.classList.remove('urgent-pulse');
                } else {
                    circle.style.stroke = '#1db954';
                    circle.classList.remove('urgent-pulse');
                }
            }

            if (remaining <= 0) {
                clearInterval(MP.roundTimerInterval);
                MP.roundTimerInterval = null;
            }
        }, 100);
    }

    function updateLiveLeaderboard() {
        const list = document.getElementById('mpLiveScoreboardList');
        if (!list || !MP.room) return;

        const sortedPlayers = [...MP.room.players].sort((a, b) => b.score - a.score);

        list.innerHTML = sortedPlayers.map((p, idx) => {
            let statusHtml = '';
            if (p.roundState.isCorrect) {
                statusHtml = `<span class="status-tag correct">✅ Trouvé (${p.roundState.guessTime}s)</span>`;
            } else if (p.roundState.isFinished) {
                statusHtml = `<span class="status-tag failed">❌ Éliminé</span>`;
            } else if (p.roundState.skips > 0) {
                statusHtml = `<span class="status-tag skipped">⏭️ Skip (${p.roundState.skips})</span>`;
            } else {
                statusHtml = `<span class="status-tag listening">🎧 Écoute...</span>`;
            }

            const stars = '⭐'.repeat(p.roundsWon || 0);

            return `
                <div class="mp-score-row ${p.id === MP.playerId ? 'me' : ''}">
                    <div class="score-rank">#${idx + 1}</div>
                    <div class="score-avatar">${p.avatar || '🎧'}</div>
                    <div class="score-details">
                        <div class="score-name-row">
                            <span class="score-player-name">${escapeHtml(p.name)}</span>
                            <span class="score-stars">${stars}</span>
                        </div>
                        <div class="score-sub-row">
                            <span class="score-points">${p.score} pts</span>
                            ${statusHtml}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    function setupGameplayControls(songAudio) {
        const snippetDurations = [1, 2, 4, 7, 11, 16];
        MP.currentAttempt = 1;
        let isPlaying = false;

        const playBtn = document.getElementById('mpPlayButton');
        const progressBar = document.getElementById('mpProgressBar');
        const currentTimeDisplay = document.getElementById('mpCurrentTime');
        const totalTimeDisplay = document.getElementById('mpTotalTime');
        const searchInput = document.getElementById('mpSearchInput');
        const clearBtn = document.getElementById('mpClearButton');
        const skipBtn = document.getElementById('mpSkipButton');
        const submitBtn = document.getElementById('mpSubmitButton');

        if (window.HeardleAudioEngine && songAudio) {
            window.HeardleAudioEngine.cueSong(songAudio);
        }

        window.mpPlaySnippet = function () {
            if (isPlaying) {
                if (window.HeardleAudioEngine) window.HeardleAudioEngine.stop();
                isPlaying = false;
                if (playBtn) playBtn.textContent = '▶';
                if (progressBar) progressBar.style.width = '0%';
                if (currentTimeDisplay) currentTimeDisplay.textContent = '0:00';
                return;
            }

            const attempt = Math.min(Math.max(MP.currentAttempt || 1, 1), 6);
            const duration = snippetDurations[attempt - 1] || 1;
            isPlaying = true;
            if (playBtn) playBtn.textContent = '⏸';

            if (window.HeardleAudioEngine) {
                window.HeardleAudioEngine.playSnippet(
                    duration,
                    function (progress, elapsed) {
                        if (progressBar) progressBar.style.width = `${progress * 100}%`;
                        if (currentTimeDisplay) {
                            currentTimeDisplay.textContent = `0:${Math.floor(elapsed).toString().padStart(2, '0')}`;
                        }
                    },
                    function () {
                        isPlaying = false;
                        if (playBtn) playBtn.textContent = '▶';
                        if (progressBar) progressBar.style.width = '0%';
                        if (currentTimeDisplay) currentTimeDisplay.textContent = '0:00';
                    }
                );
            }
        };

        if (playBtn) playBtn.addEventListener('click', window.mpPlaySnippet);

        if (clearBtn && searchInput) {
            clearBtn.addEventListener('click', () => {
                searchInput.value = '';
                searchInput.focus();
            });
        }

        function submitGuess() {
            if (!searchInput) return;
            const guess = searchInput.value.trim();
            if (!guess) return;

            if (window.HeardleAudioEngine) window.HeardleAudioEngine.stop();
            isPlaying = false;
            if (playBtn) playBtn.textContent = '▶';
            if (progressBar) progressBar.style.width = '0%';
            if (currentTimeDisplay) currentTimeDisplay.textContent = '0:00';

            send('SUBMIT_GUESS', { guess: guess });
            searchInput.value = '';
        }

        function submitSkip() {
            if (window.HeardleAudioEngine) window.HeardleAudioEngine.stop();
            isPlaying = false;
            if (playBtn) playBtn.textContent = '▶';
            if (progressBar) progressBar.style.width = '0%';
            if (currentTimeDisplay) currentTimeDisplay.textContent = '0:00';

            send('SUBMIT_SKIP');
        }

        if (submitBtn) submitBtn.addEventListener('click', submitGuess);
        if (skipBtn) skipBtn.addEventListener('click', submitSkip);

        if (searchInput) {
            searchInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') submitGuess();
            });
        }

        setupAutocomplete(searchInput);
    }

    function handleGuessResult(data) {
        const boxes = document.querySelectorAll('.mp-answer-boxes .answer-box');
        const searchInput = document.getElementById('mpSearchInput');
        const submitBtn = document.getElementById('mpSubmitButton');
        const skipBtn = document.getElementById('mpSkipButton');
        const solvedBanner = document.getElementById('mpSolvedBanner');
        const solvedDetails = document.getElementById('mpSolvedDetails');

        if (data.isCorrect) {
            const currentBox = document.querySelector('.mp-answer-boxes .answer-box.current');
            if (currentBox) {
                currentBox.classList.remove('current');
                currentBox.classList.add('correct');
                currentBox.textContent = `✅ ${data.guess}`;
            }

            if (searchInput) searchInput.disabled = true;
            if (submitBtn) submitBtn.disabled = true;
            if (skipBtn) skipBtn.disabled = true;

            if (solvedBanner) {
                solvedBanner.classList.remove('hidden');
                if (solvedDetails) {
                    solvedDetails.textContent = `Trouvé en ${data.guessTime}s ! Vous gagnez +${data.points} points.`;
                }
            }

            showToast(`🎉 Bravo ! Trouvé en ${data.guessTime}s (+${data.points} pts)`, 'success');
        } else {
            const attemptIdx = (data.attemptsUsed || 1) - 1;
            MP.currentAttempt = attemptIdx + 2;
            if (boxes[attemptIdx]) {
                boxes[attemptIdx].classList.remove('current');
                boxes[attemptIdx].classList.add('incorrect');
                boxes[attemptIdx].textContent = `❌ ${data.guess || 'INCORRECT'}`;
            }

            if (boxes[attemptIdx + 1] && !data.isFinished) {
                boxes[attemptIdx + 1].classList.add('current');
                const attemptSpan = document.getElementById('mpCurrentAttempt');
                const clipSpan = document.getElementById('mpClipLength');
                const totalTimeSpan = document.getElementById('mpTotalTime');
                const durations = [1, 2, 4, 7, 11, 16];

                if (attemptSpan) attemptSpan.textContent = attemptIdx + 2;
                if (clipSpan) clipSpan.textContent = durations[attemptIdx + 1] || 16;
                if (totalTimeSpan) totalTimeSpan.textContent = `0:${(durations[attemptIdx + 1] || 16).toString().padStart(2, '0')}`;
            }

            if (data.isFinished) {
                if (searchInput) searchInput.disabled = true;
                if (submitBtn) submitBtn.disabled = true;
                if (skipBtn) skipBtn.disabled = true;
                showToast('❌ 6 tentatives épuisées ! En attente de la fin de manche.', 'error');
            }
        }
    }

    function handleSkipResult(data) {
        const boxes = document.querySelectorAll('.mp-answer-boxes .answer-box');
        const attemptIdx = (data.attemptsUsed || 1) - 1;
        MP.currentAttempt = attemptIdx + 2;

        if (boxes[attemptIdx]) {
            boxes[attemptIdx].classList.remove('current');
            boxes[attemptIdx].classList.add('skipped');
            boxes[attemptIdx].textContent = 'SKIPPED';
        }

        if (boxes[attemptIdx + 1] && !data.isFinished) {
            boxes[attemptIdx + 1].classList.add('current');
            const attemptSpan = document.getElementById('mpCurrentAttempt');
            const clipSpan = document.getElementById('mpClipLength');
            const totalTimeSpan = document.getElementById('mpTotalTime');
            const durations = [1, 2, 4, 7, 11, 16];

            if (attemptSpan) attemptSpan.textContent = attemptIdx + 2;
            if (clipSpan) clipSpan.textContent = durations[attemptIdx + 1] || 16;
            if (totalTimeSpan) totalTimeSpan.textContent = `0:${(durations[attemptIdx + 1] || 16).toString().padStart(2, '0')}`;
        }

        if (data.isFinished) {
            const searchInput = document.getElementById('mpSearchInput');
            const submitBtn = document.getElementById('mpSubmitButton');
            const skipBtn = document.getElementById('mpSkipButton');
            if (searchInput) searchInput.disabled = true;
            if (submitBtn) submitBtn.disabled = true;
            if (skipBtn) skipBtn.disabled = true;
        }
    }

    // ==========================================
    // MULTIPLAYER AUTOCOMPLETE
    // ==========================================
    function highlightMatch(text, query) {
        if (!query || !text) return escapeHtml(text || '');
        const normText = normalizeText(text);
        const normQuery = normalizeText(query);
        const index = normText.indexOf(normQuery);
        if (index === -1) return escapeHtml(text);

        const before = text.slice(0, index);
        const match = text.slice(index, index + query.length);
        const after = text.slice(index + query.length);
        return `${escapeHtml(before)}<span class="autocomplete-highlight">${escapeHtml(match)}</span>${escapeHtml(after)}`;
    }

    function setupAutocomplete(inputEl) {
        if (!inputEl) return;
        const dropdown = document.getElementById('mpAutocompleteDropdown');
        if (!dropdown) return;

        let activeSuggestionIndex = -1;
        let currentSuggestions = [];

        function updateSuggestions() {
            const query = inputEl.value.trim();
            const normQuery = normalizeText(query);
            activeSuggestionIndex = -1;

            if (normQuery.length === 0) {
                dropdown.classList.add('hidden');
                dropdown.innerHTML = '';
                currentSuggestions = [];
                return;
            }

            const allSongs = getAllSearchableSongs(MP.room ? MP.room.playlistKey : '');
            const queryWords = normQuery.split(' ').filter(w => w.length > 0);
            const matches = [];

            for (const s of allSongs) {
                const titleNorm = normalizeText(s.title);
                const artistNorm = normalizeText(s.artist);
                const originalTitleNorm = normalizeText(s.original_title || '');
                const fullTextNorm = `${artistNorm} ${titleNorm}`;

                let score = -1;
                if (titleNorm === normQuery) score = 1000;
                else if (titleNorm.startsWith(normQuery)) score = 800;
                else if (artistNorm.startsWith(normQuery)) score = 700;
                else if (titleNorm.includes(normQuery)) score = 500;
                else if (artistNorm.includes(normQuery)) score = 400;
                else if (fullTextNorm.includes(normQuery) || originalTitleNorm.includes(normQuery)) score = 300;
                else if (queryWords.every(w => fullTextNorm.includes(w) || originalTitleNorm.includes(w))) score = 200;

                if (score !== -1) {
                    score += (s.priority || 0) * 10;
                    matches.push({ song: s, score });
                }
            }

            matches.sort((a, b) => {
                if (a.score !== b.score) return b.score - a.score;
                return a.song.title.localeCompare(b.song.title);
            });

            currentSuggestions = matches.slice(0, 8).map(m => m.song);

            if (currentSuggestions.length === 0) {
                dropdown.innerHTML = `<div class="autocomplete-no-results">Aucun titre correspondant</div>`;
                dropdown.classList.remove('hidden');
                return;
            }

            dropdown.innerHTML = currentSuggestions.map((song, index) => {
                const highlightedTitle = highlightMatch(song.title, query);
                const highlightedArtist = highlightMatch(song.artist, query);
                return `
                    <div class="autocomplete-item" data-index="${index}">
                        <div class="autocomplete-item-icon">🎵</div>
                        <div class="autocomplete-item-info">
                            <div class="autocomplete-item-title">${highlightedTitle}</div>
                            <div class="autocomplete-item-artist">${highlightedArtist}</div>
                        </div>
                    </div>
                `;
            }).join('');

            dropdown.classList.remove('hidden');
        }

        inputEl.addEventListener('input', updateSuggestions);

        inputEl.addEventListener('keydown', (e) => {
            if (!dropdown.classList.contains('hidden') && currentSuggestions.length > 0) {
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    activeSuggestionIndex = (activeSuggestionIndex + 1) % currentSuggestions.length;
                    highlightActiveSuggestion();
                    return;
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    activeSuggestionIndex = (activeSuggestionIndex - 1 + currentSuggestions.length) % currentSuggestions.length;
                    highlightActiveSuggestion();
                    return;
                } else if (e.key === 'Enter') {
                    if (activeSuggestionIndex >= 0 && currentSuggestions[activeSuggestionIndex]) {
                        e.preventDefault();
                        selectSuggestion(activeSuggestionIndex);
                        return;
                    }
                } else if (e.key === 'Escape') {
                    dropdown.classList.add('hidden');
                    return;
                }
            }
        });

        function highlightActiveSuggestion() {
            dropdown.querySelectorAll('.autocomplete-item').forEach((item, idx) => {
                if (idx === activeSuggestionIndex) {
                    item.classList.add('active');
                    item.scrollIntoView({ block: 'nearest' });
                } else {
                    item.classList.remove('active');
                }
            });
        }

        function selectSuggestion(index) {
            if (index < 0 || index >= currentSuggestions.length) return;
            const chosen = currentSuggestions[index];
            inputEl.value = `${chosen.artist} - ${chosen.title}`;
            dropdown.classList.add('hidden');
            inputEl.focus();
        }

        dropdown.addEventListener('mousedown', (e) => {
            const item = e.target.closest('.autocomplete-item');
            if (item && item.dataset.index !== undefined) {
                e.preventDefault();
                selectSuggestion(parseInt(item.dataset.index, 10));
            }
        });

        document.addEventListener('click', (e) => {
            if (!dropdown.contains(e.target) && e.target !== inputEl) {
                dropdown.classList.add('hidden');
            }
        });
    }

    // ==========================================
    // ROUND OVER & RESULTS
    // ==========================================
    function handleRoundOver(data) {
        if (MP.roundTimerInterval) {
            clearInterval(MP.roundTimerInterval);
            MP.roundTimerInterval = null;
        }

        MP.room = data.room;
        const container = document.getElementById('mpDynamicArea');
        if (!container) return;

        const isMatchOver = (data.room.state === 'MATCH_OVER');

        container.innerHTML = `
            <div class="mp-round-over-card">
                <div class="round-over-header">
                    <h2>${isMatchOver ? '🏆 PARTIE TERMINÉE !' : `Manche ${data.room.currentRound} terminée !`}</h2>
                    <p class="round-winner-line">
                        ${data.roundWinner 
                            ? `🥇 Gagnant de la manche : <strong>${escapeHtml(data.roundWinner.name)}</strong> (${data.roundWinner.roundState.guessTime}s, +${data.roundWinner.roundState.pointsThisRound} pts)`
                            : 'Personne n\'a trouvé le morceau dans le temps imparti !'}
                    </p>
                </div>

                <div class="mp-song-reveal-box">
                    <img src="${data.song.thumbnail || 'https://i.ytimg.com/vi/EUww3qVQVe4/hqdefault.jpg'}" alt="Cover" class="reveal-cover" />
                    <div class="reveal-meta">
                        <span class="reveal-label">LE MORCEAU ÉTAIT :</span>
                        <h3 class="reveal-title">${escapeHtml(data.song.title)}</h3>
                        <p class="reveal-artist">${escapeHtml(data.song.artist)}</p>
                    </div>
                </div>

                <div class="reveal-audio-player">
                    <button type="button" class="reveal-play-btn" id="mpRevealPlayBtn">▶ Écouter le morceau complet</button>
                </div>

                <div class="mp-results-table-box">
                    <table class="mp-scoreboard-table">
                        <thead>
                            <tr>
                                <th>Rang</th>
                                <th>Joueur</th>
                                <th>Temps</th>
                                <th>Pts Manche</th>
                                <th>Score Total</th>
                                <th>Manches</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${data.room.players
                                .sort((a, b) => b.score - a.score)
                                .map((p, idx) => `
                                    <tr class="${p.id === MP.playerId ? 'highlight-row' : ''}">
                                        <td class="rank-col">#${idx + 1}</td>
                                        <td class="player-col">${p.avatar || '🎧'} ${escapeHtml(p.name)}</td>
                                        <td>${p.roundState.isCorrect ? `${p.roundState.guessTime}s` : '—'}</td>
                                        <td class="points-col">+${p.roundState.pointsThisRound || 0}</td>
                                        <td class="total-col"><strong>${p.score}</strong></td>
                                        <td class="stars-col">${'⭐'.repeat(p.roundsWon || 0)}</td>
                                    </tr>
                                `).join('')}
                        </tbody>
                    </table>
                </div>

                <div class="mp-round-over-footer">
                    ${isMatchOver ? `
                        ${MP.isHost ? `
                            <button type="button" class="mp-action-btn primary large glow" id="mpRestartGameBtn">
                                Rejouer dans ce salon 🔄
                            </button>
                        ` : `
                            <p class="waiting-host-msg">En attente de l'hôte pour relancer une partie...</p>
                        `}
                    ` : `
                        ${MP.isHost ? `
                            <button type="button" class="mp-action-btn primary large glow" id="mpNextRoundBtn">
                                Manche suivante ⏭️
                            </button>
                        ` : `
                            <p class="waiting-host-msg">En attente de l'hôte pour passer à la manche suivante...</p>
                        `}
                    `}
                </div>
            </div>
        `;

        setupRoundOverEventListeners(data.song);
    }

    function setupRoundOverEventListeners(song) {
        const playBtn = document.getElementById('mpRevealPlayBtn');
        let isPlayingFull = false;

        if (window.HeardleAudioEngine && song) {
            window.HeardleAudioEngine.cueSong(song);
        }

        if (playBtn) {
            playBtn.addEventListener('click', () => {
                if (isPlayingFull) {
                    if (window.HeardleAudioEngine) window.HeardleAudioEngine.pauseFull();
                    isPlayingFull = false;
                    playBtn.textContent = '▶ Écouter le morceau complet';
                } else {
                    if (window.HeardleAudioEngine) window.HeardleAudioEngine.playFull();
                    isPlayingFull = true;
                    playBtn.textContent = '⏸ Pause';
                }
            });
        }

        const nextRoundBtn = document.getElementById('mpNextRoundBtn');
        if (nextRoundBtn && MP.isHost) {
            nextRoundBtn.addEventListener('click', () => {
                nextRoundBtn.disabled = true;
                nextRoundBtn.textContent = 'Chargement...';
                if (window.HeardleAudioEngine) window.HeardleAudioEngine.stop();
                send('NEXT_ROUND');
            });
        }

        const restartBtn = document.getElementById('mpRestartGameBtn');
        if (restartBtn && MP.isHost) {
            restartBtn.addEventListener('click', () => {
                restartBtn.disabled = true;
                if (window.HeardleAudioEngine) {
                    window.HeardleAudioEngine.stop();
                    window.HeardleAudioEngine.currentSong = null;
                }
                send('RESTART_GAME');
            });
        }
    }

    // Global Keydown shortcuts
    function handleGlobalKeyDown(e) {
        const activeEl = document.activeElement;
        const isTyping = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA');

        if (isTyping) {
            if (e.key === 'Escape') {
                activeEl.blur();
            }
            return;
        }

        if (e.code === 'Space' || e.key === ' ') {
            e.preventDefault();
            if (typeof window.mpPlaySnippet === 'function') window.mpPlaySnippet();
            return;
        }

        if (e.key === 's' || e.key === 'S') {
            e.preventDefault();
            const skipBtn = document.getElementById('mpSkipButton');
            if (skipBtn && !skipBtn.disabled) skipBtn.click();
            return;
        }

        // 'D' or 'd': Focus search input
        if (e.key === 'd' || e.key === 'D') {
            e.preventDefault();
            const search = document.getElementById('mpSearchInput');
            if (search && !search.disabled) search.focus();
            return;
        }
    }

    function showToast(message, type = 'info') {
        let toastContainer = document.getElementById('mpToastContainer');
        if (!toastContainer) {
            toastContainer = document.createElement('div');
            toastContainer.id = 'mpToastContainer';
            toastContainer.className = 'mp-toast-container';
            document.body.appendChild(toastContainer);
        }

        const toast = document.createElement('div');
        toast.className = `mp-toast ${type}`;
        toast.textContent = message;
        toastContainer.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => { toast.remove(); }, 300);
        }, 3500);
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    window.HeardleMP = {
        init: () => {
            loadMpYouTubeAPI();
            initTransport();
            setupReturnSoloButton();
            window.addEventListener('keydown', handleGlobalKeyDown);
            renderHubView();
            checkUrlParams();
        }
    };

    window.addEventListener('DOMContentLoaded', () => {
        window.HeardleMP.init();
    });

})();
