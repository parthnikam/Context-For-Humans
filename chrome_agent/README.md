# Conversation Exporter

A Manifest V3 Chrome extension that scrolls a selected chat list or imports a CSV, uses a local persistent ChromaDB vector index to group conversation titles, asks Gemma to assign each group to an existing project or create a new one, and displays the result in a project graph.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose this `chrome_agent` folder. Use Chrome 114 or newer for the side-panel API.
4. Open the chat page and select the extension toolbar button to open the side panel. If the extension was already installed, select **Reload** for it in `chrome://extensions` first.

## Start the local ChromaDB service

The extension cannot host an embedded Python database itself. From the repository root, install the companion service dependencies and start it:

```powershell
python -m pip install -r chroma_service/requirements.txt
python -m uvicorn chroma_service.app:app --host 127.0.0.1 --port 8765
```

Keep that terminal open while using the extension. The first indexing request may download ChromaDB's default sentence embedding model. Chroma persists its collection under `chroma_service/data/`; it remains available across extension reloads and CSV imports. The service binds only to localhost and accepts browser requests from Chrome extension origins.

## Group conversations

1. Start the local ChromaDB service, then open **AI grouping settings** and select **Test service**. Enter and save a Google AI Studio API key and use **Test** to verify it. The Gemini key stays in this extension's local storage.
2. To extract from a chat page, select **Detect chat list**.
3. Choose the sidebar or list that contains the conversations. The selected area is outlined on the page.
4. Select **Extract & group**. The extension scrolls through the list, waits for lazy-loaded items, and groups collected link titles and URLs. After three bottom nudges produce no new links, it stops. A new link resets the counter. Select **Cancel** to stop early.
5. Or select **Import title,url CSV** to group conversations from a CSV. The header must contain `title` and `url` columns; `conversation_title` is also accepted.
6. Use the graph like the original extension graph: drag the background to pan, drag nodes to reposition them, and scroll to zoom. Clicking a project opens its details in a left sidebar with all conversation links. Rename it there or move a conversation to another project; changes sync to the larger graph view. Double-clicking a project opens its conversations. Clicking a conversation node opens that link. Conversation nodes are evenly spaced around their project node. **Clear graphs** removes saved conversations and project connections after confirmation; it does not remove API keys. **View larger** opens the same interactive graph in a full browser tab. **Download CSV** exports the current conversation data.

Expand **API debug console** in the side panel to inspect ChromaDB and Gemini request payloads and responses while grouping. The console omits API keys and authorization headers, remains in memory only, and is cleared when the panel closes.

Grouping uses two stages. The local service embeds incoming conversation titles with ChromaDB's default sentence embedding function and compares them against the persistent collection, including titles from earlier CSV imports. The cosine similarity threshold is adjustable from 0 to 1 in **AI grouping settings**; the default is `0.62`, and lower values create broader vector clusters. URLs and project assignments are stored as Chroma metadata. Then Gemma receives each incoming cluster, Chroma's similar existing-project candidates, and the existing graph's project names, descriptions, and representative titles. Its prompt requires it to either reuse one exact existing project ID or create a concise new project title. Gemma does not change cluster membership. Assignments are written back to Chroma so future imports can find prior project links.

**Clear graphs** clears both the extension graph and the local ChromaDB collection after confirmation. The selected area's starting scroll position is restored after extraction. A 400-step limit prevents an endlessly loading page from running forever.

Each import or extraction is appended to the current graph. New links with URLs already present are skipped; a new group whose name matches an existing project is merged into that project.

The code is split across the side-panel UI, CSV parser/download, Gemini assignment client, Python ChromaDB service, page actions, extraction pipeline, and graph model/view. Page extraction reads links rendered as `<a href="...">` elements and does not open conversations or click page controls.
