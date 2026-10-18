# GitHub 网页授权配置

登录按钮会打开系统浏览器中的 GitHub 授权页面。用户确认后，GitHub 将授权码发送到后端回调地址，后端交换令牌。客户端凭本次登录的随机校验值读取结果，验证 `/user` 后保存系统加密凭据。回调页通过 `happygit://oauth/complete` 唤回应用；该链接不携带令牌。客户端读取成功结果后，服务端立即删除临时凭据。未完成的请求十分钟后失效，服务重启后需要重新发起登录。

在 GitHub 开发者设置注册 OAuth App，Authorization callback URL 填写 `https://你的服务域名/api/auth/github/callback`。已有 GitHub App 也可使用网页授权，将 `GITHUB_APP_TYPE` 设置为 `github-app`，读取公开个人资料，并将用户权限 Starring 配置为读写。GitHub App 无需启用 Device Flow。OAuth App 使用 `read:user public_repo` 授权范围，后者用于公开仓库 Star；客户端只允许预先定义的个人资料、公开仓库和 Star 接口。

服务端启动前配置以下环境变量，Client Secret 不写入前端、安装包或版本库，也不要发到聊天中。

```powershell
$env:GITHUB_CLIENT_ID = '应用的 Client ID'
$env:GITHUB_CLIENT_SECRET = '应用的 Client Secret'
$env:GITHUB_CALLBACK_URL = 'https://你的服务域名/api/auth/github/callback'
$env:GITHUB_APP_TYPE = 'oauth-app'
```

在 `client/.env.local` 中配置 `VITE_API_BASE_URL=https://你的服务域名`，然后重新构建 Windows 和 Android。登录使用后端授权服务，热门页仍可在服务不可用时直接读取 GitHub 公开搜索结果。服务端缺少授权配置时返回 503，客户端会显示配置提示，不会伪造已登录状态。

本地 Windows 联调可使用 `http://127.0.0.1:8081`，并在 GitHub 应用中登记对应的回调地址。Android 手机需要能访问的 HTTPS 后端；调试模拟器可使用 `http://10.0.2.2:8081`，该例外只用于可调试安装包。正式安装包要求 HTTPS。

`/api/auth/github/begin` 接收客户端随机校验值的 SHA-256 摘要，返回 GitHub 授权地址、请求标识及过期时间。`/poll` 和 `/cancel` 需要请求标识和原始校验值；仅知道标识无法取得令牌。GitHub 回调单独验证随机 state 和 PKCE，同一次回调只能交换一次。`/refresh` 使用加密存储中保留的 refresh token 续期，401 会要求重新登录。OAuth App 未启用过期令牌时，客户端不会假设一定存在 refresh token。

Star 与取消 Star 分别调用 GitHub `PUT /user/starred/{owner}/{repo}` 和 `DELETE /user/starred/{owner}/{repo}`，204 才表示写入成功。请求超时时先读取远端状态；权限不足、速率限制和登录过期分别提示。本地缓存失败会明确告知远端已更新，可重新同步，不会将本地失败误报为 GitHub 写入失败。

反向代理应对授权接口限制请求频率，关闭回调查询参数日志和授权请求体日志，并将全部 `/api/auth/github/*` 请求固定转发到同一后端实例。当前临时授权状态保存在单实例内存中，不适合无会话亲和的多实例部署。生产环境只暴露 HTTPS，不向公网直接暴露开发端口。

配置依据：[GitHub 网页授权](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)、[Star REST 接口](https://docs.github.com/en/rest/activity/starring)。
