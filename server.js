const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const app = express();
const port = 3000;

puppeteer.use(StealthPlugin());
app.use(express.static('public'));

const dataFilePath = path.join(__dirname, 'structured_data.json');

// 存储数据
function storeData(data) {
    const now = new Date();
    const year = now.getFullYear().toString();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');
    const time = now.toTimeString().slice(0, 5);

    let storedData = {};
    if (fs.existsSync(dataFilePath)) {
        storedData = JSON.parse(fs.readFileSync(dataFilePath));
    }

    if (!storedData[year]) storedData[year] = {};
    if (!storedData[year][month]) storedData[year][month] = {};
    if (!storedData[year][month][day]) storedData[year][month][day] = {};

    storedData[year][month][day][time] = data;

    fs.writeFileSync(dataFilePath, JSON.stringify(storedData, null, 2));
}

// 查找前一日数据
function findPreviousData() {
    const now = new Date();
    const year = now.getFullYear().toString();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');

    if (!fs.existsSync(dataFilePath)) return null;
    const storedData = JSON.parse(fs.readFileSync(dataFilePath));

    if (!storedData[year] || !storedData[year][month]) return null;

    const days = Object.keys(storedData[year][month]).filter(d => d < day).sort();
    if (days.length === 0) return null;
    const lastDay = days[days.length - 1];
    const times = Object.keys(storedData[year][month][lastDay]).sort();
    const lastTime = times[times.length - 1];

    return storedData[year][month][lastDay][lastTime];
}

// 启动服务器
// app.listen(port, () => {
//     console.log(`Server is running on http://localhost:${port}`);
// });

app.listen(1086, '121.40.69.104', () => {
    console.log(`Server is running on http://121.40.69.104:1086`);
});

function readFullHistoryData() {
    if (!fs.existsSync(dataFilePath)) {
        return {}; // 如果文件不存在，返回空对象
    }
    const rawData = fs.readFileSync(dataFilePath);
    return JSON.parse(rawData);
}

app.get('/fetch-plugin-data', async (req, res) => {
    try {
        const previousData = findPreviousData();
        const pluginData = await fetchPluginData(previousData); // 获取当前插件数据
        storeData(pluginData); // 存储当前数据
        const fullHistoryData = readFullHistoryData(); // 读取完整历史数据
        res.json(fullHistoryData); // 发送完整历史数据
    } catch (error) {
        console.error('Error fetching plugin data:', error);
        res.status(500).json({ error: 'Failed to fetch plugin data' });
    }
});
async function fetchPluginData(previousData) {
    console.log('Starting Puppeteer');
    const browser = await puppeteer.launch({
        headless: true, // 使用无头模式
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setJavaScriptEnabled(true);
    await page.setViewport({ width: 1280, height: 800 });

    try {
        await page.goto('https://www.figma.com/community/search?resource_type=plugins&sort_by=relevancy&query=chart&editor_type=all&price=all&creators=all', {
            waitUntil: 'networkidle2',
        });
        await autoScroll(page);
        await new Promise(resolve => setTimeout(resolve, 1000));
        await page.waitForSelector('.plugin_row--pluginRow--lySkC', { timeout: 8000 });

        const pluginData = await page.evaluate(async (previousData) => {
            const plugins = document.querySelectorAll('.plugin_row--pluginRow--lySkC');
            const data = [];
            for (const plugin of plugins) {
                if (data.length >= 20) break; // 如果已经获取到10个插件，停止循环
                const nameElement = plugin.querySelector('.plugin_row--pluginRowTitle--GOOmC.text--fontPos13--xW8hS.text--_fontBase--QdLsd');
                const name = nameElement ? nameElement.innerText : 'N/A';
                const usersElement = plugin.querySelector('.plugin_row--toolTip--Uxz1M.dropdown--dropdown--IX0tU.text--fontPos14--OL9Hp.text--_fontBase--QdLsd.plugin_row--toolTipPositioning--OgVuh');
                let preciseUsers = 'N/A';
        
                if (usersElement) {
                    const mouseOverEvent = new MouseEvent('mouseover', { view: window, bubbles: true, cancelable: true });
                    usersElement.dispatchEvent(mouseOverEvent);
                    await new Promise(resolve => setTimeout(resolve, 500));  // 正确使用 await
                    const preciseUsersElement = usersElement.querySelector('.dropdown--dropdownContents--BqcL5');
                    preciseUsers = preciseUsersElement ? preciseUsersElement.innerText.match(/\d+/g).join('') : 'N/A';
                }
                
                const currentUsers = parseInt(preciseUsers);
                const sortName = name.slice(0, 20);
                const previousPlugin = previousData ? previousData.find(p => p.name.slice(0, 20) === sortName) : null;
                const previousUsers = previousPlugin ? parseInt(previousPlugin.users) : null;
                const DoDCount = previousUsers ? currentUsers - previousUsers : '--';
                const DoDPercent = previousUsers ? ((DoDCount / previousUsers) * 100).toFixed(2) + '%' : '--';
        
                data.push({ name, users: preciseUsers, DoDCount: DoDCount.toString(), DoDPercent });
            }
            return data;
        }, previousData); // 注意这里是如何传递 previousData 作为参数的

        await browser.close();
        console.log('Puppeteer finished');
        return pluginData;

    } catch (error) {
        console.error('Error during Puppeteer execution:', error);
        await browser.close();
        throw error;
    }
}

// 模拟用户滚动
async function autoScroll(page){
    await page.evaluate(async () => {
        await new Promise((resolve, reject) => {
            var totalHeight = 0;
            var distance = 100;
            var timer = setInterval(() => {
                var scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;

                if(totalHeight >= scrollHeight){
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
        });
    });
}

app.delete('/delete-time-data', (req, res) => {
    const { year, month, day, time } = req.query;
    try {
        if (deleteTimeData(year, month, day, time)) {
            res.json({ success: true });
        } else {
            res.status(404).json({ success: false, message: "Time data not found" });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error", error: error.message });
    }
});

app.get('/get-full-data', (req, res) => {
    // 返回最新的完整数据
    const data = readFullDataFromJSON();
    res.json(data);
});

// 函数用于从JSON文件读取数据
function readFullDataFromJSON() {
    try {
        // 同步读取文件内容
        const jsonData = fs.readFileSync(dataFilePath, 'utf8');
        // 解析JSON字符串为JavaScript对象
        return JSON.parse(jsonData);
    } catch (error) {
        console.error("Error reading JSON data from file:", error);
        // 处理错误，例如文件不存在或解析错误
        return null;
    }
}

function deleteTimeData(year, month, day, time) {
    const data = JSON.parse(fs.readFileSync(dataFilePath, 'utf8'));
    if (data[year] && data[year][month] && data[year][month][day] && data[year][month][day][time]) {
        delete data[year][month][day][time];
        fs.writeFileSync(dataFilePath, JSON.stringify(data, null, 2)); // 重新写入更新后的数据
        return true;
    }
    return false;
}
