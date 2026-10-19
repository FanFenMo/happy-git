# GitHub 网页授权配置

本文供项目维护者部署和发布时使用。普通用户只需安装应用、点击“使用 GitHub 登录”并在浏览器确认授权，不需要填写服务网址、Client ID 或 Client Secret。

两端共用 `client/public-config.json` 的 `apiBaseUrl`。维护者填入真实 HTTPS 服务地址后，Windows 和 Android 的后续构建都会自动写入该地址。GitHub Actions 也可通过仓库变量 `HAPPYGIT_API_BASE_URL` 覆盖该值。公开地址可以进入版本库，Client Secret 仅留在服务器。当前仓库尚未取得实际部署域名，默认地址为空，发布构建会明确停止，不会使用猜测的域名。

登录按钮会打开系统浏览器中的 GitHub 授权页面。用户确认后，GitHub 将授权码发送到后端回调地址，后端交换令牌。客户端凭本次登录的随机校验值读取结果，验证 `/user` 后保存系统加密凭据。回调页通过 `happygit://oauth/complete` 唤回应用；该链接不携带令牌。客户端读取成功结果后，服务端立即删除临时凭据。未完成的请求十分钟后失效，服务重启后需要重新发起登录。

在 GitHub 开发者设置注册 OAuth App，Authorization callback URL 填写 `https://你的服务域名/api/auth/github/callback`。已有 GitHub App 也可使用网页授权，将 `GITHUB_APP_TYPE` 设置为 `github-app`，读取公开个人资料，并将用户权限 Starring 配置为读写。GitHub App 无需启用 Device Flow。OAuth App 使用 `read:user public_repo` 授权范围，后者用于公开仓库 Star；客户端只允许预先定义的个人资料、公开仓库和 Star 接口。

服务端启动前配置以下环境变量，Client Secret 不写入前端、安装包或版本库，也不要发到聊天中。

```powershell
$env:GITHUB_CLIENT_ID = '应用的 Client ID'
$env:GITHUB_CLIENT_SECRET = '应用的 Client Secret'
$env:GITHUB_CALLBACK_URL = 'https://你的服务域名/api/auth/github/callback'
$env:GITHUB_APP_TYPE = 'oauth-app'
```

本地环境覆盖地址时，可在 `client/.env.local` 设置 `VITE_API_BASE_URL`；构建脚本同时读取 `.env.production` 和 `.env.production.local`，优先级为进程环境、当前构建模式的本地配置、当前模式配置、通用本地配置、通用配置、版本库内的公开配置。只向原生层输出 `apiBaseUrl`。普通用户不需要创建这些文件。

Windows 使用 `npm run build:win`，Android 发布流程先执行 `npm run build:release` 再同步 Capacitor 和构建 APK。两条流程都会拒绝空地址、回环地址、带凭据的地址和非 HTTPS 地址，并读取实际服务的 `/api/auth/github/status`。该接口需返回 `authProtocol: github-oauth-web-v1` 和 `configured: true`，否则构建失败。开发预览仍可使用 `npm run dev` 或 `npm run build`，这类产物不能当作已配置的安装包分发。服务配置检查通过只说明部署参数存在，正式发布前仍需完成一次真实账号授权和 Star 写入验收。

仓库提供 `server/Dockerfile` 与 `deploy/compose.yaml`。有可访问的服务器和域名后，将域名解析到服务器，复制 `deploy/.env.example` 为 `deploy/.env`，由维护者填入域名及 GitHub 应用凭据。GitHub 应用的回调地址登记为该域名下的 `/api/auth/github/callback`，然后在项目根目录启动服务：

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
```

部署入口由 Caddy 提供 HTTPS，证书保存在持久卷中，后端端口只在容器网络内开放。服务器需要可供证书验证和访问的 80、443 端口及有效 DNS；没有域名、服务器访问方式或应用凭据时，不能完成实际部署。当前本地没有 Docker 运行环境，容器构建、证书签发和公网回调尚未验收。

本地 Windows 联调可使用 `http://127.0.0.1:8081`，并在 GitHub 应用中登记对应的回调地址。Android 手机需要能访问的 HTTPS 后端；调试模拟器可使用 `http://10.0.2.2:8081`，该例外只用于可调试安装包。正式安装包要求 HTTPS。

`/api/auth/github/begin` 接收客户端随机校验值的 SHA-256 摘要，返回 GitHub 授权地址、请求标识及过期时间。`/poll` 和 `/cancel` 需要请求标识和原始校验值；仅知道标识无法取得令牌。GitHub 回调单独验证随机 state 和 PKCE，同一次回调只能交换一次。`/refresh` 使用加密存储中保留的 refresh token 续期，401 会要求重新登录。OAuth App 未启用过期令牌时，客户端不会假设一定存在 refresh token。

Star 与取消 Star 分别调用 GitHub `PUT /user/starred/{owner}/{repo}` 和 `DELETE /user/starred/{owner}/{repo}`，204 才表示写入成功。请求超时时先读取远端状态；权限不足、速率限制和登录过期分别提示。本地缓存失败会明确告知远端已更新，可重新同步，不会将本地失败误报为 GitHub 写入失败。

反向代理应对授权接口限制请求频率，关闭回调查询参数日志和授权请求体日志，并将全部 `/api/auth/github/*` 请求固定转发到同一后端实例。当前临时授权状态保存在单实例内存中，不适合无会话亲和的多实例部署。生产环境只暴露 HTTPS，不向公网直接暴露开发端口。

部署依据：[Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)、[Compose 环境变量](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)。

配置依据：[GitHub 网页授权](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)、[Star REST 接口](https://docs.github.com/en/rest/activity/starring)。
