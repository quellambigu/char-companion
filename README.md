# Char Companion（随身推送）

让你的角色主动给你发消息、推送到手机——就像真的在跟你聊天一样。

> 所有推送设置(渠道、API、比例等)是全局共用的，切换角色卡不会清空。只有"角色人设"和"世界书"会跟着当前角色卡实时变化。想让某个角色专属推送、聊别的角色时不受影响，可以用面板里的🔒锁定功能。

## 安装

**安装全程建议开启🔮（代理/加速）。**

### 1. 装前端（酒馆里的设置面板）

在SillyTavern的"扩展"面板里，用下面这个链接直接安装：
https://github.com/quellambigu/char-companion-frontend

### 2. 装后端（真正干活的部分）

打开Termux（如果有自动启动脚本，先退出）：


### 确认SillyTavern路径
```bash
echo $ST_DIR
```

### 如果上面输出是空的，先补一句：
```bash
export ST_DIR=~/SillyTavern
```

### 打开"服务器插件"开关
```bash
sed -i 's/enableServerPlugins: false/enableServerPlugins: true/' "$ST_DIR/config.yaml"
grep "enableServerPlugins" "$ST_DIR/config.yaml"
```
### (如果之前已经是true，上面sed不会有效果，没关系，grep看到true就算过关)

### 安装插件本体
```bash
mkdir -p "$ST_DIR/plugins"
cd "$ST_DIR/plugins"
git clone https://github.com/quellambigu/char-companion.git char-companion
cd char-companion
npm install
echo "后端插件安装完成 ✓"
```

### 重启酒馆
```bash
cd "$ST_DIR"
bash start.sh
```

### 3. 以后怎么更新

更新步骤已经整理到前端仓库的README里，点这里看：
👉 https://github.com/quellambigu/char-companion-frontend

---

## 设置说明

安装好后，在扩展面板里打开插件设置面板，右上角显示的是**当前角色卡的头像文件名**（方便同名角色卡也能分清是哪一张）。

- 🔴 总开关关闭中，不推送
- 🔵 总开关开启，推送中

名字旁的🔒彩色显示时，表示该角色已锁定
切换角色卡会依然使用已锁定角色推送。
反之，显示灰色时则推送当前聊天角色卡，且切换角色时默认需要重新打开总设置开关

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

目前支持已Discord和飞书的webhook

---

## API设置

设置好AI接口的API后，点"测试推送"确认能收到手机通知，再去设置"推送内容"这部分。

---

## 已知问题 / 待改进

- iOS用"快捷指令"实现即时推送、健康数据推送功能待说明
- webhook详细用法——这几块教程还没来得及补充
- （画饼）可切换和多选的自带提示词

