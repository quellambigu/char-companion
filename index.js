// SillyTavern Server Plugin: Char Companion (Proactive Message Pusher)
// 放置路径: <SillyTavern根目录>/plugins/char-companion/
//
// 功能:
//   1. 主动消息推送 — Bark(iOS,原生支持头像) / 可扩展其他渠道
//   2. 双模式调度: 间隔模式 / 每天固定时间点
//   3. 读取角色卡人设 + 世界书(条目可选)
//   4. 环境感知: 自动注入当前时间/日期/星期 + 天气(用户填城市名即可)
//   5. 独立 API 配置(与酒馆聊天用的接口分开)

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const PLUGIN_ID = 'char-companion';
let dataDir = null;
let scheduler = null;
let profilesCache = {};

// ===== 工具函数 =====

function getConfigPath() { return path.join(dataDir, 'profiles.json'); }

function loadProfiles() {
  try { profilesCache = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8')); }
  catch (e) { profilesCache = {}; }
  return profilesCache;
}

function saveProfiles(profiles) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify(profiles, null, 2), 'utf-8');
  profilesCache = profiles;
}

function buildPersonaText(charData) {
  const parts = [];
  if (charData.name) parts.push(`角色名: ${charData.name}`);
  if (charData.description) parts.push(`人设描述: ${charData.description}`);
  if (charData.personality) parts.push(`性格: ${charData.personality}`);
  if (charData.scenario) parts.push(`场景设定: ${charData.scenario}`);
  if (charData.mes_example) parts.push(`对话示例: ${charData.mes_example}`);
  return parts.join('\n');
}

function buildUserPersonaText(persona) {
  if (!persona) return '';
  const parts = [];
  if (persona.name) parts.push(`用户的名字/身份: ${persona.name}`);
  if (persona.description) parts.push(`用户人设描述: ${persona.description}`);
  return parts.join('\n');
}

function buildWorldInfoText(entries, selectedKeys) {
  if (!entries || !selectedKeys || selectedKeys.length === 0) return '';
  const selected = entries.filter(e => selectedKeys.includes(e.uid ?? e.key));
  return selected.map(e => `[${e.comment || e.key || '条目'}] ${e.content}`).join('\n');
}

// ===== 环境感知: 时间 + 天气 =====

function buildTimeContext() {
  const now = new Date();
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const y = now.getFullYear();
  const mo = now.getMonth() + 1;
  const d = now.getDate();
  const wd = weekdays[now.getDay()];
  const h = now.getHours();
  const mi = String(now.getMinutes()).padStart(2, '0');

  let period = '凌晨';
  if (h >= 6 && h < 9) period = '早上';
  else if (h >= 9 && h < 12) period = '上午';
  else if (h >= 12 && h < 14) period = '中午';
  else if (h >= 14 && h < 17) period = '下午';
  else if (h >= 17 && h < 19) period = '傍晚';
  else if (h >= 19 && h < 23) period = '晚上';
  else if (h >= 23 || h < 3) period = '深夜';
  else period = '凌晨';

  let guidance = '';
  if (period === '深夜' || period === '凌晨') {
    guidance = ' (现在是深夜/凌晨,用户很可能已经睡着或正准备睡,消息的语气要贴合这一点:比如"睡不着才想到你"、"知道你可能已经睡了但还是想说一句"这种感觉,不要问用户"在干嘛"或者预期对方马上会回复,更不要写得像大白天那种日常唠嗑)';
  } else if (period === '早上') {
    guidance = ' (现在是刚睡醒的时间段,可以带一点刚醒来、还没完全清醒的感觉,而不是精神饱满地聊起来)';
  }

  return `当前时间: ${y}年${mo}月${d}日 星期${wd} ${period} ${h}:${mi}${guidance}`;
}

async function fetchWeatherRaw(cityInput) {
  if (!cityInput) return null;
  // 支持"城市/区"这种更精确的写法(比如"东京/品川区"),自动转成"区, 城市"这种
  // geocoding更容易识别的顺序;只填城市(不带斜杠)照旧直接用。
  const query = cityInput.includes('/')
    ? cityInput.split('/').map(s => s.trim()).filter(Boolean).reverse().join(', ')
    : cityInput;
  try {
    const resp = await fetch(`https://wttr.in/${encodeURIComponent(query)}?format=j1`, {
      headers: { 'Accept': 'application/json' },
      timeout: 5000
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const cur = data.current_condition?.[0];
    if (!cur) return null;
    return {
      cityInput,
      desc: cur.lang_zh?.[0]?.value || cur.weatherDesc?.[0]?.value || '',
      temp: cur.temp_C,
      feelsLike: cur.FeelsLikeC,
      humidity: cur.humidity
    };
  } catch (e) {
    console.error(`[${PLUGIN_ID}] 天气获取失败:`, e.message);
    return null;
  }
}

// 给 AI 用的版本: 不出现具体地名,角色是虚构人物,提真实地名会出戏
async function fetchWeather(cityInput) {
  const w = await fetchWeatherRaw(cityInput);
  if (!w) return '';
  return `当前天气: ${w.desc}, 气温${w.temp}°C(体感${w.feelsLike}°C), 湿度${w.humidity}% (这是用户所在地的真实天气,只用来让你的话贴合真实的天气感受即可,绝对不要说出具体的现实地名/城市名,角色是虚构人物,提到真实地名会很出戏)`;
}

// 给"测试"按钮用的版本: 带上地名,方便用户自己核对有没有查对地方
async function fetchWeatherForDisplay(cityInput) {
  const w = await fetchWeatherRaw(cityInput);
  if (!w) return '';
  return `当前天气(${w.cityInput}): ${w.desc}, 气温${w.temp}°C(体感${w.feelsLike}°C), 湿度${w.humidity}%`;
}

// ===== 健康数据(来自 Health Auto Export,苹果健康) =====
// 这个接口是给手机上的 Health Auto Export App 直接调用的,不经过酒馆自己的登录/CSRF流程,
// 所以单独用一个随机生成的密钥做校验,不是酒馆账号密码。
// 第一版先把收到的原始数据完整存起来,不做精细解析 —— 等看到真实数据格式之后再精确提取,
// 不去猜字段名,避免猜错浪费时间。

function getHealthSecretPath() { return path.join(dataDir, 'health-secret.txt'); }

function getOrCreateHealthSecret() {
  try {
    return fs.readFileSync(getHealthSecretPath(), 'utf-8').trim();
  } catch (e) {
    const secret = require('crypto').randomBytes(16).toString('hex');
    fs.writeFileSync(getHealthSecretPath(), secret, 'utf-8');
    return secret;
  }
}

// ===== 专注模式(供 iOS 快捷指令远程触发) =====
// 时长结束后,让当前唯一启用推送的角色发一条鼓励消息,期间暂停间隔/定时推送。

function getFocusSecretPath() { return path.join(dataDir, 'focus-secret.txt'); }

function getOrCreateFocusSecret() {
  try {
    return fs.readFileSync(getFocusSecretPath(), 'utf-8').trim();
  } catch (e) {
    const secret = require('crypto').randomBytes(16).toString('hex');
    fs.writeFileSync(getFocusSecretPath(), secret, 'utf-8');
    return secret;
  }
}

function getApiPresetsPath() { return path.join(dataDir, 'api-presets.json'); }

function loadApiPresets() {
  try { return JSON.parse(fs.readFileSync(getApiPresetsPath(), 'utf-8')); }
  catch (e) { return []; }
}

function saveApiPresets(list) {
  fs.writeFileSync(getApiPresetsPath(), JSON.stringify(list, null, 2), 'utf-8');
}

function getRemindersPath() { return path.join(dataDir, 'reminders.json'); }

function loadReminders() {
  try { return JSON.parse(fs.readFileSync(getRemindersPath(), 'utf-8')); }
  catch (e) { return []; }
}

function saveReminders(list) {
  fs.writeFileSync(getRemindersPath(), JSON.stringify(list, null, 2), 'utf-8');
}

function getFocusStatePath() { return path.join(dataDir, 'focus-state.json'); }

function loadFocusState() {
  try { return JSON.parse(fs.readFileSync(getFocusStatePath(), 'utf-8')); }
  catch (e) { return { active: false }; }
}

function saveFocusState(state) {
  fs.writeFileSync(getFocusStatePath(), JSON.stringify(state, null, 2), 'utf-8');
}

function getHealthDataPath() { return path.join(dataDir, 'health-latest.json'); }

function saveHealthData(payload) {
  fs.writeFileSync(getHealthDataPath(), JSON.stringify({
    received_at: new Date().toISOString(),
    raw: payload
  }, null, 2), 'utf-8');
}

function loadHealthData() {
  try { return JSON.parse(fs.readFileSync(getHealthDataPath(), 'utf-8')); }
  catch (e) { return null; }
}

// 从某个指标里取最新一条数据(按日期倒序排,取第一条)
function extractLatestMetric(metrics, metricName) {
  const m = metrics.find(x => x.name === metricName);
  if (!m || !Array.isArray(m.data) || m.data.length === 0) return null;
  const sorted = [...m.data].sort((a, b) => new Date(b.date) - new Date(a.date));
  const latest = sorted[0];
  if (typeof latest.qty !== 'number') return null;
  return { qty: latest.qty, date: latest.date, units: m.units || '' };
}

// 精确解析: 基于 Health Auto Export 真实的数据格式(data.metrics 数组,
// 每项含 name/units/data,data里每条是 {date, qty, source})
function summarizeHealthData(raw) {
  try {
    const metrics = raw?.data?.metrics;
    if (!Array.isArray(metrics)) return '';
    const parts = [];

    const hrv = extractLatestMetric(metrics, 'heart_rate_variability');
    if (hrv) parts.push(`心率变异性(HRV) ${hrv.qty.toFixed(1)}${hrv.units}`);

    const rhr = extractLatestMetric(metrics, 'resting_heart_rate');
    if (rhr) parts.push(`静息心率 ${rhr.qty.toFixed(0)}${rhr.units}`);

    const sleep = extractLatestMetric(metrics, 'sleep_analysis');
    if (sleep) parts.push(`睡眠时长 ${sleep.qty.toFixed(1)}${sleep.units}`);

    const steps = extractLatestMetric(metrics, 'step_count');
    if (steps) parts.push(`步数 ${Math.round(steps.qty)}${steps.units}`);

    const resp = extractLatestMetric(metrics, 'respiratory_rate');
    if (resp) parts.push(`呼吸频率 ${resp.qty.toFixed(1)}${resp.units}`);

    return parts.join(', ');
  } catch (e) {
    console.error(`[${PLUGIN_ID}] 健康数据解析出错:`, e.message);
    return '';
  }
}

function buildHealthContext(useHealth) {
  if (!useHealth) return '';
  const health = loadHealthData();
  if (!health) return '';
  const ageMinutes = (Date.now() - new Date(health.received_at).getTime()) / 60000;
  if (ageMinutes > 180) return ''; // 超过3小时的健康数据太旧,不用
  const summary = summarizeHealthData(health.raw);
  return summary ? `用户最近的健康数据: ${summary}` : '';
}

// 独立的健康数据接收服务 — 单独开一个端口,完全不经过酒馆自己的路由和CSRF机制,
// 因为 Health Auto Export 这类外部App没办法配合酒馆的登录令牌流程,之前保存配置
// 被CSRF拦截过一次,这次直接绕开,避免同样的问题。
const HEALTH_RECEIVER_PORT = 2588;
function startHealthReceiver() {
  const http = require('http');
  const server = http.createServer((req, res) => {
    const urlObj = new URL(req.url, `http://localhost:${HEALTH_RECEIVER_PORT}`);
    const pathname = urlObj.pathname;

    if (req.method === 'POST' && pathname === '/health-data') {
      const key = urlObj.searchParams.get('key');
      const secret = getOrCreateHealthSecret();
      if (key !== secret) {
        console.log(`[${PLUGIN_ID}] 健康数据接收被拒绝: 密钥不匹配`);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '密钥不正确' }));
        return;
      }
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          saveHealthData(payload);
          console.log(`[${PLUGIN_ID}] 收到健康数据, 大小=${body.length}字节`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '数据格式不对: ' + e.message }));
        }
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/focus/start') {
      const key = urlObj.searchParams.get('key');
      const secret = getOrCreateFocusSecret();
      if (key !== secret) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '密钥不正确' }));
        return;
      }
      const minutes = parseInt(urlObj.searchParams.get('minutes'), 10);
      const reason = (urlObj.searchParams.get('reason') || '').trim();
      if (!minutes || minutes <= 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'minutes 参数缺失或不合法' }));
        return;
      }
      const profiles = loadProfiles();
      const activeId = Object.keys(profiles).find(id => profiles[id].enabled);
      if (!activeId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '当前没有启用推送的角色,无法开始提醒' }));
        return;
      }
      saveFocusState({
        active: true,
        until: Date.now() + minutes * 60 * 1000,
        durationMinutes: minutes,
        reason,
        profileId: activeId
      });
      console.log(`[${PLUGIN_ID}] 定时提醒已开始(快捷指令触发): ${minutes}分钟, 事由="${reason}", 角色=${profiles[activeId].character_name}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: `已设置,${minutes}分钟后提醒` }));
      return;
    }

    if (req.method === 'GET' && pathname === '/focus/cancel') {
      const key = urlObj.searchParams.get('key');
      const secret = getOrCreateFocusSecret();
      if (key !== secret) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '密钥不正确' }));
        return;
      }
      saveFocusState({ active: false });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: '提醒已取消' }));
      return;
    }

    res.writeHead(404); res.end('Not Found');
  });
  server.listen(HEALTH_RECEIVER_PORT, '0.0.0.0', () => {
    console.log(`[${PLUGIN_ID}] 健康数据/专注模式接收服务已启动,端口 ${HEALTH_RECEIVER_PORT}`);
  });
  return server;
}



async function callAI(apiCfg, systemPrompt) {
  if (!apiCfg || !apiCfg.api_key) throw new Error('未配置有效的 API');

  // AI供应商响应太慢或没反应时,最多等30秒就放弃,不会让整个请求无限挂着
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    if (apiCfg.provider === 'anthropic') {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiCfg.api_key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: apiCfg.model || 'claude-haiku-4-5-20251001', max_tokens: 2000, system: systemPrompt, messages: [{ role: 'user', content: '生成一条消息' }] }),
        signal: controller.signal
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(`Anthropic API 错误: ${JSON.stringify(data)}`);
      return data.content?.[0]?.text?.trim() || '';
    }

    const baseUrl = (apiCfg.base_url || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiCfg.api_key}` },
      body: JSON.stringify({ model: apiCfg.model || 'gpt-4o-mini', max_tokens: 2000, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: '生成一条消息' }] }),
      signal: controller.signal
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(`OpenAI 兼容 API 错误: ${JSON.stringify(data)}`);
    return data.choices?.[0]?.message?.content?.trim() || '';
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('AI供应商响应超时(等了30秒没反应),建议换个模型或供应商重试');
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ===== 推送: Bark =====

async function pushToBark(profile, message) {
  if (!profile.bark_server_url || !profile.bark_device_key) throw new Error('未配置 Bark 服务器地址或设备Key');
  const baseUrl = profile.bark_server_url.replace(/\/$/, '');
  const title = profile.display_name || profile.character_name || 'Companion';
  const payload = { title, body: message, device_key: profile.bark_device_key };
  if (profile.avatar_url) payload.icon = profile.avatar_url;
  const resp = await fetch(`${baseUrl}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload)
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.code !== 200) throw new Error(`Bark 推送失败: ${JSON.stringify(data)}`);
}

// ===== 生成 + 发送 =====

// ===== 消息内容比例分配 + 最近聊天感知 =====
// 每次生成前按比例抽一次"这次聊什么",避免天气/健康这类信息每次都被塞进去、变成口头禅

function pickContentCategory(ratio) {
  const entries = [
    ['daily', Number(ratio?.daily) || 0],
    ['weather', Number(ratio?.weather) || 0],
    ['health', Number(ratio?.health) || 0],
    ['other', Number(ratio?.other) || 0],
  ];
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (total <= 0) return 'daily';
  let r = Math.random() * total;
  for (const [key, w] of entries) {
    if (r < w) return key;
    r -= w;
  }
  return entries[entries.length - 1][0];
}

function buildRecentChatText(recentChat) {
  if (!Array.isArray(recentChat) || recentChat.length === 0) return '';
  return recentChat.map(m => `${m.name || '?'}: ${m.text || ''}`).join('\n');
}

async function generateAndSend(profile, overridePrompt) {
  const persona = buildPersonaText(profile.character_data || {});
  const userPersona = buildUserPersonaText(profile.user_persona);
  const worldInfo = buildWorldInfoText(profile.world_info_entries, profile.selected_world_info_keys);
  const recentChatText = profile.use_recent_chat ? buildRecentChatText(profile.recent_chat) : '';

  const weatherEnabled = profile.weather_enabled !== false; // 默认开启，兼容老数据
  let timeCtx, weatherCtx, healthCtx;
  if (overridePrompt) {
    timeCtx = buildTimeContext();
    weatherCtx = weatherEnabled ? await fetchWeather(profile.weather_city || '') : '';
    healthCtx = buildHealthContext(profile.use_health_data);
  } else {
    const category = pickContentCategory(profile.content_ratio);
    timeCtx = category === 'other' ? '' : buildTimeContext();
    weatherCtx = (category === 'weather' && weatherEnabled) ? await fetchWeather(profile.weather_city || '') : '';
    healthCtx = category === 'health' ? buildHealthContext(profile.use_health_data) : '';
  }

  const systemPrompt = [
    `你现在扮演角色: ${profile.character_name || '一个角色'}。`,
    persona ? `角色设定:\n${persona}` : '',
    userPersona ? `你正在联系的用户信息(这就是{{user}}):\n${userPersona}` : '',
    worldInfo ? `补充设定(世界书):\n${worldInfo}` : '',
    recentChatText ? `最近的聊天记录(供参考,让这条消息能呼应最新剧情,不要直接复述原文):\n${recentChatText}` : '',
    timeCtx,
    weatherCtx,
    healthCtx,
    overridePrompt || profile.custom_prompt || '现在请以这个角色的身份,主动给用户发一条简短的消息(1-2句话),像是随手发来的关心、调侃或想念。不要加引号,不要加任何前缀说明或旁白,直接给出这句话本身。'
  ].filter(Boolean).join('\n\n');

  const message = await callAI(profile.api, systemPrompt);
  if (!message) throw new Error('AI 未返回有效内容');
  await pushToBark(profile, message);
  return message;
}

// ===== 定时调度 =====

function formatHHMM(d) { return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0'); }

function isInDndWindow(nowHM, start, end) {
  if (!start || !end || start === end) return false;
  if (start < end) return nowHM >= start && nowHM < end;
  return nowHM >= start || nowHM < end;
}
function formatDateKey(d) { return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }

function startScheduler() {
  if (scheduler) clearInterval(scheduler);
  scheduler = setInterval(async () => {
    const reminders = loadReminders();
    if (reminders.length > 0) {
      const nowMs0 = Date.now();
      const due = reminders.filter(r => r.triggerAt <= nowMs0);
      if (due.length > 0) {
        saveReminders(reminders.filter(r => r.triggerAt > nowMs0));
        const remindProfiles = loadProfiles();
        let remindChanged = false;
        for (const r of due) {
          const p = remindProfiles[r.profileId];
          if (!p) continue;
          try {
            const targetStr = new Date(r.targetTime).toLocaleString('zh-CN');
            const remindPrompt = `现在到了一个提醒时刻。用户之前设置了一个提醒,事由是"${r.event || '未填写具体事由'}",原定时间是${targetStr}。请以这个角色的身份,用一两句话自然地提醒用户这件事,语气符合角色人设,不要加引号,不要加任何前缀说明或旁白,直接给出这句话本身。`;
            const msg = await generateAndSend(p, remindPrompt);
            p.last_message = msg;
            remindChanged = true;
            console.log(`[${PLUGIN_ID}] 定点提醒已触发 (${p.character_name}): ${msg}`);
          } catch (err) { console.error(`[${PLUGIN_ID}] 定点提醒发送失败:`, err.message); }
        }
        if (remindChanged) saveProfiles(remindProfiles);
      }
    }

    const focus = loadFocusState();
    if (focus.active) {
      if (Date.now() < focus.until) return;
      const allProfiles = loadProfiles();
      const focusProfile = allProfiles[focus.profileId];
      if (focusProfile) {
        try {
          const promptText = focus.reason
            ? `到了用户之前设定的提醒时间了(${focus.durationMinutes || ''}分钟前设置的,事由是"${focus.reason}")。请以这个角色的身份,自然地提醒用户这件事,语气符合角色人设,不要加引号,不要加任何前缀说明或旁白,直接给出这句话本身。`
            : `用户刚完成了一段${focus.durationMinutes || ''}分钟的专注/等待时间,没有特别说明是做什么。请以这个角色的身份,用一句话真诚地夸奖或鼓励用户,语气符合角色人设,不要加引号,不要加任何前缀说明或旁白,直接给出这句话本身。`;
          const msg = await generateAndSend(focusProfile, promptText);
          focusProfile.last_message = msg;
          saveProfiles(allProfiles);
          console.log(`[${PLUGIN_ID}] 定时提醒已到点,已发送消息 (${focusProfile.character_name}): ${msg}`);
        } catch (err) { console.error(`[${PLUGIN_ID}] 提醒消息发送失败:`, err.message); }
      }
      saveFocusState({ active: false });
      return;
    }

    const profiles = loadProfiles();
    const now = new Date();
    const nowMs = now.getTime();
    const nowHM = formatHHMM(now);
    const today = formatDateKey(now);

    for (const [id, profile] of Object.entries(profiles)) {
      if (!profile.enabled) continue;
      let changed = false;

      const inDnd = !!profile.dnd_enabled && isInDndWindow(nowHM, profile.dnd_start || '', profile.dnd_end || '');

      // 定时模式(可与间隔模式同时开启)。每个时间点可以带一句"这个点通常聊什么",
      // 留空就走原来的自由发挥/比例分配逻辑,不强制要求填。
      if (profile.schedule_enabled && !inDnd) {
        const times = (profile.schedule_times || []).map(t => typeof t === 'string' ? { time: t, note: '' } : t);
        const match = times.find(t => t.time === nowHM);
        if (match) {
          profile.last_sent_dates = profile.last_sent_dates || {};
          if (profile.last_sent_dates[nowHM] !== today) {
            try {
              const overridePrompt = match.note
                ? `现在是${nowHM}。你和用户约定过,这个时间点通常是关于"${match.note}"的。请以这个角色的身份,围绕这件事,用一两句话自然地开口(不用逐字提及具体时间),语气符合角色人设,不要加引号,不要加任何前缀说明或旁白,直接给出这句话本身。`
                : undefined;
              const msg = await generateAndSend(profile, overridePrompt);
              profile.last_sent_dates[nowHM] = today;
              profile.last_message = msg;
              changed = true;
              console.log(`[${PLUGIN_ID}] 定时已发送 (${profile.character_name} @ ${nowHM}): ${msg}`);
            } catch (err) { console.error(`[${PLUGIN_ID}] 定时发送失败 (${id} @ ${nowHM}):`, err.message); }
          }
        }
      }

      // 间隔模式(可与定时模式同时开启)
      if (profile.interval_enabled && !inDnd) {
        const intervalMs = (profile.interval_minutes || 180) * 60 * 1000;
        const last = profile.last_sent_at || 0;
        if (nowMs - last >= intervalMs) {
          try {
            const msg = await generateAndSend(profile);
            profile.last_sent_at = nowMs;
            profile.last_message = msg;
            changed = true;
            console.log(`[${PLUGIN_ID}] 已发送 (${profile.character_name}): ${msg}`);
          } catch (err) { console.error(`[${PLUGIN_ID}] 发送失败 (${id}):`, err.message); }
        }
      }

      if (changed) saveProfiles(profiles);
    }
  }, 60 * 1000);
}

// ===== 路由 =====

function registerRoutes(router) {
  router.get('/profiles', (req, res) => res.json(loadProfiles()));

  router.post('/profiles/:id', (req, res) => {
    console.log(`[${PLUGIN_ID}] 收到保存请求, id=${req.params.id}, 时间=${new Date().toISOString()}, 请求体大小=${JSON.stringify(req.body).length}字节`);
    const profiles = loadProfiles();
    if (req.body.enabled) {
      for (const [pid, p] of Object.entries(profiles)) {
        if (pid !== req.params.id && p.enabled) p.enabled = false;
      }
    }
    profiles[req.params.id] = { ...(profiles[req.params.id] || {}), ...req.body };
    saveProfiles(profiles);
    console.log(`[${PLUGIN_ID}] 保存请求处理完成, id=${req.params.id}`);
    res.json({ ok: true });
  });

  router.post('/deactivate-all', (req, res) => {
    const profiles = loadProfiles();
    let changed = false;
    for (const p of Object.values(profiles)) {
      if (p.enabled) { p.enabled = false; changed = true; }
    }
    if (changed) saveProfiles(profiles);
    res.json({ ok: true });
  });

  router.delete('/profiles/:id', (req, res) => {
    const profiles = loadProfiles();
    delete profiles[req.params.id];
    saveProfiles(profiles);
    res.json({ ok: true });
  });

  router.post('/profiles/:id/test-send', async (req, res) => {
    const profiles = loadProfiles();
    const profile = profiles[req.params.id];
    if (!profile) return res.status(404).json({ error: '未找到该配置' });
    try { const msg = await generateAndSend(profile); res.json({ ok: true, message: msg }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/test-api', async (req, res) => {
    const { api } = req.body;
    try { const message = await callAI(api, '请用一句话打个招呼,证明这个连接是通的。'); res.json({ ok: true, message }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/fetch-models', async (req, res) => {
    const { provider, api_key, base_url } = req.body;
    if (!api_key) return res.status(400).json({ error: '请先填写 API Key' });

    // 统一的"读文本再尝试解析JSON"逻辑: 如果上游返回的不是合法JSON(比如网关鉴权失败直接
    // 返回空body或者HTML错误页),之前会被 resp.json() 直接抛出一个很含糊的
    // "invalid json response body...Unexpected end of JSON input",看不出到底是什么问题。
    // 现在把HTTP状态码和原始内容的前200个字符带出来,方便判断具体卡在哪一步。
    async function safeParseJson(resp) {
      const text = await resp.text();
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new Error(`HTTP ${resp.status}, 但响应内容不是合法JSON: ${text.trim() ? text.slice(0, 200) : '(空响应体)'}`);
      }
    }

    try {
      let models = [];
      if (provider === 'anthropic') {
        const resp = await fetch('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': api_key, 'anthropic-version': '2023-06-01' } });
        const data = await safeParseJson(resp);
        if (!resp.ok) throw new Error(JSON.stringify(data));
        models = (data.data || []).map(m => m.id);
      } else {
        const url = `${(base_url || 'https://api.openai.com/v1').replace(/\/+$/, '')}/models`;
        const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${api_key}` } });
        const data = await safeParseJson(resp);
        if (!resp.ok) throw new Error(JSON.stringify(data));
        models = (data.data || []).map(m => m.id).sort();
      }
      res.json({ ok: true, models });
    } catch (err) { res.status(500).json({ error: '获取模型列表失败: ' + err.message }); }
  });

  router.post('/test-weather', async (req, res) => {
    const { city } = req.body;
    if (!city) return res.status(400).json({ error: '请填写城市名' });
    const weather = await fetchWeatherForDisplay(city);
    if (!weather) return res.status(500).json({ error: '天气获取失败,请检查城市名是否正确' });
    res.json({ ok: true, weather });
  });

  // 给前端面板用: 拿到当前的健康数据接收密钥和状态,用于展示配置说明
  router.get('/health-info', (req, res) => {
    const secret = getOrCreateHealthSecret();
    const health = loadHealthData();
    res.json({
      ok: true,
      secret,
      last_received_at: health?.received_at || null,
      summary: health ? summarizeHealthData(health.raw) : ''
    });
  });

  router.get('/focus-info', (req, res) => {
    const secret = getOrCreateFocusSecret();
    const state = loadFocusState();
    res.json({ ok: true, secret, state });
  });

  router.post('/focus/cancel', (req, res) => {
    saveFocusState({ active: false });
    res.json({ ok: true });
  });

  router.post('/focus/start-manual', (req, res) => {
    const minutes = parseInt(req.body?.minutes, 10);
    const reason = (req.body?.reason || '').trim();
    if (!minutes || minutes <= 0) {
      return res.status(400).json({ error: '分钟数不合法' });
    }
    const profiles = loadProfiles();
    const activeId = Object.keys(profiles).find(id => profiles[id].enabled);
    if (!activeId) {
      return res.status(400).json({ error: '当前没有启用推送的角色,无法开始提醒' });
    }
    saveFocusState({
      active: true,
      until: Date.now() + minutes * 60 * 1000,
      durationMinutes: minutes,
      reason,
      profileId: activeId
    });
    console.log(`[${PLUGIN_ID}] 定时提醒已开始(面板内触发): ${minutes}分钟, 事由="${reason}", 角色=${profiles[activeId].character_name}`);
    res.json({ ok: true, message: `已设置,${minutes}分钟后提醒` });
  });

  router.get('/reminders', (req, res) => res.json(loadReminders()));

  router.post('/reminders', (req, res) => {
    const list = loadReminders();
    if (list.length >= 3) {
      res.status(400).json({ error: '最多同时开启3个定点提醒,请先取消一个再新建' });
      return;
    }
    const { targetTime, leadMinutes, event } = req.body;
    const target = new Date(targetTime).getTime();
    const lead = Number(leadMinutes) || 0;
    if (!targetTime || isNaN(target)) {
      res.status(400).json({ error: '目标时间不合法' });
      return;
    }
    const triggerAt = target - lead * 60 * 1000;
    if (triggerAt <= Date.now()) {
      res.status(400).json({ error: '算上提前量,这个时间点已经过了' });
      return;
    }
    const profiles = loadProfiles();
    const activeId = Object.keys(profiles).find(id => profiles[id].enabled);
    if (!activeId) {
      res.status(400).json({ error: '当前没有启用推送的角色,无法创建提醒' });
      return;
    }
    const reminder = {
      id: require('crypto').randomBytes(6).toString('hex'),
      profileId: activeId,
      characterName: profiles[activeId].character_name || '',
      targetTime: target,
      leadMinutes: lead,
      event: (event || '').trim(),
      triggerAt
    };
    list.push(reminder);
    saveReminders(list);
    res.json({ ok: true, reminder });
  });

  router.delete('/reminders/:id', (req, res) => {
    saveReminders(loadReminders().filter(r => r.id !== req.params.id));
    res.json({ ok: true });
  });

  router.get('/api-presets', (req, res) => res.json(loadApiPresets()));

  router.post('/api-presets', (req, res) => {
    const { name, provider, base_url, api_key, model } = req.body;
    if (!name || !String(name).trim()) {
      res.status(400).json({ error: '请填写配置名称' });
      return;
    }
    if (!api_key) {
      res.status(400).json({ error: '请填写 API Key' });
      return;
    }
    const list = loadApiPresets();
    const entry = { name: String(name).trim(), provider: provider || 'openai_compatible', base_url: base_url || '', api_key, model: model || '' };
    const idx = list.findIndex(p => p.name === entry.name);
    if (idx >= 0) list[idx] = entry; else list.push(entry);
    saveApiPresets(list);
    res.json({ ok: true });
  });

  router.delete('/api-presets/:name', (req, res) => {
    saveApiPresets(loadApiPresets().filter(p => p.name !== req.params.name));
    res.json({ ok: true });
  });

}

// ===== 生命周期 =====

let healthReceiverServer = null;

async function init(router) {
  dataDir = path.join(__dirname, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  loadProfiles();
  getOrCreateHealthSecret(); // 启动时就生成好密钥,方便前端面板一开始就能显示配置说明
  getOrCreateFocusSecret();
  registerRoutes(router);
  startScheduler();
  healthReceiverServer = startHealthReceiver();
  console.log(`[${PLUGIN_ID}] 插件已加载,数据目录: ${dataDir}`);
}

async function exit() {
  if (scheduler) clearInterval(scheduler);
  if (healthReceiverServer) healthReceiverServer.close();
  console.log(`[${PLUGIN_ID}] 插件已卸载`);
}

module.exports = { init, exit, info: { id: PLUGIN_ID, name: 'Char Companion', description: '让角色卡定义的角色主动给你发消息(推送到iPhone/Apple Watch,通过Bark)' } };

