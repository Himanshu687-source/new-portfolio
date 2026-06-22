const express = require('express');
const http = require('http');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { WebSocketServer } = require('ws');
const OT = require('./ot');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3060;
const DB_PATH = path.join(__dirname, 'documents.db');

// Initialize SQLite Database for Document State & Edit History
const db = new DatabaseSync(DB_PATH);
console.log('[Editor Server] Database initialized at:', DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT DEFAULT '',
    version INTEGER DEFAULT 0,
    updated_at INTEGER NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS operations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    type TEXT NOT NULL,
    idx INTEGER NOT NULL,
    text TEXT,
    version INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

// Insert default document if empty
const checkDocs = db.prepare('SELECT COUNT(*) as count FROM documents');
if (checkDocs.get().count === 0) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO documents (id, title, content, version, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    'welcome-doc',
    'Getting Started with HyperDocs 📝',
    `Welcome to HyperDocs! This is a real-time collaborative document editor.

Here is what you can do:
1. Open this page in multiple browser tabs or windows side-by-side.
2. Type concurrently in the document. The Operational Transformation (OT) engine resolves any typing conflicts in real-time.
3. Observe live cursors and highlights showing where other active editors are positioned.
4. Try out the Gemini AI panel on the right! Select text and request a summary or completion.

Happy collaborative writing!`,
    0,
    now
  );
}

// Database helper functions
const queryGetDoc = db.prepare('SELECT * FROM documents WHERE id = ?');
const queryCreateDoc = db.prepare('INSERT INTO documents (id, title, content, version, updated_at) VALUES (?, ?, ?, ?, ?)');
const queryUpdateDoc = db.prepare('UPDATE documents SET content = ?, version = ?, updated_at = ? WHERE id = ?');
const queryInsertOp = db.prepare(`
  INSERT INTO operations (doc_id, client_id, type, idx, text, version, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const queryGetOpsFromVersion = db.prepare(`
  SELECT client_id, type, idx, text, version 
  FROM operations 
  WHERE doc_id = ? AND version >= ? 
  ORDER BY version ASC
`);
const queryGetAllDocs = db.prepare('SELECT id, title, updated_at FROM documents ORDER BY updated_at DESC');

// Express Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/ot.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'ot.js'));
});

// REST API endpoints
app.get('/api/documents', (req, res) => {
  try {
    const docs = queryGetAllDocs.all();
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/documents', (req, res) => {
  const { title } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  const id = `doc_${Math.random().toString(36).substring(2, 11)}`;
  const now = Date.now();
  try {
    queryCreateDoc.run(id, title, '', 0, now);
    res.status(201).json({ id, title, version: 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Gemini AI Assistant Integration Endpoint
app.post('/api/ai', async (req, res) => {
  const { text, promptType, customPrompt } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided for AI analysis.' });

  // Generate appropriate prompt instructions based on action
  let prompt = '';
  switch (promptType) {
    case 'summarize':
      prompt = `Summarize the following text concisely. Provide a clean, readable summary under 3 sentences:\n\n"${text}"`;
      break;
    case 'refine':
      prompt = `Refine and improve the writing style of the following text, correcting any grammatical errors and enhancing clarity while keeping the core meaning:\n\n"${text}"`;
      break;
    case 'autocomplete':
      prompt = `Continue writing the text, providing a natural extension of about 1-2 cohesive sentences:\n\n"${text}"`;
      break;
    case 'custom':
      prompt = `${customPrompt || 'Analyze and rewrite this text'}:\n\n"${text}"`;
      break;
    default:
      prompt = `Analyze this writing:\n\n"${text}"`;
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (apiKey) {
    console.log('[AI Assistant] Invoking live Gemini API...');
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }]
          })
        }
      );

      if (!response.ok) {
        throw new Error(`Gemini API returned status ${response.status}`);
      }

      const responseData = await response.json();
      const aiResponse = responseData?.candidates?.[0]?.content?.parts?.[0]?.text;
      
      if (!aiResponse) {
        throw new Error('Unexpected empty response structure from Gemini API.');
      }

      return res.json({ result: aiResponse.trim() });
    } catch (err) {
      console.error('[AI Assistant] Live Gemini API invocation failed:', err.message);
      return res.status(500).json({ 
        error: `Gemini API Error: ${err.message}. Falling back to offline simulator...`,
        fallback: getMockAIResponse(promptType, text)
      });
    }
  } else {
    // Elegant fallback simulation
    console.log('[AI Assistant] GEMINI_API_KEY not configured. Running offline simulation...');
    await new Promise(resolve => setTimeout(resolve, 1500)); // Simulate networking delay
    const mockOutput = getMockAIResponse(promptType, text);
    res.json({
      result: `[OFFLINE SIMULATION - Set GEMINI_API_KEY in .env to connect live Gemini AI]\n\n${mockOutput}`
    });
  }
});

function getMockAIResponse(type, originalText) {
  switch (type) {
    case 'summarize':
      return `This text introduces collaborative editing features, noting that multiple users can edit concurrently and use the integrated Gemini AI writing helper to summarize, continue, or rewrite selected snippets.`;
    case 'refine':
      return `Enhance your document creation workflow by leveraging collaborative text refinement. These adjustments optimize clarity, grammar, and readability to ensure your message is clear and effective.`;
    case 'autocomplete':
      return ` Adding this AI functionality allows developers to experience real-time distributed collaboration coupled with artificial intelligence tools directly in a lightweight editor.`;
    default:
      return `Simulated analysis completed. The highlighted segment spans ${originalText.length} characters and is structured into readable phrases.`;
  }
}

// WebSocket State Presence Map
// docId -> Set of connected client sockets
const docRooms = new Map();
// socket -> client user metadata { docId, clientId, username, color }
const socketMetadata = new Map();

wss.on('connection', (ws) => {
  console.log('[WS Server] New client connection opened.');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleWSMessage(ws, data);
    } catch (e) {
      console.error('[WS Server] Error parsing websocket message:', e);
    }
  });

  ws.on('close', () => {
    const meta = socketMetadata.get(ws);
    if (meta) {
      const { docId, clientId, username } = meta;
      console.log(`[WS Server] Client disconnected: ${username} (${clientId}) from room ${docId}`);
      
      const room = docRooms.get(docId);
      if (room) {
        room.delete(ws);
        if (room.size === 0) {
          docRooms.delete(docId);
        } else {
          // Broadcast exit to remaining room participants
          broadcastToRoom(docId, ws, {
            type: 'user_leave',
            clientId
          });
        }
      }
      socketMetadata.delete(ws);
    }
  });
});

function handleWSMessage(ws, data) {
  const now = Date.now();

  switch (data.type) {
    case 'join': {
      const { docId, username, color, clientId } = data;
      console.log(`[WS Server] Client ${username} (${clientId}) joining room: ${docId}`);

      // Get document state
      let doc = queryGetDoc.get(docId);
      if (!doc) {
        // Create standard default document if it doesn't exist
        queryCreateDoc.run(docId, `Document - ${docId}`, '', 0, now);
        doc = { id: docId, title: `Document - ${docId}`, content: '', version: 0 };
      }

      // Track connection room membership
      if (!docRooms.has(docId)) {
        docRooms.set(docId, new Set());
      }
      docRooms.get(docId).add(ws);

      // Save socket association
      socketMetadata.set(ws, { docId, clientId, username, color });

      // Gather current users online in this room
      const activeUsers = [];
      const room = docRooms.get(docId);
      for (const clientSocket of room) {
        if (clientSocket !== ws) {
          const clientMeta = socketMetadata.get(clientSocket);
          if (clientMeta) {
            activeUsers.push({
              clientId: clientMeta.clientId,
              username: clientMeta.username,
              color: clientMeta.color
            });
          }
        }
      }

      // Initialize connecting user's text and version
      ws.send(JSON.stringify({
        type: 'init',
        docId: doc.id,
        title: doc.title,
        content: doc.content,
        version: doc.version,
        activeUsers
      }));

      // Notify other active room members about the new user
      broadcastToRoom(docId, ws, {
        type: 'user_join',
        clientId,
        username,
        color
      });
      break;
    }

    case 'edit': {
      const { docId, op } = data;
      const meta = socketMetadata.get(ws);
      if (!meta) return;

      const doc = queryGetDoc.get(docId);
      if (!doc) return;

      let opToApply = { ...op };
      const clientVer = op.version;
      const serverVer = doc.version;

      if (clientVer > serverVer) {
        console.error(`[WS Server] Client sent version ${clientVer} higher than Server version ${serverVer}. Out of sync.`);
        return;
      }

      if (clientVer < serverVer) {
        // Operational Transformation needed!
        // Retrieve all ops from database that happened between client version and current server version
        const historicalOps = queryGetOpsFromVersion.all(docId, clientVer);
        
        console.log(`[OT] Concurrent edits detected! Client version: ${clientVer}, Server version: ${serverVer}. Transforming op...`);
        for (const histOp of historicalOps) {
          // Reconstruct historical operation format
          const formattedHistOp = {
            type: histOp.type,
            index: histOp.idx,
            text: histOp.type === 'delete' ? parseInt(histOp.text, 10) : histOp.text,
            clientId: histOp.client_id
          };

          // Transform client operation against concurrent historical operations
          const transformed = OT.transform(opToApply, formattedHistOp);
          if (!transformed) {
            opToApply = null;
            break;
          }
          opToApply = transformed;
        }
      }

      if (opToApply) {
        // Apply the resolved operation to the document text
        const updatedContent = OT.apply(doc.content, opToApply);
        const nextVersion = serverVer + 1;

        // Persist final content & version in database
        queryUpdateDoc.run(updatedContent, nextVersion, now, docId);

        // Record operation in transaction history log
        queryInsertOp.run(
          docId,
          meta.clientId,
          opToApply.type,
          opToApply.index,
          opToApply.type === 'insert' ? opToApply.text : String(opToApply.text),
          serverVer, // Version Index when this was applied (matches historical queries)
          now
        );

        // Acknowledge the operation back to the sender
        ws.send(JSON.stringify({
          type: 'ack',
          docId,
          version: nextVersion
        }));

        // Broadcast the transformed operation to other clients in the document room
        broadcastToRoom(docId, ws, {
          type: 'edit',
          docId,
          op: opToApply,
          version: nextVersion,
          clientId: meta.clientId
        });
      } else {
        // The operation became a no-op due to conflict resolution. Acknowledge anyway.
        ws.send(JSON.stringify({
          type: 'ack',
          docId,
          version: serverVer
        }));
      }
      break;
    }

    case 'cursor': {
      const { docId, index } = data;
      const meta = socketMetadata.get(ws);
      if (!meta) return;

      // Broadcast cursor coordinates to other collaborative editors
      broadcastToRoom(docId, ws, {
        type: 'cursor',
        clientId: meta.clientId,
        index,
        username: meta.username,
        color: meta.color
      });
      break;
    }
  }
}

// Help send packet to all clients connected in a room EXCEPT the sender
function broadcastToRoom(docId, senderWs, payload) {
  const room = docRooms.get(docId);
  if (!room) return;

  const rawPayload = JSON.stringify(payload);
  for (const clientSocket of room) {
    if (clientSocket !== senderWs && clientSocket.readyState === clientSocket.OPEN) {
      clientSocket.send(rawPayload);
    }
  }
}

server.listen(PORT, () => {
  console.log(`[Editor Server] HTTP server listening on http://localhost:${PORT}`);
});
