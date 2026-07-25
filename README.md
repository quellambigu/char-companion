# Char Companion（随身推送）

让你角色卡里的角色，主动给你发消息、推送到手机——就像真的在跟你聊天一样。

> ⚠️ 目前是**单角色推送**：只能给你当前正在聊的这个角色设置推送。切换角色会关闭总开关、清空该角色的推送设置（这个之后会改进，做成"保留设置"）。

## 安装

安装全程建议开启🔮（代理/加速）。

### 1. 装前端（酒馆里的设置面板）

在SillyTavern的"扩展"面板里，用下面这个链接直接安装：https://github.com/quellambigu/char-companion-frontend
### 2. 装后端（真正干活的部分）

打开Termux（如果有自动启动脚本，先退出）：

```bash
# 确认SillyTavern路径
echo $ST_DIR
# 如果上面输出是空的，先补一句：
export ST_DIR=~/SillyTavern

# 打开"服务器插件"开关
sed -i 's/enableServerPlugins: false/enableServerPlugins: true/' "$ST_DIR/config.yaml"
grep "enableServerPlugins" "$ST_DIR/config.yaml"
# (如果之前已经是true，上面sed不会有效果，没关系，grep看到true就算过关)

# 安装插件本体
mkdir -p "$ST_DIR/plugins"
cd "$ST_DIR/plugins"
git clone https://github.com/quellambigu/char-companion.git char-companion
cd char-companion
npm install
echo "后端插件安装完成 ✓"

# 重启酒馆
cd "$ST_DIR"
bash start.sh
```

**如果启动后API设置一直报错**（常见于Node版本较旧的设备），执行：

```bash
sed -i "s|const fetch = require('node-fetch');|// const fetch = require('node-fetch'); // 已禁用,改用 Node 内置 fetch,修复 Premature close 问题|" "$ST_DIR/plugins/char-companion/index.js"
grep -n "fetch = require" "$ST_DIR/plugins/char-companion/index.js"
```

### 3. 以后怎么更新

```bash
cd "$ST_DIR/plugins/char-companion" && git pull && npm install
```

前端扩展直接在SillyTavern"管理扩展"面板里点更新即可。

---

## 设置说明

安装好后，在扩展面板里打开插件设置面板，右上角显示的是**当前角色**的名字。

- 🔴 总开关关闭中，不推送
- 🔵 总开关开启，推送中

推送前请先**关闭🔮**（代理）。

接下来是三个推送渠道：

### Bark（仅iOS）

1. 下载Bark App并打开，复制App里显示的网址
2. 网址里 `http://api.day.app/` 后面那一串（例如 `6V85***********oL9`）就是你的设备Key，粘贴到插件的"设备Key"里
   > 每个人的Key都不一样，别人拿到你的Key就能给你手机发推送，请勿泄露截图给别人
3. "角色显示名"可以不填，默认用角色名
4. 想让推送带头像，填一个图床图片链接

### ntfy（安卓/iOS都能用，但iOS不支持头像）

1. 打开ntfy App，右下角 ➕ 号，随便建一个"主题"，**名字越随机越好**
   > 这个主题名字相当于你的"频道密码"，别人知道了也能给你发推送
2. 建好后进入这个主题 → 右上角三个点 → 订阅设置 → 外观，可以在App里设置头像和显示名
3. 把刚才建的主题名字，复制粘贴到插件的"ntfy Topic"里
4. 插件里也可以单独设置显示名称和头像图片链接，会跟着推送一起显示

### Webhook（进阶，转发到Discord等平台）

适合想把消息转发到Discord等群组/频道的用法，具体见后续补充说明。

---

## API设置

设置好AI接口的API后，点"测试推送"确认能收到手机通知，再去设置"推送内容"这部分。

> Gemini官方渠道目前还有点问题，暂时先别用。

---

## 已知问题 / 待改进

- 切换角色卡会清空该角色的推送设置（计划改成自动保留）
- Gemini官方API对接还没搞定
- iOS用"快捷指令"实现即时推送、健康数据推送功能、Discord webhook详细用法——这几块教程还没来得及补充

## 隐私说明

你的API Key、Bark/ntfy等推送配置，都只保存在**你自己的服务器本地**（`data/`目录），不会上传到本仓库，也不会经过任何第三方服务器。
