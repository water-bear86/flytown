document.documentElement.classList.add("js-ready");

const tabList = document.querySelector("[role='tablist']");
const tabs = Array.from(document.querySelectorAll("[data-attempt-target]"));
const panels = Array.from(document.querySelectorAll("[role='tabpanel']"));

function selectAttempt(tab, moveFocus = false) {
  const targetId = tab.getAttribute("data-attempt-target");

  for (const candidate of tabs) {
    const selected = candidate === tab;
    candidate.setAttribute("aria-selected", String(selected));
    candidate.tabIndex = selected ? 0 : -1;
  }

  for (const panel of panels) {
    panel.hidden = panel.id !== targetId;
  }

  if (moveFocus) tab.focus();
}

for (const tab of tabs) {
  tab.addEventListener("click", () => selectAttempt(tab));
}

tabList?.addEventListener("keydown", (event) => {
  if (!(event instanceof KeyboardEvent)) return;
  const activeIndex = tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true");
  let nextIndex = activeIndex;

  if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (activeIndex + 1) % tabs.length;
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (activeIndex - 1 + tabs.length) % tabs.length;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = tabs.length - 1;

  if (nextIndex !== activeIndex) {
    event.preventDefault();
    selectAttempt(tabs[nextIndex], true);
  }
});

const copyButton = document.querySelector("[data-copy-command]");
const copyStatus = document.querySelector(".copy-status");
const caButton = document.querySelector("[data-copy-ca]");
const caCopyStatus = document.querySelector("#ca-copy-status");
const caCopyAction = caButton?.querySelector(".site-nav__ca-action");

caButton?.addEventListener("click", async () => {
  const address = caButton.getAttribute("data-copy-ca") ?? "";

  try {
    await navigator.clipboard.writeText(address);
    caButton.setAttribute("data-copy-state", "success");
    if (caCopyAction) caCopyAction.textContent = "Copied";
    if (caCopyStatus) caCopyStatus.textContent = "FLYTOWN contract address copied to the clipboard.";
  } catch {
    if (caCopyStatus) caCopyStatus.textContent = `Copy this FLYTOWN contract address: ${address}`;
  }

  window.setTimeout(() => {
    caButton.removeAttribute("data-copy-state");
    if (caCopyAction) caCopyAction.textContent = "Copy";
    if (caCopyStatus) caCopyStatus.textContent = "";
  }, 2600);
});

copyButton?.addEventListener("click", async () => {
  const command = copyButton.getAttribute("data-copy-command") ?? "";

  try {
    await navigator.clipboard.writeText(command);
    copyButton.textContent = "Copied";
    if (copyStatus) copyStatus.textContent = "Clone command copied to the clipboard.";
  } catch {
    if (copyStatus) copyStatus.textContent = `Copy this command: ${command}`;
  }

  window.setTimeout(() => {
    copyButton.textContent = "Copy command";
    if (copyStatus) copyStatus.textContent = "";
  }, 2600);
});
