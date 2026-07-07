-- me_controller 一键安装器：在任意游戏内电脑上从 GitHub 拉取全套程序。
-- 用法（目标电脑的 CraftOS 终端执行）：
--   wget run https://raw.githubusercontent.com/23q3/me-controller/main/install.lua
-- 可选参数：install [分支] [安装目录]，默认 main 与根目录 /。
-- 文件清单经 GitHub git trees API 实时枚举仓库 computer/0/ 子树，
-- 以后新增模块无需改本脚本；仅供本地开发的文件在 EXCLUDE 里排除。
-- 注意：CC 终端渲染不了中文，运行期输出必须保持 ASCII（注释不受限）。

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
    error("http API unavailable: HTTP is disabled in this server's CC config", 0)
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
            lastErr = err or "unknown error"
        end
        if attempt == 1 then
            sleep(1)
        end
    end
    return nil, lastErr
end

print(("Fetching file list of %s@%s ..."):format(REPO, branch))
local treeUrl = ("https://api.github.com/repos/%s/git/trees/%s?recursive=1")
    :format(REPO, textutils.urlEncode(branch))
local treeBody, treeErr = fetch(treeUrl)
if not treeBody then
    error(("Failed to fetch file list: %s\nHTTP 403 usually means GitHub API rate limit (60/h per IP), retry later.\nAlso check the server's http.rules allow github domains."):format(treeErr), 0)
end

local tree = textutils.unserialiseJSON(treeBody)
if type(tree) ~= "table" or type(tree.tree) ~= "table" then
    error("Cannot parse GitHub API response (wrong branch name?)", 0)
end
if tree.truncated then
    error("Repo tree truncated by GitHub, installer needs a per-dir walk", 0)
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
    error(("No files under %s on branch %s"):format(PREFIX, branch), 0)
end

print(("Installing %d files to %s"):format(#files, installDir))
for i, rel in ipairs(files) do
    local body, err = fetch(("https://raw.githubusercontent.com/%s/%s/%s")
        :format(REPO, branch, PREFIX .. rel))
    if not body then
        error(("Failed to download %s: %s\nRe-run the installer to resume (files are overwritten whole)."):format(rel, err), 0)
    end
    local dest = fs.combine(installDir, rel)
    local dir = fs.getDir(dest)
    if dir ~= "" then
        fs.makeDir(dir)
    end
    local handle = fs.open(dest, "wb")
    if not handle then
        error(("Cannot write %s (disk full or read-only?)"):format(dest), 0)
    end
    handle.write(body)
    handle.close()
    print(("[%d/%d] %s"):format(i, #files, rel))
end

print("")
print("Install complete. Run me_controller to start.")
print('Autostart: create startup.lua with shell.run("me_controller")')
print("If the controller is already running, restart to load new code.")
