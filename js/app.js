// Основная логика игры: состояние, Firebase, рендер, лобби, раунды, голосования.
let nickname = localStorage.getItem('bz_nickname') || '';
    let rooms = JSON.parse(localStorage.getItem('bz_rooms') || '[]');
    let currentRoomId = localStorage.getItem('bz_current_room') || '';
    let pendingCreateRoomId = '';
    let game = JSON.parse(localStorage.getItem('bz_game') || 'null');
    let votes = {};
    let filter = 'all';
    let timerInterval = null;
    let timerTotal = 120;
    let timerLeft = 120;

    let currentPage = localStorage.getItem('bz_current_page') || 'register';

    function saveCurrentPage(page) {
      currentPage = page;
      localStorage.setItem('bz_current_page', page);
    }

    function firebaseConfigReady() {
      return FIREBASE_CONFIG
        && FIREBASE_CONFIG.apiKey
        && !String(FIREBASE_CONFIG.apiKey).includes('PASTE_')
        && FIREBASE_CONFIG.databaseURL
        && !String(FIREBASE_CONFIG.databaseURL).includes('PASTE_');
    }

    function roomsToObject(list) {
      const obj = {};
      (list || []).forEach(r => {
        if (r && r.id) obj[r.id] = r;
      });
      return obj;
    }

    function objectToRooms(obj) {
      if (!obj) return [];
      return Object.values(obj).sort((a, b) => {
        const ac = a.createdMs || 0;
        const bc = b.createdMs || 0;
        return bc - ac;
      });
    }

    function initOnline() {
      if (!firebaseConfigReady()) {
        console.warn('Firebase config не заполнен. Игра работает локально.');
        return;
      }

      try {
        firebase.initializeApp(FIREBASE_CONFIG);
        onlineDb = firebase.database();
        onlineMode = true;

        onlineDb.ref(`${ONLINE_ROOT}/rooms`).on('value', snapshot => {
          suppressOnlineWrite = true;
          rooms = objectToRooms(snapshot.val());
          rooms.forEach(r => normalizeRoomPlayers(r));
          localStorage.setItem('bz_rooms', JSON.stringify(rooms));
          if (maybeHandleLobbyKick()) {
            suppressOnlineWrite = false;
            return;
          }
          closeOrphanWaitingLobbies();
          const r = room();
          if (r && game && game.roomId === r.id) updateGameHostFromRoom(r);
          renderAll();
          suppressOnlineWrite = false;
        });

        onlineReady = true;
        startLobbyMaintenance();
        showToast('Онлайн-синхронизация включена', 2500);
        subscribeCurrentRoom();
      } catch (error) {
        console.error('Firebase init error:', error);
        showToast('Firebase не подключился. Проверь firebaseConfig.', 5000);
      }
    }

    

    function currentPlayerId() {
      if (!nickname) return '';
      let id = localStorage.getItem('bz_player_id');
      if (!id) {
        id = 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
        localStorage.setItem('bz_player_id', id);
      }
      return id;
    }

    function markCurrentPlayerOnline() {
      updatePresenceAndHosts();
    }

    function closeOrphanWaitingLobbies() {
      let changed = false;
      rooms.forEach(r => {
        normalizeRoomPlayers(r);
        if (r.status === 'Ожидание') {
          const onlinePlayers = r.players.filter(p => isPlayerOnline(p));
          if (!onlinePlayers.length) {
            r.status = 'Завершена';
            r.closedReason = 'Все игроки вышли из комнаты';
            changed = true;
            return;
          }
        }
        if (transferHostIfNeeded(r)) changed = true;
      });
      if (changed) saveState();
    }

    function startLobbyMaintenance() {
      if (window.__lobbyMaintenanceStarted) return;
      window.__lobbyMaintenanceStarted = true;

      setInterval(() => {
        updatePresenceAndHosts();
      }, PRESENCE_HEARTBEAT_MS);

      window.addEventListener('beforeunload', () => {
        markCurrentPlayerOffline();
      });
    }


    function playerSortValue(p) {
      return Number(p?.joinedAt || p?.id || 0);
    }

    function isPresenceActivePage(pageName = localStorage.getItem('bz_current_page')) {
      return pageName === 'lobby' || pageName === 'game';
    }

    function isPlayerOnline(p) {
      if (!p) return false;
      if (p.bot) return true;
      if (p.online === false) return false;
      if (p.presencePage && !isPresenceActivePage(p.presencePage)) return false;
      const lastSeen = Number(p.lastSeen || 0);
      return !!lastSeen && Date.now() - lastSeen <= PLAYER_ONLINE_TIMEOUT_MS;
    }

    function onlineStatusHtml(p) {
      const online = isPlayerOnline(p);
      return `<span class="badge ${online ? 'online-badge' : 'offline-badge'}">${online ? 'онлайн' : 'вышел'}</span>`;
    }

    function normalizeRoomPlayers(r) {
      if (!r || !Array.isArray(r.players)) return;
      r.players.forEach((p, index) => {
        p.joinedAt = Number(p.joinedAt || p.id || r.createdMs || Date.now() + index);
        p.playerId = p.playerId || ('legacy_' + String(p.name || index));
        if (p.online === undefined) p.online = !!p.lastSeen;
        if (!p.presencePage) p.presencePage = p.online ? 'game' : 'away';
        if (!p.presencePage) p.presencePage = p.online ? 'lobby' : 'away';
      });
    }

    function normalizeGamePlayers() {
      if (!game || !Array.isArray(game.players)) return;
      game.players.forEach((p, index) => {
        p.joinedAt = Number(p.joinedAt || p.id || index + 1);
        p.playerId = p.playerId || ('legacy_' + String(p.name || index));
        if (p.online === undefined) p.online = !!p.lastSeen;
      });
    }

    function updateGameHostFromRoom(r) {
      if (!game || !r || game.roomId !== r.id) return;
      normalizeGamePlayers();
      game.players.forEach(gp => {
        gp.host = (gp.playerId && gp.playerId === r.hostPlayerId) || gp.name === r.host;
      });
    }

    function syncRoomHostFromGame(r) {
      if (!game || !r || game.roomId !== r.id) return;
      const gameHost = game.players.find(p => p.host);
      if (!gameHost) return;
      r.host = gameHost.name;
      r.hostPlayerId = gameHost.playerId || r.hostPlayerId;
      r.players.forEach(rp => {
        rp.host = (rp.playerId && rp.playerId === r.hostPlayerId) || rp.name === r.host;
      });
    }

    function transferHostIfNeeded(r) {
      if (!r || !Array.isArray(r.players) || r.status === 'Завершена') return false;
      normalizeRoomPlayers(r);
      if (game && game.roomId === r.id) normalizeGamePlayers();

      const currentHost = r.players.find(p => (p.host || p.name === r.host || (r.hostPlayerId && p.playerId === r.hostPlayerId)));
      const currentHostOnline = isPlayerOnline(currentHost);
      if (currentHost && currentHostOnline) return false;

      const candidates = r.players
        .filter(p => isPlayerOnline(p))
        .sort((a, b) => playerSortValue(a) - playerSortValue(b));

      if (!candidates.length) {
        const wasInGame = r.status === 'Игра идёт';
        r.status = 'Завершена';
        r.closedReason = wasInGame
          ? 'Все игроки вышли из матча'
          : 'Все игроки вышли из комнаты';

        if (game && game.roomId === r.id) {
          game.finalSummary = 'Матч автоматически закрыт: все игроки вышли.';
        }

        return true;
      }

      const nextHost = candidates[0];
      r.host = nextHost.name;
      r.hostPlayerId = nextHost.playerId;
      r.players.forEach(p => p.host = p.playerId === nextHost.playerId || p.name === nextHost.name);

      if (game && game.roomId === r.id) {
        game.players.forEach(p => p.host = p.playerId === nextHost.playerId || p.name === nextHost.name);
        if (game.history) {
          game.history.unshift(`[${new Date().toLocaleTimeString('ru-RU', {hour:'2-digit', minute:'2-digit'})}] Ведущий вышел. Новый ведущий: ${nextHost.name}.`);
        }
      }

      return true;
    }

    function updateCurrentPresenceOnline() {
      if (!currentRoomId || !nickname) return false;
      const activePresence = isPresenceActivePage();
      if (!activePresence) {
        markCurrentPlayerOffline();
        return false;
      }

      const r = room();
      if (!r) return false;
      normalizeRoomPlayers(r);

      const now = Date.now();
      const pid = currentPlayerId();
      let changed = false;
      const pageName = localStorage.getItem('bz_current_page') || '';

      const roomPlayer = r.players.find(p => p.name === nickname || p.playerId === pid);
      if (roomPlayer) {
        roomPlayer.playerId = roomPlayer.playerId || pid;
        roomPlayer.joinedAt = roomPlayer.joinedAt || roomPlayer.id || now;
        roomPlayer.lastSeen = now;
        roomPlayer.online = true;
        roomPlayer.presencePage = pageName;
        changed = true;
      }

      if (game && game.roomId === currentRoomId) {
        normalizeGamePlayers();
        const gamePlayer = game.players.find(p => p.name === nickname || p.playerId === pid);
        if (gamePlayer) {
          gamePlayer.playerId = gamePlayer.playerId || pid;
          gamePlayer.joinedAt = gamePlayer.joinedAt || now;
          gamePlayer.lastSeen = now;
          gamePlayer.online = true;
          gamePlayer.presencePage = pageName;
          changed = true;
        }
      }

      return changed;
    }

    function updatePresenceAndHosts() {
      let changed = updateCurrentPresenceOnline();

      rooms.forEach(r => {
        normalizeRoomPlayers(r);
        if (transferHostIfNeeded(r)) changed = true;
        if (game && game.roomId === r.id) updateGameHostFromRoom(r);
      });

      if (changed) saveState();
      else renderAll();
    }

    function markCurrentPlayerOffline() {
      if (!currentRoomId || !nickname) return;
      const r = room();
      if (!r) return;
      const pid = currentPlayerId();
      const now = Date.now() - PLAYER_ONLINE_TIMEOUT_MS - 1000;
      const offlinePage = localStorage.getItem('bz_current_page') || 'away';

      const roomUpdates = (r.players || []).map(p => {
        if (p.name === nickname || p.playerId === pid) return { ...p, online: false, presencePage: offlinePage, lastSeen: now };
        return p;
      });

      r.players = roomUpdates;

      if (onlineMode && onlineDb) {
        onlineDb.ref(`${ONLINE_ROOT}/rooms/${currentRoomId}/players`).set(roomUpdates);
      }

      if (game && game.roomId === currentRoomId) {
        const gameUpdates = (game.players || []).map(p => {
          if (p.name === nickname || p.playerId === pid) return { ...p, online: false, presencePage: offlinePage, lastSeen: now };
          return p;
        });
        game.players = gameUpdates;

        if (onlineMode && onlineDb) {
          onlineDb.ref(`${ONLINE_ROOT}/games/${currentRoomId}/players`).set(gameUpdates);
        }
      }
    }

    function clearGameIfDifferentRoom() {
      if (game && currentRoomId && game.roomId !== currentRoomId) {
        game = null;
        localStorage.removeItem('bz_game');
      }
    }

function subscribeCurrentRoom() {
      if (!onlineMode || !onlineDb || !currentRoomId || subscribedRoomId === currentRoomId) return;

      if (unsubscribeGame) unsubscribeGame();
      if (unsubscribeVotes) unsubscribeVotes();

      subscribedRoomId = currentRoomId;

      const gameRef = onlineDb.ref(`${ONLINE_ROOT}/games/${currentRoomId}`);
      const votesRef = onlineDb.ref(`${ONLINE_ROOT}/votes/${currentRoomId}`);

      const gameHandler = snapshot => {
        const remoteGame = snapshot.val();

        if (!remoteGame) {
          if (game && game.roomId === currentRoomId) {
            game = null;
            localStorage.removeItem('bz_game');
            renderAll();
          }
          return;
        }

        if (remoteGame.roomId !== currentRoomId) return;

        suppressOnlineWrite = true;
        game = remoteGame;
        normalizeGamePlayers();
        const currentRoom = room();
        if (currentRoom) updateGameHostFromRoom(currentRoom);
        localStorage.setItem('bz_game', JSON.stringify(game));
        const currentVisiblePage = localStorage.getItem('bz_current_page');
        renderAll();
        suppressOnlineWrite = false;

        ensureRoundOpeningTicker();

        const r = room();
        const isParticipant = game.players && game.players.some(p => p.name === nickname);
        if (currentVisiblePage === 'lobby' && r && r.status === 'Игра идёт' && isParticipant) {
          showPage('game');
        }
      };

      const votesHandler = snapshot => {
        suppressOnlineWrite = true;
        votes = snapshot.val() || {};
        renderAll();
        suppressOnlineWrite = false;
      };

      gameRef.on('value', gameHandler);
      votesRef.on('value', votesHandler);

      unsubscribeGame = () => gameRef.off('value', gameHandler);
      unsubscribeVotes = () => votesRef.off('value', votesHandler);
    }

    function saveOnlineState() {
      if (!onlineMode || !onlineDb || suppressOnlineWrite) return;
      const currentRoomForSync = room();
      if (currentRoomForSync) syncRoomHostFromGame(currentRoomForSync);

      onlineDb.ref(`${ONLINE_ROOT}/rooms`).set(roomsToObject(rooms));

      if (currentRoomId && game && game.roomId === currentRoomId) {
        onlineDb.ref(`${ONLINE_ROOT}/games/${currentRoomId}`).set(game);
      } else if (currentRoomId && game && game.roomId !== currentRoomId) {
        localStorage.removeItem('bz_game');
      }

      if (currentRoomId) {
        onlineDb.ref(`${ONLINE_ROOT}/votes/${currentRoomId}`).set(votes || {});
      }
    }

    function saveOnlineVotes() {
      localStorage.setItem('bz_votes_' + (currentRoomId || 'local'), JSON.stringify(votes || {}));
      if (onlineMode && onlineDb && currentRoomId) {
        onlineDb.ref(`${ONLINE_ROOT}/votes/${currentRoomId}`).set(votes || {});
      }
    }





    function saveState() {
      localStorage.setItem('bz_nickname', nickname);
      localStorage.setItem('bz_rooms', JSON.stringify(rooms));
      localStorage.setItem('bz_current_room', currentRoomId || '');
      localStorage.setItem('bz_game', JSON.stringify(game));
      saveOnlineState();
    }

    function showPage(name) {
      const previousPage = localStorage.getItem('bz_current_page') || currentPage;

      if (name !== 'game') {
        hideToast();
      }

      if (isPresenceActivePage(previousPage) && !isPresenceActivePage(name)) {
        markCurrentPlayerOffline();
      }

      saveCurrentPage(name);
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      const page = document.getElementById('page-' + name);
      if (page) {
        page.classList.add('active');
        page.style.animation = 'none';
        page.offsetHeight;
        page.style.animation = '';
      }
      document.getElementById('headerSubtitle').textContent = '';

      const playerInfo = document.getElementById('playerHeaderInfo');
      const playerNick = document.getElementById('playerHeaderNickname');

      if (nickname) {
        playerInfo.style.display = '';
        playerNick.textContent = nickname;
      } else {
        playerInfo.style.display = 'none';
      }

      subscribeCurrentRoom();
      updateCurrentPresenceOnline();
      renderAll();
    }

    function randomFrom(arr) {
      if (!Array.isArray(arr) || arr.length === 0) return '';
      return arr[Math.floor(Math.random() * arr.length)];
    }

    function randomDifferentFrom(arr, exceptValue) {
      if (!Array.isArray(arr) || arr.length === 0) return '';
      const pool = arr.filter(item => item !== exceptValue);
      return randomFrom(pool.length ? pool : arr);
    }

    function randomHeight() {
      return Math.floor(Math.random() * (220 - 120 + 1)) + 120;
    }

    function randomSurvivalDuration() {
      let months;

      // 80%: от 6 месяцев до 5 лет. 20%: больше 5 лет, максимум 10 лет.
      if (Math.random() < 0.8) {
        months = Math.floor(Math.random() * (60 - 6 + 1)) + 6;
      } else {
        months = Math.floor(Math.random() * (120 - 61 + 1)) + 61;
      }

      if (months < 12) return { months, text: `${months} мес.` };

      const years = Math.floor(months / 12);
      const restMonths = months % 12;
      const yearWord = years % 10 === 1 && years % 100 !== 11 ? 'год' : (years % 10 >= 2 && years % 10 <= 4 && (years % 100 < 10 || years % 100 >= 20) ? 'года' : 'лет');

      if (restMonths === 0) return { months, text: `${years} ${yearWord}` };
      return { months, text: `${years} ${yearWord} ${restMonths} мес.` };
    }

    function formatDurationMonths(months) {
      months = Math.max(1, Number(months) || 1);

      if (months < 12) return `${months} мес.`;

      const years = Math.floor(months / 12);
      const restMonths = months % 12;

      const yearWord =
        years % 10 === 1 && years % 100 !== 11
          ? 'год'
          : (years % 10 >= 2 && years % 10 <= 4 && (years % 100 < 10 || years % 100 >= 20))
            ? 'года'
            : 'лет';

      if (restMonths === 0) return `${years} ${yearWord}`;

      return `${years} ${yearWord} ${restMonths} мес.`;
    }



    function healthIcon(stage) {
      if (stage === 'perfect') return '🟢';
      if (stage === 'light') return '🟡';
      if (stage === 'medium') return '🟠';
      if (stage === 'heavy') return '🔴';
      return '';
    }

    function healthView(player) {
      return `${healthIcon(player.cards.healthStage)} ${player.cards.health}`;
    }

    function getDiseaseProgression(health, stage) {
      const rule = diseaseProgression[health];
      if (!rule) return null;
      if (rule.byStage) return rule.byStage[stage] || null;
      return rule;
    }
    function code() { return Math.random().toString(36).slice(2, 6).toUpperCase(); }
    function room() { return rooms.find(r => r.id === currentRoomId); }
    function alivePlayers() { return game ? game.players.filter(p => p.alive && !p.exiled) : []; }
    function byId(id) { return game?.players.find(p => p.id === Number(id)); }
    function log(text) {
      if (!game) return;
      const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      game.history.unshift(`[${time}] ${text}`);
      saveState();
      renderAll();
    }

    function plainText(html) {
      const div = document.createElement('div');
      div.innerHTML = html || '';
      return div.textContent || div.innerText || '';
    }

    function showToast(message, delay = 3500, persistent = false, eventAlert = false) {
      const toast = document.getElementById('toast');
      if (!toast) return;

      if (toastTimeoutId) {
        clearTimeout(toastTimeoutId);
        toastTimeoutId = null;
      }

      toast.innerHTML = message;
      toast.classList.toggle('event-alert', !!eventAlert);
      toast.style.display = 'block';

      if (!persistent) {
        toastTimeoutId = setTimeout(() => {
          hideToast();
        }, delay);
      }
    }

    function hideToast() {
      const toast = document.getElementById('toast');

      if (toastTimeoutId) {
        clearTimeout(toastTimeoutId);
        toastTimeoutId = null;
      }

      if (toast) {
        toast.style.display = 'none';
        toast.classList.remove('event-alert');
        toast.innerHTML = '';
      }
    }

    function showEventModal(html) {
      const backdrop = document.getElementById('eventModalBackdrop');
      const content = document.getElementById('eventModalContent');
      if (!backdrop || !content) return;
      content.innerHTML = html;
      backdrop.style.display = 'flex';
    }

    function hideEventModal() {
      const backdrop = document.getElementById('eventModalBackdrop');
      if (backdrop) backdrop.style.display = 'none';
    }

    function showSpecialModal(html) {
      const backdrop = document.getElementById('specialModalBackdrop');
      const content = document.getElementById('specialModalContent');
      if (!backdrop || !content) return;
      content.innerHTML = html;
      backdrop.style.display = 'flex';
    }

    function hideSpecialModal() {
      const backdrop = document.getElementById('specialModalBackdrop');
      if (backdrop) backdrop.style.display = 'none';
    }

    function maybeShowSpecialNotice() {
      if (!game || !game.specialNotice) return;
      const noticeId = game.specialNotice.id || '';
      const seenKey = 'bz_seen_special_notice_' + noticeId;
      if (!noticeId || localStorage.getItem(seenKey)) return;
      localStorage.setItem(seenKey, '1');
      showSpecialModal(game.specialNotice.html || game.specialNotice.text || 'Игрок применил спецвозможность.');
    }

    function showFinalModal(html) {
      const backdrop = document.getElementById('finalModalBackdrop');
      const content = document.getElementById('finalModalContent');
      if (!backdrop || !content) return;
      content.innerHTML = html;
      backdrop.style.display = 'flex';
    }

    function hideFinalModal() {
      const backdrop = document.getElementById('finalModalBackdrop');
      if (backdrop) backdrop.style.display = 'none';
    }

    function maybeShowFinalNotice() {
      if (!game || !game.gameOver || !game.finalSummary) return;
      const noticeId = game.finalNoticeId || `${game.roomId}_${game.round}_final`;
      const seenKey = 'bz_seen_final_notice_' + noticeId;
      if (localStorage.getItem(seenKey)) return;
      localStorage.setItem(seenKey, '1');
      showFinalModal(game.finalSummary);
    }

    function showKickModal(html) {
      const backdrop = document.getElementById('kickModalBackdrop');
      const content = document.getElementById('kickModalContent');
      if (!backdrop || !content) {
        alert('Похоже, вы не особо нужны бункеру. Ведущий изгнал вас из лобби.');
        showPage('find');
        return;
      }
      content.innerHTML = html;
      backdrop.style.display = 'flex';
    }

    function hideKickModal() {
      const backdrop = document.getElementById('kickModalBackdrop');
      if (backdrop) backdrop.style.display = 'none';
      showPage('find');
    }

    function maybeHandleLobbyKick() {
      if (!nickname) return false;

      const pid = currentPlayerId();
      const kickedRoom = rooms.find(room =>
        (room.kickedPlayers || []).some(k => k.name === nickname || k.playerId === pid)
      );

      if (!kickedRoom) return false;

      const stillInRoom = (kickedRoom.players || []).some(p => p.name === nickname || p.playerId === pid);
      if (stillInRoom) return false;

      const kicked = (kickedRoom.kickedPlayers || []).find(k => k.name === nickname || k.playerId === pid);
      const seenKey = `bz_seen_kick_${kickedRoom.id}_${kicked.name || nickname}_${kicked.at || ''}`;

      if (localStorage.getItem(seenKey)) return false;
      localStorage.setItem(seenKey, '1');

      currentRoomId = '';
      localStorage.setItem('bz_current_room', '');
      game = null;
      localStorage.removeItem('bz_game');

      const html = `
        <div class="final-summary">
          <div class="final-summary-header">
            <div class="final-summary-title">🚪 Похоже, вы не особо нужны бункеру</div>
            <div class="final-summary-grid">
              <div class="final-stat"><span>Комната</span><strong>${kickedRoom.id}</strong></div>
              <div class="final-stat"><span>Причина</span><strong>Ведущий изгнал вас из лобби</strong></div>
            </div>
          </div>
          <div class="final-section">
            <h3>Что дальше?</h3>
            <div class="final-list">
              <span class="final-pill loser">Вы больше не можете войти в это лобби</span>
              <span class="final-pill winner">Можно выбрать другое лобби</span>
            </div>
          </div>
        </div>
      `;

      saveCurrentPage('find');
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      const findPage = document.getElementById('page-find');
      if (findPage) findPage.classList.add('active');

      showKickModal(html);
      return true;
    }

    function logLobbyKick(r, targetName) {
      if (!r) return;
      r.lobbyLog = r.lobbyLog || [];
      r.lobbyLog.unshift(`[${new Date().toLocaleTimeString('ru-RU', {hour:'2-digit', minute:'2-digit'})}] ${targetName} изгнан ведущим из лобби.`);
      r.lobbyLog = r.lobbyLog.slice(0, 20);
    }

    function kickLobbyPlayer(playerId) {
      const r = room();
      if (!r) return alert('Комната не найдена.');
      if (!isCurrentHost()) return alert('Изгонять участников может только ведущий.');
      if (r.status !== 'Ожидание') return alert('Изгонять можно только до запуска матча.');

      normalizeRoomPlayers(r);
      const target = r.players.find(p => String(p.playerId) === String(playerId) || String(p.id) === String(playerId));
      if (!target) return alert('Игрок не найден.');
      if (target.host || target.name === r.host || target.playerId === r.hostPlayerId) return alert('Ведущего нельзя изгнать.');

      r.kickedPlayers = r.kickedPlayers || [];
      r.kickedPlayers.push({
        name: target.name,
        playerId: target.playerId || '',
        at: Date.now(),
        by: nickname
      });

      r.players = r.players.filter(p => p !== target);
      logLobbyKick(r, target.name);
      transferHostIfNeeded(r);
      saveState();

      if (onlineMode && onlineDb) {
        onlineDb.ref(`${ONLINE_ROOT}/rooms/${r.id}`).set(r);
      }

      renderAll();
    }




    function saveNickname() {
      const value = document.getElementById('nicknameInput').value.trim();
      if (!value) return alert('Введи никнейм.');
      nickname = value;
      saveState();
      showPage('home');
    }

    function changeNickname() {
      const input = document.getElementById('changeNicknameInput');
      const value = input.value.trim();
      if (!value) return alert('Введи новый никнейм.');
      const oldName = nickname;
      nickname = value;

      rooms.forEach(r => {
        if (r.host === oldName) r.host = value;
        r.players.forEach(p => { if (p.name === oldName) p.name = value; });
      });

      if (game) game.players.forEach(p => { if (p.name === oldName) p.name = value; });

      input.value = '';
      saveState();
      renderAll();
    }

    function openCreateLobby() {
      if (!nickname) return showPage('register');
      pendingCreateRoomId = code();
      document.getElementById('lobbyName').value = `ROOM: ${pendingCreateRoomId}`;
      showPage('create');
    }

    function createLobbyFromForm() {
      if (!nickname) return showPage('register');
      const maxPlayers = Number(document.getElementById('maxPlayersSelect').value);
      const packKey = document.getElementById('packSelect').value;
      const seatValue = document.getElementById('seatSelect').value;
      const seats = Math.max(2, Number(seatValue));
      const survival = randomSurvivalDuration();
      const generatedRoomId = pendingCreateRoomId || code();
      const roomNameInput = document.getElementById('lobbyName').value.trim();

      const newRoom = {
        id: generatedRoomId,
        name: roomNameInput.startsWith('ROOM:')
          ? `ROOM: ${generatedRoomId}`
          : (roomNameInput || `ROOM: ${generatedRoomId}`),
        host: nickname,
        packKey,
        packName: getPack(packKey).name,
        maxPlayers,
        seats: Math.min(seats, maxPlayers - 1),
        timer: 120,
        survivalMonths: survival.months,
        survivalText: survival.text,
        years: Math.max(1, Math.ceil(survival.months / 12)),
        status: 'Ожидание',
        players: [{ id: Date.now(), playerId: currentPlayerId(), joinedAt: Date.now(), name: nickname, host: true, ready: true, online: true, lastSeen: Date.now() }],
        created: new Date().toLocaleString('ru-RU'),
        createdMs: Date.now()
      };
      rooms = rooms.filter(r => r.status !== 'Завершена');
      rooms.unshift(newRoom);
      currentRoomId = newRoom.id;
      pendingCreateRoomId = '';
      game = null;
      votes = {};
      localStorage.removeItem('bz_game');
      localStorage.removeItem('bz_votes_' + currentRoomId);
      if (onlineMode && onlineDb) {
        onlineDb.ref(`${ONLINE_ROOT}/games/${currentRoomId}`).remove();
        onlineDb.ref(`${ONLINE_ROOT}/votes/${currentRoomId}`).remove();
      }
      subscribedRoomId = '';
      subscribeCurrentRoom();
      saveState();
      showPage('lobby');
    }

    
    function joinLobbyById() {
      const input = document.getElementById('joinRoomIdInput');
      const id = (input?.value || '').trim().toUpperCase();
      if (!id) return alert('Введи ID комнаты.');
      joinLobby(id);
    }

function joinLobby(id) {
      if (!nickname) return showPage('register');
      id = String(id || '').trim().toUpperCase();
      const r = rooms.find(x => x.id === id);
      if (!r) return alert('Комната не найдена.');

      if ((r.kickedPlayers || []).some(k => k.name === nickname || k.playerId === currentPlayerId())) {
        alert('Вас изгнали из этого лобби.');
        return showPage('find');
      }

      currentRoomId = r.id;
      localStorage.setItem('bz_current_room', currentRoomId);
      clearGameIfDifferentRoom();
      subscribeCurrentRoom();

      const alreadyInRoom = r.players.some(p => p.name === nickname);

      if (r.status === 'Игра идёт') {
        if (!alreadyInRoom) {
          alert('Матч уже идёт. Новые игроки не добавляются, но можно переподключиться под ником игрока из этой комнаты.');
          return showPage('find');
        }

        if (game && game.roomId === r.id) return showPage('game');

        if (onlineMode && onlineDb) {
          onlineDb.ref(`${ONLINE_ROOT}/games/${r.id}`).once('value').then(snapshot => {
            const remoteGame = snapshot.val();
            if (remoteGame) {
              game = remoteGame;
              localStorage.setItem('bz_game', JSON.stringify(game));
              showPage('game');
            } else {
              showPage('lobby');
            }
          });
          return;
        }

        return game ? showPage('game') : showPage('lobby');
      }

      if (r.players.length >= r.maxPlayers && !alreadyInRoom) return alert('Комната заполнена.');
      if (!alreadyInRoom) r.players.push({ id: Date.now(), playerId: currentPlayerId(), joinedAt: Date.now(), name: nickname, host: false, ready: true, online: true, lastSeen: Date.now() });
      else {
        const me = r.players.find(p => p.name === nickname);
        if (me) {
          me.playerId = me.playerId || currentPlayerId();
          me.joinedAt = me.joinedAt || me.id || Date.now();
          me.lastSeen = Date.now();
          me.online = true;
          if (r.hostPlayerId && me.playerId !== r.hostPlayerId) me.host = false;
        }
      }
      transferHostIfNeeded(r);

      saveState();
      showPage('lobby');
    }

    function addBotPlayer() {
      const r = room();
      if (!r) return alert('Сначала создай комнату.');
      if (r.players.length >= r.maxPlayers) return alert('Комната уже заполнена.');
      const botNames = ['Адам', 'Ева', 'Сталкер', 'Док', 'Механик', 'Фермер', 'Химик', 'Повар', 'Охотник', 'Психолог'];
      let name = randomFrom(botNames);
      while (r.players.some(p => p.name === name)) name = randomFrom(botNames) + Math.floor(Math.random() * 99);
      r.players.push({ id: Date.now() + Math.random(), name, host: false, ready: true, bot: true });
      saveState();
      renderAll();
    }

    function closeCurrentLobby() {
      if (!currentRoomId) return;
      const r = room();
      if (r && r.host === nickname) {
        r.status = 'Завершена';
        if (game && game.roomId === r.id) {
          game.votingOpen = false;
          game.activeEvent = null;
          game.finalSummary = 'Лобби завершено, потому что ведущий вышел из комнаты.';
          if (game.history) game.history.unshift(`[${new Date().toLocaleTimeString('ru-RU', {hour:'2-digit', minute:'2-digit'})}] Лобби завершено: ведущий вышел из комнаты.`);
        }
      } else if (r) {
        r.players = r.players.filter(p => p.name !== nickname);
      }
      currentRoomId = '';
      saveState();
      showPage('home');
    }

    function isCurrentHost() {
      const r = room();
      if (!r) return false;
      const pid = currentPlayerId();
      return r.host === nickname || (r.hostPlayerId && r.hostPlayerId === pid);
    }

    function isCurrentGameHost() {
      if (!game) return false;
      const pid = currentPlayerId();
      const me = game.players.find(p => p.name === nickname || p.playerId === pid);
      return !!me && me.host;
    }

    function goToCurrentRoom() {
      if (!currentRoomId) return showPage('find');
      const r = room();
      if (!r) return showPage('find');
      subscribeCurrentRoom();
      if (r.status === 'Игра идёт' && game) showPage('game');
      else showPage('lobby');
    }

    function startGameFromLobby() {
      const r = room();
      if (!r) return alert('Комната не найдена.');
      if (!isCurrentHost()) return alert('Запустить лобби может только ведущий.');
      if (r.players.length < 3) return alert('Нужно хотя бы 3 игрока. Для теста добавь ботов.');
      const pack = getPack(r.packKey);
      if (!isPackReady(r.packKey)) return alert('Этот пак пока пустой. Заполнен только классический пак.');
      r.status = 'Игра идёт';
      timerTotal = 120;
      timerLeft = 120;
      game = {
        roomId: r.id,
        round: 1,
        seats: r.seats,
        years: r.years,
        survivalMonths: r.survivalMonths || r.years * 12,
        survivalText: r.survivalText || `${r.years} лет`,
        ...(function(){
          const totalMonths = (r.survivalMonths || r.years * 12);

          // Еда: 45-55%
          const foodPercent = 0.45 + Math.random() * 0.10;

          // Вода: 50-60%
          const waterPercent = 0.50 + Math.random() * 0.10;

          return {
            food: formatDurationMonths(Math.max(3, Math.round(totalMonths * foodPercent))),
            water: formatDurationMonths(Math.max(4, Math.round(totalMonths * waterPercent)))
          };
        })(),
        condition: randomFrom(pack.conditions),
        scenario: randomFrom(pack.scenarios),
        bunker: makeBunkerText(r),
        history: [],
        finalSummary: '',
        gameOver: false,
        votingOpen: false,
        roundOpeningActive: false,
        currentTurnPlayerId: null,
        turnTimeLeft: 0,
        turnCooldownLeft: 0,
        eventCheckedThisRound: false,
        activeEvent: null,
        specialAction: null,
        specialNotice: null,
        voteBans: {},
        players: r.players.map((p, index) => ({
          id: index + 1,
          playerId: p.playerId || ('legacy_' + p.name),
          joinedAt: p.joinedAt || p.id || Date.now() + index,
          name: p.name,
          host: (p.playerId && p.playerId === r.hostPlayerId) || p.name === r.host,
          online: isPlayerOnline(p),
          lastSeen: p.lastSeen || Date.now(),
          alive: true,
          exiled: false,
          status: 'в игре',
          winner: false,
          exclusionShield: false,
          usedSpecials: {},
          cards: makePlayerCards(),
          revealed: {
            profession:false, health:false, bodyType:false, hobby:false, biology:false, skill:false, backpack:false, inventory:false, character:false, phobia:false, fact:false, fact2:false, special1:false, special2:false
          }
        }))
      };
      game.history.unshift(`[${new Date().toLocaleTimeString('ru-RU', {hour:'2-digit', minute:'2-digit'})}] Игра запущена. Пак: ${r.packName}. Игроков: ${r.players.length}. Мест: ${r.seats}.`);
      votes = {};
      if (onlineMode && onlineDb) {
        onlineDb.ref(`${ONLINE_ROOT}/votes/${r.id}`).remove();
      }
      saveState();
      showPage('game');
    }

    function makeBunkerText(r) {
      const size = 50 + r.maxPlayers * 12;
      const systems = ['медблок', 'мастерская', 'склад еды', 'фильтрация воды', 'генератор', 'спальный отсек', 'радиорубка', 'теплица'];
      return `Площадь: ${size} м². Есть: ${randomFrom(systems)}, ${randomFrom(systems)}, ${randomFrom(systems)}. Мест доступно: ${r.seats}. Нужно выживать: ${r.years} ${r.years === 1 ? 'год' : r.years < 5 ? 'года' : 'лет'}.`;
    }

    function makePlayerCards() {
      return {
        profession: randomFrom(cards.profession),
        ...(function(){
          const category = randomFrom(['perfect','light','medium','heavy']);
          return {
            health: randomFrom(cards.healthCategories[category]),
            healthStage: category
          };
        })(),
        hobby: randomFrom(cards.hobby),
        biology: randomFrom(cards.biology),
        bodyType: cards.bodyType(),
        skill: randomFrom(cards.skill),
        backpack: randomFrom(cards.backpack),
        inventory: randomFrom(cards.inventory),
        character: randomFrom(cards.character),
        phobia: randomFrom(cards.phobia),
        fact: randomFrom(cards.fact),
        fact2: randomFrom(cards.fact),
        ...(function(){
          const special1 = randomFrom(cards.special);
          const special2 = randomDifferentFrom(cards.special, special1);
          return { special1, special2 };
        })()
      };
    }

    function maybeTriggerRoundEvent() {
      if (!game) return;
      if (game.roundOpeningActive) return;
      game.activeEvent = null;
      if (Math.random() > 0.25) return;
      const story = randomFrom(roundEventStories);
      game.activeEvent = {
        id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        createdAt: Date.now(),
        type: 'hidden_box',
        joinedBy: null,
        resolved: false,
        result: '',
        title: story.title,
        story: story.story
      };
      log('Появилось событие раунда: опасная вылазка за скрытым ящиком. Первый нажавший участвует.');
    }

    function joinRoundEvent() {
      if (!game || !game.activeEvent || game.activeEvent.resolved) return;
      if (game.activeEvent.joinedBy) return alert('В событии уже участвует другой игрок.');
      const player = game.players.find(p => p.name === nickname && p.alive && !p.exiled);
      if (!player) return alert('Только живой игрок может участвовать.');

      game.activeEvent.joinedBy = player.name;
      const roll = Math.random() * 100;

      const newItem = randomFrom(cards.inventory);

      if (roll <= 30) {
        const joke = randomFrom(eventHumor.success);
        player.cards.inventory += `, ${newItem}`;
        game.activeEvent.result = `<strong>${player.name}</strong> вскрыл тайник и забрал предмет: <strong>${newItem}</strong>.<br><br>${joke}`;
        log(plainText(game.activeEvent.result));
      } else if (roll <= 90) {
        const joke = randomFrom(eventHumor.hurt);
        player.cards.inventory += `, ${newItem}`;
        const currentHealth = player.cards.health;
        const currentStage = player.cards.healthStage || 'medium';
        const progression = getDiseaseProgression(currentHealth, currentStage);
        const isHeavyDisease = currentStage === 'heavy';

        if (isHeavyDisease) {
          const deathReason = diseaseDeaths[currentHealth] || 'Организм не выдержал критического состояния';
          player.alive = false;
          player.exiled = true;
          player.status = 'погиб';
          game.activeEvent.result = `<strong>${player.name}</strong> погиб.<br><br>Причина смерти: ☠️ ${deathReason}.`;
          log(plainText(game.activeEvent.result));
          game.activeEvent.resolved = true;
          saveState();
          if (checkGameEndAfterElimination()) {
            showEventModal(game.activeEvent.result);
            return;
          }
          renderAll();
          showEventModal(game.activeEvent.result);
          return;
        }

        if (progression) {
          player.cards.health = progression.next;
          player.cards.healthStage = progression.stage;
        } else {
          const safeFallbackByStage = {
            perfect: { next: 'Простуда', stage: 'light' },
            light: { next: 'Тахикардия', stage: 'medium' },
            medium: { next: 'Организм медленно отказывает', stage: 'heavy' }
          };
          const fallback = safeFallbackByStage[currentStage] || safeFallbackByStage.medium;
          player.cards.health = fallback.next;
          player.cards.healthStage = fallback.stage;
        }
        player.revealed.health = true;
        game.activeEvent.result = `<strong>${player.name}</strong> забрал предмет: <strong>${newItem}</strong>, но здоровье ухудшилось.<br><br>${joke}`;
        log(plainText(game.activeEvent.result));
      } else {
        const joke = randomFrom(eventHumor.death);
        player.alive = false;
        player.exiled = true;
        player.status = 'погиб';
        game.activeEvent.result = `<strong>${player.name}</strong> погиб во время вылазки.<br><br>${joke}`;
        log(plainText(game.activeEvent.result));
      }

      game.activeEvent.resolved = true;
      saveState();
      if (checkGameEndAfterElimination()) {
        showEventModal(game.activeEvent.result);
        return;
      }
      renderAll();
      showEventModal(game.activeEvent.result);

      setTimeout(() => {
        hideEventModal();
        if (game && game.activeEvent && game.activeEvent.resolved && game.activeEvent.joinedBy === player.name) {
          game.activeEvent = null;
          saveState();
          renderAll();
        }
      }, 5000);
    }

    let roundOpeningInterval = null;

    function clearRoundOpeningTimer() {
      if (roundOpeningInterval) clearInterval(roundOpeningInterval);
      roundOpeningInterval = null;
    }

    function ensureRoundOpeningTicker() {
      if (!game || !game.roundOpeningActive) {
        clearRoundOpeningTimer();
        return;
      }

      if (roundOpeningInterval) return;
      roundOpeningInterval = setInterval(handleRoundOpeningTick, 1000);
    }



    function startRoundOpening() {
      if (!game) return alert('Сначала запусти игру.');
      if (game.gameOver) return alert('Игра уже завершена.');
      if (!isCurrentGameHost()) return alert('Старт раунда может запускать только ведущий.');
      if (game.roundOpeningActive) return alert('Раунд уже идёт.');

      const queue = alivePlayers().map(p => p.id);
      if (!queue.length) return;

      const now = Date.now();
      game.roundOpeningActive = true;
      game.eventCheckedThisRound = false;
      game.turnQueue = queue;
      game.turnIndex = 0;
      game.currentTurnPlayerId = queue[0];
      game.turnStartedAt = now;
      game.turnEndsAt = now + REVEAL_TURN_SECONDS * 1000;
      game.turnTimeLeft = REVEAL_TURN_SECONDS;
      game.turnCooldownLeft = 0;

      log(`Раунд ${game.round}: старт раскрытия характеристик. Первый игрок: ${byId(game.currentTurnPlayerId)?.name || 'игрок'}.`);
      saveState();
      renderAll();
      ensureRoundOpeningTicker();
    }

    function handleRoundOpeningTick() {
      if (!game || !game.roundOpeningActive) {
        clearRoundOpeningTimer();
        return;
      }

      const now = Date.now();
      game.turnTimeLeft = Math.max(0, Math.ceil(((game.turnEndsAt || now) - now) / 1000));

      if (game.turnTimeLeft <= 0) {
        if (isCurrentGameHost()) {
          const current = byId(game.currentTurnPlayerId);
          if (current) log(`${current.name}: время на открытие характеристики закончилось.`);
          game.currentTurnPlayerId = null;
          moveToNextTurnPlayer();
          saveState();
        }
      }

      renderAll();
    }

    function moveToNextTurnPlayer() {
      if (!game || !game.roundOpeningActive) return;
      if (!isCurrentGameHost()) return;

      game.turnIndex++;

      if (game.turnIndex >= game.turnQueue.length) {
        finishRoundOpening();
        return;
      }

      const now = Date.now();
      game.currentTurnPlayerId = game.turnQueue[game.turnIndex];
      game.turnStartedAt = now;
      game.turnEndsAt = now + REVEAL_TURN_SECONDS * 1000;
      game.turnTimeLeft = REVEAL_TURN_SECONDS;
      game.turnCooldownLeft = 0;

      const current = byId(game.currentTurnPlayerId);
      log(`Ход переходит к игроку: ${current?.name || 'игрок'}.`);
      saveState();
      renderAll();
    }

    function forceRoundEvent() {
      if (!game) return;
      if (game.gameOver) return alert('Игра уже завершена.');
      if (!isCurrentGameHost()) return alert('Запускать событие может только ведущий.');
      if (game.roundOpeningActive) return alert('Событие можно запускать только после окончания представления характеристик.');
      if (game.activeEvent && !game.activeEvent.resolved) return alert('Событие уже активно.');
      game.eventCheckedThisRound = false;
      maybeTriggerRoundEvent();
      if (!game.activeEvent) {
        const story = randomFrom(roundEventStories);
        game.activeEvent = {
          id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
          createdAt: Date.now(),
          type: 'hidden_box',
          joinedBy: null,
          resolved: false,
          result: '',
          title: story.title,
          story: story.story
        };
      }
      saveState();
      renderAll();
    }

    function finishRoundOpening() {
      if (!game) return;
      clearRoundOpeningTimer();
      game.roundOpeningActive = false;
      game.currentTurnPlayerId = null;
      game.turnTimeLeft = 0;
      game.turnCooldownLeft = 0;
      log('Все игроки завершили этап открытия характеристик.');

      if (!game.eventCheckedThisRound) {
        game.eventCheckedThisRound = true;
        maybeTriggerRoundEvent();
      }

      saveState();
      renderAll();
    }

    function startVotingPhase() {
      if (!game) return alert('Сначала запусти игру.');
      if (game.gameOver) return alert('Игра уже завершена.');
      if (!isCurrentGameHost()) return alert('Запустить голосование может только ведущий.');
      if (game.roundOpeningActive) return alert('Нельзя запускать голосование во время представления характеристик.');
      game.votingOpen = true;
      votes = {};
      log('Ведущий запустил голосование. Голоса обновляются в реальном времени.');
      saveOnlineVotes();
      saveState();
      renderAll();
    }

    
    
    
    const traitKeysForSpecials = ['profession','health','bodyType','hobby','biology','skill','backpack','inventory','character','phobia','fact','fact2'];
    const traitNamesForSpecials = {
      profession: 'Профессия',
      health: 'Здоровье',
      bodyType: 'Телосложение',
      hobby: 'Хобби',
      biology: 'Биология',
      skill: 'Навык',
      backpack: 'Рюкзак',
      inventory: 'Инвентарь',
      character: 'Характер',
      phobia: 'Фобия',
      fact: 'Факт 1',
      fact2: 'Факт 2'
    };

    const specialActionMap = {
      'Иммунитет от одного исключения': { mode: 'instant', action: 'shield' },
      'Открыть одну чужую характеристику': { mode: 'trait', action: 'reveal_trait', traits: 'any_other' },
      'Поменяться рюкзаком': { mode: 'trait', action: 'swap_backpack', traits: ['backpack'] },
      'Поменяться профессией с другим игроком': { mode: 'trait', action: 'swap_profession', traits: ['profession'] },
      'Поменяться здоровьем с другим игроком': { mode: 'trait', action: 'swap_health', traits: ['health'] },
      'Украсть один предмет из инвентаря': { mode: 'trait', action: 'steal_inventory', traits: ['inventory'] },
      'Проверить одну закрытую характеристику без раскрытия': { mode: 'trait', action: 'peek_trait', traits: 'any_other' },
      'Вылечить здоровье любого игрока (повышает здоровье на 1 категорию)': { mode: 'trait', action: 'heal_health', traits: ['health'], includeSelf: true },
      'Запретить выбранному игроку голосовать один раунд': { mode: 'player', action: 'ban_vote' },
      'Поменять всю характеристику всех игроков (кроме спец. возможностей)': { mode: 'instant', action: 'reroll_all' },
      'Поменять факт о себе': { mode: 'trait', action: 'reroll_self_fact', traits: ['fact','fact2'], selfOnly: true },
      'Поменять свою профессию': { mode: 'trait', action: 'reroll_self_profession', traits: ['profession'], selfOnly: true },
      'Поменять свой характер': { mode: 'trait', action: 'reroll_self_character', traits: ['character'], selfOnly: true },
      'Поменять свою фобию': { mode: 'trait', action: 'reroll_self_phobia', traits: ['phobia'], selfOnly: true },
      'Поменять чужую профессию': { mode: 'trait', action: 'reroll_other_profession', traits: ['profession'] },
      'Поменять чужой характер': { mode: 'trait', action: 'reroll_other_character', traits: ['character'] },
      'Поменять чужую фобию': { mode: 'trait', action: 'reroll_other_phobia', traits: ['phobia'] }
    };

    function ensureSpecialState(p) {
      if (!p.usedSpecials) p.usedSpecials = {};
      if (!game.voteBans) game.voteBans = {};
      return p.usedSpecials;
    }

    function randomNewValue(key, oldValue = '') {
      let value = oldValue;
      let guard = 0;
      while (value === oldValue && guard < 20) {
        guard++;
        if (key === 'health') {
          const category = randomFrom(['perfect','light','medium','heavy']);
          return { health: randomFrom(cards.healthCategories[category]), healthStage: category };
        }
        if (key === 'bodyType') value = cards.bodyType();
        else if (key === 'fact2') value = randomFrom(cards.fact);
        else if (cards[key]) value = Array.isArray(cards[key]) ? randomFrom(cards[key]) : cards[key]();
        else value = oldValue;
      }
      return value;
    }

    function changeCardValue(player, key) {
      if (!player || !player.cards) return false;
      if (key === 'health') {
        const result = randomNewValue('health', player.cards.health);
        player.cards.health = result.health;
        player.cards.healthStage = result.healthStage;
      } else {
        player.cards[key] = randomNewValue(key, player.cards[key]);
      }
      if (player.revealed && key in player.revealed) player.revealed[key] = false;
      return true;
    }

    function improveHealthOneCategory(player) {
      if (!player || !player.cards) return false;
      const stage = player.cards.healthStage || 'medium';
      if (stage === 'perfect') return false;
      if (stage === 'light') {
        player.cards.healthStage = 'perfect';
        player.cards.health = randomFrom(cards.healthCategories.perfect);
        return true;
      }
      if (stage === 'medium') {
        player.cards.healthStage = 'light';
        player.cards.health = randomFrom(cards.healthCategories.light);
        return true;
      }
      player.cards.healthStage = 'medium';
      player.cards.health = randomFrom(cards.healthCategories.medium);
      return true;
    }

    function inventoryItems(player) {
      return String(player.cards.inventory || '').split(',').map(x => x.trim()).filter(Boolean);
    }

    function setInventoryItems(player, items) {
      player.cards.inventory = items.join(', ');
    }

    function canUseSpecial(p, key) {
      if (!game || game.gameOver || !p || !p.alive || p.exiled) return false;
      if (p.name !== nickname) return false;
      if (key !== 'special1' && key !== 'special2') return false;
      ensureSpecialState(p);
      return !p.usedSpecials[key] && !game.specialAction;
    }

    function startSpecialUse(playerId, key) {
      if (game && game.gameOver) return alert('Игра уже завершена.');
      const p = byId(playerId);
      if (!canUseSpecial(p, key)) return alert('Эту спецвозможность сейчас использовать нельзя.');
      const ability = p.cards[key];
      const config = specialActionMap[ability];
      if (!config) return alert('Для этой спецвозможности ещё нет механики.');

      if (config.mode === 'instant') {
        applySpecialAction(playerId, key, null, null);
        return;
      }

      game.specialAction = {
        ownerId: playerId,
        ownerName: p.name,
        specialKey: key,
        ability,
        mode: config.mode,
        action: config.action,
        traits: config.traits || [],
        selfOnly: !!config.selfOnly,
        includeSelf: !!config.includeSelf
      };
      saveState();
      renderAll();
    }

    function cancelSpecialAction() {
      if (!game || !game.specialAction) return;
      const owner = byId(game.specialAction.ownerId);
      if (!owner || owner.name !== nickname) return;
      game.specialAction = null;
      saveState();
      renderAll();
    }

    function isSpecialTargetPlayer(p) {
      if (!game || !game.specialAction || !p || !p.alive || p.exiled) return false;
      const action = game.specialAction;
      if (action.ownerName !== nickname) return false;
      if (action.mode !== 'player') return false;
      if (!action.includeSelf && p.id === action.ownerId) return false;
      return true;
    }

    function isSpecialTargetTrait(p, key) {
      if (!game || !game.specialAction || !p || !p.alive || p.exiled) return false;
      const action = game.specialAction;
      if (action.ownerName !== nickname) return false;
      if (action.mode !== 'trait') return false;
      if (action.selfOnly && p.id !== action.ownerId) return false;
      if (!action.selfOnly && !action.includeSelf && p.id === action.ownerId) return false;
      if (action.traits === 'any_other') return traitKeysForSpecials.includes(key);
      return Array.isArray(action.traits) && action.traits.includes(key);
    }

    function specialTraitButtonText(action) {
      if (!action) return 'Выбрать';
      if (action.action === 'peek_trait') return 'Проверить';
      if (action.action === 'reveal_trait') return 'Открыть';
      if (action.action.includes('swap')) return 'Поменяться';
      if (action.action.includes('reroll')) return 'Изменить';
      if (action.action === 'heal_health') return 'Вылечить';
      if (action.action === 'steal_inventory') return 'Украсть';
      return 'Выбрать';
    }

    function finishSpecialUse(owner, specialKey, ability, message) {
      owner.usedSpecials[specialKey] = true;
      if (owner.revealed) owner.revealed[specialKey] = true;
      game.specialAction = null;
      game.specialNotice = {
        id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        text: message,
        html: `<strong>${owner.name}</strong> применил спецвозможность:<br><br><span style="color:#ffe1a6;">${ability}</span><br><br>${message}`
      };
      log(message);
      saveState();
      renderAll();
      showSpecialModal(game.specialNotice.html);
    }

    function applySpecialAction(ownerId, specialKey, targetId = null, traitKey = null) {
      if (game && game.gameOver) return alert('Игра уже завершена.');
      const owner = byId(ownerId);
      if (!game || !owner || owner.name !== nickname || !owner.alive || owner.exiled) return;
      ensureSpecialState(owner);
      if (owner.usedSpecials[specialKey]) return alert('Эта спецвозможность уже использована.');
      const ability = owner.cards[specialKey];
      const action = specialActionMap[ability]?.action;
      const target = targetId ? byId(targetId) : null;
      let message = '';

      if (action === 'shield') {
        owner.exclusionShield = true;
        message = `${owner.name} активировал иммунитет от одного исключения.`;
      } else if (action === 'reveal_trait') {
        if (!target || !traitKey) return;
        target.revealed[traitKey] = true;
        message = `${owner.name} открыл характеристику "${label(traitKey)}" игрока ${target.name}.`;
      } else if (action === 'swap_backpack') {
        if (!target) return;
        [owner.cards.backpack, target.cards.backpack] = [target.cards.backpack, owner.cards.backpack];
        message = `${owner.name} поменялся рюкзаком с игроком ${target.name}.`;
      } else if (action === 'swap_profession') {
        if (!target) return;
        [owner.cards.profession, target.cards.profession] = [target.cards.profession, owner.cards.profession];
        message = `${owner.name} поменялся профессией с игроком ${target.name}.`;
      } else if (action === 'swap_health') {
        if (!target) return;
        [owner.cards.health, target.cards.health] = [target.cards.health, owner.cards.health];
        [owner.cards.healthStage, target.cards.healthStage] = [target.cards.healthStage, owner.cards.healthStage];
        message = `${owner.name} поменялся здоровьем с игроком ${target.name}.`;
      } else if (action === 'steal_inventory') {
        if (!target) return;
        const items = inventoryItems(target);
        if (!items.length) return alert('У этого игрока нет предметов в инвентаре.');

        const item = items.shift();
        const victimInventoryWasRevealed = !!(target.revealed && target.revealed.inventory);

        setInventoryItems(target, items);
        owner.cards.inventory = `${owner.cards.inventory}, ${item}`;

        // Если инвентарь жертвы закрыт, название украденного предмета не раскрывается в общем уведомлении.
        // Предмет всё равно добавляется в инвентарь вора. Если его инвентарь уже открыт — все увидят новый предмет в карточке.
        message = victimInventoryWasRevealed
          ? `${owner.name} украл предмет "${item}" у игрока ${target.name}.`
          : `${owner.name} украл один предмет у игрока ${target.name}.`;
      } else if (action === 'peek_trait') {
        if (!target || !traitKey) return;
        const value = traitKey === 'health' ? healthView(target) : target.cards[traitKey];
        showSpecialModal(`<strong>Проверка характеристики</strong><br><br>${target.name} — ${label(traitKey)}: <strong>${value}</strong>`);
        message = `${owner.name} тайно проверил одну закрытую характеристику.`;
      } else if (action === 'heal_health') {
        if (!target) return;
        const improved = improveHealthOneCategory(target);
        message = improved ? `${owner.name} вылечил здоровье игрока ${target.name} на 1 категорию.` : `${owner.name} попытался вылечить ${target.name}, но здоровье уже было в лучшей категории.`;
      } else if (action === 'ban_vote') {
        if (!target) return;
        game.voteBans[target.name] = game.round;
        message = `${owner.name} запретил игроку ${target.name} голосовать в этом раунде.`;
      } else if (action === 'reroll_all') {
        game.players.forEach(player => {
          if (!player.alive || player.exiled) return;
          const oldSpecial1 = player.cards.special1;
          const oldSpecial2 = player.cards.special2;
          const oldUsed = player.usedSpecials || {};
          player.cards = makePlayerCards();
          player.cards.special1 = oldSpecial1;
          player.cards.special2 = oldSpecial2;
          player.usedSpecials = oldUsed;
          Object.keys(player.revealed || {}).forEach(revealKey => {
            if (revealKey !== 'special1' && revealKey !== 'special2') player.revealed[revealKey] = false;
          });
        });
        message = `${owner.name} поменял все характеристики всех живых игроков, кроме спецвозможностей.`;
      } else if (action === 'reroll_self_fact') {
        changeCardValue(owner, traitKey || 'fact');
        message = `${owner.name} поменял свой факт.`;
      } else if (action === 'reroll_self_profession') {
        changeCardValue(owner, 'profession');
        message = `${owner.name} поменял свою профессию.`;
      } else if (action === 'reroll_self_character') {
        changeCardValue(owner, 'character');
        message = `${owner.name} поменял свой характер.`;
      } else if (action === 'reroll_self_phobia') {
        changeCardValue(owner, 'phobia');
        message = `${owner.name} поменял свою фобию.`;
      } else if (action === 'reroll_other_profession') {
        if (!target) return;
        changeCardValue(target, 'profession');
        message = `${owner.name} поменял профессию игрока ${target.name}.`;
      } else if (action === 'reroll_other_character') {
        if (!target) return;
        changeCardValue(target, 'character');
        message = `${owner.name} поменял характер игрока ${target.name}.`;
      } else if (action === 'reroll_other_phobia') {
        if (!target) return;
        changeCardValue(target, 'phobia');
        message = `${owner.name} поменял фобию игрока ${target.name}.`;
      } else {
        return alert('Для этой спецвозможности ещё нет механики.');
      }
      finishSpecialUse(owner, specialKey, ability, message);
    }

function canRevealTrait(p, key) {
      if (!game || !p || !p.alive || p.exiled || p.revealed[key]) return false;
      if (p.name !== nickname) return false;
      if (!game.roundOpeningActive) return false;
      if (game.currentTurnPlayerId !== p.id) return false;
      if ((game.turnEndsAt || 0) <= Date.now()) return false;
      return true;
    }

function reveal(playerId, key) {
      const p = byId(playerId);
      if (!canRevealTrait(p, key)) {
        showToast('Открывать можно только свои характеристики, только после старта ведущего и только в свой ход.', 3500);
        return;
      }

      p.revealed[key] = true;
      log(`${p.name} раскрывает: ${label(key)} — ${key === 'health' ? healthView(p) : p.cards[key]}.`);
      saveState();
      renderAll();
    }

    function label(key) {
      return {
        profession:'Профессия', health:'Здоровье', bodyType:'Телосложение', hobby:'Хобби', biology:'Пол/возраст', skill:'Навык', backpack:'Рюкзак', inventory:'Инвентарь', character:'Характер', phobia:'Фобия', fact:'Факт 1', fact2:'Факт 2', special1:'Спец. возможность 1', special2:'Спец. возможность 2'
      }[key];
    }

    function vote(targetId) {
      if (!game || !game.votingOpen) return alert('Голосование ещё не запущено ведущим.');
      const voter = game.players.find(p => p.name === nickname);
      if (!voter || !voter.alive || voter.exiled) return alert('Мёртвые и изгнанные игроки не голосуют.');
      if (game.voteBans && game.voteBans[nickname] === game.round) return alert('Тебе запрещено голосовать в этом раунде.');
      const voterKey = nickname || 'Игрок';
      votes[voterKey] = Number(targetId);
      saveOnlineVotes();
      renderVoting();
    }

    function cancelVoting() {
      if (!game) return;
      if (!isCurrentGameHost()) return alert('Прервать голосование может только ведущий.');
      if (!game.votingOpen) return;
      votes = {};
      game.votingOpen = false;
      saveOnlineVotes();
      log('Ведущий прервал голосование. Раунд продолжается без изгнания.');
      saveOnlineVotes();
      saveState();
      renderAll();
    }

    function finishVoting() {
      if (!game) return;
      if (!isCurrentGameHost()) return alert('Завершить голосование может только ведущий.');
      if (alivePlayers().length <= game.seats) return showWinners();

      const count = {};
      const validVoterNames = new Set(alivePlayers().map(p => p.name));
      Object.entries(votes).forEach(([voterName, id]) => {
        if (validVoterNames.has(voterName)) count[id] = (count[id] || 0) + 1;
      });
      const sorted = Object.entries(count).sort((a,b) => b[1] - a[1]);
      if (!sorted.length) return alert('Голосов ещё нет.');

      const active = alivePlayers();
      const allHaveOneVote = sorted.length === active.length && sorted.every(([, amount]) => amount === 1);
      if (allHaveOneVote) {
        votes = {};
        game.votingOpen = false;
        saveOnlineVotes();
        game.round++;
        game.eventCheckedThisRound = false;
        log('У всех игроков по 1 голосу. Раунд пропущен без изгнания. Начинается следующий раунд.');
        saveState();
        renderAll();
        return;
      }

      const maxVotes = sorted[0][1];
      const leaders = sorted.filter(([, amount]) => amount === maxVotes).map(([id]) => Number(id));
      const targetId = leaders.length > 1 ? leaders[Math.floor(Math.random() * leaders.length)] : leaders[0];
      const p = byId(targetId);
      if (!p) return;

      votes = {};
      game.votingOpen = false;
      saveOnlineVotes();

      if (p.exclusionShield) {
        p.exclusionShield = false;
        log(`${p.name} должен был быть изгнан, но иммунитет от одного исключения спас его.`);
        game.round++;
        game.eventCheckedThisRound = false;
        saveState();
        renderAll();
        return;
      }

      p.alive = false;
      p.exiled = true;
      p.status = 'изгнан';

      if (leaders.length > 1) log(`Ничья среди лидеров голосования. Случайно изгнан: ${p.name}. Теперь он наблюдает за игрой.`);
      else log(`${p.name} изгнан из бункера. Теперь он наблюдает за игрой.`);

      game.round++;
      game.eventCheckedThisRound = false;
      saveState();
      if (alivePlayers().length <= game.seats) return showWinners();
      renderAll();
    }

    function checkGameEndAfterElimination() {
      if (!game) return false;
      if (alivePlayers().length <= game.seats) {
        showWinners();
        return true;
      }
      return false;
    }

    function showWinners() {
      if (!game) return;
      game.players.forEach(p => p.winner = p.alive && !p.exiled && alivePlayers().length <= game.seats);

      const winnersList = game.players.filter(p => p.winner).map(p => p.name);
      const losersList = game.players.filter(p => p.exiled || !p.alive).map(p => p.name);

      const winnersHtml = winnersList.length
        ? winnersList.map(name => `<span class="final-pill winner">🏆 ${name}</span>`).join('')
        : '<span class="final-pill">нет</span>';

      const losersHtml = losersList.length
        ? losersList.map(name => `<span class="final-pill loser">☠️ ${name}</span>`).join('')
        : '<span class="final-pill">нет</span>';

      const winners = winnersList.join(', ');
      const r = room();

      game.gameOver = true;
      game.votingOpen = false;
      game.roundOpeningActive = false;
      game.activeEvent = null;
      game.specialAction = null;
      game.finalNoticeId = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      game.finalSummary = `
        <div class="final-summary">
          <div class="final-summary-header">
            <div class="final-summary-title">🏁 Партия завершена</div>
            <div class="final-summary-grid">
              <div class="final-stat"><span>Комната</span><strong>${game.roomId}</strong></div>
              <div class="final-stat"><span>Раундов сыграно</span><strong>${game.round}</strong></div>
              <div class="final-stat"><span>Мест в бункере</span><strong>${game.seats}</strong></div>
              <div class="final-stat"><span>Срок выживания</span><strong>${game.survivalText || `${game.years} лет`}</strong></div>
              <div class="final-stat"><span>Еда</span><strong>${game.food}</strong></div>
              <div class="final-stat"><span>Вода</span><strong>${game.water}</strong></div>
            </div>
          </div>

          <div class="final-section">
            <h3>✅ Прошли в бункер</h3>
            <div class="final-list">${winnersHtml}</div>
          </div>

          <div class="final-section">
            <h3>❌ Не прошли / погибли</h3>
            <div class="final-list">${losersHtml}</div>
          </div>
        </div>
      `;

      if (r) r.status = 'Завершена';
      log(`Финал. В бункер проходят: ${winners || 'никто'}.`);
      saveState();
      renderAll();
      showFinalModal(game.finalSummary);
    }

    function setFilter(value) { filter = value; renderPlayers(); renderTabs(); }

    function startTimer() {
      pauseTimer();
      timerInterval = setInterval(() => {
        timerLeft--;
        if (timerLeft <= 0) { timerLeft = 0; pauseTimer(); log('Время ведущего вышло.'); }
        }, 1000);
    }
    function pauseTimer() { if (timerInterval) clearInterval(timerInterval); timerInterval = null; }
    function setHostTimer() {
      const select = document.getElementById('hostTimerSelect');
      if (!select) return;
      timerTotal = Number(select.value);
      timerLeft = timerTotal;
      const r = room();
      if (r) r.timer = timerTotal;
      saveState();
    }
    function resetTimer() { pauseTimer(); timerLeft = timerTotal || 120; renderTimer(); }

    function renderTimer() {
      const timerEl = document.getElementById('timer');
      const barEl = document.getElementById('timerBar');
      if (!timerEl || !barEl) return;
      const m = String(Math.floor(timerLeft / 60)).padStart(2, '0');
      const s = String(timerLeft % 60).padStart(2, '0');
      timerEl.textContent = `${m}:${s}`;
      barEl.style.width = (timerTotal ? ((timerTotal - timerLeft) / timerTotal) * 100 : 0) + '%';
    }

    function renderHome() {
      document.getElementById('currentNameView') && (document.getElementById('currentNameView').textContent = nickname || '—');
    }

    function renderActiveRooms() {
      const box = document.getElementById('activeRoomsGrid');
      if (!box) return;
      closeOrphanWaitingLobbies();
      const active = rooms.filter(r => r.status !== 'Завершена');
      box.innerHTML = '';
      if (!active.length) { box.innerHTML = '<p class="small">Активных лобби пока нет.</p>'; return; }
      active.forEach(r => {
        const el = document.createElement('div');
        el.className = 'room-card';
        const alreadyInside = r.players.some(p => p.name === nickname);
        const buttonText = r.status === 'Игра идёт'
          ? (alreadyInside ? 'Вернуться в матч' : 'Переподключиться к матчу')
          : (alreadyInside ? 'Вернуться в лобби' : 'Войти в лобби');

        el.innerHTML = `
          <div class="card-title"><h3>${r.name}</h3><span class="badge">${r.status}</span></div>
          <p class="small">ID: <strong>${r.id}</strong> · Ведущий: <span class="host-label">${r.host}</span></p>
          <div class="kv">
            <div><span>Пак</span><strong>${r.packName}</strong></div>
            <div><span>Игроки</span><strong>${r.players.length}/${r.maxPlayers}</strong></div>
            <div><span>Мест</span><strong>${r.seats}</strong></div>
            <div><span>Выживать</span><strong>${r.survivalText || `${r.years} лет`}</strong></div>
          </div>
          <button style="margin-top:12px;" onclick="joinLobby('${r.id}')">${buttonText}</button>
        `;
        box.appendChild(el);
      });
    }

    function renderLobby() {
      const r = room();
      if (!r) return;
      document.getElementById('lobbyCodeView').textContent = r.id;
      document.getElementById('bigRoomCode').textContent = r.id;
      document.getElementById('lobbyHostView').textContent = r.host;
      document.getElementById('lobbyPackView').textContent = r.packName;
      document.getElementById('lobbyCountView').textContent = `${r.players.length}/${r.maxPlayers}`;
      document.getElementById('lobbyNameView').textContent = r.name;
      document.getElementById('lobbyStatusView').textContent = r.status;
      document.getElementById('lobbySeatsView').textContent = r.seats;
      document.getElementById('lobbyYearsView').textContent = r.survivalText || `${r.years} лет`;

      const controls = document.getElementById('lobbyControls');
      if (controls) {
        if (isCurrentHost()) {
          controls.innerHTML = `
            <button class="good" onclick="startGameFromLobby()">Запустить лобби</button>
            <button class="secondary" onclick="addBotPlayer()">Добавить бота для теста</button>
            <button class="danger" onclick="closeCurrentLobby()">Закрыть комнату</button>
            <p class="small">Только ведущий может запускать лобби, добавлять ботов и изгонять участников.</p>
          `;
        } else {
          controls.innerHTML = `
            <button class="secondary" onclick="closeCurrentLobby()">Покинуть лобби</button>
            <p class="small">Ожидайте запуска матча ведущим.</p>
          `;
        }
      }

      if (r.status === 'Игра идёт' && game && localStorage.getItem('bz_current_page') === 'lobby') {
        setTimeout(() => showPage('game'), 0);
      }

      const box = document.getElementById('lobbyPlayersGrid');
      box.innerHTML = '';
      r.players.forEach(p => {
        const el = document.createElement('div');
        el.className = 'player-card';
        const canKick = isCurrentHost() && r.status === 'Ожидание' && !p.host && p.name !== r.host;
        el.innerHTML = `
          <div class="player-title">
            <h3 class="${p.host ? 'host-name' : ''}">${p.name}</h3>
            <div class="row">
              <span class="badge ${p.host ? 'host-badge' : ''}">${p.host ? 'ведущий' : p.bot ? 'бот' : 'игрок'}</span>
              ${canKick ? `<button class="danger" onclick="kickLobbyPlayer('${p.playerId || p.id}')">Изгнать</button>` : ''}
            </div>
          </div>
          <p class="small">Статус: ${onlineStatusHtml(p)}</p>
        `;
        box.appendChild(el);
      });
    }

    function renderGame() {
      if (!game) return;
      normalizeGamePlayers();
      if (game.roomId && currentRoomId !== game.roomId) {
        currentRoomId = game.roomId;
        localStorage.setItem('bz_current_room', currentRoomId);
        subscribeCurrentRoom();
      }

      document.querySelectorAll('.host-only').forEach(el => {
        el.style.display = (isCurrentGameHost() && !game.gameOver) ? '' : 'none';
      });

      document.querySelectorAll('[onclick="forceRoundEvent()"]').forEach(el => {
        el.disabled = !!game.roundOpeningActive || !!game.gameOver || !isCurrentGameHost();
        el.title = game.gameOver ? 'Игра завершена' : (game.roundOpeningActive ? 'Событие можно запустить после окончания представления характеристик' : '');
      });

      const chroniclesButton = document.getElementById('gameChroniclesButton');
      if (chroniclesButton) chroniclesButton.style.display = game.gameOver ? '' : 'none';

      document.getElementById('statRound').textContent = game.round;
      document.getElementById('statSeats').textContent = game.seats;
      document.getElementById('statAlive').textContent = alivePlayers().length;
      document.getElementById('scenario').textContent = game.scenario;
      document.getElementById('bunkerInfo').textContent = game.bunker;
      document.getElementById('gameYearsView').textContent = game.survivalText || `${game.years} лет`;
      document.getElementById('gameFoodView').textContent = game.food;
      document.getElementById('gameWaterView').textContent = game.water;
      document.getElementById('gameConditionView').textContent = game.condition;
      document.getElementById('log').innerHTML = game.history.map(h => `<div>${h}</div>`).join('');
      ensureRoundOpeningTicker();
      renderPlayers();
      renderVoting();
      renderRoundEvent();
      maybeShowSpecialNotice();
      maybeShowFinalNotice();
    }

    function renderRoundEvent() {
      const panel = document.getElementById('eventPanel');
      const content = document.getElementById('eventContent');
      const button = document.getElementById('joinEventButton');
      if (!panel || !content || !button) return;

      const pageNow = localStorage.getItem('bz_current_page') || currentPage;

      if (!game || !game.activeEvent || pageNow !== 'game') {
        panel.style.display = 'none';
        hideToast();
        return;
      }

      panel.style.display = 'block';
      const ev = game.activeEvent;

      if (!ev.id) ev.id = `${game.roomId || 'room'}_${game.round || 0}_event`;
      if (!ev.createdAt) ev.createdAt = Date.now();

      if (ev.resolved) {
        content.innerHTML = `<div class="event-outcome">${ev.result}</div>`;
        button.disabled = true;
        button.textContent = 'Событие завершено';
        hideToast();
        return;
      }

      const elapsed = Date.now() - Number(ev.createdAt || Date.now());
      const remaining = Math.max(0, 10000 - elapsed);

      if (remaining > 0) {
        if (displayedEventToastId !== ev.id) {
          displayedEventToastId = ev.id;
          showToast('Началось событие раунда: опасная вылазка. Первый нажавший участвует.', remaining, false, true);
        }
      } else if (displayedEventToastId === ev.id) {
        hideToast();
      }

      content.innerHTML = `
        <strong>${ev.title || 'Опасная вылазка'}</strong><br><br>
        ${ev.story || 'В опасной зоне найден подозрительный ящик. Первый игрок, нажавший участие, отправляется за добычей.'}<br><br>
        Исход вылазки неизвестен. Бункер не обязан быть честным.
      `;
      button.disabled = false;
      button.textContent = 'Участвовать';
    }

    function renderTabs() {
      ['All','Alive','Dead'].forEach(name => document.getElementById('tab' + name)?.classList.remove('active'));
      document.getElementById('tab' + (filter === 'all' ? 'All' : filter === 'alive' ? 'Alive' : 'Dead'))?.classList.add('active');
    }

    function kickOfflineMatchPlayer(playerId) {
      if (!game) return;
      if (!isCurrentGameHost()) return alert('Изгонять вышедших игроков может только ведущий.');
      if (game.gameOver) return alert('Игра уже завершена.');

      const target = game.players.find(p => Number(p.id) === Number(playerId));
      if (!target) return alert('Игрок не найден.');
      if (target.host) return alert('Ведущего нельзя изгнать.');
      if (isPlayerOnline(target)) return alert('Этот игрок сейчас онлайн.');
      if (target.exiled || !target.alive) return alert('Игрок уже не участвует.');

      target.alive = false;
      target.exiled = true;
      target.status = 'изгнан';
      log(`${target.name} изгнан ведущим, потому что вышел из матча.`);

      saveState();
      if (checkGameEndAfterElimination()) return;
      renderAll();
    }

    function renderPlayers() {
      const grid = document.getElementById('playersGrid');
      if (!grid || !game) return;
      let list = [...game.players];
      if (filter === 'alive') list = list.filter(p => p.alive && !p.exiled);
      if (filter === 'dead') list = list.filter(p => !p.alive || p.exiled);
      grid.innerHTML = '';

      if (game.specialAction && game.specialAction.ownerName === nickname) {
        const hint = document.createElement('div');
        hint.className = 'special-action-hint';
        hint.innerHTML = `Вы используете спецвозможность: <strong>${game.specialAction.ability}</strong>. Выберите цель на карточках игроков. <button class="secondary" onclick="cancelSpecialAction()">Отмена</button>`;
        grid.appendChild(hint);
      }

      list.forEach(p => {
        const el = document.createElement('div');
        el.className = 'player-card compact'
          + (p.exiled || !p.alive ? ' dead exiled' : '')
          + (p.winner ? ' winner' : '')
          + (game.currentTurnPlayerId === p.id ? ' active-turn-card' : '')
          + (isSpecialTargetPlayer(p) ? ' special-target-card' : '');
        el.innerHTML = `
          <div class="player-title">
            <div>
              <h3 class="${p.host ? 'host-name' : ''}">${p.name}</h3>
              ${isSpecialTargetPlayer(p) ? `<button class="good" onclick="applySpecialAction(${game.specialAction.ownerId}, '${game.specialAction.specialKey}', ${p.id}, null)">Выбрать игрока</button>` : ''}
              <div class="private-note">${p.name === nickname ? '' : ''}</div>
              ${turnStatusHtml(p)}
            </div>
            <div class="row">
              ${onlineStatusHtml(p)}
              <span class="badge ${p.host ? 'host-badge' : ''}">${p.winner ? 'выжил' : p.status === 'погиб' ? 'погиб · наблюдает' : p.exiled ? 'изгнан · наблюдает' : p.alive ? (p.host ? 'ведущий' : 'в игре') : 'изгнан · наблюдает'}</span>
              ${isCurrentGameHost() && !game.gameOver && !p.host && p.alive && !p.exiled && !isPlayerOnline(p) ? `<button class="danger" onclick="kickOfflineMatchPlayer(${p.id})">Изгнать</button>` : ''}
            </div>
          </div>
          <div class="traits-board">
            ${traitHtml(p, 'biology')}
            ${traitHtml(p, 'health')}
            ${traitHtml(p, 'bodyType')}
            ${traitHtml(p, 'profession')}
            ${traitHtml(p, 'hobby')}
            ${traitHtml(p, 'skill')}
            ${traitHtml(p, 'backpack')}
            ${traitHtml(p, 'inventory')}
            ${traitHtml(p, 'character')}
            ${traitHtml(p, 'phobia')}
            ${traitHtml(p, 'fact')}
            ${traitHtml(p, 'fact2')}
          </div>
          <div class="specials-row">
            ${traitHtml(p, 'special1')}
            ${traitHtml(p, 'special2')}
          </div>
        `;
        grid.appendChild(el);
      });
    }

    function turnStatusHtml(p) {
      if (!game || !game.roundOpeningActive) return '';
      if (game.currentTurnPlayerId === p.id) return `<div class="turn-timer">Открытие характеристики: ${game.turnTimeLeft} сек.</div>`;
      return '';
    }

    function traitHtml(p, key) {
      const isOwner = p.name === nickname;
      const canSee = isOwner || p.revealed[key] || !p.alive || p.exiled || p.winner;
      const value = canSee ? (key === 'health' ? healthView(p) : p.cards[key]) : '<span class="hidden">закрыто</span>';
      let button = '';

      if (canRevealTrait(p, key)) {
        button = `<button class="secondary" onclick="reveal(${p.id}, '${key}')">Открыть</button>`;
      }

      if ((key === 'special1' || key === 'special2') && canUseSpecial(p, key)) {
        button += `<button class="good" onclick="startSpecialUse(${p.id}, '${key}')">Использовать</button>`;
      }

      if (isSpecialTargetTrait(p, key)) {
        const action = game.specialAction;
        button += `<button class="good" onclick="applySpecialAction(${action.ownerId}, '${action.specialKey}', ${p.id}, '${key}')">${specialTraitButtonText(action)}</button>`;
      }

      if ((key === 'special1' || key === 'special2') && p.usedSpecials && p.usedSpecials[key]) {
        button += `<span class="badge">использовано</span>`;
      }

      return `<div class="trait"><div><strong>${label(key)}:</strong> ${value}</div>${button}</div>`;
    }

    function renderVoting() {
      const panel = document.getElementById('votingPanel');
      const box = document.getElementById('anonymousVoteList');
      if (!panel || !box || !game) return;

      panel.style.display = game.votingOpen ? 'block' : 'none';
      box.innerHTML = '';
      if (!game.votingOpen) return;

      const alive = alivePlayers();
      const totalVotes = Object.keys(votes).filter(name => alive.some(p => p.name === name)).length;
      const counts = {};
      Object.entries(votes).forEach(([voterName, id]) => {
        if (alive.some(p => p.name === voterName)) counts[id] = (counts[id] || 0) + 1;
      });
      const currentVoter = game.players.find(p => p.name === nickname);
      const isVoteBanned = !!(game.voteBans && game.voteBans[nickname] === game.round);
      const canCurrentVote = !!currentVoter && currentVoter.alive && !currentVoter.exiled && !isVoteBanned;
      const votedAlready = votes[nickname || 'Игрок'];

      alive.forEach(p => {
        const amount = counts[p.id] || 0;
        const percent = totalVotes ? Math.round((amount / totalVotes) * 100) : 0;
        const el = document.createElement('div');
        el.className = 'vote-item';
        el.innerHTML = `
          <div class="vote-head">
            <strong>${p.name}</strong>
            <span class="badge">${amount} голосов · ${percent}%</span>
          </div>
          <div class="vote-bar"><div style="width:${percent}%"></div></div>
          <button class="secondary" style="margin-top:10px;" onclick="vote(${p.id})" ${(!canCurrentVote || votedAlready) ? 'disabled' : ''}>${isVoteBanned ? 'Голос запрещён' : canCurrentVote ? 'Проголосовать' : 'Наблюдатель не голосует'}</button>
        `;
        box.appendChild(el);
      });

      const info = document.createElement('p');
      info.className = 'small';
      info.textContent = `Голосование синхронизировано. Подано голосов: ${totalVotes}/${alive.length}.`;
      box.appendChild(info);

      if (isCurrentGameHost()) {
        const actions = document.createElement('div');
        actions.className = 'row';
        actions.style.marginTop = '12px';

        const finish = document.createElement('button');
        finish.className = 'danger';
        finish.textContent = 'Завершить голосование и изгнать';
        finish.onclick = finishVoting;

        const cancel = document.createElement('button');
        cancel.className = 'secondary';
        cancel.textContent = 'Прервать голосование';
        cancel.onclick = cancelVoting;

        actions.appendChild(finish);
        actions.appendChild(cancel);
        box.appendChild(actions);
      } else {
        const note = document.createElement('p');
        note.className = 'small';
        note.textContent = 'Итог голосования подводит только ведущий.';
        box.appendChild(note);
      }
    }

    function renderChronicles() {
      const summary = document.getElementById('chroniclesSummary');
      const logBox = document.getElementById('chroniclesLog');
      if (!summary || !logBox) return;
      summary.innerHTML = game?.finalSummary || 'Игра ещё не завершена.';
      logBox.innerHTML = game?.history?.map(h => `<div>${h}</div>`).join('') || '';
    }

    function chroniclesText() {
      const summary = (game?.finalSummary || 'Игра ещё не завершена.').replaceAll('<br>', '\n').replace(/<[^>]*>/g, '');
      return `<span style="color:#ffffff;">BUNKER</span> <span class="title-accent">LAST HOPE</span>\n\n${summary}\n\nЛетопись:\n${game?.history?.join('\n') || ''}`;
    }

    function exportChronicles() {
      const blob = new Blob([chroniclesText()], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'bunker-chronicles.txt';
      a.click();
      URL.revokeObjectURL(url);
    }

    function copyChronicles() { navigator.clipboard.writeText(chroniclesText()).then(() => alert('Хроники скопированы.')); }

    function renderAll() {
      renderHome();
      renderActiveRooms();
      renderLobby();
      renderGame();
      renderTabs();
      renderChronicles();
      maybeHandleLobbyKick();
    }

    function restorePageAfterReload() {
      const allowedPages = ['home', 'find', 'create', 'lobby', 'game', 'chronicles'];

      if (!nickname) {
        showPage('register');
        return;
      }

      clearGameIfDifferentRoom();
      const savedPage = localStorage.getItem('bz_current_page');

      if (savedPage === 'game' && game && (!currentRoomId || game.roomId === currentRoomId)) {
        showPage('game');
        return;
      }

      if (savedPage === 'lobby' && currentRoomId) {
        showPage('lobby');
        return;
      }

      if (savedPage === 'chronicles' && game) {
        showPage('chronicles');
        return;
      }

      if (allowedPages.includes(savedPage)) {
        showPage(savedPage);
        return;
      }

      showPage('home');
    }

    initOnline();
    startLobbyMaintenance();
    restorePageAfterReload();
    if ((localStorage.getItem('bz_current_page') || '') !== 'game') hideToast();
