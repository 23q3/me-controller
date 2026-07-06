export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type RecipeEntry = {
  item: string;
  label?: string;
  count?: number;
  targetCount?: number;
};

// 样板（recipes.db）：配方的唯一权威——输入/输出/工序地址；
// 目标经 recipeId 引用样板，条目不携带 targetCount（那是目标侧库存策略）
export type RecipeSnapshot = {
  id: string;
  name?: string;
  address?: string;
  products?: RecipeEntry[];
  inputs?: RecipeEntry[];
};

export type TargetSnapshot = {
  id: string;
  enabled?: boolean;
  address?: string;
  priority?: number;
  recipeId?: string;
  products?: RecipeEntry[];
  inputs?: RecipeEntry[];
  status?: string;
  message?: string;
  productCount?: number;
  productCounts?: Record<string, JsonValue>;
  inputCounts?: Record<string, JsonValue>;
  targetCount?: number;
  dependencyDemand?: number;
  desiredBatches?: number;
  neededBatches?: number;
  promisedBatches?: number;
  neededInputs?: number;
  neededInputItems?: Record<string, number>;
  promisedInputs?: number;
  promisedInputItems?: Record<string, number>;
  nextExpiry?: number;
};

export type ControllerSnapshot = {
  schema?: string;
  time?: number;
  network?: {
    ready?: boolean;
    error?: string | null;
    stockEntries?: number;
    stockSerial?: number;
    lastStockReadAt?: number;
    stockName?: string;
    monitorName?: string;
  };
  dependency?: {
    passes?: number;
    demandByTarget?: Record<string, JsonValue>;
  };
  summary?: {
    total?: number;
    enabled?: number;
    requested?: number;
    waiting?: number;
    error?: number;
    satisfied?: number;
    disabled?: number;
  };
  targets?: TargetSnapshot[];
  recipes?: RecipeSnapshot[];
  orders?: OrderSnapshot[];
  commands?: CommandRecord[];
  stockCounts?: Record<string, number>;
};

// 订单（下单纳管）：一张订单 = 一次 requestFiltered 变参调用 = 一个 PackageOrder。
// 生命周期 queued → dispatched → completed | expired | failed | cancelled；
// queued 可真取消，dispatched 取消 = 释放跟踪（包裹已物理发出无法召回）。
// jobId/parentOrderId 为合成链预留：未来"手动请求自动合成"的链式规划器把
// 整条链拆成多张订单，共享 jobId 分组、父子经 parentOrderId 关联。
export type OrderSnapshot = {
  id?: string;
  kind?: string; // maintain(自动维持) | recipe(样板下单) | manual(缺料催单) | 预留:chain
  source?: string;
  status?: string; // queued | dispatched | completed | expired | failed | cancelled
  recipeId?: string;
  recipeName?: string;
  targetId?: string;
  jobId?: string;
  parentOrderId?: string;
  address?: string;
  batches?: number;
  items?: Array<{ item?: string; count?: number }>;
  products?: Array<{ item?: string; count?: number }>;
  wanted?: number;
  requested?: number;
  // 目标联动单（maintain/manual）：承诺跟踪进度
  tracked?: boolean;
  trackedInputs?: number;
  remainingInputs?: number;
  // 样板单（recipe）：主产物库存基线观测进度
  baselineProductCount?: number;
  deliveredProducts?: number;
  note?: string;
  error?: string;
  commandId?: string;
  dispatchAttempts?: number;
  createdAt?: number;
  dispatchedAt?: number;
  completedAt?: number;
  expiresAt?: number;
};

export type CommandRecord = {
  id?: string;
  commandId?: string;
  kind?: string;
  source?: string;
  targetId?: string;
  status?: string;
  item?: string;
  items?: Array<{ item?: string; count?: number }>;
  wanted?: number;
  requested?: number;
  createdAt?: number;
  completedAt?: number;
  error?: string;
};

export type ControllerCommand = {
  commandId?: string;
  id?: string;
  kind: string;
  type?: string;
  source?: string;
  targetId?: string;
  target?: JsonValue;
  recipeId?: string;
  recipe?: JsonValue;
  batches?: number;
  enabled?: boolean;
  address?: string;
  item?: string;
  count?: number;
  amount?: number;
  // 多物品请求：全部条目并入一张订单（同一 PackageOrder，理包机可按订单合包）
  items?: Array<{ item: string; count: number }>;
  trackCommitment?: boolean;
  // cancel_order：要取消的订单 id
  orderId?: string;
  // 合成链预留（request_recipe 已透传，链式规划器扩展时协议无需再动）
  jobId?: string;
  parentOrderId?: string;
  options?: Record<string, JsonValue>;
};

export type BridgeEnvelope =
  | {
      type: "hello";
      clientId?: string;
      protocol?: string;
      time?: number;
    }
  | {
      type: "snapshot" | "heartbeat";
      clientId?: string;
      time?: number;
      snapshot?: ControllerSnapshot;
    }
  | {
      type: "command_result";
      clientId?: string;
      time?: number;
      commandId?: string;
      ok?: boolean;
      response?: JsonValue;
    }
  | {
      type: "error";
      clientId?: string;
      time?: number;
      error?: string;
    };

// 服务端 sqlite 命令账本的行形状；/api/status 与 /ui state 信封实际下发的就是它
export type StoredCommand = {
  commandId: string;
  kind: string;
  status: string;
  request: JsonValue;
  response?: JsonValue;
  createdAt: number;
  sentAt?: number;
  completedAt?: number;
};

export type UiEnvelope =
  | {
      type: "state";
      bridge: BridgeState;
      snapshot: ControllerSnapshot | null;
      commands: StoredCommand[];
    }
  | {
      type: "command_result";
      commandId?: string;
      ok: boolean;
      response: JsonValue;
    }
  | {
      type: "command_accepted";
      commandId?: string;
      ok: boolean;
      response: JsonValue;
    }
  | {
      type: "error";
      error: string;
    };

export type BridgeState = {
  connected: boolean;
  clientId?: string;
  protocol?: string;
  connectedAt?: number;
  lastSeenAt?: number;
};
