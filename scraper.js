/**
 * IPTV M3U 自动抓取脚本 v3
 * 在 GitHub Actions 中通过 Puppeteer 运行
 * 使用 puppeteer-extra + stealth 绕过 Cloudflare 检测
 * 抓取结果通过 Cloudflare API 写入 KV 存储
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// Cloudflare 配置
const CF_ACCOUNT_ID = '13992e7b764637d462d3cf98f3a20086';
const CF_NAMESPACE_ID = '5a49325bf26b4106a0f497a6403a063d';
const CF_API_TOKEN = process.env.CF_API_TOKEN;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('=== IPTV M3U 抓取开始 ===');
  console.log('时间:', new Date().toISOString());

  let browser;
  try {
    // 启动浏览器
    console.log('[1/7] 启动浏览器...');
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });
    page.setDefaultTimeout(90000);
    page.setDefaultNavigationTimeout(90000);

    // 步骤1: 访问首页
    console.log('[2/7] 访问首页...');
    await page.goto('https://iptv.cqshushu.com/index.php', {
      waitUntil: 'networkidle2',
      timeout: 90000
    });
    console.log('初始加载完成, URL:', page.url());

    // 步骤2: 等待 Cloudflare Challenge 通过
    console.log('[3/7] 等待 Cloudflare 验证通过...');
    await waitForCloudflarePass(page);
    console.log('Cloudflare 验证已通过');

    // 步骤3: 查找新上线的 Multicast IP
    console.log('[4/7] 查找新上线Multicast IP...');
    let ipInfo = await findNewOnlineIP(page);

    // 如果当前页没找到，翻页查找
    if (!ipInfo) {
      console.log('当前页未找到新上线IP，尝试翻页...');
      for (let pageNum = 2; pageNum <= 5; pageNum++) {
        console.log(`  检查第 ${pageNum} 页...`);
        const clicked = await page.evaluate((pn) => {
          const links = document.querySelectorAll('a');
          for (const link of links) {
            if (link.textContent.trim() === String(pn)) {
              link.click();
              return true;
            }
          }
          for (const link of links) {
            if (link.textContent.includes('下一页')) {
              link.click();
              return true;
            }
          }
          return false;
        }, pageNum);

        if (!clicked) {
          console.log(`  第 ${pageNum} 页不存在，停止翻页`);
          break;
        }

        await sleep(3000);
        await simulateHuman(page);
        ipInfo = await findNewOnlineIP(page);
        if (ipInfo) break;
      }
    }

    // 如果还是没找到，使用第一个可用 IP
    if (!ipInfo || !ipInfo.token) {
      console.log('未找到新上线IP，使用第一个可用IP...');
      ipInfo = await page.evaluate(() => {
        const tables = document.querySelectorAll('table');
        let mTable = tables.length >= 2 ? tables[1] : null;
        if (!mTable) return null;
        const rows = mTable.querySelectorAll('tbody tr');
        if (rows.length === 0) return null;
        const cells = rows[0].querySelectorAll('td');
        if (cells.length < 6) return null;
        const link = cells[0].querySelector('a');
        if (!link) return null;
        const onclick = link.getAttribute('onclick') || '';
        const m = onclick.match(/gotoIP\('([^']+)','([^']+)'\)/);
        return {
          ip: link.textContent.trim(),
          token: m ? m[1] : null,
          type: m ? m[2] : 'multicast',
          status: cells[5].textContent.trim()
        };
      });
      if (ipInfo) console.log(`使用IP: ${ipInfo.ip} (状态: ${ipInfo.status})`);
    }

    if (!ipInfo || !ipInfo.token) {
      throw new Error('未找到可用的Multicast IP');
    }
    console.log(`目标IP: ${ipInfo.ip}`);

    // 步骤4: 点击IP进入详情页
    console.log('[5/7] 进入详情页...');
    const pagesBefore = (await browser.pages()).length;

    await page.evaluate((token, type) => {
      if (typeof gotoIP === 'function') gotoIP(token, type);
    }, ipInfo.token, ipInfo.type);

    console.log('等待新页面...');
    await sleep(8000);

    // 查找详情页
    let detailPage = null;
    const allPages = await browser.pages();
    console.log(`标签页数量: ${allPages.length}（之前 ${pagesBefore}）`);

    for (const p of allPages) {
      const url = p.url();
      if (url.includes('iptv.cqshushu.com') &&
          !url.includes('eatcells') &&
          !url.includes('faithfuloccasion') &&
          url !== 'about:blank' &&
          p !== page) {
        detailPage = p;
      }
    }

    if (!detailPage && (page.url().includes('p=') || page.url().includes('detail'))) {
      detailPage = page;
    }

    if (!detailPage) throw new Error('未找到详情页');

    // 关闭广告页
    for (const p of allPages) {
      const url = p.url();
      if (url.includes('eatcells') || url.includes('faithfuloccasion')) {
        try { await p.close(); } catch(e) {}
      }
    }

    console.log('详情页URL:', detailPage.url());
    await sleep(3000);

    // 步骤5: 查找M3U链接
    console.log('[6/7] 查找M3U链接...');
    let m3uUrl = await detailPage.evaluate(() => {
      const links = document.querySelectorAll('a');
      for (const link of links) {
        if (link.textContent.includes('M3U') || link.textContent.includes('m3u')) {
          let href = link.href;
          if (href && !href.startsWith('http')) href = new URL(href, window.location.origin).href;
          return href;
        }
      }
      return null;
    });

    if (!m3uUrl) {
      const channelLink = await detailPage.evaluate(() => {
        const links = document.querySelectorAll('a');
        for (const link of links) {
          if (link.textContent.includes('查看频道列表') || link.textContent.includes('频道列表')) {
            return link.href;
          }
        }
        return null;
      });

      if (channelLink) {
        console.log('进入频道列表页...');
        await detailPage.goto(channelLink, { waitUntil: 'networkidle2', timeout: 30000 });
        await sleep(3000);
        m3uUrl = await detailPage.evaluate(() => {
          const links = document.querySelectorAll('a');
          for (const link of links) {
            if (link.textContent.includes('M3U') || link.textContent.includes('m3u')) {
              let href = link.href;
              if (href && !href.startsWith('http')) href = new URL(href, window.location.origin).href;
              return href;
            }
          }
          return null;
        });
      }
    }

    if (!m3uUrl) throw new Error('未找到M3U链接');
    console.log('M3U链接:', m3uUrl);

    // 步骤7: 保存到 KV
    console.log('[7/7] 保存到 Cloudflare KV...');
    await saveToCloudflare(m3uUrl, ipInfo.ip);
    console.log('=== 抓取成功 ===');

  } catch (error) {
    console.error('抓取失败:', error.message);
    try {
      await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/last_error`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'text/plain' },
        body: new Date().toISOString() + ': ' + error.message
      });
    } catch(e) {}
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
}

// 等待 Cloudflare Challenge 通过
async function waitForCloudflarePass(page) {
  for (let i = 0; i < 30; i++) {
    const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 200) || '');
    const tableCount = await page.evaluate(() => document.querySelectorAll('table').length);

    console.log(`  等待中... (${i+1}/30) tables=${tableCount} text="${bodyText.substring(0, 50)}"`);

    // 检查是否通过了 Cloudflare 验证
    if (tableCount >= 2) return true;

    // 检查是否在 Cloudflare challenge 页面
    if (bodyText.includes('请稍候') || bodyText.includes('Just a moment') || bodyText.includes('Checking')) {
      console.log('  检测到 Cloudflare 验证页面，等待...');
      await sleep(3000);
      await simulateHuman(page);
      continue;
    }

    // 检查是否有 Turnstile/Challenge 需要点击
    try {
      const challengeFrame = await page.$('iframe[src*="challenges"]');
      if (challengeFrame) {
        console.log('  检测到 Challenge iframe，尝试点击...');
        const frame = await challengeFrame.contentFrame();
        if (frame) {
          const checkbox = await frame.$('input[type="checkbox"]');
          if (checkbox) await checkbox.click();
        }
      }
    } catch(e) {}

    await sleep(2000);
  }

  // 最后一次检查
  const tableCount = await page.evaluate(() => document.querySelectorAll('table').length);
  if (tableCount >= 2) return true;

  const pageContent = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '');
  console.log('最终页面内容:', pageContent);
  throw new Error('Cloudflare 验证超时，页面内容: ' + pageContent.substring(0, 100));
}

async function findNewOnlineIP(page) {
  return await page.evaluate(() => {
    const tables = document.querySelectorAll('table');
    let mTable = tables.length >= 2 ? tables[1] : null;
    if (!mTable) return null;
    const rows = mTable.querySelectorAll('tbody tr');
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 6) {
        const status = cells[5].textContent.trim();
        if (status === '新上线') {
          const link = cells[0].querySelector('a');
          if (link) {
            const onclick = link.getAttribute('onclick') || '';
            const m = onclick.match(/gotoIP\('([^']+)','([^']+)'\)/);
            return { ip: link.textContent.trim(), token: m ? m[1] : null, type: m ? m[2] : 'multicast' };
          }
        }
      }
    }
    return null;
  });
}

async function simulateHuman(page) {
  try {
    for (let i = 0; i < 5; i++) {
      await page.mouse.move(Math.random() * 1920, Math.random() * 1080);
      await sleep(200 + Math.random() * 300);
    }
    await page.evaluate(() => window.scrollBy(0, Math.random() * 300));
    await sleep(500);
  } catch(e) {}
}

async function saveToCloudflare(m3uLink, ip) {
  const timestamp = new Date().toISOString();
  const headers = { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'text/plain' };

  const r1 = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/m3u_link`, { method: 'PUT', headers, body: m3uLink });
  console.log('  m3u_link:', (await r1.json()).success ? 'OK' : 'FAIL');

  const r2 = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/current_ip`, { method: 'PUT', headers, body: ip });
  console.log('  current_ip:', (await r2.json()).success ? 'OK' : 'FAIL');

  const r3 = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/last_update`, { method: 'PUT', headers, body: timestamp });
  console.log('  last_update:', (await r3.json()).success ? 'OK' : 'FAIL');

  await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/last_error`, { method: 'PUT', headers, body: '' });
  console.log('Cloudflare KV 更新完成');
}

main().catch(err => {
  console.error('脚本异常:', err);
  process.exit(1);
});
