/**
 * IPTV M3U 自动抓取脚本 v5
 * puppeteer-extra + stealth 绕过 Cloudflare
 * 修复 evaluate 作用域问题
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const CF_ACCOUNT_ID = '13992e7b764637d462d3cf98f3a20086';
const CF_NAMESPACE_ID = '5a49325bf26b4106a0f497a6403a063d';
const CF_API_TOKEN = process.env.CF_API_TOKEN;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('=== IPTV M3U 抓取开始 ===');
  console.log('时间:', new Date().toISOString());

  let browser;
  try {
    console.log('[1/7] 启动浏览器...');
    browser = await puppeteer.launch({
      headless: 'new',
      protocolTimeout: 180000,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-blink-features=AutomationControlled','--window-size=1920,1080']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });
    page.setDefaultTimeout(90000);

    console.log('[2/7] 访问首页...');
    await page.goto('https://iptv.cqshushu.com/index.php', { waitUntil: 'networkidle2', timeout: 90000 });
    console.log('加载完成, URL:', page.url());

    console.log('[3/7] 等待 Cloudflare 验证...');
    await waitForCF(page);
    console.log('CF 验证已通过');

    // 分析表格
    console.log('[4/7] 分析表格...');
    const debug = await page.evaluate(() => {
      const tables = document.querySelectorAll('table');
      if (tables.length < 2) return { error: 'tables<2', count: tables.length };
      const rows = tables[1].querySelectorAll('tbody tr');
      if (!rows.length) return { error: 'no rows' };
      const cells = rows[0].querySelectorAll('td');
      const info = [];
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i], a = c.querySelector('a');
        info.push({ i, text: c.textContent.trim().substring(0,40), hasA: !!a, href: a?a.href.substring(0,120):null, onclick: a?(a.getAttribute('onclick')||'').substring(0,120):null, html: c.innerHTML.substring(0,150) });
      }
      return { rows: rows.length, cols: cells.length, cells: info };
    });
    console.log('表格:', JSON.stringify(debug, null, 2));

    // 查找IP
    console.log('查找IP...');
    let ipInfo = await findIP(page);
    if (!ipInfo) throw new Error('未找到可用IP');
    console.log(`目标: ${ipInfo.ip}, 方式: ${ipInfo.nav}, token: ${ipInfo.token}`);

    // 进入详情页
    console.log('[5/7] 进入详情页...');
    let dp = await gotoDetail(page, browser, ipInfo);
    if (!dp) throw new Error('未找到详情页');
    console.log('详情URL:', dp.url());
    await sleep(3000);

    // 查找M3U（需要 browser 来管理多标签页）
    console.log('[6/7] 查找M3U...');
    let m3u = await findM3U(dp, browser);
    if (!m3u) throw new Error('未找到M3U链接');
    console.log('M3U:', m3u);

    // 保存KV
    console.log('[7/7] 保存KV...');
    await saveKV(m3u, ipInfo.ip);
    console.log('=== 成功 ===');

  } catch (error) {
    console.error('失败:', error.message);
    try {
      await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/last_error`, {
        method: 'PUT', headers: { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'text/plain' },
        body: new Date().toISOString() + ': ' + error.message
      });
    } catch(e) {}
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
}

// 提取IP信息的浏览器函数（参数通过 evaluate 传入）
function extractIPCode(filterNewOnline) {
  return (filter) => {
    const tables = document.querySelectorAll('table');
    if (tables.length < 2) return null;
    const rows = tables[1].querySelectorAll('tbody tr');
    for (let i = 0; i < rows.length; i++) {
      const cells = rows[i].querySelectorAll('td');
      if (cells.length < 1) continue;
      if (filter && (cells.length < 6 || cells[5].textContent.trim() !== '新上线')) continue;
      const a = cells[0].querySelector('a');
      if (!a) continue;
      const ip = a.textContent.trim();
      const onclick = a.getAttribute('onclick') || '';
      const href = a.href || '';
      const m = onclick.match(/gotoIP\(['"]([^'"]+)['"],\s*['"]([^'"]+)['"]\)/) || onclick.match(/gotoIP\(([^,]+),\s*([^)]+)\)/);
      let nav = 'click', token = null, type = 'multicast';
      if (m) { nav = 'gotoIP'; token = m[1]; type = m[2]; }
      else if (href && href.includes('iptv.cqshushu.com') && href !== window.location.href) { nav = 'href'; }
      return { ip, token, type, nav, href, onclick: onclick.substring(0,200), status: cells.length >= 6 ? cells[5].textContent.trim() : '' };
    }
    return null;
  };
}

async function findIP(page) {
  // 找新上线
  let info = await page.evaluate(extractIPCode(true), true);
  if (info) { console.log('找到新上线:', info.ip); return info; }

  // 翻页
  for (let p = 2; p <= 3; p++) {
    console.log(`翻第${p}页...`);
    const clicked = await page.evaluate((pn) => {
      for (const l of document.querySelectorAll('a')) { if (l.textContent.trim() === String(pn)) { l.click(); return true; } }
      for (const l of document.querySelectorAll('a')) { if (l.textContent.includes('下一页')) { l.click(); return true; } }
      return false;
    }, p);
    if (!clicked) break;
    await sleep(3000);
    info = await page.evaluate(extractIPCode(true), true);
    if (info) { console.log(`第${p}页找到:`, info.ip); return info; }
  }

  // 回第1页取第一个
  console.log('用第一个IP...');
  await page.evaluate(() => { for (const l of document.querySelectorAll('a')) { if (l.textContent.trim() === '1') { l.click(); return; } } });
  await sleep(2000);
  info = await page.evaluate(extractIPCode(false), false);
  if (info) console.log('使用:', info.ip, info.nav, 'status:', info.status);
  return info;
}

async function gotoDetail(page, browser, ipInfo) {
  // 策略：直接用 Puppeteer 点击链接（而不是 evaluate 调用 gotoIP）
  // 这样浏览器会认为是真实用户点击，允许打开新标签页
  console.log('模拟点击IP链接...');
  
  const linkSelector = 'table:nth-child(2) a.ip-link, table:nth-of-type(2) a.ip-link';
  
  // 找到目标链接并点击
  const clicked = await page.evaluateHandle((ip) => {
    const tables = document.querySelectorAll('table');
    if (tables.length < 2) return null;
    const links = tables[1].querySelectorAll('a');
    for (const l of links) {
      if (l.textContent.trim() === ip) return l;
    }
    return null;
  }, ipInfo.ip);
  
  if (clicked) {
    // 使用 Puppeteer 的 click 方法（模拟真实点击）
    await clicked.click();
    console.log('已点击链接');
  } else {
    // fallback: 用 evaluate 调用 gotoIP
    console.log('链接未找到，使用 gotoIP...');
    await page.evaluate((t, ty) => { if (typeof gotoIP === 'function') gotoIP(t, ty); }, ipInfo.token, ipInfo.type);
  }

  // 等待新标签页打开
  console.log('等待新标签页...');
  for (let w = 0; w < 8; w++) {
    await sleep(3000);
    const pages = await browser.pages();
    console.log(`  ${w+1}/8: ${pages.length} 个标签页`);
    for (const p of pages) {
      const u = p.url();
      if (u !== 'about:blank') console.log(`    ${u.substring(0, 120)}`);
    }
    // 查找详情页（非首页、非广告）
    for (const p of pages) {
      const u = p.url();
      if (u.includes('iptv.cqshushu.com') && 
          !u.includes('eatcells') && !u.includes('faithfuloccasion') && 
          u !== 'about:blank' && 
          !u.includes('_js=1') &&  // 排除首页（_js=1 是首页标志）
          p !== page) {
        for (const ad of pages) { if (ad.url().includes('eatcells') || ad.url().includes('faithfuloccasion')) { try { await ad.close(); } catch(e){} } }
        return p;
      }
    }
    // 也检查当前页是否已跳转
    const curUrl = page.url();
    if (!curUrl.includes('_js=1') && curUrl.includes('iptv.cqshushu.com') && curUrl.includes('p=')) {
      return page;
    }
  }
  return null;
}

async function findM3U(dp, browser) {
  console.log('在详情页查找M3U相关信息...');
  
  // 先打印详情页完整内容用于分析
  const detailHtml = await dp.evaluate(() => document.documentElement.innerHTML);
  console.log('详情页HTML长度:', detailHtml.length);
  
  // 查找所有包含 M3U 或 m3u 的内容
  const m3uMatches = detailHtml.match(/m3u[^"'<>\s]*/gi);
  if (m3uMatches) {
    console.log('找到M3U相关:', m3uMatches.slice(0, 10));
  }
  
  // 查找所有 onclick 中包含 copy 的内容（可能是复制M3U链接）
  const copyMatches = detailHtml.match(/copy\(['"]([^'"]+)['"]\)/gi);
  if (copyMatches) {
    console.log('找到copy函数:', copyMatches.slice(0, 5));
    // 提取第一个copy的参数作为M3U链接
    const firstMatch = copyMatches[0].match(/copy\(['"]([^'"]+)['"]\)/);
    if (firstMatch) {
      console.log('从copy提取M3U:', firstMatch[1]);
      return firstMatch[1];
    }
  }
  
  // 查找所有 href 中包含 http 的链接
  const httpMatches = detailHtml.match(/href=["'](https?:\/\/[^"']+)["']/gi);
  if (httpMatches) {
    console.log('找到http链接:', httpMatches.slice(0, 5));
    for (const match of httpMatches) {
      const url = match.replace(/href=["']/, '').replace(/["']$/, '');
      if (url.includes('m3u') || url.includes('M3U')) {
        console.log('找到M3U链接:', url);
        return url;
      }
    }
  }
  
  // 查找详情页中的 IP:端口信息，构造可能的M3U URL
  const ipPortMatch = detailHtml.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{4,5})/);
  if (ipPortMatch) {
    const ipPort = ipPortMatch[1];
    console.log('找到IP端口:', ipPort);
    
    // 尝试构造常见的M3U路径
    const possibleUrls = [
      `http://${ipPort}/`,
      `http://${ipPort}/playlist.m3u`,
      `http://${ipPort}/channels.m3u`,
      `http://${ipPort}/list.m3u`,
      `http://${ipPort}/tv.m3u`,
    ];
    
    // 返回第一个作为候选
    console.log('可能的M3U地址:', possibleUrls[0]);
    return possibleUrls[0];
  }
  
  console.log('未找到M3U链接');
  return null;
}

async function waitForCF(page) {
  for (let i = 0; i < 30; i++) {
    const info = await page.evaluate(() => ({ t: document.body?.innerText?.substring(0,100)||'', n: document.querySelectorAll('table').length }));
    if (info.n >= 2) return;
    if (info.t.includes('请稍候') || info.t.includes('Just a moment') || info.t.includes('Checking')) {
      if (i%5===0) console.log(`  CF验证... (${i+1}/30)`);
      await sleep(3000);
      try { for (let j=0;j<3;j++) { await page.mouse.move(Math.random()*1920,Math.random()*1080); await sleep(200); } await page.evaluate(()=>window.scrollBy(0,Math.random()*200)); } catch(e){}
      continue;
    }
    await sleep(2000);
  }
  const info = await page.evaluate(() => ({ n: document.querySelectorAll('table').length, t: document.body?.innerText?.substring(0,200)||'' }));
  if (info.n >= 2) return;
  throw new Error('CF验证超时: ' + info.t.substring(0,100));
}

async function saveKV(m3u, ip) {
  const ts = new Date().toISOString();
  const h = { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'text/plain' };
  const base = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/`;
  for (const [k,v] of [['m3u_link',m3u],['current_ip',ip],['last_update',ts],['last_error','']]) {
    const r = await fetch(base+k, { method:'PUT', headers:h, body:v });
    console.log(`  ${k}: ${(await r.json()).success?'OK':'FAIL'}`);
  }
}

main().catch(e => { console.error('异常:',e); process.exit(1); });
