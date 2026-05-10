/**
 * IPTV M3U 自动抓取脚本 v4
 * 使用 puppeteer-extra + stealth 绕过 Cloudflare
 * 增强调试和多种 IP 导航策略
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const CF_ACCOUNT_ID = '13992e7b764637d462d3cf98f3a20086';
const CF_NAMESPACE_ID = '5a49325bf26b4106a0f497a6403a063d';
const CF_API_TOKEN = process.env.CF_API_TOKEN;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 在浏览器中执行的提取函数（作为字符串注入）
const EXTRACT_IP_FN = `
function extractIPInfo(cells) {
  if (cells.length < 1) return null;
  var link = cells[0].querySelector('a');
  if (!link) return null;
  var ip = link.textContent.trim();
  var onclick = link.getAttribute('onclick') || '';
  var href = link.href || '';
  var m = onclick.match(/gotoIP\\('([^']+)','([^']+)'\\)/);
  var navMethod = 'click', token = null, type = 'multicast';
  if (m) { navMethod = 'gotoIP'; token = m[1]; type = m[2]; }
  else if (href && href.includes('iptv.cqshushu.com') && href !== window.location.href) { navMethod = 'href'; }
  return { ip: ip, token: token, type: type, navMethod: navMethod, href: href, onclick: onclick.substring(0, 100) };
}
`;

async function main() {
  console.log('=== IPTV M3U 抓取开始 ===');
  console.log('时间:', new Date().toISOString());

  let browser;
  try {
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

    console.log('[2/7] 访问首页...');
    await page.goto('https://iptv.cqshushu.com/index.php', {
      waitUntil: 'networkidle2',
      timeout: 90000
    });
    console.log('初始加载完成, URL:', page.url());

    console.log('[3/7] 等待 Cloudflare 验证...');
    await waitForCloudflarePass(page);
    console.log('Cloudflare 验证已通过');

    // 调试：打印表格结构
    console.log('[4/7] 分析表格结构...');
    const tableDebug = await page.evaluate(EXTRACT_IP_FN + `
      var tables = document.querySelectorAll('table');
      if (tables.length < 2) return { error: 'less than 2 tables', count: tables.length };
      var rows = tables[1].querySelectorAll('tbody tr');
      if (rows.length === 0) return { error: 'no rows' };
      var cells = rows[0].querySelectorAll('td');
      var info = [];
      for (var i = 0; i < cells.length; i++) {
        var c = cells[i], link = c.querySelector('a');
        info.push({
          idx: i,
          text: c.textContent.trim().substring(0, 40),
          hasLink: !!link,
          href: link ? link.href.substring(0, 120) : null,
          onclick: link ? (link.getAttribute('onclick') || '').substring(0, 120) : null,
          html: c.innerHTML.substring(0, 150)
        });
      }
      return { rows: rows.length, cols: cells.length, cells: info };
    `);
    console.log('表格结构:', JSON.stringify(tableDebug, null, 2));

    // 查找 IP
    console.log('查找Multicast IP...');
    let ipInfo = await findIP(page);
    if (!ipInfo) throw new Error('未找到可用的Multicast IP');
    console.log(`目标IP: ${ipInfo.ip}, 导航: ${ipInfo.navMethod}, token: ${ipInfo.token}`);

    // 进入详情页
    console.log('[5/7] 进入详情页...');
    let detailPage = await navigateToDetail(page, browser, ipInfo);
    if (!detailPage) throw new Error('未找到详情页');
    console.log('详情页URL:', detailPage.url());
    await sleep(3000);

    // 查找M3U
    console.log('[6/7] 查找M3U链接...');
    let m3uUrl = await findM3ULink(detailPage);
    if (!m3uUrl) throw new Error('未找到M3U链接');
    console.log('M3U链接:', m3uUrl);

    // 保存
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

async function findIP(page) {
  // 查找新上线
  let ipInfo = await page.evaluate(EXTRACT_IP_FN + `
    var tables = document.querySelectorAll('table');
    if (tables.length < 2) return null;
    var rows = tables[1].querySelectorAll('tbody tr');
    for (var i = 0; i < rows.length; i++) {
      var cells = rows[i].querySelectorAll('td');
      if (cells.length >= 6 && cells[5].textContent.trim() === '新上线') {
        return extractIPInfo(cells);
      }
    }
    return null;
  `);
  if (ipInfo) { console.log('找到新上线IP:', ipInfo.ip); return ipInfo; }

  // 翻页查找（最多2页）
  for (let p = 2; p <= 3; p++) {
    console.log(`翻到第 ${p} 页...`);
    const clicked = await page.evaluate((pn) => {
      const links = document.querySelectorAll('a');
      for (const l of links) { if (l.textContent.trim() === String(pn)) { l.click(); return true; } }
      for (const l of links) { if (l.textContent.includes('下一页')) { l.click(); return true; } }
      return false;
    }, p);
    if (!clicked) break;
    await sleep(3000);
    ipInfo = await page.evaluate(EXTRACT_IP_FN + `
      var tables = document.querySelectorAll('table');
      if (tables.length < 2) return null;
      var rows = tables[1].querySelectorAll('tbody tr');
      for (var i = 0; i < rows.length; i++) {
        var cells = rows[i].querySelectorAll('td');
        if (cells.length >= 6 && cells[5].textContent.trim() === '新上线') return extractIPInfo(cells);
      }
      return null;
    `);
    if (ipInfo) { console.log(`第${p}页找到:`, ipInfo.ip); return ipInfo; }
  }

  // 回到第1页用第一个IP
  console.log('使用第一个可用IP...');
  await page.evaluate(() => {
    const links = document.querySelectorAll('a');
    for (const l of links) { if (l.textContent.trim() === '1') { l.click(); return; } }
  });
  await sleep(2000);

  ipInfo = await page.evaluate(EXTRACT_IP_FN + `
    var tables = document.querySelectorAll('table');
    if (tables.length < 2) return null;
    var rows = tables[1].querySelectorAll('tbody tr');
    if (rows.length === 0) return null;
    return extractIPInfo(rows[0].querySelectorAll('td'));
  `);
  if (ipInfo) console.log('使用IP:', ipInfo.ip, '导航:', ipInfo.navMethod);
  return ipInfo;
}

async function navigateToDetail(page, browser, ipInfo) {
  if (ipInfo.navMethod === 'gotoIP' && ipInfo.token) {
    await page.evaluate((token, type) => {
      if (typeof gotoIP === 'function') gotoIP(token, type);
    }, ipInfo.token, ipInfo.type);
    await sleep(8000);
  } else if (ipInfo.navMethod === 'href' && ipInfo.href) {
    console.log('直接导航到:', ipInfo.href);
    await page.goto(ipInfo.href, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(3000);
    const txt = await page.evaluate(() => document.body?.innerText?.substring(0, 100) || '');
    if (txt.includes('请稍候') || txt.includes('验证')) {
      console.log('详情页CF验证...');
      await waitForCloudflarePass(page);
    }
    return page;
  } else {
    // 点击方式
    await page.evaluate((ip) => {
      const tables = document.querySelectorAll('table');
      if (tables.length < 2) return;
      const links = tables[1].querySelectorAll('a');
      for (const l of links) { if (l.textContent.trim() === ip) { l.click(); return; } }
    }, ipInfo.ip);
    await sleep(8000);
  }

  // 查找详情页
  const allPages = await browser.pages();
  for (const p of allPages) {
    const url = p.url();
    if (url.includes('iptv.cqshushu.com') &&
        !url.includes('eatcells') && !url.includes('faithfuloccasion') &&
        url !== 'about:blank' && p !== page) {
      for (const ad of allPages) {
        if (ad.url().includes('eatcells') || ad.url().includes('faithfuloccasion')) {
          try { await ad.close(); } catch(e) {}
        }
      }
      return p;
    }
  }
  if (page.url().includes('p=') || page.url().includes('detail')) return page;
  return null;
}

async function findM3ULink(detailPage) {
  let m3uUrl = await detailPage.evaluate(() => {
    const links = document.querySelectorAll('a');
    for (const l of links) {
      if (l.textContent.includes('M3U') || l.textContent.includes('m3u')) {
        let h = l.href; if (h && !h.startsWith('http')) h = new URL(h, window.location.origin).href;
        return h;
      }
    }
    return null;
  });
  if (m3uUrl) return m3uUrl;

  const channelLink = await detailPage.evaluate(() => {
    const links = document.querySelectorAll('a');
    for (const l of links) { if (l.textContent.includes('查看频道列表') || l.textContent.includes('频道列表')) return l.href; }
    return null;
  });
  if (channelLink) {
    console.log('进入频道列表页...');
    await detailPage.goto(channelLink, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(3000);
    m3uUrl = await detailPage.evaluate(() => {
      const links = document.querySelectorAll('a');
      for (const l of links) {
        if (l.textContent.includes('M3U') || l.textContent.includes('m3u')) {
          let h = l.href; if (h && !h.startsWith('http')) h = new URL(h, window.location.origin).href;
          return h;
        }
      }
      return null;
    });
  }
  return m3uUrl;
}

async function waitForCloudflarePass(page) {
  for (let i = 0; i < 30; i++) {
    const info = await page.evaluate(() => ({
      text: document.body?.innerText?.substring(0, 100) || '',
      tables: document.querySelectorAll('table').length
    }));
    if (info.tables >= 2) return true;
    if (info.text.includes('请稍候') || info.text.includes('Just a moment') || info.text.includes('Checking')) {
      if (i % 5 === 0) console.log(`  CF验证中... (${i+1}/30)`);
      await sleep(3000);
      await simulateHuman(page);
      continue;
    }
    await sleep(2000);
  }
  const info = await page.evaluate(() => ({ tables: document.querySelectorAll('table').length, text: document.body?.innerText?.substring(0, 200) || '' }));
  if (info.tables >= 2) return true;
  throw new Error('CF验证超时: ' + info.text.substring(0, 100));
}

async function simulateHuman(page) {
  try {
    for (let i = 0; i < 3; i++) { await page.mouse.move(Math.random()*1920, Math.random()*1080); await sleep(200); }
    await page.evaluate(() => window.scrollBy(0, Math.random()*200));
  } catch(e) {}
}

async function saveToCloudflare(m3uLink, ip) {
  const ts = new Date().toISOString();
  const h = { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'text/plain' };
  const base = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/`;
  for (const [k, v] of [['m3u_link', m3uLink], ['current_ip', ip], ['last_update', ts], ['last_error', '']]) {
    const r = await fetch(base + k, { method: 'PUT', headers: h, body: v });
    console.log(`  ${k}: ${(await r.json()).success ? 'OK' : 'FAIL'}`);
  }
}

main().catch(err => { console.error('异常:', err); process.exit(1); });
