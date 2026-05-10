/**
 * IPTV TXT 接口自动抓取脚本 v9
 * puppeteer-extra + stealth 绕过 Cloudflare
 * 从首页获取所有Multicast IP的token，选择节目数最多的新上线IP
 * 直接构造TXT链接保存（不验证TXT内容，因为GitHub Actions服务器可能无法访问组播源）
 * 用户在自己网络环境下打开TXT链接即可获取频道列表
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
    console.log('[1/4] 启动浏览器...');
    browser = await puppeteer.launch({
      headless: 'new',
      protocolTimeout: 180000,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-blink-features=AutomationControlled','--window-size=1920,1080']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });
    page.setDefaultTimeout(90000);

    console.log('[2/4] 访问首页...');
    await page.goto('https://iptv.cqshushu.com/index.php', { waitUntil: 'networkidle2', timeout: 90000 });
    console.log('加载完成, URL:', page.url());

    console.log('[3/4] 等待 Cloudflare 验证...');
    await waitForCF(page);
    console.log('CF 验证已通过');

    // 收集所有Multicast IP的token
    console.log('提取所有Multicast IP token...');
    const allTokens = await page.evaluate(() => {
      const tables = document.querySelectorAll('table');
      if (tables.length < 2) return [];
      // 第二个表格是Multicast IP
      const rows = tables[1].querySelectorAll('tbody tr');
      const results = [];
      for (let i = 0; i < rows.length; i++) {
        const cells = rows[i].querySelectorAll('td');
        if (cells.length < 1) continue;
        const a = cells[0].querySelector('a');
        if (!a) continue;
        const ip = a.textContent.trim();
        const onclick = a.getAttribute('onclick') || '';
        const m = onclick.match(/gotoIP\(['"]([^'"]+)['"],\s*['"]([^'"]+)['"]\)/) || onclick.match(/gotoIP\(([^,]+),\s*([^)]+)\)/);
        if (m) {
          const status = cells.length >= 6 ? cells[5].textContent.trim() : '';
          const channelNum = cells.length >= 2 ? parseInt(cells[1].textContent.trim()) || 0 : 0;
          const type = cells.length >= 3 ? cells[2].textContent.trim() : '';
          results.push({ ip, token: m[1], type: m[2], status, channelNum, region: type });
        }
      }
      return results;
    });
    console.log(`提取到 ${allTokens.length} 个Multicast IP`);

    // 排序：排除暂时失效，新上线优先，频道数多的优先
    allTokens.sort((a, b) => {
      if (a.status === '暂时失效' && b.status !== '暂时失效') return 1;
      if (a.status !== '暂时失效' && b.status === '暂时失效') return -1;
      if (a.status === '新上线' && b.status !== '新上线') return -1;
      if (a.status !== '新上线' && b.status === '新上线') return 1;
      return b.channelNum - a.channelNum;
    });

    // 选择最佳IP（新上线 + 频道数最多）
    const best = allTokens[0];
    if (!best || !best.token) throw new Error('未找到有效IP');

    const txtUrl = `http://iptv.cqshushu.com/index.php?s=${best.token}&t=multicast&channels=1&format=txt`;
    console.log(`选中: ${best.ip} (${best.region}, ${best.status}, ${best.channelNum}个节目)`);
    console.log(`TXT链接: ${txtUrl}`);

    // 保存KV
    console.log('[4/4] 保存KV...');
    await saveKV(txtUrl, best.ip, best.channelNum, best.region, best.status);
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

async function saveKV(txtUrl, ip, channelNum, region, status) {
  const ts = new Date().toISOString();
  const h = { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'text/plain' };
  const base = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/`;
  const entries = [
    ['txt_link', txtUrl],
    ['current_ip', ip],
    ['last_update', ts],
    ['channel_count', String(channelNum)],
    ['region', region || ''],
    ['ip_status', status || ''],
    ['last_error', '']
  ];
  for (const [k,v] of entries) {
    const r = await fetch(base+k, { method:'PUT', headers:h, body:v });
    console.log(`  ${k}: ${(await r.json()).success?'OK':'FAIL'}`);
  }
}

main().catch(e => { console.error('异常:',e); process.exit(1); });
