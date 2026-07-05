# ME Controller Web 控制台

基于 Bun 的本地后端 + 浏览器控制台,配合游戏内 ComputerCraft ME 控制器使用。前后端全部 TypeScript,无框架,界面为 AE2 风格(侧边导航:总览 / 物品终端 / 自动维持 / 命令日志,自动合成与样板管理为规划中的占位)。

## 运行

```sh
cd web
bun install
bun run dev
```

脚本说明(`package.json`):

| 脚本 | 作用 |
|---|---|
| `bun run dev` | 先打包前端再启动服务器(改前端后重跑即可) |
| `bun run dev:client` | 前端打包挂 `--watch`,增量重打包 |
| `bun run dev:server` | 只启动服务器 |
| `bun run start` | 打包 + 启动(与 dev 等价的正式入口) |
| `bun run assets` | 手动重建物品资产索引与图标(装/删 mod 后跑,不必启动服务器) |
| `bun test` | 跑 `tests/` 下的金样测试 |

前端入口 `src/client/main.ts` 打包到 `public/assets/main.js`(带 sourcemap)。端口默认 `8787`,可用 `PORT` 环境变量覆盖;注意部分 Windows 机器上 8787 落在系统保留端口区,启动失败时换一个端口即可。

浏览器打开:

```text
http://localhost:8787
```

### 不开游戏做前端开发

`scripts/fake-bridge.ts` 可模拟游戏内桥接(发送带 `stockCounts` 的快照心跳、确认命令),物品终端等视图即可看到数据:

```sh
PORT=8787 bun run scripts/fake-bridge.ts
```

`FAKE_SILENT=1` 可模拟"收到命令但不回包",用于测试前端的命令超时提示。注意 fake-bridge 的 `PORT` 要与服务器一致。

## 连接游戏内 Lua 控制器

在 CC 电脑终端里:

```text
me_controller bridge enable ws://localhost:8787/bridge
me_controller
```

如果 ComputerCraft 拒绝本地/局域网地址,确认 `config/computercraft-server.toml` 放行了 `$private` 规则(本实例已配置):

```toml
[[http.rules]]
host = "$private"
action = "allow"
```

如果游戏内 `localhost` 解析到 Minecraft 进程而不是宿主机,改用宿主机局域网 IP,例如 `ws://192.168.1.20:8787/bridge`。

### 物品终端(库存快照)

物品终端视图需要 Lua 侧快照携带 `stockCounts`,默认关闭(快照会大很多)。开启方式:编辑 `computer/0/apps/me_controller/bridge.db`,加上/改为 `includeStock = true`。桥接每次重连都会热加载 `bridge.db`,无需重启 Lua 程序;未开启时前端物品终端会显示开启指引空态。

## 多原料与副产物配方

维持目标的配方支持多种原料与多种产物。编辑器(自动维持 → 新增/编辑目标)是结构化行编辑,物品 ID 输入框带中文名/英文名/ID 自动补全(数据来自物品资产索引):

- **原料**:每行一种,"每批消耗"是一批配方消耗的数量。决策器按整批比例计算并请求;某种原料全网缺货时整个目标等待,不会瘸腿请求。
- **产物**:第一行是**主产物**,其"目标库存"驱动生产;其余行是**副产物**,目标库存默认 0——只入账、不驱动生产(AE2 式副产物语义)。副产物目标设为正数则按共产物维持,批次数取各产物需求的最大值。
- 下游目标消耗某个副产物时,依赖规划器会把需求传导给该物品的生产者(同一物品有多个生产者时取优先级最小者),副产物需求同样能拉动上游生产。
- Lua 侧位置化默认与此一致:targets.db 中省略 `targetCount` 的产物,第一个继承目标级 targetCount,其余按 0 处理;规整后每个产物都带显式 targetCount 落盘(历史存档不受影响——旧规整从不省略该字段)。
- 目标行的"请求"按钮会把**全部缺料**逐项下发(每种上限 64,人工催单用,不接管调度)。

## 目录结构

```text
web/
├── src/
│   ├── shared/          # 服务端与前端共用(协议类型、目标字段描述符、命令规范化、summary 重算)
│   ├── server/          # index(bootstrap)、routes、static、bridge-ws、ui-ws、state、store(sqlite)、assets
│   └── client/          # main、state(极简 store)、ws(重连)、api、render(全量重渲染)、target-editor、dom
├── scripts/fake-bridge.ts
├── tests/               # bun:test 金样测试(基于 fixtures/ 的真实快照)
└── public/              # index.html、styles.css;assets/ 与 generated/ 为构建产物(git 忽略)
```

## WebSocket 端点

- `/bridge`:游戏内 Lua 控制器连接(协议 `me_controller.bridge.v1`)。
- `/ui`:浏览器控制台连接,快照与命令状态实时广播。

## HTTP 端点

- `GET /api/status`:桥接状态、最新快照、近期命令。
- `GET /api/items`:物品资产索引(中文名/图标路径)。
- `POST /api/commands`:向 Lua 桥下发命令;body 不是合法 JSON 时返回 400 `{"error":"invalid json"}`。

命令示例:

```json
{
  "kind": "set_enabled",
  "targetId": "create_iron_sheet",
  "enabled": false
}
```

缺 `commandId` 时由后端补齐(mutating 命令幂等去重靠它)。命令状态存于 `../data/me-controller.sqlite`(存档 `computercraft/data/` 下,与 `web/` 平级),状态机为 sent → acknowledged/failed → synced。

快照不做乐观改写:界面上"启用中/停用中"等转圈状态只是 pending 标记,一切以 Lua 回传的权威快照为准。

## 物品名称与图标

后端扫描本地游戏资源,生成:

```text
public/generated/item-index.json
public/generated/items/<namespace>/<item>.png
```

扫描顺序(后者覆盖前者):实例根目录 jar(原版) → `mods/**/*.jar` → `automodpack/modpacks/*/mods/*.jar`(整合包 mod 由 automodpack 运行时注入,不在 mods/ 里) → `kubejs/assets`。**刻意不扫 `resourcepacks/`**:整合包会往里放未启用的高清材质包(如 64x 写实包),混进来会整批污染"原版长相"的图标。jar 逐个打开逐个释放,上百个 mod 不会同时驻留内存。

中文名:原版取启动器共享资源库(`assets/indexes/<id>.json` → hash 寻址的 `zh_cn.json`,客户端 jar 里只有英文),mod 取 jar 内 `assets/*/lang/zh_cn.json`;回退 `en_us.json`,再回退物品 id。

图标合成(`src/server/icons.ts` + 零依赖 PNG 编解码 `src/server/png.ts`),优先级从高到低:

- **游戏内导出图(可选,效果最佳)**:实例根目录存在 `icon-exports-xN/`(IconExporter mod 的产物)时直接采用——游戏引擎亲自渲染,箱子/楼梯真实形状/代码渲染物品/染色/附魔光效全部与游戏内一致。多个导出目录取最近修改的,可用 `ICON_EXPORTS_DIR` 环境变量指定;文件名 `modid__itemid[__变体].png`,同物品多变体取无后缀的基础款;导出里有而物品模型缺失的 id 也会并入索引。
- 模型有 `layer0` → 平面物品,多层叠加(药水=液体+瓶身);`cross` 类(花/树苗)也走平面。
- 模型 parent 链途经 `block/` → 按物品栏视角合成**等距立方体**(顶/左/右三面,明暗 1.0/0.8/0.6,输出 64px,前端 `.itemIcon.iso` 平滑缩小)。楼梯/台阶等非完整方块也画成整块立方体,属已知取舍。
- 动画贴图(高为宽的整数倍的纵向长条)裁第一帧;草方块顶面/树叶等灰度贴图按平原群系固定色染色(白名单见 `icons.ts` 的 `TINTS`)。
- 源 PNG 解不开时原样拷贝兜底;箱子/潜影盒等实体渲染方块无常规贴图,没有导出图时可能无图标。

### 游戏内导出图标(一次性操作)

1. 下载两个 mod 放进实例的 `mods/` 文件夹(**不是** automodpack 目录):[IconExporter](https://modrinth.com/mod/icon-exporter)(选 NeoForge 1.21.1 版)及其前置 [Cyclops Core](https://modrinth.com/mod/cyclopscore)(同样 NeoForge 1.21.1)。
2. 启动游戏进任意存档,聊天栏执行 `/iconexporter export 64`(64 为分辨率,够网页用;想更清晰可用 128)。等右上角进度跑完,8000+ 物品约几分钟,Esc 可中断。
3. 产物在实例根目录 `icon-exports-x64/`。重新导出前建议删掉旧目录,避免已卸载 mod 的图标残留。
4. 跑 `bun run assets`(或重启网页服务器),统计行出现"游戏内导出 N"即生效;浏览器硬刷新一次。
5. 两个 mod 是纯客户端工具,导完可以从 `mods/` 删除;若留着,连服务器被校验拦下时同样删掉即可。

资产索引在**服务器启动时异步构建一次**(约 10s),`/api/items` 会等待构建完成;装了新 mod 后重启服务器,或手动跑 `bun run assets` 重建(会先清空旧图)。图标 URL 带 `?v=构建版本` 参数,重建后浏览器缓存自动失效。生成物是本地缓存,git 忽略。

### TACZ 枪械的已知限制

TACZ 是数据驱动 mod:所有枪共享 `tacz:modern_kinetic_gun` 一个物品 id(弹药/配件同理),具体型号存在物品组件里。限制链条:

1. Create 报点器(`stock()`)按变体分行,但字段由 CC:Tweaked 的 detail registry 决定——**不含 TACZ 组件**,无法知道某行是哪把枪;
2. `displayName` 虽是本地化枪名,但 CC:Tweaked 字符集会把中文吃成 `?`,不可用;
3. Lua 侧(`network.lua`)按物品 id 聚合,所以网页上所有枪合并为一行"现代动能枪械"、所有弹药合并为"枪械弹药"(名字来自 `assets.ts` 的 `EXTRA_NAMES` 特判表——这些物品在官方 lang 里没有基础翻译键)。

枪包(`实例根/tacz/*.zip`)里其实自带每把枪的物品栏贴图(`assets/<ns>/textures/gun/slot/`,由 display json 的 `slot` 字段索引)和中文名(`tacz.gun.<id>.name`),**卡点只在于外设层拿不到组件**。要真正按型号分行,需要一个伴生小 mod 给 CC:Tweaked 注册 detail provider 暴露 `GunId`,Lua/网页侧改动都很小。
