# GitHub Pages 发布设计

## 目标

在不改变现有页面视觉、文案和预约演示交互的前提下，把“澄场 PICKLE CLUB”发布为 GitHub Pages 公共网站，绕开当前 `chatgpt.site` 域名的 Cloudflare 访问拦截。

## 方案

保留现有 vinext/Sites 构建作为原部署路径，新增一个仅在 GitHub Pages 构建时启用的 Next.js 静态导出模式。GitHub Actions 从同一份源码生成 `out/` 静态目录，再由 GitHub Pages 发布。

仓库固定使用 `chengchang-pickle-club`，因此公共路径为 `/<repository>/`。构建时通过环境变量注入 GitHub Pages 的 `basePath` 和公开网址；普通 Sites 构建不启用这些设置。

## 代码改动

- `next.config.ts`
  - 仅在 `GITHUB_PAGES=true` 时设置 `output: "export"`。
  - 同时设置 `basePath` 和 `trailingSlash: true`，保证项目站点子路径可用。
- `app/layout.tsx`
  - 移除依赖请求头的动态元数据。
  - 改为构建时可确定的静态元数据，并使用 `NEXT_PUBLIC_SITE_URL` 生成图标和社交卡绝对地址。
- `package.json`
  - 新增 `build:pages` 脚本，调用 Next.js 静态构建。
- `.github/workflows/pages.yml`
  - 在 `main` 分支更新时安装依赖、构建静态站、上传 `out/` 并部署到 GitHub Pages。
  - 在产物中加入 `.nojekyll`，避免 `_next` 资源被 Jekyll 忽略。

## 交互与数据

预约面板继续使用浏览器端 React 状态、校验和成功提示。它不调用 API、不写数据库，也不会保存或发送姓名、电话；GitHub Pages 可完整承载当前演示行为。

## 错误处理

- 静态导出失败时不创建或更新公开仓库。
- 子路径资源检查不通过时不发布，避免页面只有 HTML 而缺少样式或脚本。
- GitHub Actions 部署失败时保留仓库和构建日志，不影响原 Sites 版本。

## 验证

1. 先写一个针对 `out/index.html` 的失败测试。
2. 完成最小配置后运行静态构建，确认测试转为通过。
3. 运行现有完整测试，确认 Sites 构建和预约校验未回归。
4. 发布后检查 GitHub Actions 成功状态与 Pages 公共网址。
5. 用非 GitHub 登录访问路径验证首页、样式、锚点导航和预约演示。

## 范围外

- 不新增真实预约后端。
- 不迁移数据库、登录或文件上传。
- 不删除或覆盖现有 ChatGPT Sites 部署。
