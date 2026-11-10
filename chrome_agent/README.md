# Conversation Exporter

A Manifest V3 Chrome extension that scrolls a selected chat list or imports a CSV, classifies conversation titles into 134 broad categories with TypeSafe Jev, groups related titles inside each category with a persistent local ChromaDB vector index, and uses OpenAI to name the resulting projects. The graph displays the category -> project -> conversation hierarchy.

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

## Configure TypeSafe and OpenAI

Put both API keys in `chrome_agent/.env`:

```text
TYPESAFE_API_KEY=your-typesafe-key
OPENAI_API_KEY=your-key
```

Restart the local service after creating or changing `.env`. The service reads keys from its environment first and then from this file. Keys stay in the Python service; they are not stored in Chrome, sent by the extension, or written to the debug console. In **AI grouping settings**, select **Test Jev** and **Test OpenAI** to check both API connections. Jev uses the `jev-latest` Choice model; OpenAI project naming uses `gpt-5.6-luna`. See [TypeSafe's Choice docs](https://docs.typesafe.ai/primitives/choice) for the classification primitive.

## Group conversations

1. Start the local service, then open **AI grouping settings** and select **Test service**, **Test Jev**, and **Test OpenAI**.
2. To extract from a chat page, select **Detect chat list**.
3. Choose the sidebar or list that contains the conversations. The selected area is outlined on the page.
4. Select **Extract & group**. The extension scrolls through the list, waits for lazy-loaded items, and groups collected link titles and URLs. After three bottom nudges produce no new links, it stops. A new link resets the counter. Select **Cancel** to stop early.
5. Or select **Import title,url CSV** to group conversations from a CSV. The header must contain `title` and `url` columns; `conversation_title` is also accepted.
6. Browse the category list in **list view**, or select the graph icon in the toolbar for an interactive **graph view**. The graph starts with category nodes only; click a category to spawn its projects and conversation links around it and see them listed in the detail panel. Click empty canvas (or press Escape) to clear the spawn and the detail panel. Drag nodes, pan, and scroll to zoom. Move a link to another project in that same category from the list view. Use the search field to filter by words or meaning in either view; ChromaDB semantic matches are highlighted. **Clear graphs** removes the saved graph and local index after confirmation. **View larger** opens the same category browser in a full browser tab. **Download CSV** exports the current conversation data.

Expand **API debug console** in the side panel to inspect local-service requests, ChromaDB clusters and category results, semantic search results, and OpenAI assignment payloads and responses. The service does not include API keys or authorization headers in these records. The console remains in memory only and is cleared when the panel closes.

Each title is first classified by TypeSafe Jev into one of the 134 fixed choices defined in `chroma_service/categories.py`. ChromaDB then groups similar titles only within the same category and retains category and project assignments in its persistent local collection. The cosine similarity threshold is adjustable from 0 to 1 in **AI grouping settings**; the default is `0.62`, and lower values create broader vector clusters. OpenAI receives each fixed cluster and its category, then either reuses a project in that exact category or creates a concise project name. It does not change category labels or cluster membership. The extension graph also saves the category on every project.

On first side-panel open after this redesign, a saved graph without category metadata is reclassified and rebuilt automatically. Keep both API keys configured and the local service running while that migration completes.

**Clear graphs** clears both the extension graph and the local ChromaDB collection after confirmation. The selected area's starting scroll position is restored after extraction. A 400-step limit prevents an endlessly loading page from running forever.

Each import or extraction is appended to the current graph. New links with URLs already present are skipped; a new group whose name matches an existing project is merged into that project.

Each conversation link shows its provider's logo beside the title in list view and in the detail panel: inline brand marks for OpenAI (chatgpt.com/openai.com), Claude (claude.ai/anthropic.com), and Gemini (gemini.google.com), and the site favicon (fetched from Google's favicon service) for any other provider; links without a reachable favicon show none.

The code is organized into folders by responsibility:

```text
chrome_agent/
  manifest.json          Extension manifest (paths point into the folders below)
  background/            Service worker that opens the side panel
  pages/                 Side panel and the larger graph page (HTML, CSS, JS)
  lib/                   Shared modules: local-service client (grouping.js),
                         list view + view toggle (graph-view.js),
                         canvas force-graph engine (graph-canvas.js),
                         detail panel (graph-detail.js), provider logos
                         (provider-logos.js), graph state/model, extraction,
                         page actions, CSV parsing and download
  tests/                 Node test files (run: node tests/<file>.js)

chroma_service/
  app.py                 FastAPI routes (thin) — run with uvicorn
  config.py              Paths, limits, model names, API-key loading
  models.py              Pydantic request models
  categories.py          The 134-category taxonomy sent to Jev
  typesafe_client.py     Jev Choice classification (batched, token-limit safe)
  openai_client.py       OpenAI project naming and reuse
  chroma_store.py        ChromaDB collection, clustering, search, persistence
  pipeline.py            Categorize-then-cluster orchestration behind /cluster
  tests/                 Unit tests (run: python -m unittest discover -s chroma_service/tests -t .)
```

Page extraction reads links rendered as `<a href="...">` elements and does not open conversations or click page controls.
