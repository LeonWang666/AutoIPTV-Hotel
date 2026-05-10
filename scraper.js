/**
 * IPTV TXT 接口自动抓取脚本 v12
 * 
 * 核心改进：token是session绑定的，必须在同一Puppeteer session中获取token并立即访问TXT
 * 流程：首页获取token → 同一page导航到TXT → 保存完整TXT内容到KV
 * Workers直接返回KV中的txt_content（纯文本频道列表）
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const CF_ACCOUNT_ID = '13992e7b764637d462d3cf98f3a20086';
const CF_NAMESPACE_ID = '5a49325bf26b4106a0f497a6403a063d';
const CF_API_TOKEN = process.env.CF_API_TOKEN;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('=== IPTV TXT 接口抓取 v12 ===');
  console.log('时间:', new Date().toISOString());

  if (!CF_API_TOKEN) {
    console.error('错误: 缺少 CF_API_TOKEN 环境变量');
    process.exit(1);
  }

  let browser;
  try {
    console.log('[1/5] 启动浏览器...');
    browser = await puppeteer.launch({
      headless: 'new',
      protocolTimeout: 180000,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080'
      ]
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

    // 提取所有Multicast IP的token和频道数
    console.log('提取所有Multicast IP信息...');
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
        const m = onclick.match(/gotoIP\(['"]([^'"]+)['"],\s*['"]([^'"]+)['"]\)/) ||
                  onclick.match(/gotoIP\(([^,]+),\s*([^)]+)\)/);
        if (m) {
          const status = cells.length >= 6 ? cells[5].textContent.trim() : '';
          const channelNum = cells.length >= 2 ? parseInt(cells[1].textContent.trim()) || 0 : 0;
          const type = cells.length >= 3 ? cells[2].textContent.trim() : '';
          results.push({ ip, token: m[1], status, channelNum, region: type });
        }
      }
      return results;
    });
    console.log(`提取到 ${allTokens.length} 个Multicast IP`);

    // 过滤有效IP（非"暂时失效"，有token，有频道数）
    const validIPs = allTokens.filter(ip =>
      ip.status !== '暂时失效' && ip.token && ip.channelNum > 0
    ).sort((a, b) => b.channelNum - a.channelNum); // 按频道数降序
    console.log(`有效IP(有频道): ${validIPs.length} 个`);
    for (const ip of validIPs.slice(0, 5)) {
      console.log(`  ${ip.ip}: ${ip.channelNum}个频道, ${ip.status}, ${ip.region}`);
    }

    // 关键：在同一session中逐个访问TXT页面，获取实际频道内容
    console.log('[4/5] 在同一session中获取TXT内容...');
    let bestContent = null;
    let bestCount = 0;
    let bestIP = '';

    for (let i = 0; i < validIPs.length && i < 5; i++) {
      const ip = validIPs[i];
      const txtUrl = `https://iptv.cqshushu.com/index.php?s=${ip.token}&t=multicast&channels=1&format=txt`;
      console.log(`\n尝试 ${i + 1}/${Math.min(validIPs.length, 5)}: ${ip.ip} (${ip.channelNum}个频道)`);
      console.log(`  URL: ${txtUrl.substring(0, 80)}...`);

      try {
        // 在同一page中导航到TXT页面（保持session/cookie）
        const resp = await page.goto(txtUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(2000); // 等待内容加载

        // 获取页面文本内容
        const txtContent = await page.evaluate(() => document.body?.innerText || '');
        const lines = txtContent.split('\n').filter(l => l.trim() && !l.startsWith('#'));
        const channelCount = lines.length;

        console.log(`  响应状态: ${resp ? resp.status() : 'N/A'}`);
        console.log(`  内容前100字符: ${txtContent.substring(0, 100)}`);
        console.log(`  频道行数: ${channelCount}`);

        // 检查是否有实际频道内容（非0）
        if (channelCount > 0 && txtContent.includes('http')) {
          console.log(`  ✅ 获取到 ${channelCount} 个频道!`);
          if (channelCount > bestCount) {
            bestContent = txtContent;
            bestCount = channelCount;
            bestIP = ip.ip;
          }
          // 找到好的内容就可以停止了
          if (channelCount >= 100) {
            console.log('  频道数足够，停止尝试');
            break;
          }
        } else {
          console.log(`  ❌ 无有效频道内容`);
        }

        // 如果还有下一个IP要试，需要回到首页重新获取token
        if (i < validIPs.length - 1 && i < 4) {
          console.log('  返回首页重新获取token...');
          await page.goto('https://iptv.cqshushu.com/index.php', {
            waitUntil: 'networkidle2', timeout: 60000
          });
          await waitForCF(page);

          // 重新提取token
          const newTokens = await page.evaluate(() => {
            const tables = document.querySelectorAll('table');
            if (tables.length < 2) return [];
            const rows = tables[1].querySelectorAll('tbody tr');
            const results = [];
            for (let i = 0; i < rows.length; i++) {
              const cells = rows[i].querySelectorAll('td');
              if (cells.length < 1) continue;
              const a = cells[0].querySelector('a');
              if (!a) continue;
              const onclick = a.getAttribute('onclick') || '';
              const m = onclick.match(/gotoIP\(['"]([^'"]+)['"],\s*['"]([^'"]+)['"]\)/) ||
                        onclick.match(/gotoIP\(([^,]+),\s*([^)]+)\)/);
              if (m) {
                const status = cells.length >= 6 ? cells[5].textContent.trim() : '';
                const channelNum = cells.length >= 2 ? parseInt(cells[1].textContent.trim()) || 0 : 0;
                results.push({ token: m[1], status, channelNum });
              }
            }
            return results;
          });

          // 更新后续IP的token
          const validNew = newTokens.filter(t => t.status !== '暂时失效' && t.token && t.channelNum > 0);
          for (let j = i + 1; j < validIPs.length && j - i - 1 < validNew.length; j++) {
            validIPs[j].token = validNew[j - i - 1].token;
          }
          console.log(`  重新获取了 ${validNew.length} 个有效token`);
        }
      } catch (err) {
        console.log(`  ❌ 访问失败: ${err.message}`);
      }
    }

    // 保存到KV
    console.log('\n[5/5] 保存到KV...');
    const ts = new Date().toISOString();
    const h = { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'text/plain' };
    const base = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/`;

    if (bestContent && bestCount > 0) {
      // 保存TXT内容（这是APP需要的核心数据）
      const r1 = await fetch(base + 'txt_content', { method: 'PUT', headers: h, body: bestContent });
      console.log(`  txt_content (${bestContent.length}字节, ${bestCount}频道): ${(await r1.json()).success ? 'OK' : 'FAIL'}`);

      // 保存元数据
      const meta = [
        ['last_update', ts],
        ['channel_count', String(bestCount)],
        ['current_ip', bestIP],
        ['total_ips', String(validIPs.length)],
        ['last_error', ''],
        ['scrape_version', 'v12']
      ];
      for (const [k, v] of meta) {
        const r = await fetch(base + k, { method: 'PUT', headers: h, body: v });
        console.log(`  ${k}: ${(await r.json()).success ? 'OK' : 'FAIL'}`);
      }

      console.log(`\n=== 成功! 获取 ${bestCount} 个频道, 来源IP: ${bestIP} ===`);
    } else {
      // 没有获取到内容
      console.log('  ⚠️ 未能获取到任何频道内容');
      const meta = [
        ['last_update', ts],
        ['channel_count', '0'],
        ['current_ip', ''],
        ['last_error', ts + ': 所有IP均返回0频道 - 可能是地理限制或token过期'],
        ['scrape_version', 'v12']
      ];
      for (const [k, v] of meta) {
        await fetch(base + k, { method: 'PUT', headers: h, body: v });
      }
      console.log('=== 失败: 0频道 ===');
      // 不退出1，让workflow显示成功但记录错误
    }

  } catch (error) {
    console.error('抓取失败:', error.message);
    console.error(error.stack);
    try {
      const h = { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'text/plain' };
      await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/last_error`, {
        method: 'PUT', headers: h,
        body: new Date().toISOString() + ': ' + error.message
      });
    } catch (e) { }
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
}

async function waitForCF(page) {
  for (let i = 0; i < 30; i++) {
    const info = await page.evaluate(() => ({
      t: document.body?.innerText?.substring(0, 100) || '',
      n: document.querySelectorAll('table').length
    }));
    if (info.n >= 2) return;
    if (info.t.includes('请稍候') || info.t.includes('Just a moment') || info.t.includes('Checking')) {
      if (i % 5 === 0) console.log(`  CF验证... (${i + 1}/30)`);
      await sleep(3000);
      try {
        for (let j = 0; j < 3; j++) {
          await page.mouse.move(Math.random() * 1920, Math.random() * 1080);
          await sleep(200);
        }
        await page.evaluate(() => window.scrollBy(0, Math.random() * 200));
      } catch (e) { }
      continue;
    }
    await sleep(2000);
  }
  const info = await page.evaluate(() => ({
    n: document.querySelectorAll('table').length,
    t: document.body?.innerText?.substring(0, 200) || ''
  }));
  if (info.n >= 2) return;
  throw new Error('CF验证超时: ' + info.t.substring(0, 100));
}

main().catch(e => { console.error('异常:', e); process.exit(1); });
