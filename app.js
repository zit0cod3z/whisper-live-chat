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
const attachmentSidebar = document.getElementById("attachmentSidebar");
const dropZone = document.getElementById("dropZone");
const recordVoiceButton = document.getElementById("recordVoiceButton");
const discardVoiceButton = document.getElementById("discardVoiceButton");
const voiceStatus = document.getElementById("voiceMockStatus");
const themeSelect = document.getElementById("themeSelect");
const roomLinkDisplay = document.getElementById("roomLinkDisplay");
const copyRoomLinkButton = document.getElementById("copyRoomLink");
const shareRoomLinkButton = document.getElementById("shareRoomLink");
const lightbox = document.getElementById("lightbox");
const lightboxContent = document.getElementById("lightboxContent");
const lightboxClose = document.getElementById("lightboxClose");

const sessionId = sessionStorage.getItem("whisper-room-live-session") || createToken();
sessionStorage.setItem("whisper-room-live-session", sessionId);

const state = {
  roomId: getOrCreateRoomId(),
  messages: [],
  selectedFile: null,
  mediaRecorder: null,
  audioChunks: [],
  socket: null,
  reconnectTimer: null,
  lightboxTouchStartY: null,
  typingUsers: new Map(),
  isConnected: false,
  lastReadMessageId: 0,
  typingTimeout: null,
  sentTypingState: false,
  recordingStream: null,
};

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

function formatTime(date) {
  return new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDateLabel(date) {
  return new Date(date).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
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
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || "";
}

function getOrCreateRoomId() {
  const existing = window.location.hash.replace("#", "").trim();
  if (existing) {
    return existing;
  }
  const generated = `room-${Math.random().toString(36).slice(2, 10)}`;
  window.location.hash = generated;
  return generated;
}

function getRoomLink() {
  return `${window.location.origin}${window.location.pathname}#${state.roomId}`;
}

function updateRoomLink() {
  roomLinkDisplay.textContent = getRoomLink();
}

function updatePresence(participants) {
  if (!participants || participants === 1) {
    presenceStatus.textContent = "You are alone in the room right now.";
    return;
  }
  presenceStatus.textContent = `${participants} participants currently active in this room.`;
}

function showReconnectBanner(message) {
  reconnectBanner.textContent = message;
  reconnectBanner.classList.remove("d-none");
}

function hideReconnectBanner() {
  reconnectBanner.classList.add("d-none");
  reconnectBanner.textContent = "";
}

function updateTypingUi() {
  const names = Array.from(state.typingUsers.values()).filter(Boolean);
  if (!names.length) {
    roomTypingStatus.classList.add("d-none");
    roomTypingStatus.textContent = "";
    return;
  }
  roomTypingStatus.classList.remove("d-none");
  roomTypingStatus.textContent = names.length === 1
    ? `${names[0]} is typing...`
    : `${names.length} people are typing...`;
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

function renderEmptyBoard(message) {
  messageBoard.innerHTML = `<div class="system-note">${escapeHtml(message)}</div>`;
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
      <img class="message-preview js-lightbox-trigger" data-kind="image" data-src="${file.data_url}" src="${file.data_url}" alt="${escapeHtml(file.name)}">
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
      preview = `<img class="js-lightbox-trigger" data-kind="image" data-src="${file.data_url}" src="${file.data_url}" alt="${escapeHtml(file.name)}">`;
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

function renderMessages() {
  if (!state.messages.length) {
    renderEmptyBoard("Room is ready. Share the link and start chatting.");
    renderAttachments();
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

    const article = document.createElement("article");
    article.className = `message-card${message.session_id === sessionId ? " self" : ""}${grouped ? " grouped" : ""}`;
    article.innerHTML = `
      <div class="message-meta">
        <span class="message-meta-main">
          <span>${escapeHtml(message.sender_name)}</span>
        </span>
        <span>${formatTime(message.timestamp)}</span>
      </div>
      ${message.text ? `<div class="message-text">${escapeHtml(message.text)}</div>` : ""}
      ${buildFileMarkup(message.file)}
      ${receiptLabel(message)}
    `;
    messageBoard.appendChild(article);
    previousMessage = message;
  });

  messageBoard.scrollTop = messageBoard.scrollHeight;
  renderAttachments();
  bindLightboxTriggers();
  sendReadReceipt();
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
  const socketUrl = `${protocol}://${window.location.host}/ws?room=${encodeURIComponent(state.roomId)}&session_id=${encodeURIComponent(sessionId)}`;
  const socket = new WebSocket(socketUrl);
  state.socket = socket;

  socket.addEventListener("open", () => {
    state.isConnected = true;
    hideReconnectBanner();
    sessionStatus.textContent = `Connected live to ${state.roomId}. Messages now arrive instantly.`;
  });

  socket.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      handleSocketEvent(payload);
    } catch (error) {
      presenceStatus.textContent = "Received an unreadable realtime event.";
    }
  });

  socket.addEventListener("close", () => {
    state.isConnected = false;
    updatePresence(0);
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

function handleSocketEvent(payload) {
  if (payload.type === "welcome") {
    state.messages = payload.messages || [];
    renderMessages();
    updatePresence(payload.participants);
    sessionStatus.textContent = `Connected as ${payload.sender_name} in ${payload.room_id}. Messages live only while the room stays active.`;
    hideReconnectBanner();
    return;
  }

  if (payload.type === "presence") {
    updatePresence(payload.participants);
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

  if (payload.type === "message" && payload.message) {
    const exists = state.messages.some((message) => message.id === payload.message.id);
    if (!exists) {
      state.messages.push(payload.message);
      renderMessages();
    }
    return;
  }

  if (payload.type === "receipt_update" && payload.receipts) {
    payload.receipts.forEach((receipt) => {
      const existing = state.messages.find((message) => message.id === receipt.id);
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

function sendTypingState(isTyping) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    return;
  }
  if (state.sentTypingState === isTyping) {
    return;
  }
  state.sentTypingState = isTyping;
  state.socket.send(JSON.stringify({ type: "typing", is_typing: isTyping }));
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
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    return;
  }
  const lastMessage = state.messages[state.messages.length - 1];
  if (!lastMessage || lastMessage.id <= state.lastReadMessageId) {
    return;
  }
  state.lastReadMessageId = lastMessage.id;
  state.socket.send(JSON.stringify({ type: "read", last_message_id: lastMessage.id }));
}

async function sendMessage() {
  const text = messageInput.value.trim();
  const sourceFile = state.selectedFile;

  if (state.mediaRecorder && state.mediaRecorder.state === "recording") {
    fileStatus.textContent = "Stop the voice recording first, then send it.";
    return;
  }

  if (!text && !sourceFile) {
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

  await showTypingEffect();
  sendTypingState(false);
  state.socket.send(JSON.stringify({
    type: "message",
    text,
    file: filePayload,
  }));

  messageInput.value = "";
  fileInput.value = "";
  state.selectedFile = null;
  discardVoiceButton.classList.add("d-none");
  voiceStatus.textContent = "Tap to record a real browser voice note if your device allows microphone access.";
  fileStatus.textContent = filePayload ? "Sent to the room instantly." : "Message sent instantly.";
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
  state.mediaRecorder.addEventListener("stop", () => {
    const finalMimeType = state.mediaRecorder?.mimeType || mimeType || "audio/webm";
    const extension = finalMimeType.includes("mp4") ? "m4a" : finalMimeType.includes("ogg") ? "ogg" : "webm";
    const blob = new Blob(state.audioChunks, { type: finalMimeType });
    const file = new File([blob], `voice-note-${Date.now()}.${extension}`, { type: blob.type });
    state.audioChunks = [];
    setSelectedFile(file);
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

function discardVoiceRecording() {
  if (!state.selectedFile || !state.selectedFile.type.startsWith("audio/")) {
    return;
  }
  state.selectedFile = null;
  fileInput.value = "";
  discardVoiceButton.classList.add("d-none");
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

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await sendMessage();
  } catch (error) {
    fileStatus.textContent = error.message || "Unable to send right now.";
  }
});

clearComposerButton.addEventListener("click", () => {
  messageInput.value = "";
  fileInput.value = "";
  state.selectedFile = null;
  if (state.recordingStream) {
    state.recordingStream.getTracks().forEach((track) => track.stop());
    state.recordingStream = null;
  }
  discardVoiceButton.classList.add("d-none");
  recordVoiceButton.textContent = "Start voice note";
  fileStatus.textContent = "Composer reset.";
  voiceStatus.textContent = "Tap to record a real browser voice note if your device allows microphone access.";
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) {
    state.selectedFile = null;
    fileStatus.textContent = "Optional. Files are sent inside this live room only.";
    return;
  }
  setSelectedFile(file);
});

messageInput.addEventListener("input", () => {
  const hasDraft = Boolean(messageInput.value.trim());
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

dropZone.addEventListener("drop", (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (!file) {
    return;
  }
  setSelectedFile(file);
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
      // Fall through to clipboard.
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
  state.roomId = getOrCreateRoomId();
  state.messages = [];
  state.typingUsers.clear();
  updateTypingUi();
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
  updateRoomLink();
  renderMessages();
  connectSocket();
}

init();
