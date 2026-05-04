const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { scrapeKISD } = require('./scraper');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 500,
    title: 'KISD Calendar',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC handler ──────────────────────────────────────────────────────────────

ipcMain.handle('scrape', async (event, { username, password }) => {
  try {
    // Passed to the scraper so it can pause and request a code from the UI
    const requestMfaCode = () => new Promise((resolve) => {
      ipcMain.once('mfa-submit', (_e, code) => resolve(code));
      event.sender.send('mfa-required');
    });

    const courses = await scrapeKISD(username, password, requestMfaCode);
    return { ok: true, courses };
  } catch (err) {
    console.error('[scrape error]', err);
    return { ok: false, error: err.message };
  }
});
