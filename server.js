const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const { createObjectCsvWriter } = require('csv-writer');
const app = express();
const port = 3000;

puppeteer.use(StealthPlugin());

app.use(express.static('public')); // Serve static files from "public" directory

const dataFilePath = path.join(__dirname, 'fetched_data.json');
const csvFilePath = path.join(__dirname, 'fetched_data.csv');

// 创建CSV写入器
const csvWriter = createObjectCsvWriter({
    path: csvFilePath,
    header: [
        { id: 'timestamp', title: 'Timestamp' },
        { id: 'name', title: 'Plugin Name' },
        { id: 'users', title: 'Users' }
    ],
    append: true
});

app.get('/fetch-plugin-data', async (req, res) => {
    try {
        const data = await fetchPluginData();
        console.log('Fetched data:', data); // 打印抓取到的数据

        // 读取现有数据
        let existingData = [];
        if (fs.existsSync(dataFilePath)) {
            const rawData = fs.readFileSync(dataFilePath);
            existingData = JSON.parse(rawData);
        }

        // 添加新的数据
        const now = new Date();
        const formattedTime = now.getFullYear() + '-' +
            String(now.getMonth() + 1).padStart(2, '0') + '-' +
            String(now.getDate()).padStart(2, '0') + ' ' +
            String(now.getHours()).padStart(2, '0') + ':' +
            String(now.getMinutes()).padStart(2, '0');
        const timestampedData = data.map(item => ({
            timestamp: formattedTime,
            ...item
        }));
        existingData.push({ timestamp: formattedTime, data });

        // 保存数据到文件
        fs.writeFileSync(dataFilePath, JSON.stringify(existingData, null, 2));

        // 写入CSV文件
        await csvWriter.writeRecords(timestampedData);

        res.json(existingData); // 以JSON格式返回历史数据
    } catch (error) {
        console.error('Error fetching plugin data:', error);
        res.status(500).json({ error: 'Failed to fetch plugin data' });
    }
});

async function fetchPluginData() {
    console.log('Starting Puppeteer');
    const browser = await puppeteer.launch({
        headless: true, // 使用无头模式
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();

    // 设置User Agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

    // 设置更多的请求头
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
    });

    // 启用JavaScript
    await page.setJavaScriptEnabled(true);

    // 设置页面视口
    await page.setViewport({ width: 1280, height: 800 });

    try {
        await page.goto('https://www.figma.com/community/search?resource_type=plugins&sort_by=relevancy&query=chart&editor_type=all&price=all&creators=all', {
            waitUntil: 'networkidle2', // 等待网络空闲以确保页面加载完成
        });
        console.log('Page loaded');

        // 模拟用户滚动
        await autoScroll(page);

        // 使用 setTimeout 来等待特定时间（例如：5000毫秒 = 5秒）
        await new Promise(resolve => setTimeout(resolve, 5000));
        console.log('Waited for 5 seconds');

        // 确保插件列表加载完成
        await page.waitForSelector('.plugin_row--pluginRow--lySkC', { timeout: 60000 });
        console.log('Plugins container loaded');

        const pluginData = await page.evaluate(async () => {
            const plugins = document.querySelectorAll('.plugin_row--pluginRow--lySkC');
            console.log('Inside evaluate - Plugins found:', plugins.length);

            const data = [];
            let count = 0;

            for (const plugin of plugins) {
                if (count >= 10) break; // 如果已经获取到10个插件，停止循环

                const nameElement = plugin.querySelector('.plugin_row--pluginRowTitle--GOOmC.text--fontPos13--xW8hS.text--_fontBase--QdLsd');
                const name = nameElement ? nameElement.innerText : 'N/A';
                const usersElement = plugin.querySelector('.plugin_row--toolTip--Uxz1M.dropdown--dropdown--IX0tU.text--fontPos14--OL9Hp.text--_fontBase--QdLsd.plugin_row--toolTipPositioning--OgVuh');

                console.log('Inside evaluate - Plugin name:', name);
                console.log('Inside evaluate - Users element:', usersElement);

                if (usersElement) {
                    // 触发鼠标悬停事件
                    const mouseOverEvent = new MouseEvent('mouseover', {
                        view: window,
                        bubbles: true,
                        cancelable: true
                    });
                    usersElement.dispatchEvent(mouseOverEvent);

                    // 等待内容更新
                    await new Promise(resolve => setTimeout(resolve, 1000));

                    // 获取悬停后显示的精确值
                    const preciseUsersElement = usersElement.querySelector('.dropdown--dropdownContents--BqcL5');
                    let preciseUsers = preciseUsersElement ? preciseUsersElement.innerText : 'N/A';

                    // 使用正则表达式提取数值部分
                    const match = preciseUsers.match(/\d+/g);
                    preciseUsers = match ? match.join('') : 'N/A';

                    console.log('Inside evaluate - Precise users:', preciseUsers);
                    data.push({ name, users: preciseUsers });
                } else {
                    data.push({ name, users: 'N/A' });
                }

                count++;
            }

            return data;
        });

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

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});