window.addEventListener("error", (event) => {
  showPanelError(`Script error: ${event.message}`);
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
  showPanelError(`Unhandled failure: ${reason}`);
});

function showPanelError(message) {
  const status = document.querySelector("#status");
  if (status) {
    status.textContent = message;
    status.style.color = "#b3261e";
  }
  console.error("[Context For Humans]", message);
}
