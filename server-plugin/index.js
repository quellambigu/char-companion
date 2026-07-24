// SillyTavern Server Plugin: Char Companion (Proactive Message Pusher)
// 放置路径: <SillyTavern根目录>/plugins/char-companion/
//
// 功能范围(第一版):
//   1. 主动消息推送(定时/间隔触发) — Discord Webhook
//   2. 双 API 支持 — 主 API(酒馆聊天用) / 副 API(推送专用,可用便宜模型)
//   3. 读取角色卡人设 + 世界书(条目可选)
//
// 不包含(留待后续版本): 心情/健康数据读取、天气、上下文感知聊天记录模式
//
// 重要: 这是一个"本地单机"设计 —— 每个用户的配置(API Key、Webhook URL)
// 都存在自己的酒馆 data 目录下,插件代码本身不含任何人的密钥,
// 也不会把任何数据发到除了"用户自己配置的推送渠道 / API"以外的地方。

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const PLUGIN_ID = 'char-companion';
let dataDir = null;          // 配置存储目录(酒馆会在 init 时告诉我们)
let scheduler = null;        // setInterval 句柄
let profilesCache = {};      // 内存缓存,避免每次都读盘

// ---------- 工具函数 ----------

function getConfigPath() {
  return path.join(dataDir, 'profiles.json');
}

function loadProfiles() {
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf-8');
    profilesCache = JSON.parse(raw);
  } catch (e) {
    profilesCache = {}; // 文件不存在时,视为空配置
  }
  return profilesCache;
}

function saveProfiles(profiles) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify(profiles, null, 2), 'utf-8');
  profilesCache = profiles;
}

// 从酒馆的角色卡数据里提取人设文本
// charData 是前端传来的角色卡对象(酒馆前端已经能拿到,插件本身不直接碰酒馆的角色文件)
function buildPersonaText(charData) {
  const parts = [];
  if (charData.name) parts.push(`角色名: ${charData.name}`);
  if (charData.description) parts.push(`人设描述: ${charData.description}`);
  if (charData.personality) parts.push(`性格: ${charData.personality}`);
  if (charData.scenario) parts.push(`场景设定: ${charData.scenario}`);
  if (charData.mes_example) parts.push(`对话示例: ${charData.mes_example}`);
  return parts.join('\n');
}

// 拼接被选中的世界书条目
function buildWorldInfoText(worldInfoEntries, selectedKeys) {
  if (!worldInfoEntries || !selectedKeys || selectedKeys.length === 0) return '';
  const selected = worldInfoEntries.filter(e => selectedKeys.includes(e.uid ?? e.key));
  if (selected.length === 0) return '';
  return selected.map(e => `[${e.comment || e.key || '条目'}] ${e.content}`).join('\n');
}

// ---------- AI 调用(区分主/副 API) ----------

async function callAI(profile, systemPrompt) {
  const apiCfg = profile.use_secondary_api ? profile.secondary_api : profile.primary_api;
  if (!apiCfg || !apiCfg.api_key) {
    throw new Error('未配置有效的 API(请检查主/副 API 设置)');
  }

  // 统一走 OpenAI 兼容格式(Claude / OpenAI / Gemini 中转多数支持这个格式,
  // 如果用户直接用 Anthropic 原生端点,下面会单独处理)
  if (apiCfg.provider === 'anthropic') {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiCfg.api_key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: apiCfg.model || 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        system: systemPrompt,
        messages: [{ role: 'user', content: '生成一条消息' }]
      })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(`Anthropic API 错误: ${JSON.stringify(data)}`);
    return data.content?.[0]?.text?.trim() || '';
  }

  // OpenAI 兼容(GPT / Gemini 中转 / 国内中转站 多数适用这个格式)
  const baseUrl = apiCfg.base_url || 'https://api.openai.com/v1';
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiCfg.api_key}`
    },
    body: JSON.stringify({
      model: apiCfg.model || 'gpt-4o-mini',
      max_tokens: 150,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: '生成一条消息' }
      ]
    })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`OpenAI 兼容 API 错误: ${JSON.stringify(data)}`);
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// ---------- 推送(第一版只做 Discord Webhook) ----------

async function pushToDiscord(profile, message) {
  if (!profile.discord_webhook_url) {
    throw new Error('未配置 Discord Webhook URL');
  }
  await fetch(profile.discord_webhook_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: profile.display_name || profile.character_name || 'Companion',
      avatar_url: profile.avatar_url || undefined,
      content: message
    })
  });
}

// ---------- 生成 + 发送 一条完整消息 ----------

async function generateAndSend(profile) {
  const persona = buildPersonaText(profile.character_data || {});
  const worldInfo = buildWorldInfoText(profile.world_info_entries, profile.selected_world_info_keys);

  const systemPrompt = [
    `你现在扮演角色: ${profile.character_name || '一个角色'}。`,
    profile.relationship ? `你和用户的关系设定: ${profile.relationship}` : '',
    persona ? `角色设定:\n${persona}` : '',
    worldInfo ? `补充设定(世界书):\n${worldInfo}` : '',
    profile.custom_prompt || '现在请以这个角色的身份,主动给用户发一条简短的消息(1-2句话),像是随手发来的关心、调侃或想念。不要加引号,不要加任何前缀说明或旁白,直接给出这句话本身。'
  ].filter(Boolean).join('\n\n');

  const message = await callAI(profile, systemPrompt);
  if (!message) throw new Error('AI 未返回有效内容');

  await pushToDiscord(profile, message);
  return message;
}

// ---------- 定时调度 ----------

function startScheduler() {
  if (scheduler) clearInterval(scheduler);
  // 每分钟检查一次所有 profile,谁到点了就发谁的
  scheduler = setInterval(async () => {
    const profiles = loadProfiles();
    const now = Date.now();
    for (const [id, profile] of Object.entries(profiles)) {
      if (!profile.enabled) continue;
      const intervalMs = (profile.interval_minutes || 180) * 60 * 1000;
      const last = profile.last_sent_at || 0;
      if (now - last >= intervalMs) {
        try {
          const msg = await generateAndSend(profile);
          profile.last_sent_at = now;
          profile.last_message = msg;
          saveProfiles(profiles);
          console.log(`[${PLUGIN_ID}] 已发送 (${profile.character_name}): ${msg}`);
        } catch (err) {
          console.error(`[${PLUGIN_ID}] 发送失败 (${id}):`, err.message);
        }
      }
    }
  }, 60 * 1000);
}

// ---------- 路由(供前端 Extension 调用) ----------

function registerRoutes(router) {
  // 获取所有 profile
  router.get('/profiles', (req, res) => {
    res.json(loadProfiles());
  });

  // 新建/更新一个 profile
  router.post('/profiles/:id', (req, res) => {
    const profiles = loadProfiles();
    const existing = profiles[req.params.id] || {};
    profiles[req.params.id] = { ...existing, ...req.body };
    saveProfiles(profiles);
    res.json({ ok: true });
  });

  // 删除一个 profile
  router.delete('/profiles/:id', (req, res) => {
    const profiles = loadProfiles();
    delete profiles[req.params.id];
    saveProfiles(profiles);
    res.json({ ok: true });
  });

  // 立即测试发送(不影响定时计划)
  router.post('/profiles/:id/test-send', async (req, res) => {
    const profiles = loadProfiles();
    const profile = profiles[req.params.id];
    if (!profile) return res.status(404).json({ error: '未找到该配置' });
    try {
      const msg = await generateAndSend(profile);
      res.json({ ok: true, message: msg });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

// ---------- 插件生命周期(酒馆规定的入口格式) ----------

async function init(router) {
  // 酒馆会传入一个可写的数据目录路径;不同版本字段名可能是
  // globalThis.DATA_ROOT 或者由 router 附带,这里做个兜底
  dataDir = path.join(__dirname, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  loadProfiles();
  registerRoutes(router);
  startScheduler();
  console.log(`[${PLUGIN_ID}] 插件已加载,数据目录: ${dataDir}`);
}

async function exit() {
  if (scheduler) clearInterval(scheduler);
  console.log(`[${PLUGIN_ID}] 插件已卸载`);
}

module.exports = {
  init,
  exit,
  info: {
    id: PLUGIN_ID,
    name: 'Char Companion',
    description: '让角色卡定义的角色主动给你发消息(推送到 Discord)'
  }
};
