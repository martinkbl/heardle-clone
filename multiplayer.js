/**
 * Heardle Unlimited - Multiplayer Client Module
 * Real-time multiplayer rooms, synchronized audio, 60s circular timer,
 * speed scoring with skip penalties, and private room sharing.
 */

(function () {
    'use strict';

    // State
    const MP = {
        ws: null,
        isConnected: false,
        playerId: null,
        room: null,
        isHost: false,
        currentRoundData: null,
        roundTimerInterval: null,
        roundSecondsLeft: 60,
        roundDuration: 60,
        availablePlaylists: [],
        activeMode: 'solo', // 'solo' | 'multiplayer'
        playerAvatar: '🎧',
        playerName: localStorage.getItem('heardle_mp_name') || '',
        pendingRoomCodeFromUrl: null
    };

    const AVATARS = ['🎧', '🎵', '🔥', '⚡', '👑', '🚀', '🎸', '🎹', '🦊', '🐯', '💎', '⭐'];

    // Check URL parameters for ?room=CODE or ?join=CODE
    function checkUrlParams() {
        const urlParams = new URLSearchParams(window.location.search);
        const roomCode = urlParams.get('room') || urlParams.get('join');
        if (roomCode) {
            MP.pendingRoomCodeFromUrl = roomCode.toUpperCase().trim();
            // Automatically switch to multiplayer tab
            setTimeout(() => {
                switchGameMode('multiplayer');
                if (MP.pendingRoomCodeFromUrl) {
                    const joinInput = document.getElementById('mpJoinCodeInput');
                    if (joinInput) joinInput.value = MP.pendingRoomCodeFromUrl;
                    showJoinTab();
                }
            }, 300);
        }
    }

    // Connect WebSocket
    function connectWebSocket(callback) {
        if (MP.ws && MP.ws.readyState === WebSocket.OPEN) {
            if (callback) callback();
            return;
        }

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host || 'localhost:3000';
        const wsUrl = `${protocol}//${host}`;

        try {
            MP.ws = new WebSocket(wsUrl);

            MP.ws.onopen = () => {
                console.log('✅ Connected to Multiplayer WebSocket');
                MP.isConnected = true;
                updateConnectionStatus(true);
                if (callback) callback();
            };

            MP.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    handleServerMessage(data);
                } catch (e) {
                    console.error('Error parsing MP message:', e);
                }
            };

            MP.ws.onclose = () => {
                console.log('❌ Disconnected from Multiplayer WebSocket');
                MP.isConnected = false;
                updateConnectionStatus(false);
            };

            MP.ws.onerror = (err) => {
                console.warn('WebSocket connection error:', err);
                MP.isConnected = false;
                updateConnectionStatus(false);
            };
        } catch (e) {
            console.error('Failed to initialize WebSocket:', e);
            updateConnectionStatus(false);
        }
    }

    function send(type, payload = {}) {
        if (MP.ws && MP.ws.readyState === WebSocket.OPEN) {
            MP.ws.send(JSON.stringify({ type, ...payload }));
        } else {
            connectWebSocket(() => {
                MP.ws.send(JSON.stringify({ type, ...payload }));
            });
        }
    }

    function handleServerMessage(data) {
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
        if (dot) {
            dot.className = connected ? 'connection-dot online' : 'connection-dot offline';
            dot.title = connected ? 'Connecté au serveur' : 'Déconnecté';
        }
    }

    // Switch between Solo and Multiplayer modes
    function switchGameMode(mode) {
        MP.activeMode = mode;
        const soloContainer = document.getElementById('soloGameContent');
        const mpContainer = document.getElementById('mpGameContent');
        const soloTabBtn = document.getElementById('modeSoloBtn');
        const mpTabBtn = document.getElementById('modeMpBtn');

        if (mode === 'multiplayer') {
            if (soloContainer) soloContainer.classList.add('hidden');
            if (mpContainer) mpContainer.classList.remove('hidden');
            if (soloTabBtn) soloTabBtn.classList.remove('active');
            if (mpTabBtn) mpTabBtn.classList.add('active');

            connectWebSocket();

            if (!MP.room) {
                renderHubView();
            } else if (MP.room.state === 'LOBBY') {
                renderLobbyView();
            }
        } else {
            if (soloContainer) soloContainer.classList.remove('hidden');
            if (mpContainer) mpContainer.classList.add('hidden');
            if (soloTabBtn) soloTabBtn.classList.add('active');
            if (mpTabBtn) mpTabBtn.classList.remove('active');
        }
    }

    // Render Multiplayer Main Hub (Create / Join Tabs)
    function renderHubView() {
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
                            <option value="abdoul">Abdoul (499 sons)</option>
                            <option value="gustave">Gustave (641 sons)</option>
                            <option value="erwan">Erwan (3198 sons)</option>
                            <option value="rayane">Rayane (2314 sons)</option>
                            <option value="anir">Anir (312 sons)</option>
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
                btn.addEventListener('click', (e) => {
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

    // Render Room Lobby
    function renderLobbyView() {
        const container = document.getElementById('mpDynamicArea');
        if (!container || !MP.room) return;

        // Form full shareable URL with site domain
        const baseUrl = window.location.origin.includes('localhost') 
            ? window.location.origin 
            : (window.location.origin || 'https://heardle-clone-delta.vercel.app');
        const shareUrl = `${baseUrl}/?room=${MP.room.code}`;

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
                                <option value="abdoul" ${MP.room.playlistKey === 'abdoul' ? 'selected' : ''}>Abdoul</option>
                                <option value="gustave" ${MP.room.playlistKey === 'gustave' ? 'selected' : ''}>Gustave</option>
                                <option value="erwan" ${MP.room.playlistKey === 'erwan' ? 'selected' : ''}>Erwan</option>
                                <option value="rayane" ${MP.room.playlistKey === 'rayane' ? 'selected' : ''}>Rayane</option>
                                <option value="anir" ${MP.room.playlistKey === 'anir' ? 'selected' : ''}>Anir</option>
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
                    <div class="mp-players-grid" id="mpLobbyPlayersGrid">
                        <!-- Rendered by renderLobbyPlayers() -->
                    </div>
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
    // IN-GAME MULTIPLAYER ROUND HANDLING
    // ==========================================

    function handleRoundStart(data) {
        MP.currentRoundData = data;
        MP.room = data.room;
        MP.roundDuration = data.duration || 60;
        MP.roundSecondsLeft = MP.roundDuration;

        const container = document.getElementById('mpDynamicArea');
        if (!container) return;

        // Render In-Game Multiplayer Layout
        container.innerHTML = `
            <div class="mp-gameplay-container">
                <!-- Top Header: Round info & Circular Timer -->
                <div class="mp-gameplay-header">
                    <div class="mp-round-badge">
                        Manche <span class="highlight">${data.round}</span> • Premier à <span class="highlight">${data.winningRounds}</span> ⭐
                    </div>

                    <!-- Circular 60s SVG Timer -->
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

                <!-- Main Arena: Center Game Board & Right Live Leaderboard -->
                <div class="mp-game-arena">
                    <!-- Audio Player & Guess Bars Area -->
                    <div class="mp-player-board">
                        <div class="mp-game-stats">
                            <span>Tentative: <span id="mpCurrentAttempt">1</span>/6</span>
                            <span>Extrait: <span id="mpClipLength">1</span>s</span>
                            <span id="mpSongSource">Source: Multijoueur</span>
                        </div>

                        <!-- 6 Answer Guess Boxes -->
                        <div class="answer-boxes mp-answer-boxes" id="mpAnswerBoxes">
                            <div class="answer-box current" data-attempt="1"><div class="attempt-number">1</div></div>
                            <div class="answer-box" data-attempt="2"><div class="attempt-number">2</div></div>
                            <div class="answer-box" data-attempt="3"><div class="attempt-number">3</div></div>
                            <div class="answer-box" data-attempt="4"><div class="attempt-number">4</div></div>
                            <div class="answer-box" data-attempt="5"><div class="attempt-number">5</div></div>
                            <div class="answer-box" data-attempt="6"><div class="attempt-number">6</div></div>
                        </div>

                        <!-- Audio Controls -->
                        <p class="instruction-text" id="mpInstructionText">Écoutez et devinez le titre ou l'artiste !</p>

                        <div class="audio-player mp-audio-player">
                            <div id="mpGameAudio"></div>
                            <div class="progress-container" id="mpProgressContainer">
                                <div class="progress-bar" id="mpProgressBar"></div>
                            </div>
                            <div class="time-display">
                                <span id="mpCurrentTime">0:00</span>
                                <span id="mpTotalTime">0:01</span>
                            </div>
                            <button type="button" class="play-button" id="mpPlayButton">▶</button>
                        </div>

                        <!-- Search & Guess Controls -->
                        <div class="search-container mp-search-container">
                            <input type="text" class="search-input" placeholder="Connaissez-vous le son ? Recherchez ici..." id="mpSearchInput" autocomplete="off" />
                            <button type="button" class="clear-button" id="mpClearButton">✕</button>
                            <div class="autocomplete-dropdown hidden" id="mpAutocompleteDropdown"></div>
                        </div>

                        <div class="action-buttons mp-action-buttons">
                            <button type="button" class="action-button skip-button" id="mpSkipButton">SKIP (+1s)</button>
                            <button type="button" class="action-button submit-button" id="mpSubmitButton">VALIDER</button>
                        </div>

                        <!-- Finished Banner if solved -->
                        <div class="mp-solved-banner hidden" id="mpSolvedBanner">
                            <div class="solved-icon">🎉</div>
                            <div class="solved-text">
                                <h4>Bien joué !</h4>
                                <p id="mpSolvedDetails">Réponse enregistrée. En attente des autres joueurs...</p>
                            </div>
                        </div>
                    </div>

                    <!-- Live Leaderboard Sidebar -->
                    <div class="mp-live-scoreboard">
                        <div class="scoreboard-header">
                            <h4>Classement en direct</h4>
                        </div>
                        <div class="scoreboard-list" id="mpLiveScoreboardList">
                            <!-- Populated dynamically -->
                        </div>
                    </div>
                </div>
            </div>
        `;

        setupGameplayControls(data.songAudio);
        startCircularTimer(MP.roundDuration);
        updateLiveLeaderboard();

        // Start initial audio playback synchronized
        setTimeout(() => {
            if (typeof window.mpPlaySnippet === 'function') {
                window.mpPlaySnippet();
            }
        }, 600);
    }

    function startCircularTimer(durationSeconds) {
        if (MP.roundTimerInterval) clearInterval(MP.roundTimerInterval);

        const circle = document.getElementById('mpTimerCircle');
        const numberSpan = document.getElementById('mpTimerNumber');
        const totalCircumference = 2 * Math.PI * 44; // r=44 => ~276.46

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

                // Color transitions
                if (remaining <= 10) {
                    circle.style.stroke = '#ef4444'; // Red urgent
                    circle.classList.add('urgent-pulse');
                } else if (remaining <= 25) {
                    circle.style.stroke = '#f59e0b'; // Amber warning
                    circle.classList.remove('urgent-pulse');
                } else {
                    circle.style.stroke = '#1db954'; // Spotify Green
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

        // Sort by total score descending
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

            // Star wins
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

    // Controls setup during active round
    function setupGameplayControls(songAudio) {
        const snippetDurations = [1, 2, 4, 7, 11, 16];
        let currentAttempt = 1;
        let isPlaying = false;
        let snippetTimer = null;

        const playBtn = document.getElementById('mpPlayButton');
        const progressBar = document.getElementById('mpProgressBar');
        const currentTimeDisplay = document.getElementById('mpCurrentTime');
        const totalTimeDisplay = document.getElementById('mpTotalTime');
        const searchInput = document.getElementById('mpSearchInput');
        const clearBtn = document.getElementById('mpClearButton');
        const skipBtn = document.getElementById('mpSkipButton');
        const submitBtn = document.getElementById('mpSubmitButton');
        const currentAttemptDisplay = document.getElementById('mpCurrentAttempt');
        const clipLengthDisplay = document.getElementById('mpClipLength');
        const instructionText = document.getElementById('mpInstructionText');

        // Prepare audio element
        let audioPlayer = null;
        if (songAudio.audioPreviewUrl) {
            audioPlayer = new Audio(songAudio.audioPreviewUrl);
        }

        window.mpPlaySnippet = function () {
            if (isPlaying) {
                stopSnippet();
                return;
            }

            const duration = snippetDurations[currentAttempt - 1];
            isPlaying = true;
            if (playBtn) playBtn.textContent = '⏸';

            if (audioPlayer) {
                audioPlayer.currentTime = 0;
                audioPlayer.play().catch(e => console.warn('Audio play prevented:', e));
            } else if (window.YT && window.YT.Player) {
                // If using YouTube player
                if (typeof window.player !== 'undefined' && window.player && window.player.seekTo) {
                    window.player.seekTo(0);
                    window.player.playVideo();
                }
            }

            animateProgressBar(duration);

            snippetTimer = setTimeout(() => {
                stopSnippet();
            }, duration * 1000);
        };

        function stopSnippet() {
            if (snippetTimer) {
                clearTimeout(snippetTimer);
                snippetTimer = null;
            }
            isPlaying = false;
            if (playBtn) playBtn.textContent = '▶';
            if (audioPlayer) {
                audioPlayer.pause();
                audioPlayer.currentTime = 0;
            }
            if (typeof window.player !== 'undefined' && window.player && window.player.pauseVideo) {
                window.player.pauseVideo();
                window.player.seekTo(0);
            }
            if (progressBar) progressBar.style.width = '0%';
            if (currentTimeDisplay) currentTimeDisplay.textContent = '0:00';
        }

        function animateProgressBar(duration) {
            let start = performance.now();
            if (progressBar) progressBar.style.width = '0%';

            function step(timestamp) {
                if (!isPlaying) {
                    if (progressBar) progressBar.style.width = '0%';
                    return;
                }

                const elapsed = (timestamp - start) / 1000;
                const progress = Math.min(elapsed / duration, 1);
                if (progressBar) progressBar.style.width = `${progress * 100}%`;
                if (currentTimeDisplay) {
                    currentTimeDisplay.textContent = `0:${Math.floor(elapsed).toString().padStart(2, '0')}`;
                }

                if (progress < 1) {
                    requestAnimationFrame(step);
                } else {
                    if (currentTimeDisplay) currentTimeDisplay.textContent = '0:00';
                }
            }
            requestAnimationFrame(step);
        }

        if (playBtn) {
            playBtn.addEventListener('click', window.mpPlaySnippet);
        }

        if (clearBtn && searchInput) {
            clearBtn.addEventListener('click', () => {
                searchInput.value = '';
                searchInput.focus();
            });
        }

        // Handle Guess Submission
        function submitGuess() {
            if (!searchInput) return;
            const guess = searchInput.value.trim();
            if (!guess) return;

            send('SUBMIT_GUESS', { guess: guess });
            searchInput.value = '';
        }

        // Handle Skip
        function submitSkip() {
            send('SUBMIT_SKIP');
        }

        if (submitBtn) submitBtn.addEventListener('click', submitGuess);
        if (skipBtn) skipBtn.addEventListener('click', submitSkip);

        if (searchInput) {
            searchInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') submitGuess();
            });
        }

        // Autocomplete setup
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
            // Find current attempt box
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
            // Mark wrong attempt
            const attemptIdx = (data.attemptsUsed || 1) - 1;
            if (boxes[attemptIdx]) {
                boxes[attemptIdx].classList.remove('current');
                boxes[attemptIdx].classList.add('incorrect');
                boxes[attemptIdx].textContent = `❌ ${data.guess || 'INCORRECT'}`;
            }

            // Move current to next box
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

    // Autocomplete setup helper using window.songs
    function setupAutocomplete(inputEl) {
        if (!inputEl) return;
        const dropdown = document.getElementById('mpAutocompleteDropdown');
        if (!dropdown) return;

        inputEl.addEventListener('input', () => {
            const query = inputEl.value.trim().toLowerCase();
            if (!query || query.length < 2) {
                dropdown.classList.add('hidden');
                dropdown.innerHTML = '';
                return;
            }

            // Get song pool from window.songs or playlists
            const songPool = window.songs || window.HEARDLE_SONGS || [];
            const matches = songPool.filter(s => {
                if (!s) return false;
                const title = (s.title || '').toLowerCase();
                const artist = (s.artist || '').toLowerCase();
                return title.includes(query) || artist.includes(query);
            }).slice(0, 6);

            if (matches.length === 0) {
                dropdown.classList.add('hidden');
                return;
            }

            dropdown.innerHTML = matches.map(s => `
                <div class="autocomplete-item" data-title="${escapeHtml(s.title)}" data-artist="${escapeHtml(s.artist)}">
                    <span class="item-title">${escapeHtml(s.title)}</span>
                    <span class="item-artist">${escapeHtml(s.artist)}</span>
                </div>
            `).join('');

            dropdown.classList.remove('hidden');

            dropdown.querySelectorAll('.autocomplete-item').forEach(item => {
                item.addEventListener('click', () => {
                    const title = item.getAttribute('data-title');
                    const artist = item.getAttribute('data-artist');
                    inputEl.value = `${artist} - ${title}`;
                    dropdown.classList.add('hidden');
                    inputEl.focus();
                });
            });
        });

        document.addEventListener('click', (e) => {
            if (!dropdown.contains(e.target) && e.target !== inputEl) {
                dropdown.classList.add('hidden');
            }
        });
    }

    // ==========================================
    // ROUND OVER & MATCH OVER SCREENS
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

        // Render Round Over Screen
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

                <!-- Song Details Revealed -->
                <div class="mp-song-reveal-box">
                    <img src="${data.song.thumbnail || 'https://i.ytimg.com/vi/EUww3qVQVe4/hqdefault.jpg'}" alt="Cover" class="reveal-cover" />
                    <div class="reveal-meta">
                        <span class="reveal-label">LE MORCEAU ÉTAIT :</span>
                        <h3 class="reveal-title">${escapeHtml(data.song.title)}</h3>
                        <p class="reveal-artist">${escapeHtml(data.song.artist)}</p>
                    </div>
                </div>

                <!-- Full Track Audio Player -->
                <div class="reveal-audio-player">
                    <audio id="mpRevealAudio" src="${data.song.audioPreviewUrl || ''}" preload="auto"></audio>
                    <button type="button" class="reveal-play-btn" id="mpRevealPlayBtn">▶ Écouter le morceau complet</button>
                </div>

                <!-- Round & Total Scoreboard -->
                <div class="mp-results-table-box">
                    <h3>Classement de la partie</h3>
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

                <!-- Footer Host Controls -->
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
        const audio = document.getElementById('mpRevealAudio');

        if (playBtn && audio && song.audioPreviewUrl) {
            playBtn.addEventListener('click', () => {
                if (audio.paused) {
                    audio.play().then(() => {
                        playBtn.textContent = '⏸ Pause';
                    }).catch(e => console.warn(e));
                } else {
                    audio.pause();
                    playBtn.textContent = '▶ Écouter le morceau complet';
                }
            });

            audio.addEventListener('ended', () => {
                playBtn.textContent = '▶ Écouter le morceau complet';
            });
        }

        const nextRoundBtn = document.getElementById('mpNextRoundBtn');
        if (nextRoundBtn && MP.isHost) {
            nextRoundBtn.addEventListener('click', () => {
                nextRoundBtn.disabled = true;
                nextRoundBtn.textContent = 'Chargement...';
                if (audio) audio.pause();
                send('NEXT_ROUND');
            });
        }

        const restartBtn = document.getElementById('mpRestartGameBtn');
        if (restartBtn && MP.isHost) {
            restartBtn.addEventListener('click', () => {
                restartBtn.disabled = true;
                if (audio) audio.pause();
                send('RESTART_GAME');
            });
        }
    }

    // Helper Toast notifications
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

    // Export global helpers
    window.HeardleMP = {
        switchGameMode,
        init: () => {
            checkUrlParams();
            // Setup Tab Switcher buttons
            const soloBtn = document.getElementById('modeSoloBtn');
            const mpBtn = document.getElementById('modeMpBtn');
            if (soloBtn) soloBtn.addEventListener('click', () => switchGameMode('solo'));
            if (mpBtn) mpBtn.addEventListener('click', () => switchGameMode('multiplayer'));
        }
    };

    // Auto-init on page load
    window.addEventListener('DOMContentLoaded', () => {
        window.HeardleMP.init();
    });

})();
