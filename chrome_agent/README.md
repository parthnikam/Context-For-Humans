# Conversation Exporter

A Manifest V3 Chrome extension that scrolls a selected chat list or imports a CSV, groups conversations into projects with Gemma, and displays a project graph in the Chrome side panel.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose this `chrome_agent` folder. Use Chrome 114 or newer for the side-panel API.
4. Open the chat page and select the extension toolbar button to open the side panel. If the extension was already installed, select **Reload** for it in `chrome://extensions` first.

## Group conversations

1. Open **AI grouping settings**, enter and save a Mem0 API key and a Google AI Studio API key. Use each **Test** button to verify access. Both keys stay in this extension's local storage.
2. To extract from a chat page, select **Detect chat list**.
3. Choose the sidebar or list that contains the conversations. The selected area is outlined on the page.
4. Select **Extract & group**. The extension scrolls through the list, waits for lazy-loaded items, and groups collected link titles and URLs. After three bottom nudges produce no new links, it stops. A new link resets the counter. Select **Cancel** to stop early.
5. Or select **Import title,url CSV** to group conversations from a CSV. The header must contain `title` and `url` columns; `conversation_title` is also accepted.
6. Use the graph like the original extension graph: drag the background to pan, drag nodes to reposition them, and scroll to zoom. Clicking a project opens its details in a left sidebar with all conversation links. Rename it there or move a conversation to another project; changes sync to the larger graph view. Double-clicking a project opens its conversations. Clicking a conversation node opens that link. Conversation nodes are evenly spaced around their project node. **Clear graphs** removes saved conversations and project connections after confirmation; it does not remove API keys. **View larger** opens the same interactive graph in a full browser tab. **Download CSV** exports the current conversation data.

Grouping uses two stages. The extension sends each conversation title (not its URL) to Mem0 with inference disabled, waits for indexing, then searches those titles within a unique run and connects pairs whose Mem0 hybrid relevance score is at least `0.6`. Mem0's score combines semantic and keyword relevance; it is not a raw cosine-distance value. Connected components form the groups, including singleton groups. Gemma receives representative titles from multi-conversation clusters in bounded batches to generate project names and intents; singleton groups retain their conversation title, and Gemma cannot change group membership. Mem0 retains these memories, scoped by run ID. The generated graph and API keys are stored locally by Chrome. The selected area's starting scroll position is restored after extraction. A 400-step limit prevents an endlessly loading page from running forever.

The code is split across the side-panel UI, CSV parser/download, grouping client, page actions, extraction pipeline, and graph model/view. Page extraction reads links rendered as `<a href="...">` elements and does not open conversations or click page controls.
