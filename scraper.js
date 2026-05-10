/**
 * IPTV TXT 接口自动抓取脚本 v10
 * puppeteer-extra + stealth 绕过 Cloudflare
 * 从首页获取token → 在同一浏览器中访问TXT链接 → 抓取完整TXT内容保存到KV
 * Workers直接返回KV中的txt_content，用户APP获取到完整频道列表
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
    console.log('[1/5] 启动浏览器...');
    browser = await puppeteer.launch({
      headless: 'new',
      protocolTimeout: 180000,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-blink-features=AutomationControlled','--window-size=1920,1080']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });
    page.setDefaultTimeout(90000);

    console.log('[2/5] 访问首页...');
    await page.goto('https://iptv.cqshushu.com/index.php', { waitUntil: 'networkidle2', timeout: 90000 });
    console.log('加载完成, URL:', page.url());

    console.log('[3/5] 等待 Cloudflare 验证...');
    await waitForCF(page);
    console.log('CF 验证已通过');

    // 收集所有Multicast IP的token
    console.log('提取所有Multicast IP token...');
    const allTokens = await page.evaluate(() => {
      const tables = document.querySelectorAll('table');
      if (tables.length < 2) return [];
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

    // 逐个尝试，找到能获取到TXT内容的IP
    console.log('[4/5] 验证TXT内容...');
    let bestResult = null;

    for (let i = 0; i < Math.min(allTokens.length, 5); i++) {
      const ipInfo = allTokens[i];
      if (!ipInfo.token) continue;

      const txtUrl = `http://iptv.cqshushu.com/index.php?s=${ipInfo.token}&t=multicast&channels=1&format=txt`;
      console.log(`  #${i+1} ${ipInfo.ip} (${ipInfo.status}, 表格${ipInfo.channelNum}个): 访问TXT...`);

      // 在同一page中导航到TXT链接（保持CF cookie）
      try {
        await page.goto(txtUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch(e) {
        console.log('    加载超时，继续...');
      }
      await sleep(3000);

      // 获取页面文本内容
      const txtContent = await page.evaluate(() => document.body?.innerText || '');
      console.log(`    内容长度: ${txtContent.length}`);

      // 检查是否有频道数据
      const urlMatches = txtContent.match(/http:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+/g) || [];
      const countMatch = txtContent.match(/#节目数量[：:]\s*(\d+)/);
      const declaredCount = countMatch ? parseInt(countMatch[1]) : 0;
      const actualCount = urlMatches.length;
      const channelCount = Math.max(declaredCount, actualCount);

      console.log(`    声明: ${declaredCount}, 实际URL: ${actualCount}`);

      if (channelCount > 0) {
        bestResult = {
          txtUrl,
          ip: ipInfo.ip,
          channelCount,
          region: ipInfo.region,
          status: ipInfo.status,
          txtContent: txtContent  // 保存完整TXT内容
        };
        console.log(`    ✅ 找到有效内容: ${channelCount} 个频道`);
        break;
      } else {
        console.log('    ❌ 0频道，跳过');
      }

      // 回首页尝试下一个
      try {
        await page.goto('https://iptv.cqshushu.com/index.php', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await sleep(2000);
        await waitForCF(page);
      } catch(e) {
        console.log('    回首页失败，停止尝试');
        break;
      }
    }

    if (!bestResult) {
      // 所有IP都返回0频道，使用频道数最多的IP的TXT链接（用户本地网络可能能访问）
      const fallback = allTokens.find(ip => ip.status !== '暂时失效' && ip.channelNum > 0);
      if (fallback) {
        const txtUrl = `http://iptv.cqshushu.com/index.php?s=${fallback.token}&t=multicast&channels=1&format=txt`;
        bestResult = {
          txtUrl,
          ip: fallback.ip,
          channelCount: 0,
          region: fallback.region,
          status: fallback.status,
          txtContent: ''  // 空内容，Workers会做重定向
        };
        console.log('警告: 所有IP返回0频道，使用fallback:', fallback.ip);
      } else {
        throw new Error('所有IP均无有效频道');
      }
    }

    console.log(`最终: ${bestResult.ip}, ${bestResult.channelCount}频道`);
    console.log(`TXT内容长度: ${bestResult.txtContent.length}`);

    // 保存KV
    console.log('[5/5] 保存KV...');
    await saveKV(bestResult);
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

async function saveKV(result) {
  const ts = new Date().toISOString();
  const h = { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'text/plain' };
  const base = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/`;

  // 保存TXT内容（如果有的话）
  if (result.txtContent && result.txtContent.length > 10) {
    const r = await fetch(base + 'txt_content', { method:'PUT', headers:h, body: result.txtContent });
    console.log(`  txt_content (${result.txtContent.length}字节): ${(await r.json()).success?'OK':'FAIL'}`);
  } else {
    // 清空旧内容
    await fetch(base + 'txt_content', { method:'PUT', headers:h, body: '' });
    console.log('  txt_content: 已清空（无有效内容）');
  }

  const entries = [
    ['txt_link', result.txtUrl],
    ['current_ip', result.ip],
    ['last_update', ts],
    ['channel_count', String(result.channelCount)],
    ['region', result.region || ''],
    ['ip_status', result.status || ''],
    ['last_error', '']
  ];
  for (const [k,v] of entries) {
    const r = await fetch(base+k, { method:'PUT', headers:h, body:v });
    console.log(`  ${k}: ${(await r.json()).success?'OK':'FAIL'}`);
  }
}

main().catch(e => { console.error('异常:',e); process.exit(1); });
