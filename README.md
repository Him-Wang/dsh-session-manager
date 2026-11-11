# dsh-session-manager

给 DeepSeek Harness 的 Web GUI 补上**真正删除**的能力：删会话（默认移入回收站，可恢复）、删工作区（可选把文件夹移入回收站）。

## 为什么需要它

DSH 目前刻意不做会话删除：

- 侧栏只有「归档」，归档的行仍然留在磁盘上，只能靠 archived 视图过滤回来。
- 工作区菜单里的「删除工作区」只删注册分组，文件夹与会话记录全部保留。
- 会话持久化层（`dsh-session-persistence-jsonl`）的说明原文是 “Nothing deletes session files — logs accumulate under root until removed externally; the seam has no deletion API.”

所以会话日志会一直堆在 `~/.dsh/sessions/` 里。这个插件把「外部删除」做成界面上的动作，并且默认先扔进回收站。

## 安装了什么

| 位置 | 作用 |
| --- | --- |
| 会话行 `...` 菜单 →「删除会话（移到回收站）…」 | 二次确认后把该会话移入回收站 |
| 会话行悬停按钮（垃圾桶图标） | 同上，单行快捷删除 |
| 侧栏分组标题右侧的垃圾桶按钮（`未分组` 或某个工作区） | 二次确认后把该分组里**所有未归档**会话移入回收站 |
| 设置 →「会话与工作区清理」 | 清单式管理：多选删会话、移除工作区、回收站的恢复与彻底删除 |

分组标题那个按钮是插件从 DOM 上挂进去的：ui-workspace 没有为分组行开 Slot，但它给每行留了稳定的 `data-row-key="workspace:<id>"`（未分组是 `workspace:`），插件据此识别分组并用 MutationObserver 在 React 重渲染后重新挂上按钮。已归档的会话不会被这个按钮删掉，需要单独在设置页处理。

## 回收站

删会话不再是 `rm`，而是一次可逆的搬家：

```
~/.dsh/trash/<时间戳>-session-<会话目录名>/
  meta.json          # id、所属项目目录、标题、原始大小、归档/置顶状态、原工作区 id
  session/           # 原来 ~/.dsh/sessions/<项目>/<会话>/ 里的全部内容
  projection.json    # 侧栏标题缓存（移回时一起还回去）
```

设置页「回收站」页签里：

- **恢复**（只对会话条目）：日志移回原项目目录，标题缓存一起还回去；`meta.json` 里记住的归档 / 置顶 / 工作区归属也会重新写进 `workspace.json`，刷新页面后会话回到原来的分组。
- **彻底删除**：从磁盘上真删，不可撤销。

工作区文件夹的条目没有 `meta.json`（原始父目录未知），只能彻底删除或到磁盘上手动移回。

「删除会话」是被刻意做成默认进入回收站的——`cordis.patch.yml` 里写 `trashSessions: false` 才会回到直接 `rm` 的老行为。

## 安全边界

- **只走本机回环**：HTTP 路由拒绝任何非 `127.0.0.1` / `::1` 直连的请求（也拒绝带 `forwarded`、`x-forwarded-for` 头的请求），并要求同源 `Origin`；POST 必须带 `x-dsh-session-manager: 1` 头，避免被其他页面跨站触发。
- **只动枚举出来的目录**：目标目录必须在 `~/.dsh/sessions/` 之下，且目录名必须等于该会话 id 的编码形式，防止路径穿越或误删。
- **在用会话不删**：最近 30 秒内还有写入的会话会被拒绝（`busyWindowMs` 可配），提示先切换走再删。
- **不覆盖任何东西**：回收站条目名碰撞时自动加 `-2`、`-3`；恢复时如果原位置已经有同名会话，直接拒绝而不是合并。
- **工作区文件夹只移动不删除**：删工作区时文件夹是 `rename` 进 `~/.dsh/trash/`，可以手动恢复；彻底清除是回收站里单独的、逐项的确认动作。
- **不动正在用的目录**：文件夹包含（或等于）DSH 数据目录、当前进程工作目录时拒绝移动。
- **只改该改的字段**：会话离开侧栏后只清理 `workspace.json` 里的 `sessionIds` / `archivedSessionIds` / `pinnedSessionIds`，其他内容原样保留；工作区注册走官方 `workspaceController.delete`。

## 配置

可选，写在 `cordis.patch.yml` 的 `config` 里：

```yaml
- insert:
    - id: dsh-session-manager
      name: dsh-session-manager
      config:
        enabled: true
        busyWindowMs: 30000        # 最近这么久内有写入的会话拒绝删除；0 关闭该保护
        trashSessions: true        # 删会话是否先进回收站；false 则直接永久删除
        # home: C:/Users/you/.dsh  # 默认取 DSH_HOME 或 ~/.dsh
        # trashDir: C:/Users/you/.dsh/trash
```

## 安装

profile（`~/.dsh/profiles/desktop`）里三步：

1. `package.json` 的 `dependencies` 加 `"dsh-session-manager": "file:C:/Users/<you>/.dsh/local-plugins/dsh-session-manager"`，并把它加进 `dsh.profile.bundles`。
2. `node_modules/dsh-session-manager` 建一个指向 `~/.dsh/local-plugins/dsh-session-manager` 的 Junction（Windows：`cmd /c mklink /J`）。
3. **重启 DSH NEXT**：客户端半在启动时打包，不重启不会出现菜单项。

卸载：把名字从 `bundles` 与 `dependencies` 里去掉，删掉那个 Junction，重启。

## 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-session-manager/overview` | 会话 / 工作区 / 回收站清单与占用 |
| POST | `/dsh-session-manager/delete-sessions` | `{ ids: string[] }` 把会话移入回收站（`trashSessions: false` 时永久删除） |
| POST | `/dsh-session-manager/restore-session` | `{ name }` 把回收站里的会话条目恢复原位 |
| POST | `/dsh-session-manager/delete-workspace` | `{ workspaceId, trash?: boolean }` 移除注册，`trash` 为真时把文件夹移入回收站 |
| POST | `/dsh-session-manager/purge-trash` | `{ name }` 彻底删除一个回收站条目 |

## 测试

`test/` 下三个脚本不需要 DSH 运行，直接 `node` 跑：

```sh
node test/store.test.mjs   # 路径编码、清单、删除、簿记、会话与文件夹回收站、恢复
node test/host.test.mjs    # 假 ctx + 真 HTTP 服务：鉴权、载荷、控制器调用次数、恢复流程
node test/client.test.mjs  # 客户端半：槽位注册、确认对话框、面板渲染
```

三个脚本都在临时目录里造数据，跑完自清理，不会碰到真实会话。
