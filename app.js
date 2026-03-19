const statusEl = document.getElementById("status");
const roomInput = document.getElementById("roomIdInput");
const activeRoomIdEl = document.getElementById("activeRoomId");
const matchBtn = document.getElementById("matchBtn");
const nextBtn = document.getElementById("nextBtn");
const createBtn = document.getElementById("createBtn");
const joinBtn = document.getElementById("joinBtn");
const hangupBtn = document.getElementById("hangupBtn");
const copyBtn = document.getElementById("copyBtn");
const muteBtn = document.getElementById("muteBtn");
const cameraBtn = document.getElementById("cameraBtn");
const reportBtn = document.getElementById("reportBtn");
const blockBtn = document.getElementById("blockBtn");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const localLevelEl = document.getElementById("localLevel");
const remoteLevelEl = document.getElementById("remoteLevel");
const selfGenderEl = document.getElementById("selfGender");
const targetGenderEl = document.getElementById("targetGender");
const callTimerEl = document.getElementById("callTimer");
const onlineNowEl = document.getElementById("onlineNow");
const chatMessagesEl = document.getElementById("chatMessages");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");

const db = window.voiceDb;
const auth = window.voiceAuth;

let localStream = null;
let remoteStream = null;
let peerConnection = null;
let roomRef = null;
let roomUnsubscribe = null;
let callerCandidatesUnsub = null;
let calleeCandidatesUnsub = null;
let pairSubscription = null;
let queueCounterUnsub = null;
let pairCounterUnsub = null;
let chatUnsubscribe = null;
let currentPairId = null;
let currentPeerUid = null;
let waitingCount = 0;
let activePairsCount = 0;
let micEnabled = true;
let cameraEnabled = true;
let localMeterContext = null;
let remoteMeterContext = null;
let currentMode = "idle";
let callTimerInterval = null;
let callStartedAt = 0;
let blockedUserIds = new Set();
let isSwitchingMatch = false;
let activeVideoProfileLabel = "auto";

const rtcConfig = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }
  ],
  iceCandidatePoolSize: 10
};

function preferVp8InSdp(sdp) {
  if (!sdp) return sdp;

  const lines = sdp.split("\r\n");
  const mLineIndex = lines.findIndex((line) => line.startsWith("m=video "));
  if (mLineIndex === -1) return sdp;

  const vp8Payloads = lines
    .filter((line) => /a=rtpmap:(\d+) VP8\/90000/i.test(line))
    .map((line) => line.match(/a=rtpmap:(\d+) VP8\/90000/i)[1]);

  if (!vp8Payloads.length) return sdp;

  const mLineParts = lines[mLineIndex].split(" ");
  const header = mLineParts.slice(0, 3);
  const payloads = mLineParts.slice(3);

  const prioritized = [
    ...vp8Payloads,
    ...payloads.filter((pt) => !vp8Payloads.includes(pt))
  ];

  lines[mLineIndex] = [...header, ...prioritized].join(" ");
  return lines.join("\r\n");
}

function getVideoProfiles(audioConstraints) {
  return [
    {
      label: "1080p",
      constraints: {
        audio: audioConstraints,
        video: {
          facingMode: "user",
          width: { ideal: 1920, max: 1920 },
          height: { ideal: 1080, max: 1080 },
          frameRate: { ideal: 30, max: 30 }
        }
      }
    },
    {
      label: "720p",
      constraints: {
        audio: audioConstraints,
        video: {
          facingMode: "user",
          width: { ideal: 1280, max: 1280 },
          height: { ideal: 720, max: 720 },
          frameRate: { ideal: 30, max: 30 }
        }
      }
    },
    {
      label: "540p",
      constraints: {
        audio: audioConstraints,
        video: {
          facingMode: "user",
          width: { ideal: 960, max: 960 },
          height: { ideal: 540, max: 540 },
          frameRate: { ideal: 24, max: 30 }
        }
      }
    },
    {
      label: "fallback",
      constraints: {
        audio: audioConstraints,
        video: {
          facingMode: "user"
        }
      }
    },
    {
      label: "compat",
      constraints: {
        audio: audioConstraints,
        video: true
      }
    }
  ];
}

async function tuneVideoSender(peer, stream) {
  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.contentHint = "detail";
  }

  const videoSender = peer.getSenders().find((sender) => sender.track && sender.track.kind === "video");
  if (!videoSender || typeof videoSender.getParameters !== "function") {
    return;
  }

  const params = videoSender.getParameters() || {};
  if (!params.encodings || !params.encodings.length) {
    params.encodings = [{}];
  }

  const bitrateByProfile = {
    "1080p": 2600000,
    "720p": 1800000,
    "540p": 1200000,
    fallback: 900000,
    compat: 700000,
    auto: 1200000
  };

  params.encodings[0].maxBitrate = bitrateByProfile[activeVideoProfileLabel] || bitrateByProfile.auto;
  params.encodings[0].maxFramerate = activeVideoProfileLabel === "1080p" || activeVideoProfileLabel === "720p" ? 30 : 24;
  params.degradationPreference = "balanced";

  try {
    await videoSender.setParameters(params);
  } catch (error) {
    console.warn("No se pudo ajustar bitrate/framerate del video sender", error);
  }
}

function setStatus(text) {
  statusEl.textContent = text;
}

function setActiveRoom(id) {
  activeRoomIdEl.textContent = id || "-";
  copyBtn.disabled = !id;
}

function toggleManualButtons(disabled) {
  createBtn.disabled = disabled;
  joinBtn.disabled = disabled;
}

function setCallControlsEnabled(enabled) {
  hangupBtn.disabled = !enabled;
  muteBtn.disabled = !enabled;
  cameraBtn.disabled = !enabled;
}

function setModerationButtonsEnabled(enabled) {
  reportBtn.disabled = !enabled;
  blockBtn.disabled = !enabled;
}

function setChatEnabled(enabled) {
  chatInput.disabled = !enabled;
  const submitButton = chatForm.querySelector("button[type='submit']");
  if (submitButton) {
    submitButton.disabled = !enabled;
  }
}

function setMode(mode) {
  currentMode = mode;
  if (mode === "matchmaking") {
    matchBtn.disabled = true;
    nextBtn.disabled = false;
    return;
  }

  matchBtn.disabled = false;
  nextBtn.disabled = true;
}

function formatDuration(seconds) {
  const mm = Math.floor(seconds / 60).toString().padStart(2, "0");
  const ss = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

function startCallTimer() {
  stopCallTimer();
  callStartedAt = Date.now();
  callTimerEl.textContent = "00:00";
  callTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - callStartedAt) / 1000);
    callTimerEl.textContent = formatDuration(elapsed);
  }, 1000);
}

function stopCallTimer() {
  if (callTimerInterval) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }
  callTimerEl.textContent = "00:00";
}

function updateOnlineBadge() {
  const total = waitingCount + (activePairsCount * 2);
  onlineNowEl.textContent = String(total);
}

function subscribePresenceCounters() {
  if (queueCounterUnsub) queueCounterUnsub();
  if (pairCounterUnsub) pairCounterUnsub();

  queueCounterUnsub = db.collection("voiceQueue").where("status", "==", "waiting").onSnapshot((snapshot) => {
    waitingCount = snapshot.size;
    updateOnlineBadge();
  });

  pairCounterUnsub = db.collection("voicePairs").where("status", "==", "active").onSnapshot((snapshot) => {
    activePairsCount = snapshot.size;
    updateOnlineBadge();
  });
}

function closeSubscriptions() {
  if (roomUnsubscribe) roomUnsubscribe();
  if (callerCandidatesUnsub) callerCandidatesUnsub();
  if (calleeCandidatesUnsub) calleeCandidatesUnsub();
  roomUnsubscribe = null;
  callerCandidatesUnsub = null;
  calleeCandidatesUnsub = null;
}

function closePairSubscription() {
  if (pairSubscription) pairSubscription();
  pairSubscription = null;
}

function closeChatSubscription() {
  if (chatUnsubscribe) chatUnsubscribe();
  chatUnsubscribe = null;
}

function clearChat() {
  chatMessagesEl.innerHTML = "";
}

function appendChatMessage(text, type) {
  const item = document.createElement("div");
  item.className = `chat-msg ${type}`;
  item.textContent = text;
  chatMessagesEl.appendChild(item);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

async function ensureAuth() {
  if (auth.currentUser) return auth.currentUser;
  const cred = await auth.signInAnonymously();
  return cred.user;
}

async function loadBlockedUsers() {
  if (!auth.currentUser) return;
  const doc = await db.collection("userBlocks").doc(auth.currentUser.uid).get();
  const data = doc.exists ? doc.data() : {};
  const ids = Array.isArray(data.blockedUids) ? data.blockedUids : [];
  blockedUserIds = new Set(ids);
}

async function blockPeerUser() {
  if (!auth.currentUser || !currentPeerUid) {
    setStatus("No hay usuario para bloquear.");
    return;
  }

  const confirmed = window.confirm("Bloquear este usuario y pasar al siguiente?");
  if (!confirmed) return;

  await db.collection("userBlocks").doc(auth.currentUser.uid).set(
    {
      blockedUids: firebase.firestore.FieldValue.arrayUnion(currentPeerUid),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  blockedUserIds.add(currentPeerUid);
  setStatus("Usuario bloqueado. Buscando nueva pareja...");
  await nextMatch();
}

async function reportPeerUser() {
  if (!auth.currentUser || !currentPeerUid || !currentPairId) {
    setStatus("No hay usuario activo para reportar.");
    return;
  }

  const reason = window.prompt("Motivo del reporte (spam, contenido inapropiado, etc):", "");
  if (!reason || !reason.trim()) return;

  await db.collection("voiceReports").add({
    pairId: currentPairId,
    roomId: currentPairId,
    reportedUid: currentPeerUid,
    reporterUid: auth.currentUser.uid,
    reason: reason.trim().slice(0, 300),
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });

  setStatus("Reporte enviado. Gracias por ayudar a moderar.");
}

function getProfilePreferences() {
  return {
    profile: {
      gender: selfGenderEl.value || "unknown"
    },
    preferences: {
      targetGender: targetGenderEl.value || "all"
    }
  };
}

function allowsGender(targetGender, candidateGender) {
  if (targetGender === "all") return true;
  if (candidateGender === "unknown") return true;
  return candidateGender === targetGender;
}

function areUsersCompatible(myProfile, myPreferences, candidateProfile, candidatePreferences) {
  const candidateGender = String(candidateProfile && candidateProfile.gender ? candidateProfile.gender : "unknown");
  const myGender = String(myProfile && myProfile.gender ? myProfile.gender : "unknown");

  const iAcceptCandidate = allowsGender(myPreferences.targetGender || "all", candidateGender);
  const candidateAcceptsMe = allowsGender(
    candidatePreferences && candidatePreferences.targetGender ? candidatePreferences.targetGender : "all",
    myGender
  );

  return iAcceptCandidate && candidateAcceptsMe;
}

async function ensureLocalMedia() {
  if (localStream) return localStream;

  const audioConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  };

  const profiles = getVideoProfiles(audioConstraints);

  let mediaError = null;
  for (const profile of profiles) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia(profile.constraints);
      activeVideoProfileLabel = profile.label;
      break;
    } catch (error) {
      mediaError = error;
    }
  }

  if (!localStream) {
    throw mediaError || new Error("No se pudo acceder a camara y microfono");
  }

  localVideo.srcObject = localStream;
  return localStream;
}

function safeAddIceCandidate(candidateData) {
  if (!peerConnection || !candidateData) return;
  peerConnection.addIceCandidate(new RTCIceCandidate(candidateData)).catch((error) => {
    console.warn("No se pudo agregar ICE candidate", error);
  });
}

function stopAllMedia() {
  if (localMeterContext) {
    localMeterContext.close();
    localMeterContext = null;
  }
  if (remoteMeterContext) {
    remoteMeterContext.close();
    remoteMeterContext = null;
  }

  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
  }
  if (remoteStream) {
    remoteStream.getTracks().forEach((track) => track.stop());
  }

  localStream = null;
  remoteStream = null;
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
}

function setupAudioMeters(stream, fillEl, contextRefName) {
  if (!stream || !stream.getAudioTracks().length) return;
  if (contextRefName === "local" && localMeterContext) return;
  if (contextRefName === "remote" && remoteMeterContext) return;

  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  if (contextRefName === "local") {
    localMeterContext = context;
  } else if (contextRefName === "remote") {
    remoteMeterContext = context;
  }

  const data = new Uint8Array(analyser.frequencyBinCount);

  const tick = () => {
    if (!stream.active) {
      fillEl.style.width = "0%";
      return;
    }

    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i += 1) {
      const v = Math.abs(data[i] - 128);
      if (v > peak) peak = v;
    }

    const percent = Math.min(100, Math.round((peak / 128) * 220));
    fillEl.style.width = `${percent}%`;
    requestAnimationFrame(tick);
  };

  tick();
}

async function createPeerConnection() {
  const stream = await ensureLocalMedia();
  peerConnection = new RTCPeerConnection(rtcConfig);

  remoteStream = new MediaStream();
  remoteVideo.srcObject = remoteStream;

  stream.getTracks().forEach((track) => {
    peerConnection.addTrack(track, stream);
  });

  await tuneVideoSender(peerConnection, stream);

  peerConnection.ontrack = (event) => {
    event.streams[0].getTracks().forEach((track) => {
      remoteStream.addTrack(track);
      if (track.kind === "audio") {
        setupAudioMeters(remoteStream, remoteLevelEl, "remote");
      }
    });
  };

  peerConnection.onconnectionstatechange = () => {
    if (!peerConnection) return;
    const state = peerConnection.connectionState;
    setStatus(`Conexion: ${state}`);

    if (state === "connected") {
      startCallTimer();
      return;
    }

    if (state === "failed" || state === "disconnected" || state === "closed") {
      stopCallTimer();
      if (currentMode === "matchmaking" && !isSwitchingMatch) {
        setStatus("Conexion perdida. Buscando nueva pareja...");
        nextMatch().catch((error) => {
          console.error(error);
          setStatus(`No se pudo reconectar: ${error.message}`);
        });
      }
    }
  };

  setupAudioMeters(stream, localLevelEl, "local");
}

async function createOfferForRoom(targetRoomRef) {
  const callerCandidatesCollection = targetRoomRef.collection("callerCandidates");

  peerConnection.onicecandidate = async (event) => {
    if (!event.candidate) return;
    await callerCandidatesCollection.add(event.candidate.toJSON());
  };

  const offer = await peerConnection.createOffer();
  offer.sdp = preferVp8InSdp(offer.sdp);
  await peerConnection.setLocalDescription(offer);

  await targetRoomRef.set({ offer: { type: offer.type, sdp: offer.sdp } }, { merge: true });

  roomUnsubscribe = targetRoomRef.onSnapshot(async (snapshot) => {
    const data = snapshot.data();
    if (!data || !data.answer || peerConnection.currentRemoteDescription) return;
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
  });

  calleeCandidatesUnsub = targetRoomRef.collection("calleeCandidates").onSnapshot((snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === "added") {
        safeAddIceCandidate(change.doc.data());
      }
    });
  });
}

async function waitForOffer(targetRoomRef, timeoutMs = 25000) {
  const initial = await targetRoomRef.get();
  const initialData = initial.data();
  if (initialData && initialData.offer) return initialData.offer;

  return new Promise((resolve, reject) => {
    let unsub = null;
    const timer = setTimeout(() => {
      if (unsub) unsub();
      reject(new Error("No llego la oferta de video a tiempo"));
    }, timeoutMs);

    unsub = targetRoomRef.onSnapshot((snapshot) => {
      const data = snapshot.data();
      if (!data || !data.offer) return;
      clearTimeout(timer);
      unsub();
      resolve(data.offer);
    });
  });
}

async function answerRoom(targetRoomRef) {
  const calleeCandidatesCollection = targetRoomRef.collection("calleeCandidates");

  peerConnection.onicecandidate = async (event) => {
    if (!event.candidate) return;
    await calleeCandidatesCollection.add(event.candidate.toJSON());
  };

  const offerDescription = await waitForOffer(targetRoomRef);
  await peerConnection.setRemoteDescription(new RTCSessionDescription(offerDescription));

  const answer = await peerConnection.createAnswer();
  answer.sdp = preferVp8InSdp(answer.sdp);
  await peerConnection.setLocalDescription(answer);

  await targetRoomRef.set(
    {
      answer: {
        type: answer.type,
        sdp: answer.sdp
      },
      state: "connected",
      joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
      joinedUid: auth.currentUser.uid
    },
    { merge: true }
  );

  callerCandidatesUnsub = targetRoomRef.collection("callerCandidates").onSnapshot((snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === "added") {
        safeAddIceCandidate(change.doc.data());
      }
    });
  });
}

async function connectAsCaller(roomId) {
  await createPeerConnection();
  roomRef = db.collection("voiceRooms").doc(roomId);

  await roomRef.set(
    {
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      creatorUid: auth.currentUser.uid,
      state: "waiting"
    },
    { merge: true }
  );

  await createOfferForRoom(roomRef);
}

async function connectAsCallee(roomId) {
  await createPeerConnection();
  roomRef = db.collection("voiceRooms").doc(roomId);
  await answerRoom(roomRef);
}

function subscribeRoomChat(roomId) {
  closeChatSubscription();
  clearChat();
  appendChatMessage("Conectado. Puedes enviar mensajes aqui.", "system");

  chatUnsubscribe = db.collection("voiceRooms").doc(roomId).collection("messages")
    .orderBy("createdAt")
    .limit(120)
    .onSnapshot((snapshot) => {
      clearChat();
      if (!snapshot.size) {
        appendChatMessage("No hay mensajes todavia.", "system");
        return;
      }

      snapshot.forEach((doc) => {
        const data = doc.data() || {};
        const text = String(data.text || "").trim();
        if (!text) return;
        const type = data.senderUid === (auth.currentUser && auth.currentUser.uid) ? "mine" : "other";
        appendChatMessage(text, type);
      });
    });
}

async function sendChatMessage(event) {
  event.preventDefault();
  if (!auth.currentUser || !currentPairId) return;

  const text = String(chatInput.value || "").trim();
  if (!text) return;

  await db.collection("voiceRooms").doc(currentPairId).collection("messages").add({
    senderUid: auth.currentUser.uid,
    text: text.slice(0, 240),
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });

  chatInput.value = "";
}

async function createRoom() {
  setMode("manual");
  toggleManualButtons(true);

  try {
    await ensureAuth();
    await loadBlockedUsers();

    const roomDoc = db.collection("voiceRooms").doc();
    await connectAsCaller(roomDoc.id);

    currentPairId = roomDoc.id;
    currentPeerUid = null;
    setActiveRoom(roomDoc.id);
    roomInput.value = roomDoc.id;
    setCallControlsEnabled(true);
    setModerationButtonsEnabled(false);
    setChatEnabled(true);
    subscribeRoomChat(roomDoc.id);
    setStatus("Sala creada. Comparte el ID para que se unan.");
  } catch (error) {
    console.error(error);
    setStatus(`Error al crear sala: ${error.message}`);
    toggleManualButtons(false);
  }
}

async function joinRoom() {
  const roomId = roomInput.value.trim();
  if (!roomId) {
    setStatus("Escribe un ID de sala para unirte.");
    return;
  }

  setMode("manual");
  toggleManualButtons(true);

  try {
    await ensureAuth();
    await loadBlockedUsers();

    const roomSnapshot = await db.collection("voiceRooms").doc(roomId).get();
    if (!roomSnapshot.exists) {
      throw new Error("Esa sala no existe.");
    }

    await connectAsCallee(roomId);

    currentPairId = roomId;
    currentPeerUid = null;
    setActiveRoom(roomId);
    setCallControlsEnabled(true);
    setModerationButtonsEnabled(false);
    setChatEnabled(true);
    subscribeRoomChat(roomId);
    setStatus("Te uniste a la sala. Audio y video activos.");
  } catch (error) {
    console.error(error);
    setStatus(`Error al unirte: ${error.message}`);
    toggleManualButtons(false);
  }
}

async function leaveQueue() {
  if (!auth.currentUser) return;

  try {
    await db.collection("voiceQueue").doc(auth.currentUser.uid).delete();
  } catch (error) {
    console.warn("No se pudo limpiar cola", error);
  }
}

async function markCurrentPairEnded() {
  if (!currentPairId) return;

  try {
    await db.collection("voicePairs").doc(currentPairId).set(
      {
        status: "ended",
        endedAt: firebase.firestore.FieldValue.serverTimestamp(),
        endedBy: auth.currentUser ? auth.currentUser.uid : null
      },
      { merge: true }
    );
  } catch (error) {
    console.warn("No se pudo marcar fin de emparejamiento", error);
  }
}

function subscribeToPairs() {
  if (!auth.currentUser) return;
  closePairSubscription();

  const uid = auth.currentUser.uid;
  pairSubscription = db.collection("voicePairs").where("members", "array-contains", uid).onSnapshot((snapshot) => {
    const activePairs = snapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((pair) => pair.status === "active");

    if (!activePairs.length) return;

    activePairs.sort((a, b) => {
      const ta = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
      const tb = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
      return tb - ta;
    });

    const pair = activePairs[0];
    if (currentPairId === pair.id) return;

    const peerUid = Array.isArray(pair.members) ? pair.members.find((id) => id !== uid) : null;
    connectToPair(pair.id, pair.callerUid === uid, peerUid || null).catch((error) => {
      console.error(error);
      setStatus(`No se pudo conectar con pareja: ${error.message}`);
    });
  });
}

async function findMatchOrQueue() {
  if (!auth.currentUser) return;

  const uid = auth.currentUser.uid;
  const queueCol = db.collection("voiceQueue");
  const myQueueRef = queueCol.doc(uid);
  const pairRef = db.collection("voicePairs").doc();

  const { profile, preferences } = getProfilePreferences();
  let matched = false;
  let matchedPeerUid = null;

  await db.runTransaction(async (transaction) => {
    const waitingSnapshot = await transaction.get(queueCol.where("status", "==", "waiting").orderBy("createdAt").limit(25));
    let candidateDoc = null;

    waitingSnapshot.docs.forEach((doc) => {
      if (candidateDoc) return;
      if (doc.id === uid) return;
      if (blockedUserIds.has(doc.id)) return;

      const data = doc.data() || {};
      const candidateBlocked = Array.isArray(data.blockedUids) ? data.blockedUids : [];
      if (candidateBlocked.includes(uid)) return;

      const candidateProfile = data.profile || { gender: "unknown" };
      const candidatePreferences = data.preferences || { targetGender: "all" };
      const compatible = areUsersCompatible(profile, preferences, candidateProfile, candidatePreferences);

      if (compatible) {
        candidateDoc = doc;
      }
    });

    if (candidateDoc) {
      matched = true;
      matchedPeerUid = candidateDoc.id;

      transaction.delete(candidateDoc.ref);
      transaction.delete(myQueueRef);
      transaction.set(pairRef, {
        members: [uid, candidateDoc.id],
        callerUid: uid,
        calleeUid: candidateDoc.id,
        status: "active",
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      return;
    }

    transaction.set(
      myQueueRef,
      {
        uid,
        status: "waiting",
        profile,
        preferences,
        blockedUids: Array.from(blockedUserIds),
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  });

  if (matched) {
    await connectToPair(pairRef.id, true, matchedPeerUid);
    return;
  }

  setStatus("Buscando pareja disponible...");
}

async function connectToPair(pairId, isCaller, peerUid) {
  await leaveQueue();

  if (peerConnection) {
    await hangup({ keepMode: true, skipPairClose: true });
  }

  currentPairId = pairId;
  currentPeerUid = peerUid || null;

  setActiveRoom(pairId);
  setCallControlsEnabled(true);
  setModerationButtonsEnabled(!!currentPeerUid);
  setChatEnabled(true);
  subscribeRoomChat(pairId);
  toggleManualButtons(true);

  if (isCaller) {
    setStatus("Pareja encontrada. Iniciando videollamada...");
    await connectAsCaller(pairId);
  } else {
    setStatus("Pareja encontrada. Uniendote a la videollamada...");
    await connectAsCallee(pairId);
  }
}

async function startMatchmaking() {
  try {
    await ensureAuth();
    await loadBlockedUsers();
    await ensureLocalMedia();

    if (activeVideoProfileLabel !== "compat" && activeVideoProfileLabel !== "fallback") {
      setStatus(`Calidad local: ${activeVideoProfileLabel}. Buscando pareja...`);
    }

    setMode("matchmaking");
    toggleManualButtons(true);
    subscribeToPairs();
    await findMatchOrQueue();
  } catch (error) {
    console.error(error);
    setMode("idle");
    toggleManualButtons(false);
    setStatus(`Error al emparejar: ${error.message}`);
  }
}

async function nextMatch() {
  if (isSwitchingMatch) return;
  isSwitchingMatch = true;

  try {
    await markCurrentPairEnded();
    await hangup({ keepMode: true, skipPairClose: true });
    setStatus("Saltando a la siguiente pareja...");
    await startMatchmaking();
  } catch (error) {
    console.error(error);
    setStatus(`No se pudo saltar de pareja: ${error.message}`);
  } finally {
    isSwitchingMatch = false;
  }
}

async function hangup(options = {}) {
  const keepMode = !!options.keepMode;
  const skipPairClose = !!options.skipPairClose;

  closeSubscriptions();

  if (peerConnection) {
    peerConnection.getSenders().forEach((sender) => {
      if (sender.track) sender.track.stop();
    });
    peerConnection.close();
    peerConnection = null;
  }

  stopAllMedia();
  closeChatSubscription();
  stopCallTimer();
  clearChat();

  localLevelEl.style.width = "0%";
  remoteLevelEl.style.width = "0%";

  if (!skipPairClose) {
    await markCurrentPairEnded();
  }

  setCallControlsEnabled(false);
  setModerationButtonsEnabled(false);
  setChatEnabled(false);

  if (!keepMode || currentMode !== "matchmaking") {
    toggleManualButtons(false);
  }

  micEnabled = true;
  cameraEnabled = true;
  muteBtn.textContent = "Mute";
  cameraBtn.textContent = "Camera Off";

  setActiveRoom(null);
  if (!keepMode) {
    setStatus("Llamada finalizada.");
  }

  roomRef = null;
  currentPairId = null;
  currentPeerUid = null;
}

function toggleMute() {
  if (!localStream) return;
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach((track) => {
    track.enabled = micEnabled;
  });
  muteBtn.textContent = micEnabled ? "Mute" : "Unmute";
}

function toggleCamera() {
  if (!localStream) return;
  cameraEnabled = !cameraEnabled;
  localStream.getVideoTracks().forEach((track) => {
    track.enabled = cameraEnabled;
  });
  cameraBtn.textContent = cameraEnabled ? "Camera Off" : "Camera On";
}

async function copyRoomId() {
  const roomId = activeRoomIdEl.textContent.trim();
  if (!roomId || roomId === "-") return;
  await navigator.clipboard.writeText(roomId);
  setStatus("ID copiado al portapapeles.");
}

createBtn.addEventListener("click", createRoom);
joinBtn.addEventListener("click", joinRoom);
matchBtn.addEventListener("click", startMatchmaking);
nextBtn.addEventListener("click", nextMatch);
hangupBtn.addEventListener("click", () => hangup());
muteBtn.addEventListener("click", toggleMute);
cameraBtn.addEventListener("click", toggleCamera);
copyBtn.addEventListener("click", copyRoomId);
reportBtn.addEventListener("click", reportPeerUser);
blockBtn.addEventListener("click", blockPeerUser);
chatForm.addEventListener("submit", sendChatMessage);

window.addEventListener("beforeunload", () => {
  closePairSubscription();
  closeSubscriptions();
  closeChatSubscription();
  if (queueCounterUnsub) queueCounterUnsub();
  if (pairCounterUnsub) pairCounterUnsub();
  if (auth.currentUser) {
    db.collection("voiceQueue").doc(auth.currentUser.uid).delete().catch(() => {});
  }
});

(async function init() {
  try {
    await ensureAuth();
    await loadBlockedUsers();
    subscribePresenceCounters();
    setMode("idle");
    setCallControlsEnabled(false);
    setModerationButtonsEnabled(false);
    setChatEnabled(false);
    setStatus("Ready. Press Start to begin.");
  } catch (error) {
    console.error(error);
    setStatus(`No se pudo iniciar Firebase/Auth: ${error.message}`);
  }
})();
