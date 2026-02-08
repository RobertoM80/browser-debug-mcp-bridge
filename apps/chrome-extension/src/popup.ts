console.log('[BrowserDebug] Popup loaded');

document.addEventListener('DOMContentLoaded', () => {
  const statusEl = document.getElementById('status');
  if (statusEl) {
    statusEl.textContent = 'Extension active';
  }
});
