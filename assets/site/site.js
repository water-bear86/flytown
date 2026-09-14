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
const fund = document.querySelector("[data-fund]");
const fundTrigger = fund?.querySelector(".site-nav__fund-trigger");
const fundCopyStatus = document.querySelector("#fund-copy-status");

// "Fund the Research": opens while a mouse or pen hovers it, and on click,
// tap or keyboard (Enter/Space) for devices without hover. Escape, a click
// outside, or tabbing away closes it.
if (fund && fundTrigger) {
  let hovering = false;
  let pinned = false;
  let dismissed = false;
  let hoverTimer = 0;

  const isOpen = () => (hovering || pinned) && !dismissed;

  const render = () => {
    const open = isOpen();
    fund.toggleAttribute("data-open", open);
    fundTrigger.setAttribute("aria-expanded", String(open));
  };

  const setHovering = (next, delay) => {
    window.clearTimeout(hoverTimer);
    hoverTimer = window.setTimeout(() => {
      hovering = next;
      // Coming back after Escape or a click-close counts as new interest.
      if (next) dismissed = false;
      render();
    }, delay);
  };

  fund.addEventListener("pointerenter", (event) => {
    if (event.pointerType !== "touch") setHovering(true, 90);
  });

  fund.addEventListener("pointerleave", (event) => {
    if (event.pointerType !== "touch") setHovering(false, 180);
  });

  fundTrigger.addEventListener("click", () => {
    if (!isOpen()) {
      pinned = true;
      dismissed = false;
    } else if (!pinned) {
      pinned = true;
    } else {
      pinned = false;
      dismissed = hovering;
    }
    render();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !isOpen()) return;
    const focusInPanel = fund.contains(document.activeElement) && document.activeElement !== fundTrigger;
    pinned = false;
    dismissed = true;
    render();
    if (focusInPanel) fundTrigger.focus();
  });

  document.addEventListener("pointerdown", (event) => {
    if (!pinned || fund.contains(event.target)) return;
    pinned = false;
    render();
  });

  fund.addEventListener("focusout", (event) => {
    const next = event.relatedTarget;
    if (!pinned || !(next instanceof Node) || fund.contains(next)) return;
    pinned = false;
    render();
  });
}

for (const walletButton of document.querySelectorAll("[data-copy-wallet]")) {
  const addressElement = document.getElementById(walletButton.getAttribute("data-copy-wallet") ?? "");
  const walletName = walletButton.getAttribute("data-wallet-name") ?? "Wallet";
  let resetTimer = 0;

  walletButton.addEventListener("click", async () => {
    // Copy exactly what is displayed, so the copied address is the one people can check.
    const address = addressElement?.textContent?.trim() ?? "";
    if (!addressElement || !address) return;

    try {
      await navigator.clipboard.writeText(address);
      walletButton.setAttribute("data-copy-state", "success");
      walletButton.textContent = "Copied";
      if (fundCopyStatus) fundCopyStatus.textContent = `${walletName} wallet address copied to the clipboard.`;
    } catch {
      const range = document.createRange();
      range.selectNodeContents(addressElement);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      if (fundCopyStatus) fundCopyStatus.textContent = `Copy this ${walletName} wallet address: ${address}`;
    }

    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => {
      walletButton.removeAttribute("data-copy-state");
      walletButton.textContent = "Copy";
      if (fundCopyStatus) fundCopyStatus.textContent = "";
    }, 2600);
  });
}

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
