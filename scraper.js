/**
 * IPTV M3U 自动抓取脚本 v2
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

    // 隐藏自动化特征
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      // 覆盖 plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5]
      });
      // 覆盖 languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['zh-CN', 'zh', 'en']
      });
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });

    // 设置超时
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);

    // 步骤1: 访问首页
    console.log('[2/7] 访问首页...');
    const response = await page.goto('https://iptv.cqshushu.com/index.php', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });
    console.log('响应状态:', response ? response.status() : 'null');
    console.log('当前URL:', page.url());

    // 步骤2: 处理 JS 验证 + 等待页面加载
    console.log('[3/7] 等待页面加载和JS验证...');

    // 先等待页面有基本内容
    try {
      await page.waitForSelector('body', { timeout: 10000 });
      console.log('body 已加载');
    } catch(e) {
      console.log('body 选择器超时，继续...');
    }

    // 模拟鼠标移动（反爬检测）
    await simulateHuman(page);

    // 等待 JS 验证完成并设置 cookie
    // 网站会通过 JS 设置 list_js_verified cookie
    console.log('等待 JS 验证...');
    await sleep(5000);

    // 检查 cookie 是否已设置
    const cookies = await page.cookies();
    const verifiedCookie = cookies.find(c => c.name === 'list_js_verified');
    console.log('list_js_verified cookie:', verifiedCookie ? '已设置' : '未设置');

    // 手动设置 cookie 以确保通过验证
    if (!verifiedCookie) {
      console.log('手动设置验证 cookie...');
      await page.setCookie({
        name: 'list_js_verified',
        value: '1',
        domain: 'iptv.cqshushu.com',
        path: '/'
      });
    }

    // 等待表格出现（带重试）
    console.log('等待表格加载...');
    let tablesLoaded = false;
    for (let retry = 0; retry < 3; retry++) {
      const tableCount = await page.evaluate(() => document.querySelectorAll('table').length);
      console.log(`  重试 ${retry + 1}/3: 当前 table 数量 = ${tableCount}`);
      if (tableCount >= 2) {
        tablesLoaded = true;
        break;
      }
      // 可能需要刷新
      if (retry < 2) {
        console.log('  重新加载页面...');
        await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
        await sleep(5000);
        await simulateHuman(page);
      }
    }

    if (!tablesLoaded) {
      // 截图调试
      const screenshot = await page.screenshot({ encoding: 'base64' });
      console.log('页面截图(base64前100字符):', screenshot.substring(0, 100));
      const pageContent = await page.evaluate(() => document.body.innerText.substring(0, 500));
      console.log('页面内容:', pageContent);
      throw new Error('页面加载失败：未找到足够的表格元素');
    }

    console.log('页面加载成功');

    // 步骤3: 查找新上线的 Multicast IP（可能需要翻页）
    console.log('[4/7] 查找新上线Multicast IP...');
    let ipInfo = null;

    // 先检查当前页
    ipInfo = await findNewOnlineIP(page);

    // 如果当前页没找到，翻页查找（最多查3页）
    if (!ipInfo) {
      console.log('当前页未找到新上线IP，尝试翻页...');
      for (let pageNum = 2; pageNum <= 5; pageNum++) {
        console.log(`  检查第 ${pageNum} 页...`);
        // 点击下一页
        const clicked = await page.evaluate((pn) => {
          const links = document.querySelectorAll('a');
          for (const link of links) {
            if (link.textContent.trim() === String(pn)) {
              link.click();
              return true;
            }
          }
          // 尝试"下一页"按钮
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

    if (!ipInfo || !ipInfo.token) {
      // 如果还是没找到，尝试直接用第一页的第一个 IP（即使不是新上线）
      console.log('未找到新上线IP，尝试使用第一个可用IP...');
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
      if (ipInfo) {
        console.log(`使用IP: ${ipInfo.ip} (状态: ${ipInfo.status})`);
      }
    }

    if (!ipInfo || !ipInfo.token) {
      throw new Error('未找到可用的Multicast IP');
    }
    console.log(`目标IP: ${ipInfo.ip}`);

    // 步骤4: 点击IP进入详情页
    console.log('[5/7] 进入详情页...');
    const allPagesBefore = (await browser.pages()).length;

    await page.evaluate((token, type) => {
      if (typeof gotoIP === 'function') gotoIP(token, type);
    }, ipInfo.token, ipInfo.type);

    // 等待新页面打开
    console.log('等待新页面...');
    await sleep(8000);

    // 查找详情页
    let detailPage = null;
    const allPages = await browser.pages();
    console.log(`当前共有 ${allPages.length} 个标签页（之前 ${allPagesBefore} 个）`);

    for (const p of allPages) {
      const url = p.url();
      console.log(`  标签页: ${url.substring(0, 80)}`);
      if (url.includes('iptv.cqshushu.com') &&
          (url.includes('p=') || url.includes('index.php')) &&
          !url.includes('eatcells') &&
          !url.includes('faithfuloccasion') &&
          url !== 'about:blank' &&
          p !== page) {
        detailPage = p;
      }
    }

    // 如果没找到新标签页，检查当前页是否已跳转
    if (!detailPage) {
      const currentUrl = page.url();
      if (currentUrl.includes('p=') || currentUrl.includes('detail')) {
        detailPage = page;
        console.log('当前页已跳转到详情页');
      }
    }

    if (!detailPage) {
      // 截图调试
      for (const p of allPages) {
        if (p.url() !== 'about:blank') {
          const content = await p.evaluate(() => document.body?.innerText?.substring(0, 300) || 'empty');
          console.log(`  页面内容: ${content}`);
        }
      }
      throw new Error('未找到详情页');
    }

    // 关闭广告页面
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
    let m3uUrl = null;

    // 先在详情页查找 M3U 链接
    m3uUrl = await detailPage.evaluate(() => {
      const links = document.querySelectorAll('a');
      for (const link of links) {
        const text = link.textContent;
        if (text.includes('M3U') || text.includes('m3u')) {
          let href = link.href;
          if (href && !href.startsWith('http')) href = new URL(href, window.location.origin).href;
          return href;
        }
      }
      return null;
    });

    if (m3uUrl) {
      console.log('详情页直接找到M3U链接:', m3uUrl);
    } else {
      // 查找"查看频道列表"链接
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
        console.log('找到频道列表链接，跳转...');
        await detailPage.goto(channelLink, { waitUntil: 'networkidle2', timeout: 30000 });
        await sleep(3000);

        m3uUrl = await detailPage.evaluate(() => {
          const links = document.querySelectorAll('a');
          for (const link of links) {
            const text = link.textContent;
            if (text.includes('M3U') || text.includes('m3u')) {
              let href = link.href;
              if (href && !href.startsWith('http')) href = new URL(href, window.location.origin).href;
              return href;
            }
          }
          return null;
        });
      }
    }

    if (!m3uUrl) {
      // 最后尝试：直接构造 M3U URL
      const detailUrl = detailPage.url();
      console.log('尝试从详情页URL构造M3U链接...');
      m3uUrl = await detailPage.evaluate(() => {
        // 查找所有链接，看看有没有 m3u 相关的
        const links = Array.from(document.querySelectorAll('a'));
        const allHrefs = links.map(l => l.href).filter(h => h && h.startsWith('http'));
        return allHrefs.join(' | ');
      });
      console.log('页面所有链接:', m3uUrl);
      throw new Error('未找到M3U链接');
    }

    console.log('找到M3U链接:', m3uUrl);

    // 步骤7: 保存到 Cloudflare KV
    console.log('[7/7] 保存到 Cloudflare KV...');
    await saveToCloudflare(m3uUrl, ipInfo.ip);

    console.log('=== 抓取成功 ===');

  } catch (error) {
    console.error('抓取失败:', error.message);

    // 保存错误信息到 Cloudflare
    try {
      await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/last_error`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${CF_API_TOKEN}`,
          'Content-Type': 'text/plain'
        },
        body: new Date().toISOString() + ': ' + error.message
      });
    } catch(e) {
      console.error('保存错误信息失败:', e.message);
    }

    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// 在 Multicast 表格中查找新上线的 IP
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

// 模拟人类行为
async function simulateHuman(page) {
  try {
    const width = 1920, height = 1080;
    for (let i = 0; i < 5; i++) {
      await page.mouse.move(
        Math.random() * width,
        Math.random() * height
      );
      await sleep(200 + Math.random() * 300);
    }
    // 随机滚动
    await page.evaluate(() => {
      window.scrollBy(0, Math.random() * 300);
    });
    await sleep(500);
  } catch(e) {}
}

async function saveToCloudflare(m3uLink, ip) {
  const timestamp = new Date().toISOString();

  console.log('保存到 Cloudflare KV...');

  // KV API: Content-Type 设为 text/plain，直接发送字符串值
  const headers = {
    'Authorization': `Bearer ${CF_API_TOKEN}`,
    'Content-Type': 'text/plain'
  };

  // 保存 M3U 链接
  const r1 = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/m3u_link`, {
    method: 'PUT',
    headers,
    body: m3uLink
  });
  console.log('  m3u_link:', m3uLink, '->', (await r1.json()).success ? 'OK' : 'FAIL');

  // 保存 IP
  const r2 = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/current_ip`, {
    method: 'PUT',
    headers,
    body: ip
  });
  console.log('  current_ip:', ip, '->', (await r2.json()).success ? 'OK' : 'FAIL');

  // 保存更新时间
  const r3 = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/last_update`, {
    method: 'PUT',
    headers,
    body: timestamp
  });
  console.log('  last_update:', timestamp, '->', (await r3.json()).success ? 'OK' : 'FAIL');

  // 清除错误
  await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/last_error`, {
    method: 'PUT',
    headers,
    body: ''
  });

  console.log('Cloudflare KV 更新完成');
}

main().catch(err => {
  console.error('脚本异常:', err);
  process.exit(1);
});
