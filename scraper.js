/**
 * IPTV TXT 接口自动抓取脚本 v6
 * puppeteer-extra + stealth 绕过 Cloudflare
 * 直接从首页获取token，构造TXT接口链接
 * 用Puppeteer访问TXT链接验证内容包含频道地址
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const CF_ACCOUNT_ID = '13992e7b764637d462d3cf98f3a20086';
const CF_NAMESPACE_ID = '5a49325bf26b4106a0f497a6403a063d';
const CF_API_TOKEN = process.env.CF_API_TOKEN;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('=== IPTV TXT 接口抓取开始 ===');
  console.log('时间:', new Date().toISOString());

  let browser;
  try {
    console.log('[1/6] 启动浏览器...');
    browser = await puppeteer.launch({
      headless: 'new',
      protocolTimeout: 180000,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-blink-features=AutomationControlled','--window-size=1920,1080']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });
    page.setDefaultTimeout(90000);

    console.log('[2/6] 访问首页...');
    await page.goto('https://iptv.cqshushu.com/index.php', { waitUntil: 'networkidle2', timeout: 90000 });
    console.log('加载完成, URL:', page.url());

    console.log('[3/6] 等待 Cloudflare 验证...');
    await waitForCF(page);
    console.log('CF 验证已通过');

    // 查找IP和token
    console.log('[4/6] 查找新上线IP...');
    let ipInfo = await findIP(page);
    if (!ipInfo) throw new Error('未找到可用IP');
    console.log(`目标: ${ipInfo.ip}, token: ${ipInfo.token}, 状态: ${ipInfo.status}`);

    // 构造TXT链接
    // 格式: http://iptv.cqshushu.com/index.php?s=<token>&t=multicast&channels=1&format=txt
    if (!ipInfo.token) throw new Error('未获取到token，无法构造TXT链接');
    const txtUrl = `http://iptv.cqshushu.com/index.php?s=${ipInfo.token}&t=multicast&channels=1&format=txt`;
    console.log('[5/6] 构造TXT链接:', txtUrl);

    // 用Puppeteer访问TXT链接验证内容
    console.log('验证TXT链接内容...');
    const txtPage = await browser.newPage();
    await txtPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
    
    try {
      await txtPage.goto(txtUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    } catch(e) {
      // networkidle2可能超时，但内容可能已加载
      console.log('页面加载超时，尝试继续...');
    }
    
    await sleep(3000);
    
    const txtContent = await txtPage.evaluate(() => document.body?.innerText || '');
    console.log('TXT内容长度:', txtContent.length);
    console.log('TXT前200字符:', txtContent.substring(0, 200));
    
    // 验证内容是否包含频道地址格式
    const channelPattern = /http:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+\/rtp\//;
    const channelCount = (txtContent.match(/http:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+/g) || []).length;
    console.log('频道地址数量:', channelCount);
    
    if (channelCount === 0) {
      console.log('警告: TXT内容未检测到频道地址，内容:', txtContent.substring(0, 500));
      // 不抛错，仍然保存链接（可能是网络问题导致内容未加载）
    }
    
    await txtPage.close();

    // 保存KV
    console.log('[6/6] 保存KV...');
    await saveKV(txtUrl, ipInfo.ip, channelCount);
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

// 提取IP信息的浏览器函数
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

async function saveKV(txtUrl, ip, channelCount) {
  const ts = new Date().toISOString();
  const h = { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'text/plain' };
  const base = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/`;
  const entries = [
    ['txt_link', txtUrl],
    ['current_ip', ip],
    ['last_update', ts],
    ['channel_count', String(channelCount)],
    ['last_error', '']
  ];
  for (const [k,v] of entries) {
    const r = await fetch(base+k, { method:'PUT', headers:h, body:v });
    console.log(`  ${k}: ${(await r.json()).success?'OK':'FAIL'}`);
  }
}

main().catch(e => { console.error('异常:',e); process.exit(1); });
