const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const app = express();
const port = 1086;

puppeteer.use(StealthPlugin());
app.use(express.static('public'));

const dataFilePath = path.join(__dirname, 'structured_data.json');

// 存储数据
function storeData(data) {
    const now = new Date();
    const year = now.getFullYear().toString();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');
    const time = now.toTimeString().slice(0, 5).replace(/:/g, '-');

    const dirPath = path.join(__dirname, 'data', year, month, day);

    try {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }

        const filePath = path.join(dirPath, `${time}.json`);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        console.log('Data stored successfully:', filePath);
    } catch (error) {
        console.error('Failed to store data:', error);
    }
}

function findFirstDataOfToday() {
    const now = new Date();
    const year = now.getFullYear().toString();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');

    // 检查目录是否存在
    const dirPath = path.join(__dirname, 'data', year, month, day);
    if (!fs.existsSync(dirPath)) {
        console.log("No data for today.");
        return null;
    }

    // 读取目录中的所有文件，假设文件名是时间戳，如 "08-00.json"
    const files = fs.readdirSync(dirPath).filter(file => file.endsWith('.json'));
    if (files.length === 0) {
        console.log("No data files found for today.");
        return null;
    }

    // 对文件名进行排序以找到第一个文件，即最早的数据点
    const firstFile = files.sort()[0];
    const filePath = path.join(dirPath, firstFile);
    const firstData = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    return firstData;
}

//启动服务器
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});

// app.listen(1086, '0.0.0.0', () => {
//     console.log(`Server is running on 1086`);
// });

function startFetchTask() {
    const now = new Date();
    const millisTillNextHalfHour = 1800000 - (now.getMinutes() * 60000 + now.getSeconds() * 1000 + now.getMilliseconds()) % 1800000;
    
    setTimeout(() => {
        fetchData(); // 在接下来的半小时点执行
        setInterval(fetchData, 1800000); // 每半小时执行一次
    }, millisTillNextHalfHour);
}

startFetchTask();

async function fetchData() {
    const previousData = findFirstDataOfToday();
    const pluginData = await fetchPluginData(previousData); // 获取当前插件数据
    storeData(pluginData); // 存储当前数据
}

// 读取指定日期和时间的数据
function readDataByDateTime(year, month, day, time) {
    const dirPath = path.join(__dirname, 'data', year, month, day);
    const fileName = `${time}.json`; // 时间格式应为 "HH-MM"，例如 "13-45.json"
    const filePath = path.join(dirPath, fileName);

    if (fs.existsSync(filePath)) {
        const fileData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return fileData; // 返回该时间点的数据
    } else {
        return null; // 如果文件不存在，返回 null 或适当的默认值
    }
}

app.get('/fetch-plugin-data', async (req, res) => {
    try {
        await fetchData();
        res.json({ success: true });
    } catch (error) {
        console.error('Error fetching plugin data:', error);
        res.status(500).json({ error: 'Failed to fetch plugin data' });
    }
});

async function fetchPluginData(previousData) {
    console.log('Starting Puppeteer');

    try {
        const url1 = 'https://www.figma.com/community/search?resource_type=plugins&sort_by=relevancy&query=chart&editor_type=all&price=all&creators=all';
        const url2 = 'https://www.figma.com/community/search?resource_type=plugins&sort_by=relevancy&query=i+3D+extrude+shape&editor_type=all&price=all&creators=all';

        // Fetch data from the first URL
        const data1 = await fetchPageData(url1, previousData);

        // Fetch data from the second URL
        const data2 = await fetchPageData(url2, previousData);

        // Combine data from both pages
        const pluginData = data1.concat(data2);

        console.log('Puppeteer finished');
        return pluginData;

    } catch (error) {
        console.error('Error during Puppeteer execution:', error);
        throw error;
    }
}

async function fetchPageData(url, previousData) {
    const browser = await puppeteer.launch({
        headless: true,
        // executablePath: '/usr/bin/google-chrome',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setJavaScriptEnabled(true);
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(url, {
        waitUntil: 'networkidle2', timeout: 30000, 
    });
    await autoScroll(page);
    await new Promise(resolve => setTimeout(resolve, 1000));
    await page.waitForSelector('.plugin_row--pluginRow--lySkC', { timeout: 8000 });

    const plugins = await page.$$('.plugin_row--pluginRow--lySkC');
    const data = [];
    for (const plugin of plugins) {
        if (data.length >= 20) break;

        const name = await plugin.$eval('.plugin_row--pluginRowTitle--GOOmC.text--fontPos13--xW8hS.text--_fontBase--QdLsd', el => el.innerText);
        const usersElement = await plugin.$('.plugin_row--toolTip--Uxz1M.dropdown--dropdown--IX0tU.text--fontPos14--OL9Hp.text--_fontBase--QdLsd.plugin_row--toolTipPositioning--OgVuh');

        let preciseUsers = 'N/A';
        if (usersElement) {
            await usersElement.hover(); // Use hover from Puppeteer
            await new Promise(resolve => setTimeout(resolve, 500)); // Manually create a timeout
            preciseUsers = await usersElement.$eval('.dropdown--dropdownContents--BqcL5', el => el.innerText.match(/\d+/g).join(''));
        }

        const currentUsers = parseInt(preciseUsers);
        const sortName = name.slice(0, 20);
        const previousPlugin = previousData ? previousData.find(p => p.name.slice(0, 20) === sortName) : null;
        const previousUsers = previousPlugin ? parseInt(previousPlugin.users) : null;
        const DoDCount = previousUsers ? currentUsers - previousUsers : '--';
        const DoDPercent = previousUsers ? ((DoDCount / previousUsers) * 100).toFixed(2) + '%' : '--';

        data.push({ name, users: preciseUsers, DoDCount: DoDCount.toString(), DoDPercent });
    }
    await browser.close();
    return data;
}

function constructDirectory() {
    const basePath = path.join(__dirname, 'data');
    let directory = {};

    function exploreDirectory(dirPath, current) {
        fs.readdirSync(dirPath, { withFileTypes: true }).forEach(dirent => {
            if (dirent.isDirectory()) {
                const nextPath = path.join(dirPath, dirent.name);
                if (!current[dirent.name]) current[dirent.name] = {};
                exploreDirectory(nextPath, current[dirent.name]);
            } else {
                // 确保只处理以 '.json' 结尾的文件
                if (dirent.name.endsWith('.json')) {
                    if (!current.times) current.times = [];
                    current.times.push(dirent.name.replace('.json', ''));
                }
            }
        });
    }

    exploreDirectory(basePath, directory);
    return directory;
}

// 模拟用户滚动
async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve, reject) => {
            var totalHeight = 0;
            var distance = 100;
            var timer = setInterval(() => {
                var scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;

                if (totalHeight >= scrollHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
        });
    });
}

app.delete('/delete-time-data', (req, res) => {
    const { year, month, day, time } = req.query;
    console.log(`Attempting to delete data for: ${year}-${month}-${day} at ${time}`);
    try {
        if (deleteTimeData(year, month, day, time)) {
            console.log('Data deleted successfully');
            res.json({ success: true });
        } else {
            console.log('Data not found');
            res.status(404).json({ success: false, message: "Time data not found" });
        }
    } catch (error) {
        console.error('Error during deletion:', error);
        res.status(500).json({ success: false, message: "Server error", error: error.message });
    }
});

app.get('/get-data', (req, res) => {
    const { year, month, day, time } = req.query;
    try {
        const data = readDataByDateTime(year, month, day, time);
        res.json(data);
    } catch (error) {
        console.error("Error fetching data:", error);
        res.status(500).json({ error: "Failed to fetch data" });
    }
});
app.get('/get-directory', (req, res) => {
    try {
        const directory = constructDirectory();
        res.json(directory);
    } catch (error) {
        console.error('Failed to construct directory:', error);
        res.status(500).json({ error: 'Failed to get directory' });
    }
});


function deleteTimeData(year, month, day, time) {
    const filePath = path.join(__dirname, 'data', year, month, day, `${time}.json`);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath); // 删除文件
        return true;
    }
    return false;
}
