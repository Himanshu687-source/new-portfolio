# HyperDocs: Real-time Collaborative Document Editor

HyperDocs is a fully functional real-time collaborative rich-text editor inspired by Google Docs. It leverages **WebSockets** for instant bi-directional messaging, implements an **Operational Transformation (OT)** engine to resolve document synchronization conflicts, maintains active user presence cursors, and features built-in **Google Gemini AI** writing assistants.

Designed to illustrate distributed systems engineering and AI integration, this project demonstrates client-server state machines, cursor mirror mapping, and concurrency control.

---

## Key Features

- 🔄 **Operational Transformation (OT):** A custom character-level Jupiter-style OT engine. Synchronizes and transforms overlapping insertions and deletions to guarantee document convergence:
  $$\text{apply}(\text{apply}(S, B), A') = \text{apply}(\text{apply}(S, A), B')$$
- 📡 **Real-time WebSockets:** Low-latency bi-directional messaging for character typing updates, presence joins, and cursor locations.
- 📍 **Virtual Cursor Presence:** Renders floats of collaborator positions in real-time, matching colored labels and name tags with typing updates, even when text lines wrap.
- ✨ **Gemini AI Writer:** Selection-triggered AI side-panel helper to instantly **Summarize**, **Refine & Grammar-Check**, or **Autocomplete** text using raw HTTP calls to Gemini API.
- 💾 **SQLite Version Persistence:** Keeps full edit logs and text versions saved in an SQLite DB (`documents.db`) via Node's native `node:sqlite` module.

---

## File Structure

```bash
collaborative-doc-editor/
├── server.js              # Express app, WebSocket connection coordinator, and Gemini API proxy
├── ot.js                  # Operational Transformation algorithm classes (shared by Server & Client)
├── documents.db           # SQLite database generated at runtime
├── public/                # Frontend client files
│   ├── index.html         # Document editor panel, collaborative users panel, and AI sidebar
│   ├── editor.css         # Glassmorphic editor visual styles and virtual cursors
│   └── editor.js          # WS client, local-diffing editor listener, and OT client state machine
└── README.md              # Documentation
```

---

## How to Run Locally

### 1. Set Environment Variables (Optional)
If you want to enable the live Google Gemini AI features, configure a `.env` file in the project folder:
```bash
GEMINI_API_KEY=your_google_gemini_api_key
```
*Note: If no API key is specified, the application automatically runs a graceful offline simulator for demonstration purposes.*

### 2. Start the Collaborative Editor Server
```bash
npm start
# OR
node server.js
```
*The editor server will listen on port `3060`.*

### 3. Open in Browser
Open [http://localhost:3060](http://localhost:3060) in your web browser. 

To test collaborative editing:
1. Open the URL in two separate browser tabs/windows side-by-side.
2. Join using different names (e.g. Alice and Bob).
3. Type concurrently in the editor, move your cursor, highlight text, and watch modifications sync instantly!
4. Select text and click "Summarize" or "Refine" in the Gemini sidebar to try the AI assistant.
