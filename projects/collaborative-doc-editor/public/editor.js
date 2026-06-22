// Client-side Operational Transformation & WebSocket Controller
const clientId = `client_${Math.random().toString(36).substring(2, 11)}`;
let username = 'Guest';
let avatarColor = '#ef4444';
let currentDocId = 'welcome-doc';

let ws = null;
let docVersion = 0;
let localContent = '';

// OT Client State
let outstandingOp = null;
let bufferOps = []; // Queue of unsent operations

// Active Collaborators cursors and presence
const collaborators = new Map(); // clientId -> { username, color, index, timer }

// DOM Elements
const textarea = document.getElementById('editor-textarea');
const cursorLayer = document.getElementById('editor-cursor-layer');
const mirror = document.getElementById('editor-mirror');
const docTitle = document.getElementById('doc-title');
const syncStatus = document.getElementById('doc-sync-status');
const docListEl = document.getElementById('doc-list');
const usersListEl = document.getElementById('users-list');
const newDocBtn = document.getElementById('btn-new-doc');

// Join Modal Elements
const joinModal = document.getElementById('join-modal');
const inputUsername = document.getElementById('input-username');
const btnJoinSession = document.getElementById('btn-join-session');
const colorDots = document.querySelectorAll('.color-dot');

// Initialize Avatar Selection
colorDots.forEach(dot => {
  dot.addEventListener('click', (e) => {
    colorDots.forEach(d => d.classList.remove('selected'));
    dot.classList.add('selected');
    avatarColor = dot.getAttribute('data-color');
  });
});

btnJoinSession.addEventListener('click', () => {
  const inputName = inputUsername.value.trim();
  if (!inputName) {
    alert('Please enter a username.');
    return;
  }
  username = inputName;
  joinModal.style.opacity = 0;
  setTimeout(() => {
    joinModal.style.display = 'none';
  }, 300);

  // Set header profile details
  document.getElementById('header-my-name').textContent = username;
  const myAvatar = document.getElementById('header-my-avatar');
  myAvatar.textContent = username.slice(0, 2).toUpperCase();
  myAvatar.style.backgroundColor = avatarColor;

  initApp();
});

function initApp() {
  fetchDocuments();
  connectWebSocket();
}

// REST: Fetch Documents List
async function fetchDocuments() {
  try {
    const res = await fetch('/api/documents');
    const docs = await res.json();
    
    docListEl.innerHTML = docs.map(d => {
      const activeClass = d.id === currentDocId ? 'active' : '';
      return `
        <div class="doc-item ${activeClass}" onclick="switchDocument('${d.id}', '${d.title}')" data-id="${d.id}">
          ${d.title}
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to fetch documents:', err);
  }
}

// Create New Document
newDocBtn.addEventListener('click', async () => {
  const title = prompt('Enter document title:', 'Untitled Document');
  if (!title) return;

  try {
    const res = await fetch('/api/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    });
    const doc = await res.json();
    await fetchDocuments();
    switchDocument(doc.id, doc.title);
  } catch (err) {
    console.error('Failed to create document:', err);
  }
});

// Switch Document Room
function switchDocument(docId, title) {
  if (docId === currentDocId) return;
  console.log(`Switching from document ${currentDocId} to ${docId}`);
  
  currentDocId = docId;
  docTitle.textContent = title;
  
  // Highlight active sidebar item
  document.querySelectorAll('.doc-item').forEach(item => {
    item.classList.remove('active');
    if (item.getAttribute('data-id') === docId) {
      item.classList.add('active');
    }
  });

  // Reset OT buffers and local state
  outstandingOp = null;
  bufferOps = [];
  localContent = '';
  textarea.value = '';
  
  // Clear collaborators cursors
  collaborators.forEach(c => {
    if (c.element) c.element.remove();
  });
  collaborators.clear();
  updateCollaboratorsList();

  // Re-connect WS Room
  connectWebSocket();
}

// WebSockets: Connection management
function connectWebSocket() {
  if (ws) {
    ws.close();
  }

  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('[WebSocket] Connection open. Sending join...');
    ws.send(JSON.stringify({
      type: 'join',
      docId: currentDocId,
      username,
      color: avatarColor,
      clientId
    }));
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleWSMessage(data);
    } catch (e) {
      console.error('[WebSocket] Error processing message:', e);
    }
  };

  ws.onclose = () => {
    console.log('[WebSocket] Connection closed. Reconnecting in 3s...');
    syncStatus.textContent = 'Offline';
    syncStatus.className = 'doc-status saving';
    setTimeout(connectWebSocket, 3000);
  };
}

function handleWSMessage(data) {
  switch (data.type) {
    case 'init': {
      docVersion = data.version;
      localContent = data.content;
      textarea.value = localContent;
      syncStatus.textContent = 'Synced';
      syncStatus.className = 'doc-status';

      // Load existing users
      data.activeUsers.forEach(u => {
        collaborators.set(u.clientId, {
          username: u.username,
          color: u.color,
          index: 0,
          element: null
        });
      });
      updateCollaboratorsList();
      break;
    }

    case 'user_join': {
      console.log(`Collaborator joined: ${data.username}`);
      collaborators.set(data.clientId, {
        username: data.username,
        color: data.color,
        index: 0,
        element: null
      });
      updateCollaboratorsList();
      break;
    }

    case 'user_leave': {
      console.log(`Collaborator left: ${data.clientId}`);
      const c = collaborators.get(data.clientId);
      if (c) {
        if (c.element) c.element.remove();
        collaborators.delete(data.clientId);
      }
      updateCollaboratorsList();
      break;
    }

    case 'ack': {
      // Server acknowledged our outstanding operation!
      docVersion = data.version;
      outstandingOp = null;
      
      // Send next buffer operation if one exists
      if (bufferOps.length > 0) {
        outstandingOp = bufferOps[0];
        bufferOps = bufferOps.slice(1);
        sendEdit(outstandingOp);
      }

      if (!outstandingOp && bufferOps.length === 0) {
        syncStatus.textContent = 'Synced';
        syncStatus.className = 'doc-status';
      }
      break;
    }

    case 'edit': {
      // External edit received from server!
      const { op, version, clientId: senderId } = data;
      if (senderId === clientId) return; // Ignore own echoes

      console.log(`[OT] Received edit from server. Current version: ${docVersion} -> New version: ${version}`);
      
      let serverOp = { ...op };
      
      // Transform incoming server edit against our local outstanding/buffered edits
      if (outstandingOp) {
        serverOp = OT.transform(serverOp, outstandingOp);
      }

      if (serverOp) {
        for (let i = 0; i < bufferOps.length; i++) {
          const transformed = OT.transform(serverOp, bufferOps[i]);
          if (!transformed) {
            serverOp = null;
            break;
          }
          serverOp = transformed;
        }
      }

      // If there are local outstanding/buffered ops, transform them against the server's concurrent op
      if (serverOp) {
        if (outstandingOp) {
          outstandingOp = OT.transform(outstandingOp, op); // Transform against original server op
        }
        for (let i = 0; i < bufferOps.length; i++) {
          bufferOps[i] = OT.transform(bufferOps[i], op);
        }

        // Apply transformed server operation to local text
        const selectionStart = textarea.selectionStart;
        const selectionEnd = textarea.selectionEnd;
        
        const oldContent = localContent;
        localContent = OT.apply(localContent, serverOp);
        textarea.value = localContent;
        docVersion = version;

        // Shift local cursor position if the insertion/deletion happened before it
        let newStart = selectionStart;
        let newEnd = selectionEnd;
        const len = serverOp.type === 'insert' ? serverOp.text.length : -(typeof serverOp.text === 'number' ? serverOp.text : serverOp.text.length);

        if (serverOp.index <= selectionStart) {
          newStart += len;
        }
        if (serverOp.index <= selectionEnd) {
          newEnd += len;
        }

        // Restore cursor selection
        textarea.setSelectionRange(newStart, newEnd);
      } else {
        docVersion = version;
      }

      // Update virtual cursors locations
      updateVirtualCursors();
      break;
    }

    case 'cursor': {
      // Peer cursor coordinates updated
      const { clientId: peerId, index, username: peerName, color: peerColor } = data;
      let c = collaborators.get(peerId);
      
      if (!c) {
        c = { username: peerName, color: peerColor, index: 0, element: null };
        collaborators.set(peerId, c);
        updateCollaboratorsList();
      }
      
      c.index = index;
      
      // Update coordinates
      renderVirtualCursor(peerId, c);
      break;
    }
  }
}

function updateCollaboratorsList() {
  if (collaborators.size === 0) {
    usersListEl.innerHTML = `
      <div class="user-item">
        <span class="user-avatar" style="background-color: ${avatarColor}">${username.slice(0,2).toUpperCase()}</span>
        <span class="user-name">${username} (You)</span>
      </div>
      <div class="loading-text" style="margin-top: 10px;">No other editors active.</div>
    `;
    return;
  }

  let listHTML = `
    <div class="user-item">
      <span class="user-avatar" style="background-color: ${avatarColor}">${username.slice(0,2).toUpperCase()}</span>
      <span class="user-name">${username} (You)</span>
    </div>
  `;

  collaborators.forEach((c) => {
    listHTML += `
      <div class="user-item">
        <span class="user-avatar" style="background-color: ${c.color}">${c.username.slice(0,2).toUpperCase()}</span>
        <span class="user-name">${c.username}</span>
      </div>
    `;
  });

  usersListEl.innerHTML = listHTML;
}

// Local Editor Input Listener
textarea.addEventListener('input', (e) => {
  const newContent = textarea.value;
  const cursorPos = textarea.selectionStart;
  
  // Calculate character diff details between local state and input
  const diff = getDiff(localContent, newContent, cursorPos);
  
  if (diff) {
    // Inject client context
    diff.clientId = clientId;
    diff.version = docVersion;
    
    localContent = newContent;
    
    // Transition state
    if (outstandingOp === null) {
      outstandingOp = diff;
      sendEdit(outstandingOp);
      syncStatus.textContent = 'Saving...';
      syncStatus.className = 'doc-status saving';
    } else {
      bufferOps.push(diff);
    }
  }

  // Broadcast cursor coordinate changes
  broadcastCursor();
});

// Calculate differences between states
function getDiff(oldStr, newStr, cursorPos) {
  let start = 0;
  while (start < oldStr.length && start < newStr.length && oldStr[start] === newStr[start]) {
    start++;
  }
  
  let endOld = oldStr.length;
  let endNew = newStr.length;
  while (endOld > start && endNew > start && oldStr[endOld - 1] === newStr[endNew - 1]) {
    endOld--;
    endNew--;
  }
  
  const removed = oldStr.slice(start, endOld);
  const added = newStr.slice(start, endNew);
  
  if (removed.length > 0) {
    return { type: 'delete', index: start, text: removed.length };
  } else if (added.length > 0) {
    return { type: 'insert', index: start, text: added };
  }
  return null;
}

function sendEdit(op) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'edit',
      docId: currentDocId,
      op
    }));
  }
}

// Local Cursor Selection broad cast helper
let cursorBroadcastTimeout = null;
textarea.addEventListener('keyup', throttleCursorBroadcast);
textarea.addEventListener('click', throttleCursorBroadcast);
textarea.addEventListener('focus', throttleCursorBroadcast);

function throttleCursorBroadcast() {
  clearTimeout(cursorBroadcastTimeout);
  cursorBroadcastTimeout = setTimeout(broadcastCursor, 150);
}

function broadcastCursor() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'cursor',
      docId: currentDocId,
      index: textarea.selectionStart
    }));
  }
}

// Cursors Positioning Calculations (using invisible mirror element)
function renderVirtualCursor(peerId, c) {
  // Clear any existing timer
  clearTimeout(c.timer);

  if (!c.element) {
    c.element = document.createElement('div');
    c.element.className = 'virtual-cursor';
    c.element.style.backgroundColor = c.color;
    
    const tag = document.createElement('div');
    tag.className = 'virtual-cursor-tag';
    tag.style.backgroundColor = c.color;
    tag.textContent = c.username;
    
    c.element.appendChild(tag);
    cursorLayer.appendChild(c.element);
  }

  // Calculate coordinates
  const coords = getCursorCoords(c.index);
  
  c.element.style.left = `${coords.left}px`;
  c.element.style.top = `${coords.top}px`;
  c.element.style.display = 'block';

  // Hide virtual cursor if collaborator becomes idle (no updates for 5s)
  c.timer = setTimeout(() => {
    c.element.style.display = 'none';
  }, 5000);
}

function updateVirtualCursors() {
  collaborators.forEach((c, peerId) => {
    if (c.element) {
      renderVirtualCursor(peerId, c);
    }
  });
}

// Redraw cursors when container scrolls
textarea.addEventListener('scroll', updateVirtualCursors);
window.addEventListener('resize', updateVirtualCursors);

function getCursorCoords(charIndex) {
  const text = textarea.value;
  const boundedIndex = Math.max(0, Math.min(charIndex, text.length));
  
  // Replicate styles of textarea onto mirror div
  const style = window.getComputedStyle(textarea);
  mirror.style.width = style.width;
  mirror.style.padding = style.padding;
  mirror.style.fontFamily = style.fontFamily;
  mirror.style.fontSize = style.fontSize;
  mirror.style.lineHeight = style.lineHeight;
  mirror.style.borderStyle = style.borderStyle;
  mirror.style.borderWidth = style.borderWidth;
  
  // Fill mirror with text up to cursor index, append marker span, and fill remainder
  const textBefore = text.slice(0, boundedIndex);
  const textAfter = text.slice(boundedIndex);
  
  mirror.innerHTML = '';
  mirror.appendChild(document.createTextNode(textBefore));
  
  const marker = document.createElement('span');
  marker.innerHTML = '&nbsp;';
  mirror.appendChild(marker);
  
  mirror.appendChild(document.createTextNode(textAfter));
  
  // Calculate relative pixel offsets
  const textareaRect = textarea.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();
  
  const left = markerRect.left - textareaRect.left + textarea.scrollLeft;
  const top = markerRect.top - textareaRect.top + textarea.scrollTop;
  
  return { left, top };
}

// --- GEMINI AI ASSISTANT FRONTEND INTERACTION ---
let aiSelectedRange = null;

textarea.addEventListener('mouseup', handleTextSelection);
textarea.addEventListener('keyup', handleTextSelection);

function handleTextSelection() {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  
  if (start !== end) {
    aiSelectedRange = { start, end, text: textarea.value.slice(start, end) };
  } else {
    // Keep range if clicking AI assistant panel to avoid losing focus select
  }
}

async function triggerAI(promptType) {
  if (!aiSelectedRange) {
    alert('Please select a segment of text inside the editor first.');
    return;
  }

  const resultCard = document.getElementById('ai-result-card');
  const resultContent = document.getElementById('ai-result-content');
  const insertBtn = document.getElementById('btn-ai-insert');
  const customInput = document.getElementById('ai-custom-input');

  resultContent.innerHTML = 'Connecting to Gemini model... ⚡';
  resultContent.classList.remove('loaded');
  insertBtn.style.display = 'none';

  let customPrompt = '';
  if (promptType === 'custom') {
    customPrompt = customInput.value.trim();
    if (!customPrompt) {
      alert('Please enter a custom query.');
      return;
    }
  }

  try {
    const response = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: aiSelectedRange.text,
        promptType,
        customPrompt
      })
    });

    const data = await response.json();
    if (data.error && !data.fallback) {
      resultContent.innerHTML = `<span style="color: var(--danger);">${data.error}</span>`;
      return;
    }

    const finalResult = data.result || data.fallback;

    // Simulate standard streaming typing effect
    resultContent.innerHTML = '';
    resultContent.classList.add('loaded');
    
    let charIdx = 0;
    const typingTimer = setInterval(() => {
      if (charIdx < finalResult.length) {
        resultContent.textContent += finalResult[charIdx];
        charIdx++;
        resultContent.scrollTop = resultContent.scrollHeight;
      } else {
        clearInterval(typingTimer);
        insertBtn.style.display = 'block'; // Show insert button
      }
    }, 15);

  } catch (err) {
    resultContent.innerHTML = `<span style="color: var(--danger);">Network failure invoking AI: ${err.message}</span>`;
  }
}

function insertAIResult() {
  if (!aiSelectedRange) return;

  const resultText = document.getElementById('ai-result-content').textContent;
  
  // Prepare OT operations to reflect this change
  const currentText = textarea.value;
  const { start, end } = aiSelectedRange;
  
  // 1. Delete selection
  const deleteOp = {
    type: 'delete',
    index: start,
    text: end - start,
    clientId,
    version: docVersion
  };

  // Apply delete locally
  let updatedText = currentText.slice(0, start) + currentText.slice(end);
  
  // 2. Insert AI output
  const insertOp = {
    type: 'insert',
    index: start,
    text: resultText,
    clientId,
    version: docVersion
  };
  
  // Apply insert locally
  updatedText = updatedText.slice(0, start) + resultText + updatedText.slice(start);
  
  localContent = updatedText;
  textarea.value = updatedText;
  
  // Submit changes to broker
  if (outstandingOp === null) {
    outstandingOp = deleteOp;
    sendEdit(outstandingOp);
    bufferOps.push(insertOp);
  } else {
    bufferOps.push(deleteOp);
    bufferOps.push(insertOp);
  }

  syncStatus.textContent = 'Saving...';
  syncStatus.className = 'doc-status saving';

  // Clear highlights selection
  textarea.setSelectionRange(start, start + resultText.length);
  aiSelectedRange = null;
  document.getElementById('btn-ai-insert').style.display = 'none';
  document.getElementById('ai-result-content').innerHTML = 'Selection replaced successfully!';
  document.getElementById('ai-result-content').classList.remove('loaded');
}
