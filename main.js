const { app, BrowserWindow, ipcMain, safeStorage, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const { scrapeKISD, resetBrowser } = require('./scraper');

if (process.env.NODE_ENV === 'development') {
  require('electron-reload')(__dirname, {
    electron: require('path').join(__dirname, 'node_modules', '.bin', 'electron')
  });
}

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

// ── Credential helpers ────────────────────────────────────────────────────────

function credsPath() {
  return path.join(app.getPath('userData'), 'credentials.enc');
}

function saveCredentials(username, password) {
  const p = credsPath();
  console.log('[creds] saving to:', p);
  console.log('[creds] safeStorage available:', safeStorage.isEncryptionAvailable());
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const buf = safeStorage.encryptString(JSON.stringify({ username, password }));
      fs.writeFileSync(p, buf);
    } else {
      fs.writeFileSync(p, JSON.stringify({ username, password }));
    }
  } catch (e) {
    console.error('[creds] save failed:', e.message);
  }
}

function loadCredentials() {
  const p = credsPath();
  console.log('[creds] path:', p);
  console.log('[creds] file exists:', fs.existsSync(p));
  console.log('[creds] safeStorage available:', safeStorage.isEncryptionAvailable());
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p);
    if (safeStorage.isEncryptionAvailable()) {
      return JSON.parse(safeStorage.decryptString(raw));
    } else {
      return JSON.parse(raw.toString());
    }
  } catch (e) {
    console.error('[creds] load failed:', e.message);
    return null;
  }
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('scrape', async (event, { username, password }) => {
  try {
    const requestMfaCode = () => new Promise((resolve) => {
      ipcMain.once('mfa-submit', (_e, code) => resolve(code));
      event.sender.send('mfa-required');
    });

    const userDataDir = path.join(app.getPath('userData'), 'puppeteer-profile');
    console.log('[profile] path:', userDataDir);
    console.log('[profile] exists:', fs.existsSync(userDataDir));
    const courses = await scrapeKISD(username, password, userDataDir, requestMfaCode);

    saveCredentials(username, password);
    return { ok: true, courses };
  } catch (err) {
    console.error('[scrape error]', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('get-saved-credentials', () => {
  return loadCredentials();
});

ipcMain.handle('logout', async () => {
  // Delete saved credentials
  try {
    const p = credsPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) {
    console.error('[logout] delete creds failed:', e.message);
  }

  // Wipe the Puppeteer browser profile so session cookies are gone
  const profileDir = path.join(app.getPath('userData'), 'puppeteer-profile');
  try {
    if (fs.existsSync(profileDir)) fs.rmSync(profileDir, { recursive: true, force: true });
  } catch (e) {
    console.error('[logout] clear profile failed:', e.message);
  }

  await resetBrowser();
  return { ok: true };
});

ipcMain.handle('open-external', (_event, url) => shell.openExternal(url));

ipcMain.handle('clear-session', async () => {
  const profileDir = path.join(app.getPath('userData'), 'puppeteer-profile');
  console.log('[clear-session] deleting profile:', profileDir);
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.rmSync(credsPath(), { force: true });
  await resetBrowser();
  console.log('[clear-session] done — quitting');
  app.quit();
});
