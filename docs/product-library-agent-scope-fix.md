# 修复建议：产品库页 agent 下拉为空（`/agents?scope=all` 被 403）

> 状态：**待前端机器处理**（后端补丁已上线，本文档只描述前端那一处）
> 影响版本：2026-11-21 线上产物（`ocbot.aixifs.com/videogen`）
> 提出时间：2026-11-21

## 1. 现象

线上日志（`/opt/octop-data/logs/octop.log`）里，客户打开产品库页时：

```
2026-11-21 10:33:20,279 INFO  octop.api.access — GET /api/product-library/products -> 200 49ms user=3 ip=113.67.10.157
2026-11-21 10:33:20,280 WARNING octop.api.access — GET /api/agents -> 403 49ms user=3 ip=113.67.10.157
```

产品库本身能打开，但**「选择 agent」下拉框是空的** —— 页面上没有报错，只是列表空着，
用户以为功能坏了。

## 2. 根因

前端取 agent 列表时用的是 `scope=all`：

`dashboard/src/pages/ProductLibrary/index.tsx:265`

```tsx
void request<OctopAgent[]>("/agents?scope=all")
  .then(
    (rows) =>
      version === ownerVersion.current &&
      setAgents(rows.filter((a) => a.is_owner && a.state === "running")),
  )
  .catch(() => {
    if (version === ownerVersion.current) setAgents([]);
  });
```

后端 `scope=all` 的语义是「所有人的 agent」，属于管理员视图：

`src/octop/api/routers/agents.py:288`

```python
if scope == "all" and not user_has_permission(user, "users"):
    raise OctopError(ErrorCode.FORBIDDEN, "permission required", details={"permission": "users"})
```

普通用户没有 `users` 权限 → 403 → 上面那个 `.catch()` 把错误吞掉、`setAgents([])` → 下拉框空。

**关键点：这页并不需要别人的 agent。** 它拿到结果后立刻用
`a.is_owner && a.state === "running"` 过滤，只要「自己名下且在运行的 agent」。
而 `scope=mine` 返回的正是「自己 + 别人共享给自己的」，语义完全覆盖这个需求。

## 3. 修复

一行改动，把 `scope=all` 换成 `scope=mine`：

```diff
--- a/dashboard/src/pages/ProductLibrary/index.tsx
+++ b/dashboard/src/pages/ProductLibrary/index.tsx
@@ -262,7 +262,7 @@
-    void request<OctopAgent[]>("/agents?scope=all")
+    void request<OctopAgent[]>("/agents?scope=mine")
       .then(
         (rows) =>
           version === ownerVersion.current &&
```

`scope` 是后端 `list_agents` 的查询参数，默认值本来就是 `mine`，所以
`/agents`（不带参数）也可以；显式写 `scope=mine` 是为了让人一眼看出意图。

改完 `a.is_owner && a.state === "running"` 的过滤可以保留 —— `scope=mine`
返回里同样带 `is_owner` 字段（两条分支共用同一个 `_row_dict`），语义不变。

### 不要改的地方

`scope=all` 在下面两处**是正确用法**，不要一起改掉：

- `dashboard/src/pages/Admin/Users/UsersListPanel.tsx:2003` —— 管理员给用户挑 agent
- `dashboard/src/pages/Settings/octop/Agents.tsx:81` —— 管理员看全局 agent 列表

这两处页面本身只有管理员能进，`users` 权限由后端强校验，不需要前端兜底。

### 备选方案（不推荐）

放宽后端 `scope=all` 让普通用户降级返回自己的 agent —— 这会改掉一个已经写进
OpenAPI 的权限语义（`scope=all` = 管理员看全部），且会让上面两个管理员页面在
权限异常时静默显示不全的数据。**在调用方收敛 scope 才是正确的一侧。**

## 4. 验收标准

1. 用**普通用户**（非 admin）打开产品库页 → 「选择 agent」下拉框能列出自己名下
   在运行的 agent，不再是空列表。
2. 后端日志中该请求从 `GET /api/agents -> 403` 变成 `-> 200`。
3. 管理员打开产品库页行为不变（仍只看自己的 agent，与改动前一致）。

## 5. 同一批线上问题里的另外两项（后端已修，前端无需处理）

为免重复排查，一并记录：

| 问题 | 归属 | 状态 |
|---|---|---|
| 导入后产品名出现 `candidates` | 后端 `infra/product_library/` | 已修（2026-11-21 上线） |
| agent 启动时 `skills` 目录 `path_not_found` 告警 | 后端 `infra/agents/workspace/` | 已修（2026-11-21 上线） |
| 产品库页 agent 下拉为空（本文） | 前端 `dashboard/` | **待处理** |
