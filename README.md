# 微信股票研究助手（首版）

原生微信小程序 + Azure 上的 FastAPI + 现有 TradingAgents + 本机 copilot-api。

```text
小程序 -- wx.login --> 微信临时 code
小程序 -- HTTPS --> FastAPI -- code2Session --> 微信登录服务
                         |
                         +-- SQLite：会话 / 用户配额 / 持久化任务
                         |
                         +-- 单任务子进程 --> TradingAgentsGraph.propagate
                                              |
                                              +-- copilot-api :4141
                                              +-- 原有行情/新闻供应商
```

没有改动原项目的 `main.py` 或模型配置；通过同一个 `TradingAgentsGraph.propagate` 接口接入，复用原虚拟环境和 `.env` 中的 Copilot 模型及地址。小程序不会接触 Copilot 或微信 AppSecret。

## 已实现

- 微信真实登录：服务端使用 `code2Session` 换取身份，签发随机会话令牌，7 天有效；数据库只保存令牌哈希和微信身份的应用内哈希，不保存 `session_key`、原始 OpenID 或微信登录 code。
- 每个微信用户每天 **3 次**，按北京时间零点重置；**失败、超时、中断的任务也计次**。同一用户最多一个排队/运行任务，全站串行运行，最多接纳 20 个未完成任务。
- 异步任务、状态轮询、最近 20 条历史、报告展示。提交附带 `request_id`，网络重试不会重复扣额度；同一编号改变参数返回 409。
- 严格按当前登录身份查询，不能查看其他用户的任务。重新登录撤销该用户旧会话；退出会撤销当前服务端会话。
- 运行中任务在服务重启后标记为失败，不自动再次消费模型；排队任务继续执行。单任务超过 30 分钟终止子进程组。
- 单份序列化结果上限 800,000 字节，超限明确失败，避免超过微信页面数据更新限制；历史列表不加载完整报告正文。
- IP/登录/提交频率限制、请求体 8 KiB 限制；数据库事务保证并发请求不绕过每日额度。
- 股票代码支持美股（如 NVDA）、港股（700.HK 自动转换为 0700.HK）、A 股（600519.SH 转为 600519.SS、000001.SZ）。实际数据覆盖受现有供应商限制；首版不支持加密货币、期货、外汇、指数和中文名称搜索。
- 返回五档评级或 `REVIEW`、最终分析和六个报告字段；不伪造目标价、准确率或进度百分比，数据不足不会被转换成“买入”。

## 目录

- [backend/](backend/)：API、SQLite 存储、串行任务执行器、TradingAgents 适配器。
- [miniprogram/](miniprogram/)：微信开发者工具导入的原生小程序。
- [deploy/](deploy/)：用户级 systemd 服务及 HTTPS 反向代理示例。

## 1. Azure 后端

```bash
cd /home/azureuser/stock-miniapp
/home/azureuser/.local/bin/uv venv .venv
/home/azureuser/.local/bin/uv pip install --python .venv/bin/python -r backend/requirements.txt
cp -n .env.example .env
chmod 600 .env
```

编辑 `.env`，在服务器本地填写：

```dotenv
WECHAT_APP_ID=wxa88701e1af24f636
WECHAT_APP_SECRET=你的小程序AppSecret
TRADINGAGENTS_DIR=/home/azureuser/TradingAgents
TRADINGAGENTS_PYTHON=/home/azureuser/TradingAgents/.venv/bin/python
DATA_DIR=/home/azureuser/stock-miniapp/data
```

不要将 AppSecret 发送到聊天、提交 Git 或写入小程序。已有模型设置仍读取 `/home/azureuser/TradingAgents/.env`；中文输出在适配器中覆盖，不改变原项目配置。每个任务独立保存分析记忆，避免用户间的历史分析相互影响；通用市场缓存可以共享。

前台开发启动（和 systemd **二选一**）：

```bash
.venv/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000 --workers 1
```

正式使用用户级服务：

```bash
systemctl --user link /home/azureuser/stock-miniapp/deploy/stock-miniapp.service
systemctl --user daemon-reload
systemctl --user enable --now stock-miniapp.service
systemctl --user status stock-miniapp.service --no-pager
journalctl --user -u stock-miniapp.service -n 50 --no-pager
```

若需要退出 SSH 后/机器重启后仍自动运行，管理员启用本用户的 linger：

```bash
sudo loginctl enable-linger azureuser
```

配置变更后：

```bash
systemctl --user restart stock-miniapp.service
curl -i http://127.0.0.1:8000/health
```

未填写微信凭据时，服务可以启动但 `/health` 返回 **503 / not_ready**，微信登录返回 503，**不会使用假登录兜底**。配置齐全且工作器正在运行才返回 200。健康检查检查配置、解释器路径和工作器存活，不代表微信、模型或行情供应商一定可用；实际调用错误会单独反馈。

**只允许一个 API 工作进程**，不要使用 `--workers 2`。启动锁防止多个实例同时恢复/处理一个数据库。systemd 的 `KillMode=control-group` 负责在服务退出时清理预测子进程。copilot-api 需要独立保持运行在原地址。

## 2. 小程序配置与 HTTPS

详见 [小程序说明](miniprogram/README.md)：

1. 微信开发者工具导入 `miniprogram`。当前 [project.config.json](miniprogram/project.config.json) 已配置 AppID `wxa88701e1af24f636`，与后端一致；使用其他小程序时同时修改前后端。
2. [miniprogram/config.js](miniprogram/config.js) 的 API 地址已配置为 `https://trading.japaneast.cloudapp.azure.com`（不是 copilot-api 地址）。
3. 域名 DNS 指向 Azure 公网 IP；根据实际基础设施开放 Azure NSG/防火墙的 TCP 80、443。
4. 安装并配置 Caddy 或等效 HTTPS 反向代理，将 [Caddyfile](deploy/Caddyfile) 中的域名换为真实域名。已有网站需合并配置，不要覆盖原有代理设置。8000 和 4141 均只监听本机，不应直接开放公网。
5. 在微信公众平台将该 HTTPS 域名加入 **request 合法域名**；按平台要求配置 AppSecret、服务端 IP 白名单（如适用）、小程序备案、隐私声明及服务类目。
6. 真机登录测试需要真实 AppID 和有效 HTTPS 合法域名。不能用测试桩的结果替代微信联调。

本机已安装 Caddy，运行配置为 `/etc/caddy/Caddyfile`，由 [deploy/Caddyfile](deploy/Caddyfile) 部署而来。以后修改项目配置后，需验证并同步才能生效：

```bash
sudo caddy validate --config /home/azureuser/stock-miniapp/deploy/Caddyfile --adapter caddyfile
sudo install -m 644 /home/azureuser/stock-miniapp/deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo journalctl -u caddy -n 30 --no-pager
curl -i https://trading.japaneast.cloudapp.azure.com/health
```

Caddy 自动申请和续期证书。域名当前解析到 `20.78.10.77`，Azure 网络须持续允许 Internet 入站 TCP 80、443，并指向本机；8000、4141 和 Caddy 管理端口 2019 仅监听回环地址。证书申请遇到 `Timeout during connect` 时，应检查网卡/子网 NSG、公网 IP 绑定及负载均衡转发，而不是关闭 TLS 校验。

2026-09-30 已在放行 Azure 入站规则后完成真实域名验证：Let's Encrypt 证书签发成功，系统信任链及主机名校验通过，HTTP 返回 308 跳转 HTTPS；HTTPS `/api/me` 未登录返回 401。首张证书于 2026-12-29 到期，由 Caddy 自动续期。当前 HTTPS `/health` 和微信登录返回 503 是因为 AppSecret 尚未填写，而不是证书或代理故障。

**HTTPS 证书不等于微信合法域名资格。** `cloudapp.azure.com` 是 Azure 提供的域名，尚未确认该子域名能被微信后台接受。微信官方网络文档要求服务器域名具备 ICP 备案等条件，不能因为 HTTPS 可访问就认为可用于正式小程序。请在微信公众平台尝试登记上述完整 HTTPS 域名；若因备案或域名资格被拒绝，需要使用满足要求且可管理的自有域名指向本机，并同步修改前端和 Caddy。不要通过关闭域名校验发布。

仅开发者工具本地联调可用 SSH 隧道：

```bash
# 在开发者自己的电脑执行
ssh -L 8000:127.0.0.1:8000 azureuser@你的Azure公网IP
```

临时将小程序 API 地址设为 `http://127.0.0.1:8000`，在开发者工具本地设置中勾选“不校验合法域名”。该选项只用于开发；真机/发布必须恢复 HTTPS 和合法域名校验。

## 3. 接口约定

除了健康检查和微信登录，其余接口必须带 `Authorization: Bearer <access_token>`。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health` | 配置及工作器状态 |
| POST | `/api/auth/wechat` | `{ "code": "wx.login 返回的 code" }` |
| DELETE | `/api/session` | 撤销会话，204 |
| GET | `/api/me` | 当日配额、服务器允许的最大分析日期 |
| POST | `/api/predictions` | `{ "ticker": "NVDA", "analysis_date": "YYYY-MM-DD", "request_id": "UUID" }` |
| GET | `/api/predictions` | 当前用户最近 20 个任务摘要 |
| GET | `/api/predictions/{id}` | 当前用户任务详情和完成后的结果 |

创建任务返回 202，幂等重试返回 200。状态：`queued → running → succeeded / failed`。

```json
{
  "id": "UUID",
  "ticker": "NVDA",
  "analysis_date": "YYYY-MM-DD",
  "status": "succeeded",
  "created_at": "ISO8601",
  "started_at": "ISO8601",
  "finished_at": "ISO8601",
  "error": null,
  "result": {
    "rating": "Hold",
    "final_decision": "真实的最终分析文本",
    "reports": {
      "market": "...",
      "sentiment": "...",
      "news": "...",
      "fundamentals": "...",
      "investment_plan": "...",
      "trader_plan": "..."
    },
    "disclaimer": "AI 分析基于可获得的数据，可能滞后、缺失或错误，不保证收益，不构成投资建议。"
  }
}
```

错误统一为 `{"detail": "可读错误"}`：401 重新登录、404 无此任务/无权限、409 已有活动任务或幂等键冲突、413 请求过大、422 参数不合法、429 额度/频率限制、502 微信上游失败、503 未配置/队列满/执行器不可用。网络错误不能视为预测失败，客户端应保留请求编号重试或查询历史记录。

## 4. 验证

后端标准库测试，不额外安装测试框架：

```bash
cd /home/azureuser/stock-miniapp
.venv/bin/python -m unittest discover -s backend/tests -v
```

覆盖微信响应处理、会话过期/撤销、跨用户隔离、3 次阈值、北京时间跨日、并发提交、幂等、队列上限、输入验证、限流、重启恢复、进程超时/取消和结果结构。

小程序逻辑测试（Node.js 18+，无需 npm 安装）：

```bash
node miniprogram/tests/run.js
```

覆盖登录会话隔离、网络重试、429 后保留幂等编号、存储异常提示、页面轮询生命周期与报告展示逻辑。

真实模型烟测（会消耗 Copilot 调用额度，可能持续数分钟）：

```bash
RUN_LIVE_PREDICTION=1 .venv/bin/python -m unittest backend.tests.test_live -v
```

烟测只在**测试进程内**替代微信身份交换，实际走 API 提交、SQLite、工作器、真实 TradingAgents 和 copilot-api，并检查结果；生产 API 没有测试登录入口。它不能证明真实微信登录、真机访问或行情完整性，仍需配置微信平台后验证。

本机首轮验收（2026-09-29）：31 个后端隔离用例、25 个小程序逻辑用例通过；真实 NVDA 烟测也通过，耗时约 18 分 37 秒，返回 `Hold`、1,357 字符最终分析及六个报告字段。过程中 StockTwits 返回 403，未配置 FRED 密钥，因此成功完成不代表所有数据源都完整可用。这也说明前台应使用异步任务，不应等待一个长时间同步 HTTP 请求。

## 5. 当前边界及上线检查

- 这是单机首版，不含支付、订阅、推送、价格回测、管理员后台或水平扩容。3 次额度统计的是任务而非底层 LLM 调用次数；串行队列并不保证立即开始。
- 报告按原文以文本展示，不运行模型输出的 HTML。模型和行情有失败/缺失风险，`REVIEW` 表示需人工复核，不等于中性或买入。
- 用户标识哈希、会话、股票查询与报告保存在 `data/app.sqlite3`；每个任务的内部日志和分析记忆位于 `data/jobs/<id>/`。不收集头像、昵称、手机号。SQLite 和日志不能对公网暴露。
- 当前报告保留在服务器，**尚未实现自动过期删除或自助注销**；公开运营前应明确保留期限、运营主体及删除联系渠道，配置备份/磁盘告警并按需要实现删除流程。退出登录不会删除历史报告。
- Caddy 示例不启用请求访问日志；应用日志不记录微信 code、令牌或 AppSecret。底层模型的完整错误/分析可能写到受保护的任务日志，管理员应限制访问。
- 登录限流是单进程内存状态，重启会重置；额度和队列是持久化的。多用户共用 IP 时可能触发 IP 限流，规模扩大后再做网关级限流和容量治理。
- 股票代码会交给原有模型与行情服务分析，隐私声明需如实披露；上线前还应核实金融信息服务相关类目/资质、微信审核规则及模型供应商条款。免责声明不能替代这些要求。
- 微信平台参数仍需管理员在公众平台操作，不提供绕过合法域名检查的发布路径。

当前 Azure 机器已创建独立 `.venv`、注册并启用上述用户级服务及 linger，监听 `127.0.0.1:8000`；Caddy 系统服务已启用。2026-09-30 已写入上述 AppID 和域名，创建权限为 600 的 `.env`，但 `WECHAT_APP_SECRET` 留空。请仅在服务器本地填写密钥，然后重启 `stock-miniapp.service`。密钥未配置时，健康检查和登录明确返回 503，不应误判为 HTTPS 代理失败；微信真实登录及平台域名登记仍待验证。
