// Firebase и базовые настройки онлайн-синхронизации.
const FIREBASE_CONFIG = {
      apiKey: "AIzaSyAeY4qYLMehYPtVozJ8CWt6zXQDJs0iE90",
      authDomain: "bunker-54d82.firebaseapp.com",
      databaseURL: "https://bunker-54d82-default-rtdb.firebaseio.com",
      projectId: "bunker-54d82",
      storageBucket: "bunker-54d82.firebasestorage.app",
      messagingSenderId: "763581197921",
      appId: "1:763581197921:web:2abc20e29c43d0f3a04420",
      measurementId: "G-JZVF2702W6"
    };

    const ONLINE_ROOT = 'bunker_v1';
    let onlineMode = false;
    let onlineDb = null;
    let onlineReady = false;
    let suppressOnlineWrite = false;
    let toastTimeoutId = null;
    let displayedEventToastId = null;
    let subscribedRoomId = '';
    let unsubscribeGame = null;
    const REVEAL_TURN_SECONDS = 10;
    const ORPHAN_LOBBY_CLOSE_MS = 3 * 60 * 1000;
    const PLAYER_ONLINE_TIMEOUT_MS = 30 * 1000;
    const PRESENCE_HEARTBEAT_MS = 5000;
    let unsubscribeVotes = null;
