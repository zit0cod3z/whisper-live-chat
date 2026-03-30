const messageBoard = document.getElementById("messageBoard");
const chatForm = document.getElementById("chatForm");
const messageInput = document.getElementById("messageInput");
const fileInput = document.getElementById("fileInput");
const fileStatus = document.getElementById("fileStatus");
const clearComposerButton = document.getElementById("clearComposer");
const sessionStatus = document.getElementById("sessionStatus");
const presenceStatus = document.getElementById("presenceStatus");
const typingIndicator = document.getElementById("typingIndicator");
const reconnectBanner = document.getElementById("reconnectBanner");
const roomTypingStatus = document.getElementById("roomTypingStatus");
const replyPreview = document.getElementById("replyPreview");
const pinnedMessageCard = document.getElementById("pinnedMessageCard");
const attachmentSidebar = document.getElementById("attachmentSidebar");
const dropZone = document.getElementById("dropZone");
const recordVoiceButton = document.getElementById("recordVoiceButton");
const discardVoiceButton = document.getElementById("discardVoiceButton");
const voiceStatus = document.getElementById("voiceMockStatus");
const voiceWavePreview = document.getElementById("voiceWavePreview");
const themeSelect = document.getElementById("themeSelect");
const roomLinkDisplay = document.getElementById("roomLinkDisplay");
const copyRoomLinkButton = document.getElementById("copyRoomLink");
const shareRoomLinkButton = document.getElementById("shareRoomLink");
const roomPassphraseInput = document.getElementById("roomPassphrase");
const roomExpiryMinutesInput = document.getElementById("roomExpiryMinutes");
const messageTtlMinutesInput = document.getElementById("messageTtlMinutes");
const roomInactivityLockMinutesInput = document.getElementById("roomInactivityLockMinutes");
const applyPrivacySettingsButton = document.getElementById("applyPrivacySettings");
const enableNotificationsButton = document.getElementById("enableNotifications");
const installAppButton = document.getElementById("installAppButton");
const openGalleryButton = document.getElementById("openGalleryButton");
const exportMediaButton = document.getElementById("exportMediaButton");
const blockRoomButton = document.getElementById("blockRoomButton");
const participantList = document.getElementById("participantList");
const qrCard = document.getElementById("qrCard");
const messageSelfDestructSelect = document.getElementById("messageSelfDestruct");
const lightbox = document.getElementById("lightbox");
const lightboxContent = document.getElementById("lightboxContent");
const lightboxClose = document.getElementById("lightboxClose");

const sessionId = sessionStorage.getItem("whisper-room-live-session") || createToken();
sessionStorage.setItem("whisper-room-live-session", sessionId);

const REACTION_SET = ["❤️", "🔥", "😂"];
const ROOM_BLOCKLIST_KEY = "whisper-room-live-blocked-rooms";
const MUTE_LIST_KEY = "whisper-room-live-muted-sessions";
const PASSCODE_STORAGE_KEY = "whisper-room-live-passcodes";
const DEFAULT_VOICE_STATUS = "Tap to record a real browser voice note if your device allows microphone access.";

const state = {
  roomId: "",
  roomKey: "",
  roomPasscode: "",
  roomExpiryMinutes: 0,
  roomMessageTtlMinutes: 0,
  roomInactivityLockMinutes: 0,
  roomExpiresAt: null,
  roomProtected: false,
  pinnedMessageId: null,
  messages: [],
  selectedFile: null,
  mediaRecorder: null,
  audioChunks: [],
  socket: null,
  reconnectTimer: null,
  lightboxTouchStartY: null,
  typingUsers: new Map(),
  participantDetails: [],
  isConnected: false,
  lastReadMessageId: 0,
  typingTimeout: null,
  sentTypingState: false,
  recordingStream: null,
  replyTargetId: null,
  deferredPrompt: null,
  mutedSessions: loadMutedSessions(),
};

if (loadBlockedRooms().includes(getRawRoomHash())) {
  document.body.innerHTML = `
    <main class="py-5">
      <div class="container">
        <section class="glass-panel p-5 text-center">
          <p class="eyebrow mb-2">Room blocked</p>
          <h1 class="h3 mb-3">This room is blocked on this device.</h1>
          <p class="text-light-emphasis mb-4">Clear your local storage for Whisper Room Live if you want to reopen it later.</p>
        </section>
      </div>
    </main>
  `;
  throw new Error("Blocked room");
}

function createToken() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `anon-${Math.random().toString(36).slice(2, 12)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getRawRoomHash() {
  return window.location.hash.replace(/^#/, "").trim();
}

function encodeParam(value) {
  return btoa(unescape(encodeURIComponent(value))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeParam(value) {
  if (!value) {
    return "";
  }
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    return decodeURIComponent(escape(atob(padded)));
  } catch (error) {
    return "";
  }
}

function parseRoomState() {
  const hash = getRawRoomHash();
  if (!hash) {
    return {
      room: `room-${Math.random().toString(36).slice(2, 10)}`,
      key: "",
      passcode: "",
      exp: "",
      ttl: "",
      idle: "",
    };
  }
  if (!hash.includes("=")) {
    return { room: hash, key: "", passcode: "", exp: "", ttl: "", idle: "" };
  }
  const params = new URLSearchParams(hash);
  return {
    room: params.get("room") || `room-${Math.random().toString(36).slice(2, 10)}`,
    key: decodeParam(params.get("key") || ""),
    passcode: decodeParam(params.get("pass") || ""),
    exp: params.get("exp") || "",
    ttl: params.get("ttl") || "",
    idle: params.get("idle") || "",
  };
}

function writeRoomStateToHash() {
  const params = new URLSearchParams();
  params.set("room", state.roomId);
  if (state.roomKey) {
    params.set("key", encodeParam(state.roomKey));
  }
  if (state.roomPasscode) {
    params.set("pass", encodeParam(state.roomPasscode));
  }
  if (state.roomExpiryMinutes > 0) {
    params.set("exp", String(state.roomExpiryMinutes));
  }
  if (state.roomMessageTtlMinutes > 0) {
    params.set("ttl", String(state.roomMessageTtlMinutes));
  }
  if (state.roomInactivityLockMinutes > 0) {
    params.set("idle", String(state.roomInactivityLockMinutes));
  }
  history.replaceState(null, "", `#${params.toString()}`);
}

function loadBlockedRooms() {
  try {
    return JSON.parse(localStorage.getItem(ROOM_BLOCKLIST_KEY) || "[]");
  } catch (error) {
    return [];
  }
}

function loadMutedSessions() {
  try {
    return new Set(JSON.parse(localStorage.getItem(MUTE_LIST_KEY) || "[]"));
  } catch (error) {
    return new Set();
  }
}

function persistMutedSessions() {
  localStorage.setItem(MUTE_LIST_KEY, JSON.stringify(Array.from(state.mutedSessions)));
}

function loadStoredPasscode(roomId) {
  try {
    const all = JSON.parse(localStorage.getItem(PASSCODE_STORAGE_KEY) || "{}");
    return all[roomId] || "";
  } catch (error) {
    return "";
  }
}

function storePasscode(roomId, passcode) {
  try {
    const all = JSON.parse(localStorage.getItem(PASSCODE_STORAGE_KEY) || "{}");
    if (passcode) {
      all[roomId] = passcode;
    } else {
      delete all[roomId];
    }
    localStorage.setItem(PASSCODE_STORAGE_KEY, JSON.stringify(all));
  } catch (error) {
    // Ignore storage failures.
  }
}

function initializeRoomState() {
  const parsed = parseRoomState();
  state.roomId = parsed.room;
  state.roomKey = parsed.key;
  state.roomPasscode = parsed.passcode || loadStoredPasscode(parsed.room);
  state.roomExpiryMinutes = Number(parsed.exp || 0);
  state.roomMessageTtlMinutes = Number(parsed.ttl || 0);
  state.roomInactivityLockMinutes = Number(parsed.idle || 0);
  roomPassphraseInput.value = state.roomKey || state.roomPasscode || "";
  roomExpiryMinutesInput.value = state.roomExpiryMinutes || "";
  messageTtlMinutesInput.value = state.roomMessageTtlMinutes || "";
  roomInactivityLockMinutesInput.value = state.roomInactivityLockMinutes || "";
  writeRoomStateToHash();
}

function getRoomLink() {
  return `${window.location.origin}${window.location.pathname}#${new URLSearchParams(window.location.hash.slice(1)).toString()}`;
}

function updateRoomLink() {
  roomLinkDisplay.textContent = getRoomLink();
  renderQrCode();
}

function formatTime(date) {
  return new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDateLabel(date) {
  return new Date(date).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function formatLastSeen(timestamp) {
  if (!timestamp) {
    return "Offline";
  }
  const seconds = Math.max(0, Math.round(Date.now() / 1000 - timestamp));
  if (seconds < 10) {
    return "Online now";
  }
  if (seconds < 60) {
    return `Seen ${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `Seen ${minutes}m ago`;
  }
  return `Seen ${Math.round(minutes / 60)}h ago`;
}

function getPresenceText() {
  const count = state.participantDetails.length;
  if (!count) {
    return "You are alone in the room right now.";
  }
  if (count === 1) {
    return "1 participant currently active in this room.";
  }
  return `${count} participants currently active in this room.`;
}

function participantColor(id) {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = ((hash << 5) - hash) + id.charCodeAt(index);
    hash |= 0;
  }
  return `hsl(${Math.abs(hash) % 360} 72% 58%)`;
}

function showReconnectBanner(message) {
  reconnectBanner.textContent = message;
  reconnectBanner.classList.remove("d-none");
}

function hideReconnectBanner() {
  reconnectBanner.classList.add("d-none");
  reconnectBanner.textContent = "";
}

function blockCurrentRoom() {
  const rooms = new Set(loadBlockedRooms());
  rooms.add(getRawRoomHash());
  localStorage.setItem(ROOM_BLOCKLIST_KEY, JSON.stringify(Array.from(rooms)));
}

function toggleMuteSession(targetSessionId) {
  if (!targetSessionId || targetSessionId === sessionId) {
    return;
  }
  if (state.mutedSessions.has(targetSessionId)) {
    state.mutedSessions.delete(targetSessionId);
  } else {
    state.mutedSessions.add(targetSessionId);
  }
  persistMutedSessions();
  renderMessages();
}

function updatePresence(participants, participantDetails = []) {
  state.participantDetails = participantDetails;
  presenceStatus.textContent = participants > 0 ? getPresenceText() : "You are alone in the room right now.";
  if (!participantDetails.length) {
    participantList.innerHTML = '<div class="small text-light-emphasis">No one else is here yet.</div>';
    return;
  }
  participantList.innerHTML = "";
  participantDetails.forEach((participant) => {
    const pill = document.createElement("div");
    pill.className = `participant-pill${participant.session_id === sessionId ? " self" : ""}`;
    pill.innerHTML = `
      <span class="participant-dot" style="background:${participantColor(participant.session_id)}"></span>
      <span>${escapeHtml(participant.sender_name)}</span>
      <span class="text-light-emphasis">${escapeHtml(formatLastSeen(participant.last_seen))}</span>
    `;
    participantList.appendChild(pill);
  });
}

function updateTypingUi() {
  const typers = Array.from(state.typingUsers.entries()).map(([id, name]) => ({ id, name }));
  if (!typers.length) {
    roomTypingStatus.classList.add("d-none");
    roomTypingStatus.innerHTML = "";
    return;
  }
  roomTypingStatus.classList.remove("d-none");
  roomTypingStatus.innerHTML = `
    <div class="typing-avatar-list">
      ${typers.map((typer) => `
        <div class="typing-avatar">
          <span class="avatar-dot" style="background:${participantColor(typer.id)}"></span>
          <span>${escapeHtml(typer.name)}</span>
          <span class="typing-dots"><span></span><span></span><span></span></span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderEmptyBoard(message) {
  messageBoard.innerHTML = `<div class="system-note">${escapeHtml(message)}</div>`;
}

function getFileKind(file) {
  if (!file || !file.type) {
    return "file";
  }
  if (file.type.startsWith("image/")) {
    return "image";
  }
  if (file.type.startsWith("video/")) {
    return "video";
  }
  if (file.type.startsWith("audio/")) {
    return "audio";
  }
  return "file";
}

function getPreferredAudioMimeType() {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) {
    return "";
  }
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || "";
}

function getMessageById(messageId) {
  return state.messages.find((message) => message.id === messageId) || null;
}

function pruneExpiredMessages() {
  const nowSeconds = Date.now() / 1000;
  state.messages = state.messages.filter((message) => !message.expires_at || message.expires_at > nowSeconds);
}

function renderReplySnippet(message) {
  if (!message) {
    return "";
  }
  const preview = message.text || (message.encrypted_text ? "Encrypted message" : message.file?.name || "Attachment");
  return `
    <div class="message-reply">
      <strong>${escapeHtml(message.sender_name)}</strong>
      <div>${escapeHtml(preview.slice(0, 120))}</div>
    </div>
  `;
}

function buildVoiceMarkup(file) {
  return `
    <div class="voice-note-card">
      <div class="voice-note-top">
        <div class="voice-play" aria-hidden="true"></div>
        <div>
          <strong>Voice note</strong>
          <div class="small text-light-emphasis">${escapeHtml(file.name || "audio-note.webm")}</div>
        </div>
      </div>
      <div class="voice-wave"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
      <div class="voice-progress"></div>
      <audio class="message-audio" controls src="${file.data_url}"></audio>
    </div>
  `;
}

function buildFileMarkup(file) {
  if (!file) {
    return "";
  }
  const kind = getFileKind(file);
  if (kind === "image") {
    return `
      <img class="message-preview js-lightbox-trigger" data-kind="image" data-src="${file.data_url}" alt="${escapeHtml(file.name)}" src="${file.data_url}">
      <div class="message-actions">
        <a class="message-action-link" href="${file.data_url}" download="${escapeHtml(file.name)}">Download image</a>
      </div>
    `;
  }
  if (kind === "video") {
    return `
      <video class="message-video js-lightbox-trigger" data-kind="video" data-src="${file.data_url}" data-type="${escapeHtml(file.type)}" controls preload="metadata">
        <source src="${file.data_url}" type="${escapeHtml(file.type)}">
      </video>
      <div class="message-actions">
        <a class="message-action-link" href="${file.data_url}" download="${escapeHtml(file.name)}">Download video</a>
      </div>
    `;
  }
  if (kind === "audio") {
    return `
      ${buildVoiceMarkup(file)}
      <div class="message-actions">
        <a class="message-action-link" href="${file.data_url}" download="${escapeHtml(file.name)}">Download audio</a>
      </div>
    `;
  }
  return `
    <a class="message-file" href="${file.data_url}" download="${escapeHtml(file.name)}">Attached file: ${escapeHtml(file.name)}</a>
    <div class="message-actions">
      <a class="message-action-link" href="${file.data_url}" download="${escapeHtml(file.name)}">Download file</a>
    </div>
  `;
}

function receiptLabel(message) {
  if (message.session_id !== sessionId) {
    return "";
  }
  const deliveredOthers = (message.delivered_to || []).filter((id) => id !== sessionId).length;
  const readOthers = (message.read_by || []).filter((id) => id !== sessionId).length;
  if (readOthers > 0) {
    return '<div class="message-receipt read">Read</div>';
  }
  if (deliveredOthers > 0) {
    return '<div class="message-receipt">Delivered</div>';
  }
  return '<div class="message-receipt">Sent</div>';
}

function buildReactionsMarkup(message) {
  const reactions = message.reactions || {};
  return `
    <div class="reaction-bar">
      ${REACTION_SET.map((emoji) => {
        const sessions = reactions[emoji] || [];
        const active = sessions.includes(sessionId);
        return `
          <button class="reaction-chip${active ? " active" : ""}" type="button" data-action="react" data-id="${message.id}" data-emoji="${emoji}">
            <span>${emoji}</span>
            <span>${sessions.length || ""}</span>
          </button>
        `;
      }).join("")}
    </div>
  `;
}

function buildToolbarMarkup(message) {
  if (state.mutedSessions.has(message.session_id) && message.session_id !== sessionId) {
    return `
      <div class="message-toolbar">
        <button class="message-tool-button" type="button" data-action="mute" data-session="${message.session_id}">Unmute</button>
      </div>
    `;
  }
  return `
    <div class="message-toolbar">
      <button class="message-tool-button" type="button" data-action="reply" data-id="${message.id}">Reply</button>
      <button class="message-tool-button" type="button" data-action="pin" data-id="${message.id}">${message.id === state.pinnedMessageId ? "Unpin" : "Pin"}</button>
      ${message.session_id !== sessionId ? `<button class="message-tool-button" type="button" data-action="mute" data-session="${message.session_id}">${state.mutedSessions.has(message.session_id) ? "Unmute" : "Mute"}</button>` : ""}
    </div>
  `;
}

function renderAttachments() {
  const attachments = state.messages.filter((message) => message.file);
  if (!attachments.length) {
    attachmentSidebar.innerHTML = '<div class="attachment-empty">No room uploads yet.</div>';
    return;
  }
  attachmentSidebar.innerHTML = "";
  attachments.slice().reverse().forEach((message) => {
    const file = message.file;
    const kind = getFileKind(file);
    const card = document.createElement("div");
    card.className = "attachment-card";
    let preview = "";
    if (kind === "image") {
      preview = `<img class="js-lightbox-trigger" data-kind="image" data-src="${file.data_url}" alt="${escapeHtml(file.name)}" src="${file.data_url}">`;
    } else if (kind === "video") {
      preview = `
        <video class="js-lightbox-trigger" data-kind="video" data-src="${file.data_url}" data-type="${escapeHtml(file.type)}" controls preload="metadata">
          <source src="${file.data_url}" type="${escapeHtml(file.type)}">
        </video>
      `;
    }
    card.innerHTML = `
      <div class="attachment-title">${escapeHtml(file.name)}</div>
      <div class="attachment-meta">${escapeHtml(message.sender_name)} - ${formatTime(message.timestamp)}</div>
      ${preview}
      <div class="message-actions">
        <a class="message-action-link" href="${file.data_url}" download="${escapeHtml(file.name)}">Download</a>
      </div>
    `;
    attachmentSidebar.appendChild(card);
  });
  bindLightboxTriggers();
}

async function decryptTextPayload(encryptedPayload) {
  if (!encryptedPayload || !state.roomKey || !window.crypto?.subtle) {
    return null;
  }
  try {
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(state.roomKey),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    const key = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: new TextEncoder().encode(`whisper-room-live:${state.roomId}`),
        iterations: 120000,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const iv = Uint8Array.from(atob(encryptedPayload.iv), (char) => char.charCodeAt(0));
    const encryptedBytes = Uint8Array.from(atob(encryptedPayload.cipher), (char) => char.charCodeAt(0));
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encryptedBytes);
    return new TextDecoder().decode(decrypted);
  } catch (error) {
    return null;
  }
}

async function encryptTextPayload(plainText) {
  if (!state.roomKey || !window.crypto?.subtle) {
    return null;
  }
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(state.roomKey),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(`whisper-room-live:${state.roomId}`),
      iterations: 120000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plainText));
  return {
    cipher: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
    iv: btoa(String.fromCharCode(...iv)),
  };
}

async function normalizeIncomingMessage(message) {
  if (message.encrypted_text && !message.text) {
    const decrypted = await decryptTextPayload(message.encrypted_text);
    return {
      ...message,
      text: decrypted || "[Encrypted message. Open with the secure link or correct passphrase.]",
    };
  }
  return message;
}

async function normalizeIncomingMessages(messages) {
  return Promise.all((messages || []).map((message) => normalizeIncomingMessage(message)));
}

function renderReplyPreview() {
  if (!state.replyTargetId) {
    replyPreview.classList.add("d-none");
    replyPreview.innerHTML = "";
    return;
  }
  const target = getMessageById(state.replyTargetId);
  if (!target) {
    state.replyTargetId = null;
    renderReplyPreview();
    return;
  }
  replyPreview.classList.remove("d-none");
  replyPreview.innerHTML = `
    <div>
      <div class="small text-light-emphasis mb-1">Replying to ${escapeHtml(target.sender_name)}</div>
      <div>${escapeHtml((target.text || target.file?.name || "Attachment").slice(0, 120))}</div>
    </div>
    <button class="message-tool-button" type="button" id="cancelReplyButton">Cancel</button>
  `;
  document.getElementById("cancelReplyButton").addEventListener("click", () => {
    state.replyTargetId = null;
    renderReplyPreview();
  });
}

function renderPinnedMessage() {
  if (!state.pinnedMessageId) {
    pinnedMessageCard.classList.add("d-none");
    pinnedMessageCard.innerHTML = "";
    return;
  }
  const pinned = getMessageById(state.pinnedMessageId);
  if (!pinned) {
    pinnedMessageCard.classList.add("d-none");
    pinnedMessageCard.innerHTML = "";
    return;
  }
  pinnedMessageCard.classList.remove("d-none");
  pinnedMessageCard.innerHTML = `
    <div class="small text-light-emphasis mb-1">Pinned message</div>
    <div><strong>${escapeHtml(pinned.sender_name)}</strong></div>
    <div>${escapeHtml((pinned.text || pinned.file?.name || "Attachment").slice(0, 180))}</div>
  `;
}

function renderMessages() {
  pruneExpiredMessages();
  if (!state.messages.length) {
    renderEmptyBoard("Room is ready. Share the link and start chatting.");
    renderAttachments();
    renderPinnedMessage();
    renderReplyPreview();
    return;
  }
  messageBoard.innerHTML = "";
  let previousMessage = null;
  let previousDateLabel = "";
  state.messages.forEach((message) => {
    const currentDateLabel = formatDateLabel(message.timestamp);
    if (currentDateLabel !== previousDateLabel) {
      const separator = document.createElement("div");
      separator.className = "date-separator";
      separator.textContent = currentDateLabel;
      messageBoard.appendChild(separator);
      previousDateLabel = currentDateLabel;
    }
    const grouped = Boolean(
      previousMessage
      && previousMessage.session_id === message.session_id
      && formatDateLabel(previousMessage.timestamp) === currentDateLabel
    );
    const replyTarget = message.reply_to ? getMessageById(message.reply_to) : null;
    const article = document.createElement("article");
    article.className = `message-card${message.session_id === sessionId ? " self" : ""}${grouped ? " grouped" : ""}${state.mutedSessions.has(message.session_id) && message.session_id !== sessionId ? " muted" : ""}`;
    article.dataset.messageId = String(message.id);
    article.innerHTML = `
      <div class="message-meta">
        <span class="message-meta-main">
          <span>${escapeHtml(message.sender_name)}</span>
        </span>
        <span>${formatTime(message.timestamp)}</span>
      </div>
      ${renderReplySnippet(replyTarget)}
      ${message.text ? `<div class="message-text">${escapeHtml(message.text)}</div>` : ""}
      ${buildFileMarkup(message.file)}
      ${buildReactionsMarkup(message)}
      ${buildToolbarMarkup(message)}
      ${receiptLabel(message)}
    `;
    messageBoard.appendChild(article);
    previousMessage = message;
  });
  messageBoard.scrollTop = messageBoard.scrollHeight;
  renderAttachments();
  renderPinnedMessage();
  renderReplyPreview();
  bindLightboxTriggers();
  sendReadReceipt();
}

function buildGalleryMarkup() {
  const mediaMessages = state.messages.filter((message) => {
    const kind = getFileKind(message.file);
    return kind === "image" || kind === "video";
  });
  if (!mediaMessages.length) {
    return '<div class="system-note">No media in this room yet.</div>';
  }
  return `
    <div class="gallery-grid">
      ${mediaMessages.map((message) => {
        const kind = getFileKind(message.file);
        return `
          <div class="gallery-card">
            ${kind === "video"
              ? `<video controls preload="metadata"><source src="${message.file.data_url}" type="${escapeHtml(message.file.type)}"></video>`
              : `<img src="${message.file.data_url}" alt="${escapeHtml(message.file.name)}">`
            }
            <div class="gallery-meta">
              <div>${escapeHtml(message.file.name)}</div>
              <div>${escapeHtml(message.sender_name)} • ${formatTime(message.timestamp)}</div>
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function bindLightboxTriggers() {
  document.querySelectorAll(".js-lightbox-trigger").forEach((element) => {
    if (element.dataset.bound === "true") {
      return;
    }
    element.dataset.bound = "true";
    element.addEventListener("click", () => {
      const kind = element.dataset.kind;
      const src = element.dataset.src;
      const type = element.dataset.type || "";
      if (!src) {
        return;
      }
      if (kind === "video") {
        lightboxContent.innerHTML = `
          <video controls autoplay preload="metadata">
            <source src="${src}" type="${escapeHtml(type)}">
          </video>
        `;
      } else {
        lightboxContent.innerHTML = `<img src="${src}" alt="Expanded preview">`;
      }
      lightbox.classList.remove("d-none");
      document.body.style.overflow = "hidden";
    });
  });
}

function closeLightbox() {
  lightbox.classList.add("d-none");
  lightboxContent.innerHTML = "";
  document.body.style.overflow = "";
}

function showTypingEffect() {
  typingIndicator.classList.remove("d-none");
  return new Promise((resolve) => {
    window.setTimeout(() => {
      typingIndicator.classList.add("d-none");
      resolve();
    }, 220);
  });
}

async function fileToPayload(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  return {
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    data_url: dataUrl,
  };
}

function connectSocket() {
  if (state.socket && (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const query = new URLSearchParams({
    room: state.roomId,
    session_id: sessionId,
  });
  if (state.roomPasscode) {
    query.set("passcode", state.roomPasscode);
  }
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws?${query.toString()}`);
  state.socket = socket;

  socket.addEventListener("open", () => {
    state.isConnected = true;
    hideReconnectBanner();
    sessionStatus.textContent = `Connected live to ${state.roomId}. Messages now arrive instantly.`;
    sendTypingState(false);
  });

  socket.addEventListener("message", async (event) => {
    try {
      const payload = JSON.parse(event.data);
      await handleSocketEvent(payload);
    } catch (error) {
      presenceStatus.textContent = "Received an unreadable realtime event.";
    }
  });

  socket.addEventListener("close", () => {
    state.isConnected = false;
    updatePresence(0, []);
    sessionStatus.textContent = "Realtime connection closed. Reconnecting...";
    showReconnectBanner(`Reconnecting to ${state.roomId}... messages will resume automatically.`);
    if (state.reconnectTimer) {
      window.clearTimeout(state.reconnectTimer);
    }
    state.reconnectTimer = window.setTimeout(connectSocket, 1200);
  });

  socket.addEventListener("error", () => {
    sessionStatus.textContent = "Realtime connection hit an error. Retrying...";
    showReconnectBanner(`Connection issue in ${state.roomId}. Trying again...`);
  });
}

function updateRoomPolicy(policy = {}) {
  state.roomExpiresAt = policy.expires_at || null;
  state.roomProtected = Boolean(policy.is_protected);
  state.roomMessageTtlMinutes = policy.message_ttl_seconds ? Math.round(policy.message_ttl_seconds / 60) : state.roomMessageTtlMinutes;
  state.roomInactivityLockMinutes = policy.inactivity_lock_seconds ? Math.round(policy.inactivity_lock_seconds / 60) : state.roomInactivityLockMinutes;
  if (policy.expires_at) {
    sessionStatus.textContent = `Secure room active. Link expires at ${new Date(policy.expires_at * 1000).toLocaleString()}.`;
  }
}

async function handleSocketEvent(payload) {
  if (payload.type === "welcome") {
    state.messages = await normalizeIncomingMessages(payload.messages || []);
    state.pinnedMessageId = payload.pinned_message_id || null;
    updateRoomPolicy(payload.room_policy || {});
    updatePresence(payload.participants, payload.participant_details || []);
    renderMessages();
    sessionStatus.textContent = `Connected as ${payload.sender_name} in ${payload.room_id}. Messages live only while the room stays active.`;
    hideReconnectBanner();
    return;
  }

  if (payload.type === "room_policy") {
    updateRoomPolicy(payload.room_policy || {});
    updateRoomLink();
    return;
  }

  if (payload.type === "presence") {
    updatePresence(payload.participants, payload.participant_details || []);
    return;
  }

  if (payload.type === "typing") {
    if (payload.session_id === sessionId) {
      return;
    }
    if (payload.is_typing) {
      state.typingUsers.set(payload.session_id, payload.sender_name);
    } else {
      state.typingUsers.delete(payload.session_id);
    }
    updateTypingUi();
    return;
  }

  if (payload.type === "reaction_update") {
    const target = getMessageById(payload.message_id);
    if (target) {
      target.reactions = payload.reactions || {};
      renderMessages();
    }
    return;
  }

  if (payload.type === "pin_update") {
    state.pinnedMessageId = payload.pinned_message_id || null;
    renderMessages();
    return;
  }

  if (payload.type === "message" && payload.message) {
    const normalized = await normalizeIncomingMessage(payload.message);
    const exists = state.messages.some((message) => message.id === normalized.id);
    if (!exists) {
      state.messages.push(normalized);
      renderMessages();
      if (document.hidden && normalized.session_id !== sessionId) {
        maybeNotify(normalized);
      }
    }
    return;
  }

  if (payload.type === "receipt_update" && payload.receipts) {
    payload.receipts.forEach((receipt) => {
      const existing = getMessageById(receipt.id);
      if (existing) {
        existing.delivered_to = receipt.delivered_to || [];
        existing.read_by = receipt.read_by || [];
      }
    });
    renderMessages();
    return;
  }

  if (payload.type === "error") {
    fileStatus.textContent = payload.message || "Something went wrong while sending.";
  }
}

function sendSocketEvent(payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  state.socket.send(JSON.stringify(payload));
  return true;
}

function sendTypingState(isTyping) {
  if (!sendSocketEvent({ type: "typing", is_typing: isTyping })) {
    return;
  }
  state.sentTypingState = isTyping;
}

function scheduleTypingStop() {
  if (state.typingTimeout) {
    window.clearTimeout(state.typingTimeout);
  }
  state.typingTimeout = window.setTimeout(() => {
    sendTypingState(false);
  }, 900);
}

function sendReadReceipt() {
  const lastMessage = state.messages[state.messages.length - 1];
  if (!lastMessage || lastMessage.id <= state.lastReadMessageId) {
    return;
  }
  state.lastReadMessageId = lastMessage.id;
  sendSocketEvent({ type: "read", last_message_id: lastMessage.id });
}

async function sendMessage() {
  const plainText = messageInput.value.trim();
  const sourceFile = state.selectedFile;
  if (state.mediaRecorder && state.mediaRecorder.state === "recording") {
    fileStatus.textContent = "Stop the voice recording first, then send it.";
    return;
  }
  if (!plainText && !sourceFile) {
    fileStatus.textContent = "Add a message, file, or voice note before sending.";
    return;
  }
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    fileStatus.textContent = "Realtime connection is not ready yet.";
    return;
  }
  let filePayload = null;
  if (sourceFile) {
    if (sourceFile.size > 12 * 1024 * 1024) {
      fileStatus.textContent = "Please keep uploads below 12MB for this lightweight room server.";
      return;
    }
    fileStatus.textContent = "Preparing upload...";
    filePayload = await fileToPayload(sourceFile);
  }
  const encryptedPayload = plainText && state.roomKey ? await encryptTextPayload(plainText) : null;
  await showTypingEffect();
  sendTypingState(false);
  sendSocketEvent({
    type: "message",
    text: encryptedPayload ? "" : plainText,
    encrypted_text: encryptedPayload,
    file: filePayload,
    reply_to: state.replyTargetId,
    self_destruct_minutes: Number(messageSelfDestructSelect.value || 0),
  });
  messageInput.value = "";
  fileInput.value = "";
  state.selectedFile = null;
  state.replyTargetId = null;
  messageSelfDestructSelect.value = String(state.roomMessageTtlMinutes || 0);
  discardVoiceButton.classList.add("d-none");
  voiceStatus.textContent = DEFAULT_VOICE_STATUS;
  voiceWavePreview.classList.add("d-none");
  fileStatus.textContent = filePayload ? "Sent to the room instantly." : "Message sent instantly.";
  renderReplyPreview();
}

async function toggleVoiceRecording() {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    voiceStatus.textContent = "Voice recording is not supported in this browser.";
    return;
  }
  if (state.mediaRecorder && state.mediaRecorder.state === "recording") {
    state.mediaRecorder.stop();
    recordVoiceButton.textContent = "Start voice note";
    voiceStatus.textContent = "Voice note captured and ready to send.";
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  state.recordingStream = stream;
  state.audioChunks = [];
  const mimeType = getPreferredAudioMimeType();
  state.mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  state.mediaRecorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      state.audioChunks.push(event.data);
    }
  });
  state.mediaRecorder.addEventListener("stop", async () => {
    const finalMimeType = state.mediaRecorder?.mimeType || mimeType || "audio/webm";
    const extension = finalMimeType.includes("mp4") ? "m4a" : finalMimeType.includes("ogg") ? "ogg" : "webm";
    const blob = new Blob(state.audioChunks, { type: finalMimeType });
    const file = new File([blob], `voice-note-${Date.now()}.${extension}`, { type: blob.type });
    state.audioChunks = [];
    setSelectedFile(file);
    await renderWaveform(blob);
    discardVoiceButton.classList.remove("d-none");
    if (state.recordingStream) {
      state.recordingStream.getTracks().forEach((track) => track.stop());
      state.recordingStream = null;
    }
    recordVoiceButton.textContent = "Start voice note";
    voiceStatus.textContent = "Voice note captured and ready to send.";
  });
  state.mediaRecorder.start();
  recordVoiceButton.textContent = "Stop recording";
  voiceStatus.textContent = "Recording... tap again to stop.";
}

async function renderWaveform(blob) {
  if (!voiceWavePreview || !window.AudioContext) {
    return;
  }
  try {
    const audioContext = new AudioContext();
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    const rawData = audioBuffer.getChannelData(0);
    const samples = 60;
    const blockSize = Math.floor(rawData.length / samples);
    const filtered = [];
    for (let index = 0; index < samples; index += 1) {
      let sum = 0;
      for (let offset = 0; offset < blockSize; offset += 1) {
        sum += Math.abs(rawData[(index * blockSize) + offset] || 0);
      }
      filtered.push(sum / blockSize);
    }
    const canvas = voiceWavePreview;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "rgba(255, 255, 255, 0.08)";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#ffb703";
    const barWidth = canvas.width / filtered.length;
    filtered.forEach((value, index) => {
      const height = Math.max(6, value * canvas.height * 3.2);
      context.fillRect(index * barWidth, (canvas.height - height) / 2, Math.max(3, barWidth - 2), height);
    });
    voiceWavePreview.classList.remove("d-none");
    audioContext.close();
  } catch (error) {
    voiceWavePreview.classList.add("d-none");
  }
}

function discardVoiceRecording() {
  if (!state.selectedFile || !state.selectedFile.type.startsWith("audio/")) {
    return;
  }
  state.selectedFile = null;
  fileInput.value = "";
  discardVoiceButton.classList.add("d-none");
  voiceWavePreview.classList.add("d-none");
  voiceStatus.textContent = "Voice note discarded.";
  fileStatus.textContent = "Voice note removed from the composer.";
}

function setSelectedFile(file) {
  state.selectedFile = file;
  discardVoiceButton.classList.toggle("d-none", !file.type.startsWith("audio/"));
  fileStatus.textContent = file.type.startsWith("audio/")
    ? `${file.name} recorded and ready to send.`
    : `${file.name} attached and ready to send.`;
  if (window.DataTransfer && fileInput) {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    fileInput.files = transfer.files;
  }
}

function renderQrCode() {
  const link = encodeURIComponent(getRoomLink());
  qrCard.className = "qr-card text-center";
  qrCard.innerHTML = `
    <img src="https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${link}" alt="Room QR code">
    <div class="small text-light-emphasis mt-2">Scan to join this room instantly.</div>
  `;
}

async function maybeNotify(message) {
  if (!("Notification" in window) || Notification.permission !== "granted") {
    return;
  }
  const body = message.text || message.file?.name || "New room activity";
  const notification = new Notification(`${message.sender_name} in ${state.roomId}`, { body });
  notification.onclick = () => window.focus();
}

async function requestNotifications() {
  if (!("Notification" in window)) {
    enableNotificationsButton.textContent = "Notifications unsupported";
    return;
  }
  const permission = await Notification.requestPermission();
  enableNotificationsButton.textContent = permission === "granted"
    ? "Notifications enabled"
    : "Notifications blocked";
}

function exportRoomMedia() {
  const exportPayload = {
    room_id: state.roomId,
    exported_at: new Date().toISOString(),
    media: state.messages
      .filter((message) => message.file)
      .map((message) => ({
        id: message.id,
        sender_name: message.sender_name,
        timestamp: message.timestamp,
        file: message.file,
      })),
  };
  const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${state.roomId}-media-export.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function applyPrivacySettings() {
  const passphrase = roomPassphraseInput.value.trim();
  state.roomKey = passphrase;
  state.roomPasscode = passphrase;
  state.roomExpiryMinutes = Number(roomExpiryMinutesInput.value || 0);
  state.roomMessageTtlMinutes = Number(messageTtlMinutesInput.value || 0);
  state.roomInactivityLockMinutes = Number(roomInactivityLockMinutesInput.value || 0);
  storePasscode(state.roomId, state.roomPasscode);
  writeRoomStateToHash();
  updateRoomLink();
  messageSelfDestructSelect.value = String(state.roomMessageTtlMinutes || 0);
  if (sendSocketEvent({
    type: "room_settings",
    passphrase: state.roomPasscode,
    expiry_minutes: state.roomExpiryMinutes,
    message_ttl_minutes: state.roomMessageTtlMinutes,
    inactivity_lock_minutes: state.roomInactivityLockMinutes,
  })) {
    fileStatus.textContent = "Secure link settings applied to this room.";
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  navigator.serviceWorker.register("./sw.js").catch(() => {
    // Ignore unsupported hosts.
  });
}

function setupInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.deferredPrompt = event;
    installAppButton.classList.remove("d-none");
  });
  installAppButton.addEventListener("click", async () => {
    if (!state.deferredPrompt) {
      return;
    }
    state.deferredPrompt.prompt();
    await state.deferredPrompt.userChoice;
    state.deferredPrompt = null;
    installAppButton.classList.add("d-none");
  });
}

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await sendMessage();
  } catch (error) {
    fileStatus.textContent = error.message || "Unable to send right now.";
  }
});

messageBoard.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) {
    return;
  }
  const action = button.dataset.action;
  if (action === "reply") {
    state.replyTargetId = Number(button.dataset.id || 0);
    renderReplyPreview();
    messageInput.focus();
    return;
  }
  if (action === "pin") {
    sendSocketEvent({ type: "pin", message_id: Number(button.dataset.id || 0) });
    return;
  }
  if (action === "react") {
    sendSocketEvent({
      type: "reaction",
      message_id: Number(button.dataset.id || 0),
      emoji: button.dataset.emoji || "",
    });
    return;
  }
  if (action === "mute") {
    toggleMuteSession(button.dataset.session || "");
  }
});

clearComposerButton.addEventListener("click", () => {
  messageInput.value = "";
  fileInput.value = "";
  state.selectedFile = null;
  state.replyTargetId = null;
  if (state.recordingStream) {
    state.recordingStream.getTracks().forEach((track) => track.stop());
    state.recordingStream = null;
  }
  discardVoiceButton.classList.add("d-none");
  voiceWavePreview.classList.add("d-none");
  recordVoiceButton.textContent = "Start voice note";
  fileStatus.textContent = "Composer reset.";
  voiceStatus.textContent = DEFAULT_VOICE_STATUS;
  renderReplyPreview();
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) {
    state.selectedFile = null;
    fileStatus.textContent = "Optional. Files are sent inside this live room only.";
    return;
  }
  setSelectedFile(file);
  if (file.type.startsWith("audio/")) {
    await renderWaveform(file);
  } else {
    voiceWavePreview.classList.add("d-none");
  }
});

messageInput.addEventListener("input", () => {
  const hasDraft = Boolean(messageInput.value.trim());
  if (state.sentTypingState === hasDraft) {
    return;
  }
  sendTypingState(hasDraft);
  if (hasDraft) {
    scheduleTypingStop();
  }
});

["dragenter", "dragover"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragover");
  });
});

dropZone.addEventListener("drop", async (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (!file) {
    return;
  }
  setSelectedFile(file);
  if (file.type.startsWith("audio/")) {
    await renderWaveform(file);
  }
});

recordVoiceButton.addEventListener("click", async () => {
  try {
    await toggleVoiceRecording();
  } catch (error) {
    voiceStatus.textContent = "Microphone access was denied or unavailable.";
    recordVoiceButton.textContent = "Start voice note";
  }
});

discardVoiceButton.addEventListener("click", discardVoiceRecording);

themeSelect.addEventListener("change", () => {
  document.body.dataset.theme = themeSelect.value;
});

copyRoomLinkButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(getRoomLink());
    copyRoomLinkButton.textContent = "Copied";
    window.setTimeout(() => {
      copyRoomLinkButton.textContent = "Copy link";
    }, 1200);
  } catch (error) {
    roomLinkDisplay.textContent = `${getRoomLink()} (copy manually)`;
  }
});

shareRoomLinkButton.addEventListener("click", async () => {
  const link = getRoomLink();
  if (navigator.share) {
    try {
      await navigator.share({ title: "Whisper Room Live", text: "Join my private room", url: link });
      return;
    } catch (error) {
      // Fall through.
    }
  }
  try {
    await navigator.clipboard.writeText(link);
    shareRoomLinkButton.textContent = "Link copied";
    window.setTimeout(() => {
      shareRoomLinkButton.textContent = "Share room";
    }, 1200);
  } catch (error) {
    roomLinkDisplay.textContent = `${link} (share manually)`;
  }
});

applyPrivacySettingsButton.addEventListener("click", applyPrivacySettings);
enableNotificationsButton.addEventListener("click", requestNotifications);
openGalleryButton.addEventListener("click", () => {
  lightboxContent.innerHTML = buildGalleryMarkup();
  lightbox.classList.remove("d-none");
  document.body.style.overflow = "hidden";
});
exportMediaButton.addEventListener("click", exportRoomMedia);
blockRoomButton.addEventListener("click", () => {
  blockCurrentRoom();
  sessionStatus.textContent = "This room is now blocked on this device.";
});

lightboxClose.addEventListener("click", closeLightbox);
lightbox.addEventListener("click", (event) => {
  if (event.target === lightbox) {
    closeLightbox();
  }
});

lightbox.addEventListener("touchstart", (event) => {
  state.lightboxTouchStartY = event.touches[0]?.clientY ?? null;
}, { passive: true });

lightbox.addEventListener("touchend", (event) => {
  if (state.lightboxTouchStartY === null) {
    return;
  }
  const endY = event.changedTouches[0]?.clientY ?? state.lightboxTouchStartY;
  const deltaY = endY - state.lightboxTouchStartY;
  state.lightboxTouchStartY = null;
  if (Math.abs(deltaY) > 80) {
    closeLightbox();
  }
}, { passive: true });

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeLightbox();
  }
});

window.addEventListener("hashchange", () => {
  initializeRoomState();
  state.messages = [];
  state.typingUsers.clear();
  state.participantDetails = [];
  state.replyTargetId = null;
  updateTypingUi();
  updatePresence(0, []);
  renderReplyPreview();
  showReconnectBanner(`Switching into ${state.roomId}... reconnecting now.`);
  updateRoomLink();
  renderMessages();
  if (state.socket) {
    state.socket.close();
  } else {
    connectSocket();
  }
});

window.addEventListener("beforeunload", () => {
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    sendTypingState(false);
    state.socket.close();
  }
});

function init() {
  initializeRoomState();
  messageSelfDestructSelect.value = String(state.roomMessageTtlMinutes || 0);
  updateRoomLink();
  renderMessages();
  window.setInterval(renderMessages, 5000);
  registerServiceWorker();
  setupInstallPrompt();
  connectSocket();
}

init();
