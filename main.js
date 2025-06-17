const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const puppeteer = require('puppeteer');
const crypto = require('crypto');

let mainWindow;
let intervalId;

function createWindow() {
  const nonce = crypto.randomBytes(16).toString('base64');

  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      additionalArguments: [`--nonce=${nonce}`] // 传递 nonce
    },
  });

  mainWindow.loadFile('index.html', { search: `?nonce=${nonce}` });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.on('start-fetching', async (event, interval) => {
  intervalId = setInterval(async () => {
    const data = await fetchPluginData();
    event.sender.send('fetch-result', data);
  }, interval);
});

ipcMain.on('stop-fetching', () => {
  clearInterval(intervalId);
});

async function fetchPluginData() {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://www.figma.com/community/search?resource_type=plugins&sort_by=relevancy&query=chart&editor_type=all&price=all&creators=all');

  const pluginData = await page.evaluate(async () => {
    const plugins = Array.from(document.querySelectorAll('.plugin_row--pluginRow--lySkC')); // 根据实际CSS选择器替换
    const data = [];

    for (const plugin of plugins) {
      const name = plugin.querySelector('.plugin_row--pluginRowTitle--GOOmC text--fontPos13--xW8hS text--_fontBase--QdLsd').innerText;
      const usersElement = plugin.querySelector('.plugin_row--toolTip--Uxz1M dropdown--dropdown--IX0tU text--fontPos14--OL9Hp text--_fontBase--QdLsd plugin_row--toolTipPositioning--OgVuh');
      const mouseOverEvent = new Event('mouseover');

      usersElement.dispatchEvent(mouseOverEvent);
      await new Promise(r => setTimeout(r, 1000)); // 等待悬停后的数据出现

      // 获取悬停后显示的精确值
      const preciseUsersElement = document.querySelector('.dropdown--dropdownContents--BqcL5');
      const preciseUsers = preciseUsersElement ? preciseUsersElement.innerText : 'N/A';

      data.push({ name, users: preciseUsers });
    }

    return data;
  });

  await browser.close();
  return pluginData;
}