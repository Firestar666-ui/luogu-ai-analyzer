# 洛谷 AI 代码分析器

> 在洛谷（Luogu）提交记录页面一键调用 AI，深度分析你的算法代码。

## ✨ 功能特性

- **页面注入**：在 `https://www.luogu.com.cn/record/{id}` 提交记录页面自动出现 ✨ 分析按钮
- **三维度分析**：
  - 🐾 **算法方法**：当前使用的算法标签、建议更优解法、核心考察点
  - ⚡ **运行效率**：时间/空间复杂度评估与优化建议
  - 🎨 **代码风格**：命名规范、代码结构、可读性评分（0-100）
- **流式输出**：实时显示 AI 分析进度，打字机效果
- **运行结果读取**：自动读取提交的时间（ms）、内存（KB）、得分（0-100）
- **题目信息获取**：自动抓取洛谷题目标题、难度（入门/普及/提高/省选/NOI）、标签
- **历史记录**：本地保存最近 50 条分析历史，可在 popup 中查看
- **分析完成通知**：分析完成后发送系统通知
- **多语言支持**：支持 C++17/14/11、C、Python3、PyPy3、Java、Go、Pascal 等 30+ 种语言

## 🚀 安装方法

### Chrome / Edge 开发者模式安装

1. 下载或克隆本仓库
2. 打开浏览器，进入扩展管理页面：
   - Chrome：`chrome://extensions/`
   - Edge：`edge://extensions/`
3. 开启右上角「开发者模式」
4. 点击「加载已解压的扩展程序」
5. 选择 `luogu-ai-analyzer` 文件夹
6. 安装完成，扩展图标将出现在工具栏

## ⚙️ 配置说明

点击浏览器工具栏中的扩展图标，进入配置界面：

| 配置项 | 说明 |
|--------|------|
| **API Key** | 在 [bigmodel.cn](https://open.bigmodel.cn/) 注册获取，支持智谱 GLM 系列模型 |
| **API 地址** | 留空使用默认智谱 API，也可填入任意兼容 OpenAI 格式的接口地址 |
| **模型名称** | 自定义模型名，填写后优先于下拉选择 |
| **内置模型** | 选择 GLM-4.7-Flash（推荐）或 GLM-4.5-Flash |
| **流式输出** | 开启后实时显示分析进度 |
| **分析完成提示** | 分析完成后发送系统通知 |
| **保存历史记录** | 本地保存每次分析结果 |
### 支持任意兼容OpenAI格式的模型

## 📖 使用方法

1. 打开洛谷，登录账号
2. 进入任意提交记录详情页，URL 格式：`https://www.luogu.com.cn/record/12345678`
3. 页面右下角会出现 ✨ 紫色圆形按钮
4. 点击按钮，扩展将自动：
   - 获取你的提交代码（需登录洛谷）
   - 获取题目信息（标题、难度、标签）
   - 读取运行结果（时间、内存、得分）
   - 调用 AI 进行深度分析
5. 分析结果以面板形式展示在页面中，支持切换三个分析维度

## 🔧 洛谷 API 说明

本插件使用洛谷非官方 API 获取数据：

- **提交记录**：`GET https://www.luogu.com.cn/record/{id}`（需登录 Cookie）
- **题目详情**：`GET https://www.luogu.com.cn/problem/{pid}`
- 请求头：`x-lentille-request: content-only`（获取 JSON 格式响应）

> ⚠️ 注意：若获取代码失败，请确认你已登录洛谷账号，且提交记录是你自己的（或可查看的）。

## 🗂️ 文件结构

```
luogu-ai-analyzer/
├── manifest.json     # 插件声明文件（Manifest V3）
├── content.js        # 核心内容脚本（页面注入 + 洛谷 API 调用）
├── background.js     # 后台服务（GLM API 代理 + 路由监听 + 题目获取）
├── content.css       # 分析按钮和面板样式
├── popup.html        # 配置界面 HTML
├── popup.js          # 配置界面逻辑
├── icons/            # 扩展图标
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md         # 说明文档
```

## 🌟 与 LeetCode 版本的区别

| 特性 | LeetCode 版 | 洛谷版 |
|------|------------|--------|
| 目标网站 | leetcode.cn | luogu.com.cn |
| 数据获取方式 | GraphQL API | REST API + x-lentille-request 头 |
| 语言字段 | 字符串（如 "cpp"） | 数字 ID（如 2 → C++17） |
| 难度体系 | Easy/Medium/Hard | 入门/普及/提高/省选/NOI |
| 成绩字段 | 运行时间百分比 | 得分（0-100）+ 时间(ms) + 内存(KB) |
| 存储 Key | lcAiConfig / lcAiHistory | lgAiConfig / lgAiHistory |

两个插件可以**同时安装使用**，配置完全独立互不干扰。

## 📝 已知限制

- 需要登录洛谷账号才能获取提交代码
- 仅支持自己的提交记录或有权查看的提交
- 洛谷 API 为非官方接口，若官方修改可能需要更新适配

## 🤝 反馈与贡献

- 提交 Issue：[GitHub Issues](https://github.com/Firestar666-ui/luogu-ai-analyzer/issues)
- 欢迎 PR 贡献代码

---

Made with ❤️ for 洛谷 OIers
