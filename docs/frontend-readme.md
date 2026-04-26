# iCourse Subscriber — Web 前端

基于浏览器的加密课程摘要查看器。手机端友好，无需服务器。

## 快速开始

### 1. 启用 GitHub Pages

在你 fork 的仓库中进入 **Settings → Pages**：
- Source 选择 **Deploy from a branch**
- Branch 选择 `gh-pages` / `/ (root)`

向 `main` 分支推送任意提交（或在 Actions 页面手动触发 "Deploy Frontend" workflow）。部署完成后访问：

```
https://<你的用户名>.github.io/<仓库名>/
```

### 2. 创建 GitHub Fine-grained PAT

前往 [GitHub → Settings → Developer settings → Fine-grained personal access tokens → Generate new token](https://github.com/settings/personal-access-tokens/new)，按如下配置：

| 字段 | 填写内容 |
|------|---------|
| **Token name** | `icourse-frontend`（随意取名） |
| **Expiration** | 建议 90 天（过期后可随时重新生成） |
| **Repository access** | 选择 **Only select repositories** → 选中你 fork 的仓库 |
| **Permissions → Repository permissions → Contents** | 选择 **Read and write** |
| **Permissions → Repository permissions → Actions** | 选择 **Read and write** |

其余权限全部保持 **No access**。点击 **Generate token** 并复制保存。

> **为什么需要这两组权限？**
> - **Contents: Read and Write**
>   - **Read**：从 `data` 分支拉取加密数据库
>   - **Write**：将你在网页编辑器中的修改推送回仓库
> - **Actions: Read and Write**
>   - **Write**：触发 `Export Course Summaries` workflow（前端「导出」按钮使用）
>   - 没有这个权限，导出按钮会报 `403/404`

### 3. 首次配置

打开前端 URL，会看到配置向导，要求输入 5 个值：

| 字段 | 在哪里找 | 对应的 workflow secret |
|------|---------|----------------------|
| **GitHub PAT** | 上一步创建的 token | （不是 workflow secret） |
| **STUID** | 你的学号 | `STUID` |
| **UISPSW** | 你的 UIS 密码 | `UISPSW` |
| **DASHSCOPE_API_KEY** | ModelScope API 密钥 | `DASHSCOPE_API_KEY` |
| **SMTP_PASSWORD** | QQ 邮箱 SMTP 授权码 | `SMTP_PASSWORD` |

后 4 个 secret 与你在 GitHub Secrets 中为 workflow 配置的完全一致，它们用于推导数据库的加密密钥。

点击 **Connect** — 前端会尝试拉取并解密数据库。成功后即可看到课程列表。

## 功能

- **课程列表** — 所有已订阅课程，按最近更新排序，显示摘要数量
- **节次列表** — 单课程视图，显示状态标签（就绪 / 总结中 / 等待中 / 失败）
- **摘要阅读** — 完整 Markdown 渲染，支持 LaTeX 公式（KaTeX）
- **编辑** — 点击编辑按钮修改任意摘要，保存后自动推送到 GitHub
- **课次摘要导出 PDF** — 在课程课次页点击「导出」并勾选课次后，前端会通过 GitHub API 触发 `Export Course Summaries` workflow（基于 WeasyPrint），PDF 完成后会发送到 `RECEIVER_EMAIL` 邮箱（约 1-3 分钟）。需要 PAT 具备 **Actions: Write** 权限。
- **搜索** — 全文搜索所有摘要内容
- **移动端友好** — 底部标签栏导航，触控优化，响应式布局

## 本地开发

无需部署到 GitHub Pages 也可本地测试：

```bash
cd frontend
python -m http.server 8080
# 打开 http://localhost:8080
```

在配置向导中手动填写 "Repo Owner" 和 "Repo Name"（自动检测仅在 `*.github.io` 域名下生效）。

## 安全性

- **所有凭证仅存储在浏览器的 `localStorage` 中** — 除了直接发送给 GitHub API 外，不会传输到任何其他地方。
- **加密数据库文件始终以密文形式存在于 GitHub** — 解密完全在浏览器端通过 Web Crypto API 完成。
- **Fine-grained PAT 的权限范围限定为单个仓库**，仅有 Contents 权限 — 即使泄露，影响范围也仅限于该仓库的文件内容。
- **前端源代码中不包含任何 secret。** 放在公开仓库中是安全的。

## 高级设置

可在设置页面（齿轮图标）或配置向导的「Advanced」部分访问：

| 设置项 | 默认值 | 何时需要修改 |
|--------|--------|-------------|
| **PBKDF2 迭代次数** | `10000` | 如果你的 GitHub Actions runner 使用 Ubuntu 24.04+（OpenSSL 3.2+），改为 `600000` |
| **Data Branch** | `data` | 仅当你重命名了孤儿分支时 |
| **Repo Owner / Name** | 从 URL 自动检测 | 自定义域名或本地开发时手动填写 |

## 技术栈

所有依赖通过 CDN 加载 — 无需 npm，无需构建步骤。

| 库 | 用途 |
|----|------|
| [Alpine.js](https://alpinejs.dev/) | 响应式 UI（15 KB） |
| [Tailwind CSS](https://tailwindcss.com/) | 样式 |
| [sql.js](https://sql.js.org/) | 浏览器端 SQLite（WebAssembly） |
| [marked.js](https://marked.js.org/) | Markdown → HTML |
| [KaTeX](https://katex.org/) | LaTeX 公式渲染 |
| [DOMPurify](https://github.com/cure53/DOMPurify) | HTML 消毒（防 XSS） |
| Web Crypto API | AES-256-CBC + PBKDF2（浏览器内置） |
