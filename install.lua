-- me_controller 一键安装器：在任意游戏内电脑上从 GitHub 拉取全套程序。
-- 用法（目标电脑的 CraftOS 终端执行）：
--   wget run https://raw.githubusercontent.com/23q3/me-controller/main/install.lua
-- 可选参数：install [分支] [安装目录]，默认 main 与根目录 /。
-- 文件清单经 GitHub git trees API 实时枚举仓库 computer/0/ 子树，
-- 以后新增模块无需改本脚本；仅供本地开发的文件在 EXCLUDE 里排除。

local REPO = "23q3/me-controller"
local PREFIX = "computer/0/"

-- 只服务本地 MCP 开发桥的文件，生产电脑不安装（路径相对 computer/0/）。
local EXCLUDE = {
    ["agent"] = true,
    ["agent.lua"] = true,
    ["run_all"] = true,
    ["run_all.lua"] = true,
}

local branch, installDir = ...
branch = branch or "main"
installDir = installDir or "/"

if not http then
    error("此电脑没有 http API：服务器配置关闭了 CC 的 HTTP 功能", 0)
end

-- 带一次重试的 GET。binary 模式按字节落盘，避免行尾被文本模式改写。
local function fetch(url)
    local lastErr
    for attempt = 1, 2 do
        local res, err = http.get(url, nil, true)
        if res then
            local code = res.getResponseCode()
            local body = res.readAll()
            res.close()
            if code == 200 then
                return body
            end
            lastErr = "HTTP " .. code
        else
            lastErr = err or "未知错误"
        end
        if attempt == 1 then
            sleep(1)
        end
    end
    return nil, lastErr
end

print(("正在获取 %s@%s 的文件清单..."):format(REPO, branch))
local treeUrl = ("https://api.github.com/repos/%s/git/trees/%s?recursive=1")
    :format(REPO, textutils.urlEncode(branch))
local treeBody, treeErr = fetch(treeUrl)
if not treeBody then
    error(("获取文件清单失败: %s\n403 多半是 GitHub API 限流（60 次/小时/IP），稍后重试；\n也可能是服务器 http.rules 未放行 github 域名。"):format(treeErr), 0)
end

local tree = textutils.unserialiseJSON(treeBody)
if type(tree) ~= "table" or type(tree.tree) ~= "table" then
    error("GitHub API 响应无法解析（分支名是否正确？）", 0)
end
if tree.truncated then
    error("仓库文件树被 GitHub 截断，安装器需改用分目录枚举", 0)
end

local files = {}
for _, node in ipairs(tree.tree) do
    if node.type == "blob" and node.path:sub(1, #PREFIX) == PREFIX then
        local rel = node.path:sub(#PREFIX + 1)
        if not EXCLUDE[rel] then
            files[#files + 1] = rel
        end
    end
end
table.sort(files)

if #files == 0 then
    error(("分支 %s 上没有 %s 下的文件"):format(branch, PREFIX), 0)
end

print(("共 %d 个文件，安装到 %s"):format(#files, installDir))
for i, rel in ipairs(files) do
    local body, err = fetch(("https://raw.githubusercontent.com/%s/%s/%s")
        :format(REPO, branch, PREFIX .. rel))
    if not body then
        error(("下载 %s 失败: %s\n重跑安装器即可续装（文件整份覆盖，可重复执行）。"):format(rel, err), 0)
    end
    local dest = fs.combine(installDir, rel)
    local dir = fs.getDir(dest)
    if dir ~= "" then
        fs.makeDir(dir)
    end
    local handle = fs.open(dest, "wb")
    if not handle then
        error(("无法写入 %s（磁盘满或只读？）"):format(dest), 0)
    end
    handle.write(body)
    handle.close()
    print(("[%d/%d] %s"):format(i, #files, rel))
end

print("")
print("安装完成。运行 me_controller 启动控制器。")
print('如需开机自启，创建 startup.lua，内容：shell.run("me_controller")')
print("若控制器正在运行，重启后新代码才生效。")
