# 远程访问自己的 Host

> 尚未发布。设备配对随 v2 Host 协议在之后的版本发布，而且需要一个 Web UI 才能打开：KodaX Space 会提供。

你可以从手机或另一台电脑的浏览器访问自己电脑上的 KodaX Host：网页由你的 Host 提供，手机用一个链接配对一次就行。不需要账号，也不经过我们的服务器。平台给很多用户运行 Host 的情况，看[运行 KodaX Host](host.zh-CN.md)。

能用你的 Host 的人，就能在你的电脑上执行命令。挡住陌生人靠的是配对，在私有网络里也一样：Host 分不清流量是来自隧道，还是来自本机的其他程序。

## 1. 打开配对

写 `~/.kodax/integrations/host.json`（设了 `KODAX_HOME` 就是 `$KODAX_HOME/integrations/host.json`）：

```json
{
  "version": 1,
  "server": {
    "listen": { "hostname": "127.0.0.1", "port": 8787 },
    "pairing": true,
    "webRoot": "/absolute/path/to/the/web/ui"
  }
}
```

- `127.0.0.1` 让端口不暴露在你的网络上，隧道从本机连它。
- `webRoot` 是 Web UI 所在的目录，这样网页和 Host 用同一个地址。

重启 Host，让它开始监听：

```bash
kodax daemon stop
kodax daemon start
```

想让它开机后自动在线，看[让自己电脑上的 Host 一直在线](host.zh-CN.md#让自己电脑上的-host-一直在线)。

## 2. 选择连接方式

按你的用法选，下面都是免费的。

| 用法 | 方案 | 说明 |
|---|---|---|
| 长期，随时能连 | Tailscale serve | 地址固定（`<机器>.<tailnet>.ts.net`），自带 HTTPS。只有你自己的设备能打开；手机要装 Tailscale。免费的 Personal 计划限非商业使用。 |
| 长期，手机不装 App | Tailscale funnel，或 Cloudflare 命名隧道 | 公网地址。funnel 还是 beta，有不公开的带宽限制。命名隧道需要你自己的域名。 |
| 偶尔用一下 | Cloudflare 快速隧道 | 不用账号，不用装 App。`cloudflared` 每次重启地址都会变，人在外面时没法知道新地址。 |
| 同一个 Wi-Fi | 电脑的局域网地址 | 只有 HTTP。把 `127.0.0.1` 改成 `0.0.0.0`。 |

```bash
tailscale serve --bg 8787                       # Tailscale serve
tailscale funnel --bg 8787                      # Tailscale funnel
cloudflared tunnel --url http://127.0.0.1:8787  # Cloudflare 快速隧道
```

不推荐免费版 ngrok：它会在你的网页前面插一个警告页，页面里的脚本请求也可能拿到这个警告页。

## 3. 配对一台设备

```bash
kodax daemon pair --name "我的手机" --url https://my-pc.tailnet-name.ts.net
```

它打印一个链接，形如 `https://my-pc.tailnet-name.ts.net/#pair=…`。在设备上打开它。怎么把链接发给自己都可以，也可以做成二维码。

- 链接只能用一次，10 分钟内有效。只有第一台打开它的设备能配对成功。
- 配对码在 `#` 后面，不会发给隧道和代理，也不会进日志。配对后网页会把它从地址栏清掉。
- 设备会保存一个页面脚本读不到的 cookie，以后访问时凭它连接，不用再输码。清空浏览器数据就要重新配对。
- cookie 只在配对时的地址上有效。隧道地址变了，要重新配对。

不给 `--url` 时，命令只打印 `/#pair=…`，自己在前面补上隧道地址。

## 4. 管理设备

```bash
kodax daemon devices                    # id、名称、地址、最后连接时间
kodax daemon devices revoke "我的手机"
```

吊销设备会立即断开它的连接。在 `host.json` 里关掉 `pairing`，不用重启就会断开所有配对设备，也不能再配对；设备列表还在，可以照常清理。

这些命令连的是正在运行的 Host，先把它启动起来。

## 陌生人能看到什么

用 funnel 或 Cloudflare 隧道时，你的 Host 端口在公网上。

- 配对需要在你自己电脑上生成的码。码是 128 位随机数，只有 10 分钟，猜不中。
- `/healthz` 只说 Host 是否就绪，不会透露你是不是正在用、上次用是什么时候。
- Web UI 的文件是公开的。你的 Session 不是，它们只发给配对过的设备。

## 还没测过的

这些要等 Web UI 出来，发布前会验证：

- 经 Tailscale serve 和 Cloudflare 快速隧道配对和连接；
- iPhone 超过一周没访问，再打开时是否仍然免配对；
- 在中国大陆网络下，每种方案能否稳定访问。
