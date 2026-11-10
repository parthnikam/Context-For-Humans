const MAX_STEPS = 400;
const SCROLL_SETTLE_MS = 900;
const STABLE_BOTTOM_CHECKS = 2;
const EMPTY_NUDGE_LIMIT = 3;

export async function extractConversations({ area, runOnActiveTab, isCancelled, onStatus, wait = delay }) {
  const collected = new Map();
  let originalTop = null;
  let stableBottomSteps = 0;
  let previousHeight = null;
  let emptyNudges = 0;
  let step = 0;
  let message = "";
  let errorMessage = "";
  let restoreError = "";

  try {
    const start = await runOnActiveTab({ type: "begin", selector: area.selector });
    if (!start?.ok) throw new Error(start?.error || "Could not start scrolling this area.");
    originalTop = start.originalTop;
    onStatus("Starting at the top. New links will be collected as the list loads...");

    while (step < MAX_STEPS && !isCancelled()) {
      await wait(SCROLL_SETTLE_MS);
      const result = await runOnActiveTab({ type: "scroll-step", selector: area.selector });
      if (!result?.ok) throw new Error(result?.error || "Could not continue scrolling this area.");

      const previousUniqueCount = collected.size;
      for (const conversation of result.links) {
        collected.set(conversation.url, conversation);
      }
      const newLinksFound = collected.size > previousUniqueCount;
      if (newLinksFound) emptyNudges = 0;

      const unchangedAtBottom = result.atBottom
        && result.afterTop === result.beforeTop
        && result.height === previousHeight;
      stableBottomSteps = unchangedAtBottom ? stableBottomSteps + 1 : 0;
      previousHeight = result.height;
      step += 1;
      onStatus(`Scrolling ${area.label}: step ${step}, ${collected.size} unique conversation(s) collected.`);

      if (stableBottomSteps < STABLE_BOTTOM_CHECKS) continue;

      const nudge = await runOnActiveTab({ type: "nudge-up", selector: area.selector });
      if (!nudge?.ok) throw new Error(nudge?.error || "Could not recheck the bottom of the list.");
      stableBottomSteps = 0;
      await wait(SCROLL_SETTLE_MS);
      const returnToBottom = await runOnActiveTab({ type: "scroll-step", selector: area.selector });
      if (!returnToBottom?.ok) throw new Error(returnToBottom?.error || "Could not recheck the bottom of the list.");
      const countBeforeRecheck = collected.size;
      addLinks(collected, returnToBottom.links);
      step += 1;

      await wait(SCROLL_SETTLE_MS);
      const recheck = await runOnActiveTab({ type: "collect", selector: area.selector });
      if (!recheck?.ok) throw new Error(recheck?.error || "Could not recheck the bottom of the list.");
      addLinks(collected, recheck.links);
      const newLinksAfterNudge = collected.size > countBeforeRecheck;
      if (newLinksAfterNudge) {
        emptyNudges = 0;
      } else {
        emptyNudges += 1;
      }
      previousHeight = recheck.height;
      onStatus(`Bottom check ${emptyNudges}/${EMPTY_NUDGE_LIMIT}: ${collected.size} unique conversation(s) collected.`);

      if (emptyNudges >= EMPTY_NUDGE_LIMIT) {
        message = `Stopped after ${EMPTY_NUDGE_LIMIT} bottom nudges produced no new links. Collected ${collected.size} unique conversation(s).`;
        break;
      }
      if (newLinksAfterNudge) {
        onStatus(`New links loaded after nudging; continuing through ${area.label}...`);
      }
    }

    if (!message) {
      message = isCancelled()
        ? `Stopped. Collected ${collected.size} unique conversation(s).`
        : `Reached the ${MAX_STEPS}-step safety limit. Collected ${collected.size} unique conversation(s).`;
    }
  } catch (error) {
    errorMessage = error.message;
  } finally {
    if (originalTop !== null) {
      try {
        await runOnActiveTab({
          type: "restore",
          selector: area.selector,
          scrollTop: originalTop,
        });
      } catch (error) {
        restoreError = error.message;
      }
    }
  }

  return {
    conversations: [...collected.values()],
    message: errorMessage ? "" : message,
    error: errorMessage,
    restoreError,
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function addLinks(collected, links) {
  for (const conversation of links) {
    collected.set(conversation.url, conversation);
  }
}
