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
                    'onStateChange': (e) => {
                        // Guard: If YouTube starts playing unexpectedly while engine is not playing
                        if (e.data === 1 && window.HeardleAudioEngine && !window.HeardleAudioEngine.isPlaying && !window.HeardleAudioEngine.isFullPlaying) {
                            try {
                                mpYtPlayer.pauseVideo();
                            } catch (err) {}
                        }
                    },
                    'onError': (e) => {
                        console.warn('MP YT Player Error:', e.data);
                        if (window.HeardleAudioEngine && (e.data === 150 || e.data === 101 || e.data === 100 || e.data === 2)) {
                            window.HeardleAudioEngine.handlePlaybackError();
                        }
                    }
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
        isFullPlaying: false,
        playbackTimer: null,
        progressRaf: null,
        checkInterval: null,

        handlePlaybackError: async function () {
            if (!this.currentSong) return;
            let song = this.currentSong;

            // If artist/title missing from songAudio object, look up by id in playlist database
            if (!song.artist || !song.title) {
                const allSongs = (typeof getAllSearchableSongs === 'function') 
                    ? getAllSearchableSongs() 
                    : (window.allSearchableSongs || []);
                const match = allSongs.find(s => s && s.id === song.id);
                if (match) {
                    song.artist = match.artist;
                    song.title = match.title;
                    if (match.audioPreviewUrl && !song.audioPreviewUrl) {
                        song.audioPreviewUrl = match.audioPreviewUrl;
                    }
                }
            }

            console.warn(`[AudioEngine] Video blocked/error for "${song.artist || song.id} - ${song.title || ''}". Trying automatic fallback rescue...`);

            if (song.audioPreviewUrl) {
                this.activeType = 'preview';
                if (!this.htmlAudio) this.htmlAudio = new Audio();
                this.htmlAudio.src = song.audioPreviewUrl;
                this.htmlAudio.preload = 'auto';
                if (this.isPlaying) {
                    this.htmlAudio.currentTime = 0;
                    this.htmlAudio.play().catch(e => console.warn('Preview fallback error:', e));
                }
                return;
            }

            try {
                const cleanArtist = (song.artist || '').replace(/- Topic/gi, '').split(',')[0].trim();
                const cleanTitle = (song.title || '').trim();
                if (!cleanArtist && !cleanTitle) {
                    console.warn('[AudioEngine] Missing artist and title for fallback lookup.');
                    return;
                }
                const res = await fetch(`/api/match?artist=${encodeURIComponent(cleanArtist)}&title=${encodeURIComponent(cleanTitle)}`);
                if (res.ok) {
                    const data = await res.json();
                    if (data.audioPreviewUrl) {
                        song.audioPreviewUrl = data.audioPreviewUrl;
                        this.activeType = 'preview';
                        if (!this.htmlAudio) this.htmlAudio = new Audio();
                        this.htmlAudio.src = data.audioPreviewUrl;
                        this.htmlAudio.preload = 'auto';
                        if (this.isPlaying) {
                            this.htmlAudio.currentTime = 0;
                            this.htmlAudio.play().catch(e => console.warn('Preview fallback error:', e));
                        }
                        return;
                    } else if (data.videoId && data.videoId !== song.id) {
                        song.id = data.videoId;
                        this.activeType = 'youtube';
                        if (this.isPlaying) {
                            if (mpYtPlayer && mpYtPlayer.loadVideoById) {
                                mpYtPlayer.loadVideoById({ videoId: data.videoId, startSeconds: 0 });
                            }
                        } else {
                            if (mpYtPlayer && mpYtPlayer.cueVideoById) {
                                mpYtPlayer.cueVideoById(data.videoId);
                            }
                        }
                        return;
                    }
                }
            } catch (err) {
                console.warn('[AudioEngine] Fallback rescue error:', err);
            }
        },

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
            this.isFullPlaying = false;
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
                    if (mpYtPlayer.getCurrentTime && mpYtPlayer.getCurrentTime() > 0) {
                        mpYtPlayer.seekTo(0, false);
                    }
                } catch (e) {}
            }
        },

        playFull: function () {
            this.isPlaying = true;
            this.isFullPlaying = true;
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
            this.isFullPlaying = false;
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
                    if (!confirm('Are you sure you want to leave the multiplayer match and return to Solo mode?')) {
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

    // ==========================================
    // CUSTOM PLAYLISTS & STORAGE MANAGEMENT
    // ==========================================
    const STORAGE_KEY_V1 = 'heardle_custom_playlists_v1';
    const STORAGE_KEY_OLD = 'heardle_custom_playlists';

    function getSavedCustomPlaylists() {
        try {
            const raw1 = localStorage.getItem(STORAGE_KEY_V1);
            if (raw1) return JSON.parse(raw1);
            const rawOld = localStorage.getItem(STORAGE_KEY_OLD);
            if (rawOld) return JSON.parse(rawOld);
        } catch (e) {
            console.warn('Error reading custom playlists:', e);
        }
        return {};
    }

    function saveCustomPlaylistToStorage(key, playlistObj) {
        try {
            const current = getSavedCustomPlaylists();
            current[key] = playlistObj;
            localStorage.setItem(STORAGE_KEY_V1, JSON.stringify(current));
            localStorage.setItem(STORAGE_KEY_OLD, JSON.stringify(current));
        } catch (e) {
            console.warn('Error saving custom playlist:', e);
        }
    }

    function deleteCustomPlaylistFromStorage(key) {
        try {
            const current = getSavedCustomPlaylists();
            delete current[key];
            localStorage.setItem(STORAGE_KEY_V1, JSON.stringify(current));
            localStorage.setItem(STORAGE_KEY_OLD, JSON.stringify(current));
        } catch (e) {
            console.warn('Error deleting custom playlist:', e);
        }
    }

    function isSpotifyUrl(rawInput) {
        if (!rawInput) return false;
        const str = rawInput.trim().toLowerCase();
        return str.includes('spotify.com') || str.startsWith('spotify:');
    }

    function isDeezerUrl(rawInput) {
        if (!rawInput) return false;
        const str = rawInput.trim().toLowerCase();
        return str.includes('deezer.com') || str.includes('deezer.page.link') || str.includes('dzr.page.link');
    }

    function extractSpotifyPlaylistId(rawInput) {
        if (!rawInput) return '';
        let val = rawInput.trim();
        if (val.includes('/playlist/')) {
            val = val.split('/playlist/')[1];
        } else if (val.includes('spotify:playlist:')) {
            val = val.split('spotify:playlist:')[1];
        }
        if (val.includes('?')) val = val.split('?')[0];
        if (val.includes('&')) val = val.split('&')[0];
        if (val.includes('/')) val = val.split('/')[0];
        if (val.includes('#')) val = val.split('#')[0];
        return val.trim();
    }

    function extractDeezerPlaylistId(rawInput) {
        if (!rawInput) return '';
        let val = rawInput.trim();
        if (val.includes('/playlist/')) {
            val = val.split('/playlist/')[1];
        }
        if (val.includes('?')) val = val.split('?')[0];
        if (val.includes('&')) val = val.split('&')[0];
        if (val.includes('/')) val = val.split('/')[0];
        if (val.includes('#')) val = val.split('#')[0];
        return val.trim();
    }

    function extractYouTubePlaylistId(rawInput) {
        if (!rawInput) return '';
        let val = rawInput.trim();
        if (val.includes('list=')) {
            val = val.split('list=')[1];
        }
        if (val.includes('&')) val = val.split('&')[0];
        if (val.includes('?')) val = val.split('?')[0];
        if (val.includes('#')) val = val.split('#')[0];
        return val.trim();
    }

    async function fetchSpotifyPlaylist(urlOrId, customName = '', onProgress = null) {
        if (onProgress) onProgress('Loading Spotify playlist...');
        const endpoint = `/api/spotify?url=${encodeURIComponent(urlOrId)}`;
        const res = await fetch(endpoint);
        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || `HTTP Error ${res.status}: Failed to load Spotify playlist`);
        }
        const data = await res.json();
        if (!data.songs || data.songs.length === 0) {
            throw new Error('No songs found in this Spotify playlist.');
        }
        return {
            id: data.id,
            name: customName ? customName.trim() : (data.name || 'Spotify Playlist'),
            source: 'spotify',
            songs: data.songs
        };
    }

    async function fetchDeezerPlaylist(urlOrId, customName = '', onProgress = null) {
        if (onProgress) onProgress('Loading Deezer playlist...');
        const endpoint = `/api/deezer?url=${encodeURIComponent(urlOrId)}`;
        const res = await fetch(endpoint);
        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || `HTTP Error ${res.status}: Failed to load Deezer playlist`);
        }
        const data = await res.json();
        if (!data.songs || data.songs.length === 0) {
            throw new Error('No songs found in this Deezer playlist.');
        }
        return {
            id: data.id,
            name: customName ? customName.trim() : (data.name || 'Deezer Playlist'),
            source: 'deezer',
            songs: data.songs
        };
    }

    async function fetchYouTubePlaylistFromBrowser(playlistId, customName = '', onProgress = null) {
        const apiKey = (window.YOUTUBE_CONFIG && window.YOUTUBE_CONFIG.API_KEY) || 'AIzaSyDA4eTxUyaC8s8rHlOp4AjKNqjycDljte4';
        let resolvedName = customName ? customName.trim() : '';

        if (!resolvedName) {
            try {
                const plRes = await fetch(`https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${encodeURIComponent(playlistId)}&key=${encodeURIComponent(apiKey)}`);
                if (plRes.ok) {
                    const plData = await plRes.json();
                    if (plData.items && plData.items[0]?.snippet?.title) {
                        resolvedName = plData.items[0].snippet.title;
                    }
                }
            } catch (e) {}
        }
        if (!resolvedName) resolvedName = `Playlist ${playlistId.slice(0, 8)}`;

        let allSongs = [];
        let nextPageToken = '';
        let pageCount = 0;

        do {
            pageCount++;
            if (onProgress) onProgress(`Loading page ${pageCount}... (${allSongs.length} songs)`);
            const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${encodeURIComponent(playlistId)}&key=${encodeURIComponent(apiKey)}${nextPageToken ? '&pageToken=' + encodeURIComponent(nextPageToken) : ''}`;
            const res = await fetch(url);
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error((errData.error && errData.error.message) ? errData.error.message : `HTTP ${res.status}`);
            }
            const data = await res.json();
            const items = data.items || [];
            if (items.length === 0) break;

            const cleanItems = items.map(item => {
                const snippet = item.snippet || {};
                const videoId = (item.contentDetails && item.contentDetails.videoId) || snippet.resourceId?.videoId || null;
                let title = snippet.title || 'Unknown Title';
                let artist = snippet.videoOwnerChannelTitle || 'Unknown Artist';

                if (title.includes(' - ')) {
                    const parts = title.split(' - ');
                    artist = parts[0].trim();
                    title = parts.slice(1).join(' - ').trim();
                }

                title = title
                    .replace(/[\(\[\{].*?[\)\]\}]/g, '')
                    .replace(/Official Video/gi, '')
                    .replace(/Official Audio/gi, '')
                    .replace(/Lyrics/gi, '')
                    .replace(/ft\./gi, '')
                    .replace(/feat\./gi, '')
                    .replace(/,/g, '')
                    .trim();

                return {
                    id: videoId,
                    title: title,
                    artist: artist,
                    original_title: snippet.title,
                    thumbnail: snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url
                };
            }).filter(s => s.id && s.title !== 'Private video' && s.title !== 'Deleted video');

            allSongs = allSongs.concat(cleanItems);
            nextPageToken = data.nextPageToken;
        } while (nextPageToken && pageCount < 60);

        if (allSongs.length === 0) {
            throw new Error('No playable songs found in this YouTube playlist.');
        }

        return {
            id: playlistId,
            name: resolvedName,
            source: 'youtube',
            songs: allSongs
        };
    }

    let mpModalTargetSelectId = 'mpPlaylistSelect';

    function openCustomPlaylistModal(targetSelectId = 'mpPlaylistSelect') {
        mpModalTargetSelectId = targetSelectId;
        const modal = document.getElementById('mpCustomPlaylistModal');
        if (!modal) return;

        const errorEl = document.getElementById('mpModalErrorText');
        const statusContainer = document.getElementById('mpFetchStatusContainer');
        const urlInput = document.getElementById('mpCustomPlaylistUrlInput');
        const nameInput = document.getElementById('mpCustomPlaylistNameInput');
        const submitBtn = document.getElementById('mpSubmitCustomPlaylistBtn');

        if (errorEl) { errorEl.textContent = ''; errorEl.classList.add('hidden'); }
        if (statusContainer) statusContainer.classList.add('hidden');
        if (urlInput) urlInput.value = '';
        if (nameInput) nameInput.value = '';
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Load Playlist 🚀'; }

        renderSavedPlaylistsInModal();
        modal.classList.remove('hidden');
        setTimeout(() => { if (urlInput) urlInput.focus(); }, 100);
    }

    function closeCustomPlaylistModal() {
        const modal = document.getElementById('mpCustomPlaylistModal');
        if (modal) modal.classList.add('hidden');
    }

    function renderSavedPlaylistsInModal() {
        const container = document.getElementById('mpSavedPlaylistsList');
        if (!container) return;

        const saved = getSavedCustomPlaylists();
        const keys = Object.keys(saved);

        if (keys.length === 0) {
            container.innerHTML = `<div style="color: #666; font-size: 12px; text-align: center; padding: 8px;">No custom playlists saved yet.</div>`;
            return;
        }

        container.innerHTML = keys.map(key => {
            const pl = saved[key];
            let badge = '<span class="playlist-badge yt-badge">YouTube</span>';
            if (pl.source === 'spotify') badge = '<span class="playlist-badge spotify-badge">Spotify</span>';
            else if (pl.source === 'deezer') badge = '<span class="playlist-badge deezer-badge">Deezer</span>';

            return `
                <div class="saved-playlist-row">
                    <div class="saved-playlist-info">
                        <span class="saved-playlist-name">${badge} ${escapeHtml(pl.name)}</span>
                        <span class="saved-playlist-count">${pl.songs ? pl.songs.length : 0} songs</span>
                    </div>
                    <div class="saved-playlist-actions">
                        <button type="button" class="saved-playlist-play-btn" data-key="${key}">Use</button>
                        <button type="button" class="saved-playlist-delete-btn" data-key="${key}" title="Delete playlist">🗑️</button>
                    </div>
                </div>
            `;
        }).join('');

        container.querySelectorAll('.saved-playlist-play-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const key = btn.getAttribute('data-key');
                selectCustomPlaylistByKey(key);
                closeCustomPlaylistModal();
            });
        });

        container.querySelectorAll('.saved-playlist-delete-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const key = btn.getAttribute('data-key');
                deleteCustomPlaylistFromStorage(key);
                renderSavedPlaylistsInModal();
                refreshPlaylistSelectOptions();
                showToast('Playlist deleted successfully.');
            });
        });
    }

    function selectCustomPlaylistByKey(key) {
        const saved = getSavedCustomPlaylists();
        const pl = saved[key];
        if (!pl) return;

        refreshPlaylistSelectOptions(key);

        if (mpModalTargetSelectId === 'mpLobbyPlaylistSelect' && MP.isHost && MP.room) {
            send('UPDATE_SETTINGS', {
                playlistKey: key,
                playlistName: pl.name,
                customSongs: pl.songs
            });
            showToast(`Playlist "${pl.name}" selected for room!`, 'success');
        } else {
            showToast(`Playlist "${pl.name}" selected!`, 'success');
        }
    }

    function refreshPlaylistSelectOptions(selectedKey = '') {
        const hubSelect = document.getElementById('mpPlaylistSelect');
        const lobbySelect = document.getElementById('mpLobbyPlaylistSelect');
        const playlists = getAvailablePlaylistsList();

        const buildOptionsHtml = (currentVal) => {
            return playlists.map(pl => {
                const isSelected = selectedKey ? (pl.key === selectedKey) : (pl.key === currentVal);
                return `<option value="${pl.key}" ${isSelected ? 'selected' : ''}>${escapeHtml(pl.name)} (${pl.count} songs)</option>`;
            }).join('');
        };

        if (hubSelect) hubSelect.innerHTML = buildOptionsHtml(hubSelect.value);
        if (lobbySelect) lobbySelect.innerHTML = buildOptionsHtml(lobbySelect.value);
    }

    async function handleCustomPlaylistSubmit() {
        const urlInput = document.getElementById('mpCustomPlaylistUrlInput');
        const nameInput = document.getElementById('mpCustomPlaylistNameInput');
        const errorEl = document.getElementById('mpModalErrorText');
        const statusContainer = document.getElementById('mpFetchStatusContainer');
        const statusText = document.getElementById('mpFetchStatusText');
        const submitBtn = document.getElementById('mpSubmitCustomPlaylistBtn');

        const rawUrl = (urlInput?.value || '').trim();
        const customName = (nameInput?.value || '').trim();

        if (!rawUrl) {
            if (errorEl) {
                errorEl.textContent = 'Please enter a Spotify, Deezer or YouTube link.';
                errorEl.classList.remove('hidden');
            }
            return;
        }

        if (errorEl) errorEl.classList.add('hidden');
        if (statusContainer) statusContainer.classList.remove('hidden');
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Loading...';
        }

        const updateProgress = (msg) => {
            if (statusText) statusText.textContent = msg;
        };

        try {
            let playlistResult = null;

            if (isSpotifyUrl(rawUrl)) {
                playlistResult = await fetchSpotifyPlaylist(rawUrl, customName, updateProgress);
            } else if (isDeezerUrl(rawUrl)) {
                playlistResult = await fetchDeezerPlaylist(rawUrl, customName, updateProgress);
            } else {
                const ytId = extractYouTubePlaylistId(rawUrl);
                if (ytId && ytId.length >= 8) {
                    playlistResult = await fetchYouTubePlaylistFromBrowser(ytId, customName, updateProgress);
                } else {
                    const spotifyId = extractSpotifyPlaylistId(rawUrl);
                    if (spotifyId && spotifyId.length >= 8) {
                        playlistResult = await fetchSpotifyPlaylist(spotifyId, customName, updateProgress);
                    } else {
                        const deezerId = extractDeezerPlaylistId(rawUrl);
                        if (deezerId && /^\d+$/.test(deezerId)) {
                            playlistResult = await fetchDeezerPlaylist(deezerId, customName, updateProgress);
                        } else {
                            throw new Error('Invalid playlist URL or ID. Please check the link.');
                        }
                    }
                }
            }

            if (!playlistResult || !playlistResult.songs || playlistResult.songs.length === 0) {
                throw new Error('No songs found in this playlist.');
            }

            const storageKey = `custom_${playlistResult.source}_${playlistResult.id}`;
            const playlistObj = {
                id: playlistResult.id,
                name: playlistResult.name,
                source: playlistResult.source,
                isCustom: true,
                songs: playlistResult.songs
            };

            saveCustomPlaylistToStorage(storageKey, playlistObj);
            selectCustomPlaylistByKey(storageKey);
            closeCustomPlaylistModal();

        } catch (err) {
            console.error('Playlist load error:', err);
            if (errorEl) {
                errorEl.textContent = err.message || 'Error loading playlist.';
                errorEl.classList.remove('hidden');
            }
        } finally {
            if (statusContainer) statusContainer.classList.add('hidden');
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Load Playlist 🚀';
            }
        }
    }

    function setupCustomPlaylistModalListeners() {
        const closeBtn = document.getElementById('mpClosePlaylistModalBtn');
        const cancelBtn = document.getElementById('mpCancelPlaylistModalBtn');
        const submitBtn = document.getElementById('mpSubmitCustomPlaylistBtn');
        const modal = document.getElementById('mpCustomPlaylistModal');
        const urlInput = document.getElementById('mpCustomPlaylistUrlInput');

        if (closeBtn) closeBtn.addEventListener('click', closeCustomPlaylistModal);
        if (cancelBtn) cancelBtn.addEventListener('click', closeCustomPlaylistModal);
        if (submitBtn) submitBtn.addEventListener('click', handleCustomPlaylistSubmit);

        if (urlInput) {
            urlInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') handleCustomPlaylistSubmit();
            });
        }

        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) closeCustomPlaylistModal();
            });
        }
    }

    function getAvailablePlaylistsList() {
        const result = [];
        const seenKeys = new Set();

        const plObj = window.HEARDLE_PLAYLISTS || window.playlists || {};
        Object.keys(plObj).forEach(k => {
            seenKeys.add(k);
            result.push({
                key: k,
                name: plObj[k].name || k,
                count: plObj[k].songs ? plObj[k].songs.length : 0,
                isCustom: false,
                songs: plObj[k].songs || []
            });
        });

        if (result.length === 0) {
            [
                { key: 'abdoul', name: 'Abdoul', count: 499 },
                { key: 'gustave', name: 'Gustave', count: 641 },
                { key: 'erwan', name: 'Erwan', count: 3198 },
                { key: 'rayane', name: 'Rayane', count: 2314 },
                { key: 'anir', name: 'Anir', count: 312 }
            ].forEach(p => {
                seenKeys.add(p.key);
                result.push({ ...p, isCustom: false, songs: [] });
            });
        }

        // Custom imported playlists in localStorage
        try {
            const customSaved = getSavedCustomPlaylists();
            Object.keys(customSaved).forEach(k => {
                if (!seenKeys.has(k)) {
                    seenKeys.add(k);
                    const pl = customSaved[k];
                    let icon = '⭐';
                    if (pl.source === 'spotify') icon = '🟢';
                    else if (pl.source === 'deezer') icon = '🟣';
                    else if (pl.source === 'youtube') icon = '🔴';

                    result.push({
                        key: k,
                        name: `${icon} ${pl.name || 'Custom Playlist'}`,
                        count: pl.songs ? pl.songs.length : 0,
                        isCustom: true,
                        songs: pl.songs || []
                    });
                }
            });
        } catch (e) {}

        return result;
    }

    function initP2PHostRoom(data) {
        showToast('Creating room...', 'info');
        const roomCode = generateCode();
        const peerId = 'heardle-v2-' + roomCode.toLowerCase();
        const btnCreate = document.getElementById('btnCreateRoomSubmit');

        if (typeof Peer === 'undefined') {
            showToast('Loading PeerJS... Please try again in 2 seconds.', 'error');
            if (btnCreate) {
                btnCreate.disabled = false;
                btnCreate.textContent = 'Create Private Room 🚀';
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
                        btnCreate.textContent = 'Create Private Room 🚀';
                    }
                    showToast('Room creation timed out. Please try again.', 'error');
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
                    name: (data.playerName || 'Host').trim(),
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
                    playlistName: data.playlistName || null,
                    customSongs: Array.isArray(data.customSongs) && data.customSongs.length > 0 ? data.customSongs : null,
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
                showToast(`Room ${roomCode} created successfully!`, 'success');
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
                    btnCreate.textContent = 'Create Private Room 🚀';
                }
                if (err.type === 'unavailable-id') {
                    initP2PHostRoom(data);
                } else {
                    showToast('P2P connection error: ' + err.message, 'error');
                }
            });
        } catch (e) {
            console.error('PeerJS init failed:', e);
            if (btnCreate) {
                btnCreate.disabled = false;
                btnCreate.textContent = 'Create Private Room 🚀';
            }
            showToast('Error creating P2P room.', 'error');
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
                    name: (data.playerName || 'Player').trim(),
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
                showToast(`👋 ${guest.name} joined the room!`);
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
                    playerName: leavingPlayer ? leavingPlayer.name : 'A player',
                    room: MP.room
                });

                renderLobbyPlayers();
                showToast(`🚪 ${leavingPlayer ? leavingPlayer.name : 'A player'} left.`);
            }
        });
    }

    function initP2PGuestJoin(data) {
        showToast('Connecting to room...', 'info');
        const roomCode = (data.roomCode || '').toUpperCase().trim();
        const hostPeerId = 'heardle-v2-' + roomCode.toLowerCase();
        const btnJoin = document.getElementById('btnJoinRoomSubmit');

        if (typeof Peer === 'undefined') {
            showToast('Loading PeerJS... Please try again in 2 seconds.', 'error');
            if (btnJoin) {
                btnJoin.disabled = false;
                btnJoin.textContent = 'Join Game 🎮';
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
                        btnJoin.textContent = 'Join Game 🎮';
                    }
                    showToast('Connection timed out. Room not found or inactive.', 'error');
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
                    showToast('Disconnected from room (host has left).', 'error');
                    MP.room = null;
                    renderHubView();
                });

                conn.on('error', (err) => {
                    clearTimeout(guestTimeout);
                    console.error('Guest connection error:', err);
                    if (btnJoin) {
                        btnJoin.disabled = false;
                        btnJoin.textContent = 'Join Game 🎮';
                    }
                    showToast('Could not join room: ' + err.message, 'error');
                });
            });

            MP.peer.on('error', (err) => {
                clearTimeout(guestTimeout);
                console.error('PeerJS Guest Error:', err);
                if (btnJoin) {
                    btnJoin.disabled = false;
                    btnJoin.textContent = 'Join Game 🎮';
                }
                showToast('Error: Room not found or invalid code.', 'error');
            });
        } catch (e) {
            console.error('Guest join failed:', e);
            if (btnJoin) {
                btnJoin.disabled = false;
                btnJoin.textContent = 'Join Game 🎮';
            }
            showToast('Error connecting to room.', 'error');
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
        if (MP.room && MP.room.customSongs && Array.isArray(MP.room.customSongs) && MP.room.customSongs.length > 0) {
            return MP.room.customSongs;
        }
        if (MP.p2pRoomState && MP.p2pRoomState.customSongs && Array.isArray(MP.p2pRoomState.customSongs) && MP.p2pRoomState.customSongs.length > 0) {
            return MP.p2pRoomState.customSongs;
        }
        try {
            const customSaved = getSavedCustomPlaylists();
            if (customSaved[playlistKey] && customSaved[playlistKey].songs) {
                return customSaved[playlistKey].songs;
            }
        } catch (e) {}

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
                if (data.playlistName) r.playlistName = data.playlistName;
                if (Array.isArray(data.customSongs) && data.customSongs.length > 0) {
                    r.customSongs = data.customSongs;
                } else if (data.playlistKey && !data.playlistKey.startsWith('custom_')) {
                    r.customSongs = null;
                }
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

    async function startP2PRound() {
        const r = MP.p2pRoomState;
        const songPool = getP2PSongs(r.playlistKey);

        if (!songPool || songPool.length === 0) {
            showToast('No songs found in this playlist.', 'error');
            return;
        }

        let available = songPool.filter(s => {
            if (!s) return false;
            const songKey = s.id || `${normalizeText(s.artist)} - ${normalizeText(s.title)}`;
            return (s.id || s.audioPreviewUrl || (s.title && s.artist)) && !r.playedSongIds.has(songKey);
        });
        if (available.length === 0) {
            r.playedSongIds.clear();
            available = songPool;
        }

        const song = available[Math.floor(Math.random() * available.length)];
        r.currentSong = song;
        const songKey = song.id || `${normalizeText(song.artist)} - ${normalizeText(song.title)}`;
        r.playedSongIds.add(songKey);

        if ((!song.audioPreviewUrl || !song.id) && song.artist && song.title) {
            try {
                const cleanA = (song.artist || '').replace(/- Topic/gi, '').split(',')[0].trim();
                const cleanT = (song.title || '').trim();
                const res = await fetch(`/api/match?artist=${encodeURIComponent(cleanA)}&title=${encodeURIComponent(cleanT)}`);
                if (res.ok) {
                    const d = await res.json();
                    if (d.audioPreviewUrl) {
                        song.audioPreviewUrl = d.audioPreviewUrl;
                    }
                    if (d.videoId && !song.id) {
                        song.id = d.videoId;
                    }
                }
            } catch (e) {
                console.warn('[P2P] Match pre-resolve error:', e);
            }
        }

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
        let name = r.playlistName;
        if (!name) {
            const pl = (window.HEARDLE_PLAYLISTS && window.HEARDLE_PLAYLISTS[r.playlistKey]) 
                || (window.playlists && window.playlists[r.playlistKey]) 
                || null;
            if (pl) {
                name = pl.name || r.playlistKey;
            } else {
                try {
                    const customSaved = JSON.parse(localStorage.getItem('heardle_custom_playlists') || '{}');
                    if (customSaved[r.playlistKey]) name = customSaved[r.playlistKey].name;
                } catch (e) {}
            }
        }
        return {
            code: r.code,
            hostId: r.hostId,
            state: r.state,
            playlistKey: r.playlistKey,
            playlistName: name || 'Multiplayer',
            customSongs: r.customSongs || (MP.room ? MP.room.customSongs : null),
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
                showToast(`👋 ${data.player.name} joined the game!`);
                break;

            case 'PLAYER_LEFT':
                MP.room = data.room;
                MP.isHost = (data.room.hostId === MP.playerId);
                renderLobbyPlayers();
                showToast(`🚪 ${data.playerName} left the room.`);
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
                showToast(`🎯 ${data.playerName} guessed in ${data.guessTime}s (+${data.points} pts)!`, 'success');
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
                showToast('🔄 Game was restarted by the host.');
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
            text.textContent = connected ? (MP.transport === 'webrtc' ? 'P2P Connected' : 'Online') : 'Offline';
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
                    <h2>Private Multiplayer Game</h2>
                    <p>Play against friends in real-time on the same music track. The fastest guess earns maximum points!</p>
                </div>

                <div class="mp-player-profile-box">
                    <label>Your Profile</label>
                    <div class="mp-profile-row">
                        <div class="mp-avatar-selector" id="mpAvatarPickerBtn" title="Change avatar">
                            <span id="mpCurrentAvatar">${MP.playerAvatar}</span>
                            <div class="avatar-edit-badge">✏️</div>
                        </div>
                        <input type="text" id="mpPlayerNameInput" class="mp-input" placeholder="Enter your nickname..." value="${escapeHtml(MP.playerName)}" maxlength="20" />
                    </div>
                    <div class="avatar-dropdown hidden" id="mpAvatarDropdown">
                        ${AVATARS.map(av => `<button type="button" class="avatar-btn ${av === MP.playerAvatar ? 'selected' : ''}" data-avatar="${av}">${av}</button>`).join('')}
                    </div>
                </div>

                <div class="mp-hub-tabs">
                    <button type="button" class="mp-tab-btn active" id="tabCreateBtn">Create a Room</button>
                    <button type="button" class="mp-tab-btn" id="tabJoinBtn">Join a Room</button>
                </div>

                <!-- Create Room Panel -->
                <div class="mp-tab-panel" id="panelCreateRoom">
                    <div class="mp-form-group">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                            <label for="mpPlaylistSelect" style="margin: 0;">🎵 Playlist to Play</label>
                            <button type="button" class="mp-btn-import-pl" id="btnOpenImportPlHub" title="Import Spotify, Deezer or YouTube playlist">
                                ➕ Import (Spotify / Deezer)
                            </button>
                        </div>
                        <select id="mpPlaylistSelect" class="mp-select">
                            ${getAvailablePlaylistsList().map(pl => `
                                <option value="${pl.key}">${escapeHtml(pl.name)} (${pl.count} songs)</option>
                            `).join('')}
                        </select>
                    </div>

                    <div class="mp-form-group">
                        <label for="mpWinningRoundsSelect">🏆 Number of Winning Rounds</label>
                        <select id="mpWinningRoundsSelect" class="mp-select">
                            <option value="3">First to 3 rounds</option>
                            <option value="5" selected>First to 5 rounds (Classic)</option>
                            <option value="7">First to 7 rounds</option>
                            <option value="10">First to 10 rounds (Marathon)</option>
                        </select>
                    </div>

                    <button type="button" class="mp-action-btn primary" id="btnCreateRoomSubmit">
                        Create Private Room 🚀
                    </button>
                </div>

                <!-- Join Room Panel -->
                <div class="mp-tab-panel hidden" id="panelJoinRoom">
                    <div class="mp-form-group">
                        <label for="mpJoinCodeInput">🔑 Room Code (6 letters)</label>
                        <input type="text" id="mpJoinCodeInput" class="mp-input code-input" placeholder="e.g. HEARDL" maxlength="6" value="${MP.pendingRoomCodeFromUrl || ''}" />
                    </div>

                    <button type="button" class="mp-action-btn primary" id="btnJoinRoomSubmit">
                        Join Game 🎮
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

        const btnImportPl = document.getElementById('btnOpenImportPlHub');
        if (btnImportPl) {
            btnImportPl.addEventListener('click', () => {
                openCustomPlaylistModal('mpPlaylistSelect');
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
                const name = (document.getElementById('mpPlayerNameInput')?.value || '').trim() || 'Host';
                MP.playerName = name;
                localStorage.setItem('heardle_mp_name', name);

                const playlistKey = document.getElementById('mpPlaylistSelect')?.value || 'abdoul';
                const plList = getAvailablePlaylistsList();
                const selectedPl = plList.find(p => p.key === playlistKey);
                const customSongs = selectedPl && selectedPl.isCustom ? selectedPl.songs : null;
                const plName = selectedPl ? selectedPl.name.replace(/^[⭐🟢🟣🔴]\s*/, '') : playlistKey;
                const winningRounds = parseInt(document.getElementById('mpWinningRoundsSelect')?.value, 10) || 5;

                btnCreate.disabled = true;
                btnCreate.textContent = 'Creating...';

                send('CREATE_ROOM', {
                    playerName: name,
                    avatar: MP.playerAvatar,
                    playlistKey: playlistKey,
                    playlistName: plName,
                    customSongs: customSongs,
                    winningRounds: winningRounds
                });
            });
        }

        const btnJoin = document.getElementById('btnJoinRoomSubmit');
        if (btnJoin) {
            btnJoin.addEventListener('click', () => {
                const name = (document.getElementById('mpPlayerNameInput')?.value || '').trim() || 'Player';
                MP.playerName = name;
                localStorage.setItem('heardle_mp_name', name);

                const code = (document.getElementById('mpJoinCodeInput')?.value || '').trim().toUpperCase();
                if (!code || code.length < 3) {
                    showToast('Please enter a valid room code.', 'error');
                    return;
                }

                btnJoin.disabled = true;
                btnJoin.textContent = 'Connecting...';

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
                        <span class="label">PRIVATE ROOM</span>
                        <span class="code">${MP.room.code}</span>
                    </div>
                    <div class="share-link-row">
                        <input type="text" class="mp-share-url-input" value="${shareUrl}" readonly id="mpShareUrlInput" />
                        <button type="button" class="mp-copy-btn" id="mpCopyLinkBtn">
                            📋 Copy Link
                        </button>
                    </div>
                </div>

                <div class="mp-lobby-settings-box">
                    <div class="settings-col">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                            <span class="setting-label">🎵 Playlist</span>
                            ${MP.isHost ? `
                                <button type="button" class="mp-btn-import-pl-mini" id="btnOpenImportPlLobby" title="Import a new playlist">
                                    ➕ Import
                                </button>
                            ` : ''}
                        </div>
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
                        <span class="setting-label">🏆 Winning Rounds</span>
                        ${MP.isHost ? `
                            <select id="mpLobbyWinningSelect" class="mp-select compact">
                                <option value="3" ${MP.room.winningRounds === 3 ? 'selected' : ''}>3 rounds</option>
                                <option value="5" ${MP.room.winningRounds === 5 ? 'selected' : ''}>5 rounds</option>
                                <option value="7" ${MP.room.winningRounds === 7 ? 'selected' : ''}>7 rounds</option>
                                <option value="10" ${MP.room.winningRounds === 10 ? 'selected' : ''}>10 rounds</option>
                            </select>
                        ` : `
                            <span class="setting-val">First to ${MP.room.winningRounds} rounds</span>
                        `}
                    </div>
                </div>

                <div class="mp-lobby-players-section">
                    <h3>Connected Players (<span id="mpPlayerCount">${MP.room.players.length}</span>/12)</h3>
                    <div class="mp-players-grid" id="mpLobbyPlayersGrid"></div>
                </div>

                <div class="mp-lobby-footer">
                    <button type="button" class="mp-action-btn secondary" id="mpLeaveRoomBtn">
                        Leave Room
                    </button>

                    ${MP.isHost ? `
                        <button type="button" class="mp-action-btn primary large glow" id="mpStartGameBtn">
                            Start Game 🚀
                        </button>
                    ` : `
                        <div class="mp-waiting-text">
                            <div class="spinner-dot"></div>
                            <span>Waiting for host to start...</span>
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
                    <span class="player-name">${escapeHtml(p.name)} ${p.id === MP.playerId ? '(You)' : ''}</span>
                    <span class="player-role">${p.isHost ? '👑 Host' : 'Player'}</span>
                </div>
                <div class="player-status-badge ready">Ready</div>
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
                    copyBtn.textContent = '✅ Link Copied!';
                    setTimeout(() => { copyBtn.textContent = '📋 Copy Link'; }, 2000);
                    showToast('Game link copied to clipboard!', 'success');
                }).catch(() => {
                    showToast(`Copy this link: ${shareUrl}`);
                });
            });
        }

        const btnImportLobby = document.getElementById('btnOpenImportPlLobby');
        if (btnImportLobby && MP.isHost) {
            btnImportLobby.addEventListener('click', () => {
                openCustomPlaylistModal('mpLobbyPlaylistSelect');
            });
        }

        const playlistSelect = document.getElementById('mpLobbyPlaylistSelect');
        const winningSelect = document.getElementById('mpLobbyWinningSelect');

        if (playlistSelect && MP.isHost) {
            playlistSelect.addEventListener('change', (e) => {
                const key = e.target.value;
                const plList = getAvailablePlaylistsList();
                const selectedPl = plList.find(p => p.key === key);
                const customSongs = selectedPl && selectedPl.isCustom ? selectedPl.songs : null;
                const plName = selectedPl ? selectedPl.name.replace(/^[⭐🟢🟣🔴]\s*/, '') : key;
                send('UPDATE_SETTINGS', {
                    playlistKey: key,
                    playlistName: plName,
                    customSongs: customSongs
                });
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
                startBtn.textContent = 'Starting...';
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
                        Round <span class="highlight">${data.round}</span> • First to <span class="highlight">${data.winningRounds}</span> ⭐
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
                        ⚡ Guess fast to maximize your points! (-100 pts per skip)
                    </div>
                </div>

                <div class="mp-game-arena">
                    <div class="mp-player-board">
                        <div class="mp-game-stats">
                            <span>Attempt: <span id="mpCurrentAttempt">1</span>/6</span>
                            <span>Clip: <span id="mpClipLength">1</span>s</span>
                            <span id="mpSongSource">Source: ${escapeHtml(data.room.playlistName || 'Multiplayer')}</span>
                        </div>

                        <div class="mp-answer-boxes" id="mpAnswerBoxes">
                            <div class="answer-box current" data-attempt="1"><div class="attempt-number">1</div></div>
                            <div class="answer-box" data-attempt="2"><div class="attempt-number">2</div></div>
                            <div class="answer-box" data-attempt="3"><div class="attempt-number">3</div></div>
                            <div class="answer-box" data-attempt="4"><div class="attempt-number">4</div></div>
                            <div class="answer-box" data-attempt="5"><div class="attempt-number">5</div></div>
                            <div class="answer-box" data-attempt="6"><div class="attempt-number">6</div></div>
                        </div>

                        <p class="instruction-text" id="mpInstructionText">Listen to the clip and guess the song or artist!</p>

                        <div class="audio-player">
                            <div class="progress-container" id="mpProgressContainer">
                                <div class="progress-bar" id="mpProgressBar"></div>
                            </div>
                            <div class="time-display">
                                <span id="mpCurrentTime">0:00</span>
                                <span id="mpTotalTime">0:01</span>
                            </div>
                            <button type="button" class="play-button" id="mpPlayButton" title="Play / Pause (Space)">▶</button>
                        </div>

                        <div class="search-container">
                            <input type="text" class="search-input" placeholder="Song title or artist... (Press D to search)" id="mpSearchInput" autocomplete="off" spellcheck="false" />
                            <button type="button" class="clear-button" id="mpClearButton">✕</button>
                            <div class="autocomplete-dropdown hidden" id="mpAutocompleteDropdown"></div>
                        </div>

                        <div class="action-buttons">
                            <button type="button" class="action-button skip-button" id="mpSkipButton" title="Skip attempt (S key)">SKIP (+1s)</button>
                            <button type="button" class="action-button submit-button" id="mpSubmitButton" title="Submit guess (Enter)">SUBMIT</button>
                        </div>

                        <!-- Shortcuts legend matching index.html -->
                        <div class="shortcuts-legend" style="display: flex; justify-content: center; gap: 14px; font-size: 12px; color: #888; margin-top: 10px;">
                            <span class="shortcut-item"><kbd class="kbd-key" style="background: #282828; border: 1px solid #444; padding: 2px 5px; border-radius: 3px; font-size: 11px;">Space</kbd> Play/Pause</span>
                            <span class="shortcut-item"><kbd class="kbd-key" style="background: #282828; border: 1px solid #444; padding: 2px 5px; border-radius: 3px; font-size: 11px;">S</kbd> Skip</span>
                            <span class="shortcut-item"><kbd class="kbd-key" style="background: #282828; border: 1px solid #444; padding: 2px 5px; border-radius: 3px; font-size: 11px;">D</kbd> Search</span>
                        </div>

                        <div class="mp-solved-banner hidden" id="mpSolvedBanner">
                            <div class="solved-icon">🎉</div>
                            <div class="solved-text">
                                <h4>Well done!</h4>
                                <p id="mpSolvedDetails">Guess submitted. Waiting for other players...</p>
                            </div>
                        </div>
                    </div>

                    <div class="mp-live-scoreboard">
                        <div class="scoreboard-header">
                            <h4>Live Leaderboard</h4>
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
                statusHtml = `<span class="status-tag correct">✅ Solved (${p.roundState.guessTime}s)</span>`;
            } else if (p.roundState.isFinished) {
                statusHtml = `<span class="status-tag failed">❌ Eliminated</span>`;
            } else if (p.roundState.skips > 0) {
                statusHtml = `<span class="status-tag skipped">⏭️ Skipped (${p.roundState.skips})</span>`;
            } else {
                statusHtml = `<span class="status-tag listening">🎧 Listening...</span>`;
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
                    solvedDetails.textContent = `Solved in ${data.guessTime}s! You earn +${data.points} points.`;
                }
            }

            showToast(`🎉 Great job! Solved in ${data.guessTime}s (+${data.points} pts)`, 'success');
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
                showToast('❌ 6 attempts used up! Waiting for the round to end.', 'error');
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
                dropdown.innerHTML = `<div class="autocomplete-no-results">No matching songs found</div>`;
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
                    <h2>${isMatchOver ? '🏆 MATCH OVER!' : `Round ${data.room.currentRound} Over!`}</h2>
                    <p class="round-winner-line">
                        ${data.roundWinner 
                            ? `🥇 Round Winner: <strong>${escapeHtml(data.roundWinner.name)}</strong> (${data.roundWinner.roundState.guessTime}s, +${data.roundWinner.roundState.pointsThisRound} pts)`
                            : 'No one guessed the song in time!'}
                    </p>
                </div>

                <div class="mp-song-reveal-box">
                    <img src="${data.song.thumbnail || 'https://i.ytimg.com/vi/EUww3qVQVe4/hqdefault.jpg'}" alt="Cover" class="reveal-cover" />
                    <div class="reveal-meta">
                        <span class="reveal-label">THE SONG WAS:</span>
                        <h3 class="reveal-title">${escapeHtml(data.song.title)}</h3>
                        <p class="reveal-artist">${escapeHtml(data.song.artist)}</p>
                    </div>
                </div>

                <div class="reveal-audio-player">
                    <button type="button" class="reveal-play-btn" id="mpRevealPlayBtn">▶ Listen to full song</button>
                </div>

                <div class="mp-results-table-box">
                    <table class="mp-scoreboard-table">
                        <thead>
                            <tr>
                                <th>Rank</th>
                                <th>Player</th>
                                <th>Time</th>
                                <th>Round Pts</th>
                                <th>Total Score</th>
                                <th>Rounds Won</th>
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
                                Play Again in this Room 🔄
                            </button>
                        ` : `
                            <p class="waiting-host-msg">Waiting for host to restart match...</p>
                        `}
                    ` : `
                        ${MP.isHost ? `
                            <button type="button" class="mp-action-btn primary large glow" id="mpNextRoundBtn">
                                Next Round ⏭️
                            </button>
                        ` : `
                            <p class="waiting-host-msg">Waiting for host to start next round...</p>
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
                    playBtn.textContent = '▶ Listen to full song';
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
                nextRoundBtn.textContent = 'Loading...';
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
            setupCustomPlaylistModalListeners();
            window.addEventListener('keydown', handleGlobalKeyDown);
            renderHubView();
            checkUrlParams();
        }
    };

    window.addEventListener('DOMContentLoaded', () => {
        window.HeardleMP.init();
    });

})();
