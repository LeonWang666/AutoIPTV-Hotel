/**
 * IPTV M3U 自动抓取脚本
 * 在 GitHub Actions 中通过 Puppeteer 运行
 * 抓取结果通过 Cloudflare API 写入 KV 存储
 */

const puppeteer = require('puppeteer');

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
    console.log('[1/6] 启动浏览器...');
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1280,800'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    // 步骤1: 访问首页
    console.log('[2/6] 访问首页...');
    await page.goto('https://iptv.cqshushu.com/index.php', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    // 等待JS验证和页面加载
    console.log('等待页面加载...');
    await page.waitForFunction(() => {
      return document.querySelectorAll('table').length >= 2;
    }, { timeout: 30000 });

    await sleep(3000);
    console.log('首页加载完成, URL:', page.url());

    // 步骤2: 找到第一个新上线的Multicast IP
    console.log('[3/6] 查找新上线Multicast IP...');
    const ipInfo = await page.evaluate(() => {
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

    if (!ipInfo || !ipInfo.token) {
      throw new Error('未找到新上线的Multicast IP');
    }
    console.log(`找到IP: ${ipInfo.ip}`);

    // 步骤3: 点击IP进入详情页
    console.log('[4/6] 进入详情页...');
    await page.evaluate((token, type) => {
      if (typeof gotoIP === 'function') gotoIP(token, type);
    }, ipInfo.token, ipInfo.type);

    await sleep(5000);

    // 在所有页面中查找详情页
    const pages = await browser.pages();
    let detailPage = null;
    for (const p of pages) {
      const url = p.url();
      if (url.includes('p=') && url.includes('t=multicast') && !url.includes('eatcells') && !url.includes('faithfuloccasion')) {
        detailPage = p;
        break;
      }
    }

    if (!detailPage) throw new Error('未找到详情页');
    
    // 关闭其他不需要的标签页（广告页）
    for (const p of pages) {
      const url = p.url();
      if (url.includes('eatcells') || url.includes('faithfuloccasion') || url === 'about:blank') {
        try { await p.close(); } catch(e) {}
      }
    }

    page = detailPage;
    console.log('详情页URL:', page.url());
    await sleep(2000);

    // 步骤4: 查找频道列表链接
    console.log('[5/6] 查找频道列表...');
    const channelInfo = await page.evaluate(() => {
      const links = document.querySelectorAll('a');
      for (const link of links) {
        if (link.textContent.includes('查看频道列表')) {
          return { url: link.href };
        }
      }
      for (const link of links) {
        if (link.textContent.includes('M3U')) {
          return { url: link.href, isM3U: true };
        }
      }
      return null;
    });

    if (!channelInfo) throw new Error('未找到频道列表链接');

    if (channelInfo.isM3U) {
      let m3uUrl = channelInfo.url;
      if (!m3uUrl.startsWith('http')) m3uUrl = new URL(m3uUrl, page.url()).href;
      console.log('直接找到M3U链接:', m3uUrl);
      await saveToCloudflare(m3uUrl, ipInfo.ip);
      return;
    }

    // 步骤5: 进入频道列表页
    await page.evaluate(() => {
      const links = document.querySelectorAll('a');
      for (const link of links) {
        if (link.textContent.includes('查看频道列表')) {
          link.click();
          return;
        }
      }
    });

    await sleep(5000);

    // 查找频道列表页
    const pages2 = await browser.pages();
    let channelPage = null;
    for (const p of pages2) {
      const url = p.url();
      if (url.includes('s=') && url.includes('t=multicast') && !url.includes('eatcells') && !url.includes('faithfuloccasion')) {
        channelPage = p;
        break;
      }
    }

    if (!channelPage) throw new Error('未找到频道列表页');
    page = channelPage;
    console.log('频道列表页URL:', page.url());
    await sleep(2000);

    // 步骤6: 查找M3U链接
    console.log('[6/6] 查找M3U链接...');
    const m3uResult = await page.evaluate(() => {
      const links = document.querySelectorAll('a');
      for (const link of links) {
        if (link.textContent.includes('M3U')) {
          let href = link.href;
          if (href && !href.startsWith('http')) href = new URL(href, window.location.origin).href;
          return href;
        }
      }
      return null;
    });

    if (!m3uResult) throw new Error('未找到M3U链接');

    console.log('找到M3U链接:', m3uResult);
    await saveToCloudflare(m3uResult, ipInfo.ip);

    console.log('=== 抓取成功 ===');

  } catch (error) {
    console.error('抓取失败:', error.message);
    
    // 保存错误信息到 Cloudflare
    try {
      await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/last_error`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${CF_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(new Date().toISOString() + ': ' + error.message)
      });
    } catch(e) {}
    
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function saveToCloudflare(m3uLink, ip) {
  const timestamp = new Date().toISOString();
  
  console.log('保存到 Cloudflare KV...');
  
  // 保存 M3U 链接
  await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/m3u_link`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(m3uLink)
  });
  console.log('  m3u_link:', m3uLink);

  // 保存 IP
  await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/current_ip`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(ip)
  });
  console.log('  current_ip:', ip);

  // 保存更新时间
  await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/last_update`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(timestamp)
  });
  console.log('  last_update:', timestamp);

  // 清除错误
  await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/last_error`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify('')
  });

  console.log('Cloudflare KV 更新完成');
}

main().catch(err => {
  console.error('脚本异常:', err);
  process.exit(1);
});
