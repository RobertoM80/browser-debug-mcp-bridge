console.log('[BrowserDebug] Background service worker started');

chrome.runtime.onStartup.addListener(() => {
  console.log('[BrowserDebug] Extension started');
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[BrowserDebug] Extension installed');
});
